/**
 * Agent Blame Sync Command
 *
 * Transfers attribution notes after squash/rebase merges.
 * Detects recent merges, fetches original PR commits, and transfers notes.
 */

import { execSync, spawnSync } from "node:child_process";
import {
  getRepoRoot,
  fetchNotesQuiet,
  type GitNotesAttribution,
} from "./lib";

type NoteAttribution = GitNotesAttribution["attributions"][number];

interface SyncOptions {
  dryRun?: boolean;
  verbose?: boolean;
}

interface MergeCandidate {
  sha: string;
  prNumber: number;
  message: string;
}

function run(cmd: string, cwd: string): string {
  try {
    return execSync(cmd, { encoding: "utf8", cwd }).trim();
  } catch {
    return "";
  }
}

function vlog(msg: string, options: SyncOptions): void {
  if (options.verbose) {
    console.log(`  ${msg}`);
  }
}

/**
 * Find recent commits that look like squash/rebase merges without notes
 */
function findMergeCandidates(
  repoRoot: string,
  options: SyncOptions,
): MergeCandidate[] {
  const candidates: MergeCandidate[] = [];

  // Get recent commits on current branch (last 20)
  const logOutput = run(`git log --oneline -20 --format="%H %s"`, repoRoot);

  if (!logOutput) return candidates;

  for (const line of logOutput.split("\n")) {
    const match = line.match(/^([a-f0-9]+)\s+(.+)$/);
    if (!match) continue;

    const [, sha, message] = match;

    // Check if commit message has PR number pattern: (#123) or (123)
    const prMatch = message.match(/\(#?(\d+)\)\s*$/);
    if (!prMatch) continue;

    const prNumber = parseInt(prMatch[1], 10);

    // Check if this commit already has a note
    const hasNote = run(
      `git notes --ref=refs/notes/agentblame show ${sha} 2>/dev/null`,
      repoRoot,
    );
    if (hasNote) {
      vlog(`Skipping ${sha.slice(0, 7)} - already has note`, options);
      continue;
    }

    // Check if it's a single-parent commit (squash or rebase, not merge)
    const parents = run(`git rev-list --parents -n 1 ${sha}`, repoRoot).split(
      " ",
    );
    if (parents.length > 2) {
      vlog(
        `Skipping ${sha.slice(0, 7)} - merge commit (has multiple parents)`,
        options,
      );
      continue;
    }

    candidates.push({ sha, prNumber, message });
  }

  return candidates;
}

/**
 * Fetch PR ref from remote to get original commits
 */
function fetchPRRef(
  repoRoot: string,
  prNumber: number,
  options: SyncOptions,
): boolean {
  vlog(`Fetching refs/pull/${prNumber}/head...`, options);

  run(
    `git fetch origin refs/pull/${prNumber}/head:refs/remotes/origin/pr/${prNumber} 2>&1`,
    repoRoot,
  );

  // Check if fetch succeeded
  const refExists = run(
    `git rev-parse --verify refs/remotes/origin/pr/${prNumber} 2>/dev/null`,
    repoRoot,
  );

  return !!refExists;
}

/**
 * Get commits from a PR branch
 */
function getPRCommits(
  repoRoot: string,
  prNumber: number,
  baseSha: string,
): string[] {
  // Find merge base between PR head and the base
  const prRef = `refs/remotes/origin/pr/${prNumber}`;

  // Get commits that are in PR but not in base
  const output = run(`git rev-list ${baseSha}..${prRef} 2>/dev/null`, repoRoot);

  if (!output) return [];
  return output.split("\n").filter(Boolean);
}

/**
 * Read attribution note from a commit
 */
function readNote(repoRoot: string, sha: string): GitNotesAttribution | null {
  const note = run(`git notes --ref=refs/notes/agentblame show ${sha} 2>/dev/null`, repoRoot);
  if (!note) return null;
  try {
    return JSON.parse(note);
  } catch {
    return null;
  }
}

/**
 * Write attribution note to a commit
 */
function writeNote(
  repoRoot: string,
  sha: string,
  attribution: GitNotesAttribution,
): boolean {
  const noteJson = JSON.stringify(attribution);
  try {
    // Use spawnSync with array args to avoid shell injection
    const result = spawnSync(
      "git",
      ["notes", "--ref=refs/notes/agentblame", "add", "-f", "-m", noteJson, sha],
      { encoding: "utf8", cwd: repoRoot },
    );
    if (result.status !== 0) {
      console.error(`Failed to write note to ${sha}: ${result.stderr}`);
      return false;
    }
    return true;
  } catch (err) {
    console.error(`Failed to write note to ${sha}: ${err}`);
    return false;
  }
}

/**
 * Get diff hunks from a commit
 */
function getCommitHunks(
  repoRoot: string,
  sha: string,
): Array<{
  path: string;
  startLine: number;
  content: string;
  contentHash: string;
}> {
  const diff = run(`git diff-tree -p ${sha}`, repoRoot);
  if (!diff) return [];

  const hunks: Array<{
    path: string;
    startLine: number;
    content: string;
    contentHash: string;
  }> = [];

  let currentFile = "";
  let lineNumber = 0;
  let addedLines: string[] = [];
  let startLine = 0;

  const computeHash = (content: string): string => {
    const crypto = require("node:crypto");
    return `sha256:${crypto.createHash("sha256").update(content).digest("hex")}`;
  };

  for (const line of diff.split("\n")) {
    if (line.startsWith("+++ b/")) {
      if (addedLines.length > 0 && currentFile) {
        const content = addedLines.join("\n");
        hunks.push({
          path: currentFile,
          startLine,
          content,
          contentHash: computeHash(content),
        });
        addedLines = [];
      }
      currentFile = line.slice(6);
      continue;
    }

    if (line.startsWith("@@")) {
      if (addedLines.length > 0 && currentFile) {
        const content = addedLines.join("\n");
        hunks.push({
          path: currentFile,
          startLine,
          content,
          contentHash: computeHash(content),
        });
        addedLines = [];
      }

      const match = line.match(/@@ -\d+(?:,\d+)? \+(\d+)/);
      if (match) {
        lineNumber = parseInt(match[1], 10);
        startLine = lineNumber;
      }
      continue;
    }

    if (line.startsWith("+") && !line.startsWith("+++")) {
      if (addedLines.length === 0) {
        startLine = lineNumber;
      }
      addedLines.push(line.slice(1));
      lineNumber++;
      continue;
    }

    if (!line.startsWith("-")) {
      if (addedLines.length > 0 && currentFile) {
        const content = addedLines.join("\n");
        hunks.push({
          path: currentFile,
          startLine,
          content,
          contentHash: computeHash(content),
        });
        addedLines = [];
      }
      lineNumber++;
    }
  }

  if (addedLines.length > 0 && currentFile) {
    const content = addedLines.join("\n");
    hunks.push({
      path: currentFile,
      startLine,
      content,
      contentHash: computeHash(content),
    });
  }

  return hunks;
}

/**
 * Collect attributions from PR commits with original content
 */
function collectPRAttributions(
  repoRoot: string,
  prCommits: string[],
): {
  byHash: Map<string, NoteAttribution[]>;
  withContent: Array<NoteAttribution & { originalContent: string }>;
} {
  const byHash = new Map<string, NoteAttribution[]>();
  const withContent: Array<NoteAttribution & { originalContent: string }> = [];

  for (const sha of prCommits) {
    const note = readNote(repoRoot, sha);
    if (!note?.attributions) continue;

    const hunks = getCommitHunks(repoRoot, sha);
    const hunksByHash = new Map<string, string>();
    for (const hunk of hunks) {
      hunksByHash.set(hunk.contentHash, hunk.content);
    }

    for (const attr of note.attributions) {
      const hash = attr.contentHash;
      if (!byHash.has(hash)) {
        byHash.set(hash, []);
      }
      byHash.get(hash)?.push(attr);

      const content = hunksByHash.get(hash) || "";
      if (content) {
        withContent.push({ ...attr, originalContent: content });
      }
    }
  }

  return { byHash, withContent };
}

/**
 * Find contained attributions with precise line numbers
 */
function findContainedAttributions(
  hunk: { path: string; startLine: number; content: string },
  attributions: Array<NoteAttribution & { originalContent: string }>,
): NoteAttribution[] {
  const results: NoteAttribution[] = [];

  for (const attr of attributions) {
    const attrFileName = attr.path.split("/").pop();
    const hunkFileName = hunk.path.split("/").pop();
    const sameFile =
      attrFileName === hunkFileName ||
      attr.path.endsWith(hunk.path) ||
      hunk.path.endsWith(attrFileName || "");

    if (!sameFile) continue;

    const aiContent = attr.originalContent.trim();
    const hunkContent = hunk.content;

    if (!hunkContent.includes(aiContent)) continue;

    const offset = hunkContent.indexOf(aiContent);
    let startLine = hunk.startLine;

    if (offset > 0) {
      const contentBeforeAI = hunkContent.slice(0, offset);
      const linesBeforeAI = contentBeforeAI.split("\n").length - 1;
      startLine = hunk.startLine + linesBeforeAI;
    }

    const aiLineCount = aiContent.split("\n").length;
    const endLine = startLine + aiLineCount - 1;

    const { originalContent: _, ...cleanAttr } = attr;
    results.push({
      ...cleanAttr,
      path: hunk.path,
      startLine: startLine,
      endLine: endLine,
    });
  }

  return results;
}

/**
 * Transfer notes for a single merge candidate
 */
function transferNotes(
  repoRoot: string,
  candidate: MergeCandidate,
  prCommits: string[],
  options: SyncOptions,
): number {
  const { byHash, withContent } = collectPRAttributions(repoRoot, prCommits);

  if (byHash.size === 0) {
    vlog(`No attributions found in PR commits`, options);
    return 0;
  }

  vlog(`Found ${byHash.size} unique content hashes`, options);

  const hunks = getCommitHunks(repoRoot, candidate.sha);
  vlog(`Merge commit has ${hunks.length} hunks`, options);

  const newAttributions: NoteAttribution[] = [];
  const matchedHashes = new Set<string>();

  for (const hunk of hunks) {
    // Try exact hash match
    const attrs = byHash.get(hunk.contentHash);
    if (attrs && attrs.length > 0) {
      const attr = attrs[0];
      newAttributions.push({
        ...attr,
        path: hunk.path,
        startLine: hunk.startLine,
        endLine: hunk.startLine + hunk.content.split("\n").length - 1,
      });
      matchedHashes.add(attr.contentHash);
      vlog(`  Exact match: ${hunk.path}:${hunk.startLine}`, options);
      continue;
    }

    // Fallback: containment matching
    const unmatchedAttrs = withContent.filter(
      (a) => !matchedHashes.has(a.contentHash),
    );
    const containedMatches = findContainedAttributions(hunk, unmatchedAttrs);

    for (const match of containedMatches) {
      newAttributions.push(match);
      matchedHashes.add(match.contentHash);
      vlog(
        `  Contained match: ${match.path}:${match.startLine}-${match.endLine}`,
        options,
      );
    }
  }

  if (newAttributions.length === 0) {
    return 0;
  }

  if (options.dryRun) {
    console.log(`  Would attach ${newAttributions.length} attribution(s)`);
    return newAttributions.length;
  }

  const note: GitNotesAttribution = {
    version: 2,
    timestamp: new Date().toISOString(),
    attributions: newAttributions,
  };

  if (writeNote(repoRoot, candidate.sha, note)) {
    return newAttributions.length;
  }

  return 0;
}

/**
 * Find the base commit (parent of merge commit)
 */
function findBaseSha(repoRoot: string, mergeSha: string): string {
  const parent = run(`git rev-parse ${mergeSha}^`, repoRoot);
  return parent || "";
}

/**
 * Push notes to remote
 */
function pushNotes(repoRoot: string, options: SyncOptions): boolean {
  if (options.dryRun) {
    console.log("\nWould push notes to origin");
    return true;
  }

  console.log("\nPushing notes to origin...");
  try {
    execSync("git push origin refs/notes/agentblame", {
      encoding: "utf8",
      cwd: repoRoot,
      stdio: "inherit",
    });
    return true;
  } catch {
    console.error("Failed to push notes");
    return false;
  }
}

/**
 * Main sync function
 */
export async function sync(options: SyncOptions = {}): Promise<void> {
  const repoRoot = await getRepoRoot(process.cwd());

  if (!repoRoot) {
    console.error("Error: Not in a git repository");
    process.exit(1);
  }

  console.log("Agent Blame Sync - Transferring attribution notes\n");

  if (options.dryRun) {
    console.log("[DRY RUN - no changes will be made]\n");
  }

  // Fetch latest notes from remote (silent, ignores errors)
  await fetchNotesQuiet(repoRoot, "origin", options.verbose);

  // Find merge candidates
  const candidates = findMergeCandidates(repoRoot, options);

  if (candidates.length === 0) {
    console.log("No squash/rebase merges found that need notes transferred.");
    console.log(
      "(Looking for commits with PR numbers like '#123' that don't have notes)",
    );
    return;
  }

  console.log(`Found ${candidates.length} merge(s) that may need notes:\n`);

  let totalTransferred = 0;
  let successCount = 0;

  for (const candidate of candidates) {
    console.log(
      `PR #${candidate.prNumber}: ${candidate.message.slice(0, 50)}...`,
    );
    console.log(`  Commit: ${candidate.sha.slice(0, 7)}`);

    // Fetch PR ref
    if (!fetchPRRef(repoRoot, candidate.prNumber, options)) {
      console.log(`  Skipped: Could not fetch PR #${candidate.prNumber} refs`);
      continue;
    }

    // Find base and get PR commits
    const baseSha = findBaseSha(repoRoot, candidate.sha);
    if (!baseSha) {
      console.log(`  Skipped: Could not find base commit`);
      continue;
    }

    const prCommits = getPRCommits(repoRoot, candidate.prNumber, baseSha);
    if (prCommits.length === 0) {
      console.log(`  Skipped: No PR commits found`);
      continue;
    }

    vlog(`Found ${prCommits.length} PR commits`, options);

    // Transfer notes
    const transferred = transferNotes(repoRoot, candidate, prCommits, options);

    if (transferred > 0) {
      console.log(`  Transferred ${transferred} attribution(s)`);
      totalTransferred += transferred;
      successCount++;
    } else {
      console.log(`  No attributions to transfer`);
    }

    console.log("");
  }

  // Summary
  if (totalTransferred > 0) {
    console.log(
      `\nSummary: Transferred ${totalTransferred} attribution(s) for ${successCount} merge(s)`,
    );

    // Push notes
    pushNotes(repoRoot, options);
  } else {
    console.log("\nNo attributions were transferred.");
  }
}
