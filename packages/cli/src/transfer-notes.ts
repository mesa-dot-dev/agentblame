#!/usr/bin/env bun
/**
 * Agent Blame - Transfer Notes Action
 *
 * Transfers git notes from PR commits to merge/squash/rebase commits.
 * Runs as part of GitHub Actions workflow after PR merge.
 *
 * Environment variables (set by GitHub Actions):
 *   PR_NUMBER   - The PR number
 *   PR_TITLE    - The PR title
 *   BASE_REF    - Target branch (e.g., main)
 *   BASE_SHA    - Base commit SHA before merge
 *   HEAD_SHA    - Last commit SHA on feature branch
 *   MERGE_SHA   - The merge commit SHA (for merge/squash)
 */

import { execSync, spawnSync } from "node:child_process";
import type { GitNotesAttribution } from "./lib";

// Get environment variables
const PR_NUMBER = process.env.PR_NUMBER || "";
const PR_TITLE = process.env.PR_TITLE || "";
const BASE_SHA = process.env.BASE_SHA || "";
const HEAD_SHA = process.env.HEAD_SHA || "";
const MERGE_SHA = process.env.MERGE_SHA || "";

type MergeType = "merge_commit" | "squash" | "rebase";

type NoteAttribution = GitNotesAttribution["attributions"][number];

function run(cmd: string): string {
  try {
    return execSync(cmd, { encoding: "utf8" }).trim();
  } catch {
    return "";
  }
}

function log(msg: string): void {
  console.log(`[agentblame] ${msg}`);
}

/**
 * Detect what type of merge was performed
 */
function detectMergeType(): MergeType {
  // Get the merge commit
  const mergeCommit = MERGE_SHA;
  if (!mergeCommit) {
    log("No merge commit SHA, assuming rebase");
    return "rebase";
  }

  // Check number of parents
  const parents = run(`git rev-list --parents -n 1 ${mergeCommit}`).split(" ");
  const parentCount = parents.length - 1; // First element is the commit itself

  if (parentCount > 1) {
    // Multiple parents = merge commit
    log("Detected: Merge commit (multiple parents)");
    return "merge_commit";
  }

  // Single parent - could be squash or rebase
  // Check if commit message contains PR number (squash pattern)
  const commitMsg = run(`git log -1 --format=%s ${mergeCommit}`);
  if (commitMsg.includes(`#${PR_NUMBER}`) || commitMsg.includes(PR_TITLE)) {
    log("Detected: Squash merge (single commit with PR reference)");
    return "squash";
  }

  log("Detected: Rebase merge");
  return "rebase";
}

/**
 * Get all commits that were in the PR (between base and head)
 */
function getPRCommits(): string[] {
  // Get commits that were in the feature branch but not in base
  const output = run(`git rev-list ${BASE_SHA}..${HEAD_SHA}`);
  if (!output) return [];
  return output.split("\n").filter(Boolean);
}

/**
 * Read agentblame note from a commit
 */
function readNote(sha: string): GitNotesAttribution | null {
  const note = run(`git notes --ref=refs/notes/agentblame show ${sha} 2>/dev/null`);
  if (!note) return null;
  try {
    return JSON.parse(note);
  } catch {
    return null;
  }
}

/**
 * Write agentblame note to a commit
 */
function writeNote(sha: string, attribution: GitNotesAttribution): boolean {
  const noteJson = JSON.stringify(attribution);
  try {
    // Use spawnSync with array args to avoid shell injection
    const result = spawnSync(
      "git",
      ["notes", "--ref=refs/notes/agentblame", "add", "-f", "-m", noteJson, sha],
      { encoding: "utf8" },
    );
    if (result.status !== 0) {
      log(`Failed to write note to ${sha}: ${result.stderr}`);
      return false;
    }
    return true;
  } catch (err) {
    log(`Failed to write note to ${sha}: ${err}`);
    return false;
  }
}

/**
 * Attribution with its original content for containment matching
 */
interface AttributionWithContent extends NoteAttribution {
  originalContent: string;
}

/**
 * Collect all attributions from PR commits, including original content
 */
function collectPRAttributions(prCommits: string[]): {
  byHash: Map<string, NoteAttribution[]>;
  withContent: AttributionWithContent[];
} {
  const byHash = new Map<string, NoteAttribution[]>();
  const withContent: AttributionWithContent[] = [];

  for (const sha of prCommits) {
    const note = readNote(sha);
    if (!note?.attributions) continue;

    // Get the commit's diff to extract original content
    const hunks = getCommitHunks(sha);
    const hunksByHash = new Map<string, string>();
    for (const hunk of hunks) {
      hunksByHash.set(hunk.contentHash, hunk.content);
    }

    for (const attr of note.attributions) {
      const hash = attr.content_hash;
      if (!byHash.has(hash)) {
        byHash.set(hash, []);
      }
      byHash.get(hash)?.push(attr);

      // Store with original content for containment matching
      const content = hunksByHash.get(hash) || "";
      if (content) {
        withContent.push({ ...attr, originalContent: content });
      }
    }
  }

  return { byHash, withContent };
}

