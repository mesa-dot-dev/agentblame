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
  buildNote,
  parseNote,
} from "./lib";
import type { Attribution, SessionMetadata } from "./lib/types";

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
  options: SyncOptions
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
      repoRoot
    );
    if (hasNote) {
      vlog(`Skipping ${sha.slice(0, 7)} - already has note`, options);
      continue;
    }

    // Check if it's a single-parent commit (squash or rebase, not merge)
    const parents = run(`git rev-list --parents -n 1 ${sha}`, repoRoot).split(
      " "
    );
    if (parents.length > 2) {
      vlog(
        `Skipping ${sha.slice(0, 7)} - merge commit (has multiple parents)`,
        options
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
  options: SyncOptions
): boolean {
  vlog(`Fetching refs/pull/${prNumber}/head...`, options);

  run(
    `git fetch origin refs/pull/${prNumber}/head:refs/remotes/origin/pr/${prNumber} 2>&1`,
    repoRoot
  );

  // Check if fetch succeeded
  const refExists = run(
    `git rev-parse --verify refs/remotes/origin/pr/${prNumber} 2>/dev/null`,
    repoRoot
  );

  return !!refExists;
}

/**
 * Get commits from a PR branch
 */
function getPRCommits(
  repoRoot: string,
  prNumber: number,
  baseSha: string
): string[] {
  const prRef = `refs/remotes/origin/pr/${prNumber}`;

  // Get commits that are in PR but not in base
  const output = run(`git rev-list ${baseSha}..${prRef} 2>/dev/null`, repoRoot);

  if (!output) return [];
  return output.split("\n").filter(Boolean);
}

/**
 * Read attribution note from a commit (v3 format)
 */
function readNoteFromCommit(repoRoot: string, sha: string): Attribution | null {
  const note = run(
    `git notes --ref=refs/notes/agentblame show ${sha} 2>/dev/null`,
    repoRoot
  );
  if (!note) return null;
  return parseNote(note);
}

/**
 * Write attribution note to a commit (v3 format)
 */
function writeNoteToCommit(
  repoRoot: string,
  sha: string,
  attribution: Attribution,
  sessions: Record<string, SessionMetadata>
): boolean {
  const noteContent = buildNote(attribution, sessions);
  try {
    const result = spawnSync(
      "git",
      ["notes", "--ref=refs/notes/agentblame", "add", "-f", "-m", noteContent, sha],
      { encoding: "utf8", cwd: repoRoot }
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
 * Get diff hunks from a commit with content
 */
function getCommitHunks(
  repoRoot: string,
  sha: string
): Array<{
  path: string;
  startLine: number;
  endLine: number;
  lines: Array<{ lineNumber: number; content: string }>;
}> {
  const diff = run(`git diff-tree -p ${sha}`, repoRoot);
  if (!diff) return [];

  const hunks: Array<{
    path: string;
    startLine: number;
    endLine: number;
    lines: Array<{ lineNumber: number; content: string }>;
  }> = [];

  let currentFile = "";
  let lineNumber = 0;
  let hunkLines: Array<{ lineNumber: number; content: string }> = [];
  let startLine = 0;

  for (const line of diff.split("\n")) {
    if (line.startsWith("+++ b/")) {
      if (hunkLines.length > 0 && currentFile) {
        hunks.push({
          path: currentFile,
          startLine,
          endLine: startLine + hunkLines.length - 1,
          lines: hunkLines,
        });
        hunkLines = [];
      }
      currentFile = line.slice(6);
      continue;
    }

    if (line.startsWith("@@")) {
      if (hunkLines.length > 0 && currentFile) {
        hunks.push({
          path: currentFile,
          startLine,
          endLine: startLine + hunkLines.length - 1,
          lines: hunkLines,
        });
        hunkLines = [];
      }

      const match = line.match(/@@ -\d+(?:,\d+)? \+(\d+)/);
      if (match) {
        lineNumber = parseInt(match[1], 10);
        startLine = lineNumber;
      }
      continue;
    }

    if (line.startsWith("+") && !line.startsWith("+++")) {
      if (hunkLines.length === 0) {
        startLine = lineNumber;
      }
      hunkLines.push({
        lineNumber,
        content: line.slice(1),
      });
      lineNumber++;
      continue;
    }

    if (!line.startsWith("-")) {
      if (hunkLines.length > 0 && currentFile) {
        hunks.push({
          path: currentFile,
          startLine,
          endLine: startLine + hunkLines.length - 1,
          lines: hunkLines,
        });
        hunkLines = [];
      }
      lineNumber++;
    }
  }

  if (hunkLines.length > 0 && currentFile) {
    hunks.push({
      path: currentFile,
      startLine,
      endLine: startLine + hunkLines.length - 1,
      lines: hunkLines,
    });
  }

  return hunks;
}

/**
 * Collect attributions from PR commits (v3 format)
 */
function collectPRAttributions(
  repoRoot: string,
  prCommits: string[]
): {
  sessions: Record<string, SessionMetadata>;
  fileRanges: Map<string, Map<string, Array<{ startLine: number; endLine: number; content: string[] }>>>;
} {
  const allSessions: Record<string, SessionMetadata> = {};
  // Map: filePath -> sessionId -> ranges with content
  const fileRanges = new Map<
    string,
    Map<string, Array<{ startLine: number; endLine: number; content: string[] }>>
  >();

  for (const sha of prCommits) {
    const note = readNoteFromCommit(repoRoot, sha);
    if (!note) continue;

    // Collect sessions
    for (const [sessionId, session] of Object.entries(note.sessions)) {
      if (!allSessions[sessionId]) {
        allSessions[sessionId] = session;
      }
    }

    // Get content from the commit diff
    const hunks = getCommitHunks(repoRoot, sha);
    const hunksByPath = new Map<string, typeof hunks>();
    for (const hunk of hunks) {
      if (!hunksByPath.has(hunk.path)) {
        hunksByPath.set(hunk.path, []);
      }
      hunksByPath.get(hunk.path)!.push(hunk);
    }

    // Collect file ranges with content
    for (const [filePath, fileAttr] of Object.entries(note.files)) {
      if (!fileRanges.has(filePath)) {
        fileRanges.set(filePath, new Map());
      }
      const sessionMap = fileRanges.get(filePath)!;

      for (const range of fileAttr.aiRanges) {
        if (!sessionMap.has(range.sessionId)) {
          sessionMap.set(range.sessionId, []);
        }

        // Find content for this range from hunks
        const fileHunks = hunksByPath.get(filePath) || [];
        const content: string[] = [];

        for (const hunk of fileHunks) {
          for (const line of hunk.lines) {
            if (line.lineNumber >= range.startLine && line.lineNumber <= range.endLine) {
              content.push(line.content);
            }
          }
        }

        sessionMap.get(range.sessionId)!.push({
          startLine: range.startLine,
          endLine: range.endLine,
          content,
        });
      }
    }
  }

  return { sessions: allSessions, fileRanges };
}

/**
 * Match content from PR to squash commit and build attribution
 */
function matchAndBuildAttribution(
  repoRoot: string,
  mergeSha: string,
  prData: ReturnType<typeof collectPRAttributions>,
  options: SyncOptions
): { attribution: Attribution; matchCount: number } | null {
  const mergeHunks = getCommitHunks(repoRoot, mergeSha);

  // Build content index from merge commit: path -> lineNumber -> content
  const mergeContentIndex = new Map<string, Map<number, string>>();
  for (const hunk of mergeHunks) {
    if (!mergeContentIndex.has(hunk.path)) {
      mergeContentIndex.set(hunk.path, new Map());
    }
    const lineMap = mergeContentIndex.get(hunk.path)!;
    for (const line of hunk.lines) {
      lineMap.set(line.lineNumber, line.content);
    }
  }

  // Build new attribution
  const attribution: Attribution = {
    version: 3,
    timestamp: new Date().toISOString(),
    sessions: prData.sessions,
    files: {},
  };

  let matchCount = 0;

  // For each file with AI ranges, try to find content in merge commit
  for (const [filePath, sessionRanges] of prData.fileRanges) {
    const mergeFileContent = mergeContentIndex.get(filePath);
    if (!mergeFileContent) {
      // Try to find file with different path format
      const matchingPath = Array.from(mergeContentIndex.keys()).find(
        (p) => p.endsWith(filePath) || filePath.endsWith(p)
      );
      if (!matchingPath) continue;
    }

    const targetPath = mergeContentIndex.has(filePath)
      ? filePath
      : Array.from(mergeContentIndex.keys()).find(
          (p) => p.endsWith(filePath) || filePath.endsWith(p)
        );

    if (!targetPath) continue;

    const targetContent = mergeContentIndex.get(targetPath)!;

    if (!attribution.files[targetPath]) {
      attribution.files[targetPath] = {
        aiRanges: [],
        humanRanges: [],
      };
    }

    for (const [sessionId, ranges] of sessionRanges) {
      for (const range of ranges) {
        if (range.content.length === 0) continue;

        // Try to find this content in the merge commit
        const matchedLines = findContentMatch(targetContent, range.content);

        if (matchedLines) {
          attribution.files[targetPath].aiRanges.push({
            sessionId,
            startLine: matchedLines.start,
            endLine: matchedLines.end,
          });
          matchCount++;
          vlog(
            `  Matched: ${targetPath}:${matchedLines.start}-${matchedLines.end} (${sessionId.slice(0, 8)})`,
            options
          );
        }
      }
    }
  }

  if (matchCount === 0) {
    return null;
  }

  return { attribution, matchCount };
}

/**
 * Find where content appears in the merge commit
 */
function findContentMatch(
  lineMap: Map<number, string>,
  content: string[]
): { start: number; end: number } | null {
  if (content.length === 0) return null;

  const firstLine = content[0];
  const lineNumbers = Array.from(lineMap.entries())
    .filter(([_, c]) => c === firstLine)
    .map(([n]) => n);

  for (const startLine of lineNumbers) {
    let matches = true;
    for (let i = 0; i < content.length; i++) {
      const lineContent = lineMap.get(startLine + i);
      if (lineContent !== content[i]) {
        matches = false;
        break;
      }
    }

    if (matches) {
      return { start: startLine, end: startLine + content.length - 1 };
    }
  }

  return null;
}

/**
 * Transfer notes for a single merge candidate
 */
function transferNotes(
  repoRoot: string,
  candidate: MergeCandidate,
  prCommits: string[],
  options: SyncOptions
): number {
  const prData = collectPRAttributions(repoRoot, prCommits);

  if (Object.keys(prData.sessions).length === 0) {
    vlog(`No attributions found in PR commits`, options);
    return 0;
  }

  vlog(
    `Found ${Object.keys(prData.sessions).length} sessions in PR commits`,
    options
  );

  const result = matchAndBuildAttribution(repoRoot, candidate.sha, prData, options);

  if (!result) {
    vlog(`No attributions matched to squash commit`, options);
    return 0;
  }

  if (options.dryRun) {
    console.log(`  Would attach ${result.matchCount} attribution range(s)`);
    return result.matchCount;
  }

  if (writeNoteToCommit(repoRoot, candidate.sha, result.attribution, prData.sessions)) {
    return result.matchCount;
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

  // Fetch latest notes from remote
  await fetchNotesQuiet(repoRoot, "origin", options.verbose);

  // Find merge candidates
  const candidates = findMergeCandidates(repoRoot, options);

  if (candidates.length === 0) {
    console.log("No squash/rebase merges found that need notes transferred.");
    console.log(
      "(Looking for commits with PR numbers like '#123' that don't have notes)"
    );
    return;
  }

  console.log(`Found ${candidates.length} merge(s) that may need notes:\n`);

  let totalTransferred = 0;
  let successCount = 0;

  for (const candidate of candidates) {
    console.log(
      `PR #${candidate.prNumber}: ${candidate.message.slice(0, 50)}...`
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
      console.log(`  Transferred ${transferred} attribution range(s)`);
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
      `\nSummary: Transferred ${totalTransferred} range(s) for ${successCount} merge(s)`
    );

    // Push notes
    pushNotes(repoRoot, options);
  } else {
    console.log("\nNo attributions were transferred.");
  }
}