/**
 * Get the diff of a commit and extract content hashes
 */
function getCommitHunks(sha: string): Array<{
  path: string;
  startLine: number;
  endLine: number;
  content: string;
  contentHash: string;
}> {
  const diff = run(`git diff-tree -p ${sha}`);
  if (!diff) return [];

  const hunks: Array<{
    path: string;
    startLine: number;
    endLine: number;
    content: string;
    contentHash: string;
  }> = [];

  let currentFile = "";
  let lineNumber = 0;
  let addedLines: string[] = [];
  let startLine = 0;

  for (const line of diff.split("\n")) {
    // New file header
    if (line.startsWith("+++ b/")) {
      // Save previous hunk
      if (addedLines.length > 0 && currentFile) {
        const content = addedLines.join("\n");
        const hash = computeHash(content);
        hunks.push({
          path: currentFile,
          startLine,
          endLine: startLine + addedLines.length - 1,
          content,
          contentHash: hash,
        });
        addedLines = [];
      }
      currentFile = line.slice(6);
      continue;
    }

    // Hunk header
    if (line.startsWith("@@")) {
      // Save previous hunk
      if (addedLines.length > 0 && currentFile) {
        const content = addedLines.join("\n");
        const hash = computeHash(content);
        hunks.push({
          path: currentFile,
          startLine,
          endLine: startLine + addedLines.length - 1,
          content,
          contentHash: hash,
        });
        addedLines = [];
      }

      // Parse line number: @@ -old,count +new,count @@
      const match = line.match(/@@ -\d+(?:,\d+)? \+(\d+)/);
      if (match) {
        lineNumber = parseInt(match[1], 10);
        startLine = lineNumber;
      }
      continue;
    }

    // Added line
    if (line.startsWith("+") && !line.startsWith("+++")) {
      if (addedLines.length === 0) {
        startLine = lineNumber;
      }
      addedLines.push(line.slice(1));
      lineNumber++;
      continue;
    }

    // Context or removed line
    if (!line.startsWith("-")) {
      // Save previous hunk if we hit a non-added line
      if (addedLines.length > 0 && currentFile) {
        const content = addedLines.join("\n");
        const hash = computeHash(content);
        hunks.push({
          path: currentFile,
          startLine,
          endLine: startLine + addedLines.length - 1,
          content,
          contentHash: hash,
        });
        addedLines = [];
      }
      lineNumber++;
    }
  }

  // Save last hunk
  if (addedLines.length > 0 && currentFile) {
    const content = addedLines.join("\n");
    const hash = computeHash(content);
    hunks.push({
      path: currentFile,
      startLine,
      endLine: startLine + addedLines.length - 1,
      content,
      contentHash: hash,
    });
  }

  return hunks;
}

/**
 * Compute SHA256 hash of content
 */
function computeHash(content: string): string {
  const crypto = require("node:crypto");
  return `sha256:${crypto.createHash("sha256").update(content).digest("hex")}`;
}

/**
 * Find attributions whose content is contained within the hunk content
 * Returns attributions with calculated precise line numbers
 */
function findContainedAttributions(
  hunk: { path: string; startLine: number; content: string },
  attributions: AttributionWithContent[],
): NoteAttribution[] {
  const results: NoteAttribution[] = [];

  for (const attr of attributions) {
    // Check if file paths match
    const attrFileName = attr.path.split("/").pop();
    const hunkFileName = hunk.path.split("/").pop();
    const sameFile =
      attrFileName === hunkFileName ||
      attr.path.endsWith(hunk.path) ||
      hunk.path.endsWith(attrFileName || "");

    if (!sameFile) continue;

    // Check if AI content is contained in the hunk
    const aiContent = attr.originalContent.trim();
    const hunkContent = hunk.content;

    if (!hunkContent.includes(aiContent)) continue;

    // Calculate precise line numbers
    const offset = hunkContent.indexOf(aiContent);
    let startLine = hunk.startLine;

    if (offset > 0) {
      const contentBeforeAI = hunkContent.slice(0, offset);
      const linesBeforeAI = contentBeforeAI.split("\n").length - 1;
      startLine = hunk.startLine + linesBeforeAI;
    }

    const aiLineCount = aiContent.split("\n").length;
    const endLine = startLine + aiLineCount - 1;

    // Create clean attribution without originalContent
    const { originalContent: _, ...cleanAttr } = attr;
    results.push({
      ...cleanAttr,
      path: hunk.path,
      start_line: startLine,
      end_line: endLine,
    });

    log(
      `  Contained match: ${hunk.path}:${startLine}-${endLine} (${attr.provider})`,
    );
  }

  return results;
}

/**
 * Transfer notes for a squash merge
 */
function handleSquashMerge(prCommits: string[]): void {
  log(
    `Transferring notes from ${prCommits.length} PR commits to squash commit ${MERGE_SHA}`,
  );

  // Collect all attributions from PR commits
  const { byHash, withContent } = collectPRAttributions(prCommits);
  if (byHash.size === 0) {
    log("No attributions found in PR commits");
    return;
  }

  log(
    `Found ${byHash.size} unique content hashes, ${withContent.length} with content`,
  );

  // Get hunks from the squash commit
  const hunks = getCommitHunks(MERGE_SHA);
  log(`Squash commit has ${hunks.length} hunks`);

  // Match attributions to hunks
  const newAttributions: NoteAttribution[] = [];
  const matchedContentHashes = new Set<string>();

  for (const hunk of hunks) {
    // First try exact hash match
    const attrs = byHash.get(hunk.contentHash);
    if (attrs && attrs.length > 0) {
      const attr = attrs[0];
      newAttributions.push({
        ...attr,
        path: hunk.path,
        start_line: hunk.startLine,
        end_line: hunk.endLine,
      });
      matchedContentHashes.add(attr.content_hash);
      log(
        `  Exact match: ${hunk.path}:${hunk.startLine}-${hunk.endLine} (${attr.provider})`,
      );
      continue;
    }

    // Fallback: check if any AI content is contained within this hunk
    const unmatchedAttrs = withContent.filter(
      (a) => !matchedContentHashes.has(a.content_hash),
    );
    const containedMatches = findContainedAttributions(hunk, unmatchedAttrs);

    for (const match of containedMatches) {
      newAttributions.push(match);
      matchedContentHashes.add(match.content_hash);
    }
  }

  if (newAttributions.length === 0) {
    log("No attributions matched to squash commit");
    return;
  }

  // Write note to squash commit
  const note: GitNotesAttribution = {
    version: 1,
    timestamp: new Date().toISOString(),
    attributions: newAttributions,
  };

  if (writeNote(MERGE_SHA, note)) {
    log(`✓ Attached ${newAttributions.length} attribution(s) to squash commit`);
  }
}

/**
 * Transfer notes for a rebase merge
 */
function handleRebaseMerge(prCommits: string[]): void {
  log(`Handling rebase merge: ${prCommits.length} original commits`);

  // Collect all attributions from PR commits
  const { byHash, withContent } = collectPRAttributions(prCommits);
  if (byHash.size === 0) {
    log("No attributions found in PR commits");
    return;
  }

  // Find the new commits on target branch after the base
  const newCommits = run(`git rev-list ${BASE_SHA}..HEAD`)
    .split("\n")
    .filter(Boolean);
  log(`Found ${newCommits.length} new commits after rebase`);

  let totalTransferred = 0;

  for (const newSha of newCommits) {
    const hunks = getCommitHunks(newSha);
    const newAttributions: NoteAttribution[] = [];
    const matchedContentHashes = new Set<string>();

    for (const hunk of hunks) {
      // First try exact hash match
      const attrs = byHash.get(hunk.contentHash);
      if (attrs && attrs.length > 0) {
        const attr = attrs[0];
        newAttributions.push({
          ...attr,
          path: hunk.path,
          start_line: hunk.startLine,
          end_line: hunk.endLine,
        });
        matchedContentHashes.add(attr.content_hash);
        continue;
      }

      // Fallback: containment matching
      const unmatchedAttrs = withContent.filter(
        (a) => !matchedContentHashes.has(a.content_hash),
      );
      const containedMatches = findContainedAttributions(hunk, unmatchedAttrs);

      for (const match of containedMatches) {
        newAttributions.push(match);
        matchedContentHashes.add(match.content_hash);
      }
    }

    if (newAttributions.length > 0) {
      const note: GitNotesAttribution = {
        version: 1,
        timestamp: new Date().toISOString(),
        attributions: newAttributions,
      };
      if (writeNote(newSha, note)) {
        log(
          `  ✓ ${newSha.slice(0, 7)}: ${newAttributions.length} attribution(s)`,
        );
        totalTransferred += newAttributions.length;
      }
    }
  }

  log(
    `✓ Transferred ${totalTransferred} attribution(s) across ${newCommits.length} commits`,
  );
}

/**
 * Main entry point
 */
async function main(): Promise<void> {
  log("Agent Blame - Transfer Notes");
  log(`PR #${PR_NUMBER}: ${PR_TITLE}`);
  log(
    `Base: ${BASE_SHA.slice(0, 7)}, Head: ${HEAD_SHA.slice(0, 7)}, Merge: ${MERGE_SHA.slice(0, 7)}`,
  );

  // Detect merge type
  const mergeType = detectMergeType();

  if (mergeType === "merge_commit") {
    log("Merge commit detected - notes survive automatically, nothing to do");
    return;
  }

  // Get PR commits
  const prCommits = getPRCommits();
  if (prCommits.length === 0) {
    log("No PR commits found");
    return;
  }

  log(`Found ${prCommits.length} commits in PR`);

  if (mergeType === "squash") {
    handleSquashMerge(prCommits);
  } else if (mergeType === "rebase") {
    handleRebaseMerge(prCommits);
  }

  log("Done");
}

main().catch((err) => {
  console.error("[agentblame] Error:", err);
  process.exit(1);
});
