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
import type {
  GitNotesAttribution,
  AnalyticsNote,
  PRHistoryEntry,
  ProviderBreakdown,
  ModelBreakdown,
  ContributorStats,
  AiProvider,
} from "./lib";

// Get environment variables
const PR_NUMBER = process.env.PR_NUMBER || "";
const PR_TITLE = process.env.PR_TITLE || "";
const BASE_SHA = process.env.BASE_SHA || "";
const HEAD_SHA = process.env.HEAD_SHA || "";
const MERGE_SHA = process.env.MERGE_SHA || "";
const PR_AUTHOR = process.env.PR_AUTHOR || "unknown";

// Analytics notes ref (separate from attribution notes)
const ANALYTICS_REF = "refs/notes/agentblame-analytics";
// We store analytics on the repo's first commit (root)
const ANALYTICS_ANCHOR = "agentblame-analytics-anchor";

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
 *
 * The contentHash in attributions is the hash of the FIRST line in the range.
 * We need to find that line in the commit's diff to extract the full content.
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

    // Get the commit's diff with per-line hashes
    const hunks = getCommitHunks(sha);

    // Build a map from per-line contentHash to line data
    // Also build a map from path+lineNumber to content for range extraction
    const linesByHash = new Map<string, { path: string; lineNumber: number; content: string }>();
    const linesByLocation = new Map<string, string>();

    for (const hunk of hunks) {
      for (const line of hunk.lines) {
        linesByHash.set(line.contentHash, {
          path: hunk.path,
          lineNumber: line.lineNumber,
          content: line.content,
        });
        linesByLocation.set(`${hunk.path}:${line.lineNumber}`, line.content);
      }
    }

    for (const attr of note.attributions) {
      const hash = attr.contentHash;
      if (!byHash.has(hash)) {
        byHash.set(hash, []);
      }
      byHash.get(hash)?.push(attr);

      // Extract the full content for this attribution range
      // The contentHash is for the first line; we need to get all lines in the range
      const rangeLines: string[] = [];
      for (let lineNum = attr.startLine; lineNum <= attr.endLine; lineNum++) {
        const lineContent = linesByLocation.get(`${attr.path}:${lineNum}`);
        if (lineContent !== undefined) {
          rangeLines.push(lineContent);
        }
      }

      if (rangeLines.length > 0) {
        withContent.push({ ...attr, originalContent: rangeLines.join("\n") });
      } else {
        // Fallback: try to find by hash (first line)
        const lineData = linesByHash.get(hash);
        if (lineData) {
          withContent.push({ ...attr, originalContent: lineData.content });
        }
      }
    }
  }

  return { byHash, withContent };
}

/**
 * Line-level data from a diff
 */
interface DiffLine {
  lineNumber: number;
  content: string;
  contentHash: string;
}

/**
 * Hunk with line-level data
 */
interface DiffHunk {
  path: string;
  startLine: number;
  endLine: number;
  content: string;
  contentHash: string;
  lines: DiffLine[];
}

/**
 * Get the diff of a commit and extract content with per-line hashes
 * This matches the behavior of lib/git/gitDiff.ts parseDiff()
 */
function getCommitHunks(sha: string): DiffHunk[] {
  const diff = run(`git diff-tree -p ${sha}`);
  if (!diff) return [];

  const hunks: DiffHunk[] = [];

  let currentFile = "";
  let lineNumber = 0;
  let hunkLines: DiffLine[] = [];
  let startLine = 0;

  for (const line of diff.split("\n")) {
    // New file header
    if (line.startsWith("+++ b/")) {
      // Save previous hunk
      if (hunkLines.length > 0 && currentFile) {
        const content = hunkLines.map((l) => l.content).join("\n");
        hunks.push({
          path: currentFile,
          startLine,
          endLine: startLine + hunkLines.length - 1,
          content,
          contentHash: computeHash(content),
          lines: hunkLines,
        });
        hunkLines = [];
      }
      currentFile = line.slice(6);
      continue;
    }

    // Hunk header
    if (line.startsWith("@@")) {
      // Save previous hunk
      if (hunkLines.length > 0 && currentFile) {
        const content = hunkLines.map((l) => l.content).join("\n");
        hunks.push({
          path: currentFile,
          startLine,
          endLine: startLine + hunkLines.length - 1,
          content,
          contentHash: computeHash(content),
          lines: hunkLines,
        });
        hunkLines = [];
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
      if (hunkLines.length === 0) {
        startLine = lineNumber;
      }
      const content = line.slice(1);
      hunkLines.push({
        lineNumber,
        content,
        contentHash: computeHash(content),
      });
      lineNumber++;
      continue;
    }

    // Context or removed line
    if (!line.startsWith("-")) {
      // Save previous hunk if we hit a non-added line
      if (hunkLines.length > 0 && currentFile) {
        const content = hunkLines.map((l) => l.content).join("\n");
        hunks.push({
          path: currentFile,
          startLine,
          endLine: startLine + hunkLines.length - 1,
          content,
          contentHash: computeHash(content),
          lines: hunkLines,
        });
        hunkLines = [];
      }
      lineNumber++;
    }
  }

  // Save last hunk
  if (hunkLines.length > 0 && currentFile) {
    const content = hunkLines.map((l) => l.content).join("\n");
    hunks.push({
      path: currentFile,
      startLine,
      endLine: startLine + hunkLines.length - 1,
      content,
      contentHash: computeHash(content),
      lines: hunkLines,
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
      startLine: startLine,
      endLine: endLine,
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

  // Get hunks from the squash commit (with per-line hashes)
  const hunks = getCommitHunks(MERGE_SHA);
  log(`Squash commit has ${hunks.length} hunks`);

  // Build a map of per-line hashes in the squash commit
  const squashLinesByHash = new Map<string, { path: string; lineNumber: number; content: string }>();
  for (const hunk of hunks) {
    for (const line of hunk.lines) {
      squashLinesByHash.set(line.contentHash, {
        path: hunk.path,
        lineNumber: line.lineNumber,
        content: line.content,
      });
    }
  }

  // Match attributions to squash commit
  const newAttributions: NoteAttribution[] = [];
  const matchedContentHashes = new Set<string>();

  // First pass: exact line hash matches
  for (const [hash, attrs] of byHash) {
    const squashLine = squashLinesByHash.get(hash);
    if (squashLine && attrs.length > 0) {
      const attr = attrs[0];
      // For now, create single-line attribution
      // TODO: could try to find consecutive matched lines and merge them
      newAttributions.push({
        ...attr,
        path: squashLine.path,
        startLine: squashLine.lineNumber,
        endLine: squashLine.lineNumber,
      });
      matchedContentHashes.add(hash);
      log(
        `  Line hash match: ${squashLine.path}:${squashLine.lineNumber} (${attr.provider})`,
      );
    }
  }

  // Second pass: containment matching for multi-line attributions
  for (const hunk of hunks) {
    const unmatchedAttrs = withContent.filter(
      (a) => !matchedContentHashes.has(a.contentHash),
    );
    if (unmatchedAttrs.length === 0) continue;

    const containedMatches = findContainedAttributions(hunk, unmatchedAttrs);
    for (const match of containedMatches) {
      newAttributions.push(match);
      matchedContentHashes.add(match.contentHash);
    }
  }

  if (newAttributions.length === 0) {
    log("No attributions matched to squash commit");
    return;
  }

  // Merge consecutive attributions with same provider
  const mergedAttributions = mergeConsecutiveAttributions(newAttributions);

  // Write note to squash commit
  const note: GitNotesAttribution = {
    version: 2,
    timestamp: new Date().toISOString(),
    attributions: mergedAttributions,
  };

  if (writeNote(MERGE_SHA, note)) {
    log(`✓ Attached ${mergedAttributions.length} attribution(s) to squash commit`);
  }
}

/**
 * Merge consecutive attributions with the same provider into ranges
 */
function mergeConsecutiveAttributions(attrs: NoteAttribution[]): NoteAttribution[] {
  if (attrs.length === 0) return [];

  // Sort by path, then by startLine
  const sorted = [...attrs].sort((a, b) => {
    if (a.path !== b.path) return a.path.localeCompare(b.path);
    return a.startLine - b.startLine;
  });

  const merged: NoteAttribution[] = [];
  let current = { ...sorted[0] };

  for (let i = 1; i < sorted.length; i++) {
    const next = sorted[i];
    // Check if consecutive and same provider
    if (
      current.path === next.path &&
      current.endLine >= next.startLine - 1 &&
      current.provider === next.provider
    ) {
      // Merge: extend the range
      current.endLine = Math.max(current.endLine, next.endLine);
      current.confidence = Math.min(current.confidence, next.confidence);
    } else {
      merged.push(current);
      current = { ...next };
    }
  }
  merged.push(current);

  return merged;
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

    // Build a map of per-line hashes for this commit
    const linesByHash = new Map<string, { path: string; lineNumber: number }>();
    for (const hunk of hunks) {
      for (const line of hunk.lines) {
        linesByHash.set(line.contentHash, {
          path: hunk.path,
          lineNumber: line.lineNumber,
        });
      }
    }

    // First pass: exact line hash matches
    for (const [hash, attrs] of byHash) {
      const lineInfo = linesByHash.get(hash);
      if (lineInfo && attrs.length > 0) {
        const attr = attrs[0];
        newAttributions.push({
          ...attr,
          path: lineInfo.path,
          startLine: lineInfo.lineNumber,
          endLine: lineInfo.lineNumber,
        });
        matchedContentHashes.add(hash);
      }
    }

    // Second pass: containment matching
    for (const hunk of hunks) {
      const unmatchedAttrs = withContent.filter(
        (a) => !matchedContentHashes.has(a.contentHash),
      );
      if (unmatchedAttrs.length === 0) continue;

      const containedMatches = findContainedAttributions(hunk, unmatchedAttrs);
      for (const match of containedMatches) {
        newAttributions.push(match);
        matchedContentHashes.add(match.contentHash);
      }
    }

    if (newAttributions.length > 0) {
      // Merge consecutive attributions
      const merged = mergeConsecutiveAttributions(newAttributions);
      const note: GitNotesAttribution = {
        version: 2,
        timestamp: new Date().toISOString(),
        attributions: merged,
      };
      if (writeNote(newSha, note)) {
        log(
          `  ✓ ${newSha.slice(0, 7)}: ${merged.length} attribution(s)`,
        );
        totalTransferred += merged.length;
      }
    }
  }

  log(
    `✓ Transferred ${totalTransferred} attribution(s) across ${newCommits.length} commits`,
  );
}

// =============================================================================
// Analytics Aggregation
// =============================================================================

/**
 * Get the root commit SHA (first commit in repo)
 */
function getRootCommit(): string {
  return run("git rev-list --max-parents=0 HEAD").split("\n")[0] || "";
}

/**
 * Get or create the analytics anchor tag
 * Returns the SHA the tag points to (root commit)
 */
function getOrCreateAnalyticsAnchor(): string {
  // Check if tag exists
  const existingTag = run(`git rev-parse ${ANALYTICS_ANCHOR} 2>/dev/null`);
  if (existingTag) {
    return existingTag;
  }

  // Create tag on root commit
  const rootSha = getRootCommit();
  if (!rootSha) {
    log("Warning: Could not find root commit for analytics anchor");
    return "";
  }

  const result = spawnSync(
    "git",
    ["tag", ANALYTICS_ANCHOR, rootSha],
    { encoding: "utf8" },
  );

  if (result.status !== 0) {
    log(`Warning: Could not create analytics anchor tag: ${result.stderr}`);
    return "";
  }

  log(`Created analytics anchor tag at ${rootSha.slice(0, 7)}`);
  return rootSha;
}

/**
 * Read existing analytics note
 */
function readAnalyticsNote(): AnalyticsNote | null {
  const anchorSha = getOrCreateAnalyticsAnchor();
  if (!anchorSha) return null;

  const note = run(
    `git notes --ref=${ANALYTICS_REF} show ${anchorSha} 2>/dev/null`,
  );
  if (!note) return null;

  try {
    const parsed = JSON.parse(note);
    if (parsed.version === 2) {
      return parsed as AnalyticsNote;
    }
    return null;
  } catch {
    return null;
  }
}

/**
 * Write analytics note
 */
function writeAnalyticsNote(analytics: AnalyticsNote): boolean {
  const anchorSha = getOrCreateAnalyticsAnchor();
  if (!anchorSha) return false;

  const noteJson = JSON.stringify(analytics);
  const result = spawnSync(
    "git",
    ["notes", `--ref=${ANALYTICS_REF}`, "add", "-f", "-m", noteJson, anchorSha],
    { encoding: "utf8" },
  );

  if (result.status !== 0) {
    log(`Failed to write analytics note: ${result.stderr}`);
    return false;
  }

  return true;
}

/**
 * Get PR diff stats (additions/deletions)
 * Only counts non-empty lines to match how attributions are counted
 */
function getPRDiffStats(): { additions: number; deletions: number } {
  const diff = run(`git diff ${BASE_SHA}..${MERGE_SHA || "HEAD"}`);
  if (!diff) return { additions: 0, deletions: 0 };

  let additions = 0;
  let deletions = 0;

  for (const line of diff.split("\n")) {
    // Added line (but not diff header)
    if (line.startsWith("+") && !line.startsWith("+++")) {
      const content = line.slice(1).trim();
      if (content !== "") {
        additions++;
      }
    }
    // Deleted line (but not diff header)
    else if (line.startsWith("-") && !line.startsWith("---")) {
      const content = line.slice(1).trim();
      if (content !== "") {
        deletions++;
      }
    }
  }

  return { additions, deletions };
}

/**
 * Aggregate PR statistics from attribution notes
 */
function aggregatePRStats(
  attributions: NoteAttribution[],
): {
  aiLines: number;
  byProvider: ProviderBreakdown;
  byModel: ModelBreakdown;
} {
  let aiLines = 0;
  const byProvider: ProviderBreakdown = {};
  const byModel: ModelBreakdown = {};

  for (const attr of attributions) {
    const lineCount = attr.endLine - attr.startLine + 1;
    aiLines += lineCount;

    // Aggregate by provider
    const provider = attr.provider as AiProvider;
    byProvider[provider] = (byProvider[provider] || 0) + lineCount;

    // Aggregate by model
    if (attr.model) {
      byModel[attr.model] = (byModel[attr.model] || 0) + lineCount;
    }
  }

  return { aiLines, byProvider, byModel };
}

/**
 * Merge provider breakdowns
 */
function mergeProviders(
  a: ProviderBreakdown,
  b: ProviderBreakdown,
): ProviderBreakdown {
  const result: ProviderBreakdown = { ...a };
  for (const [key, value] of Object.entries(b)) {
    const k = key as keyof ProviderBreakdown;
    result[k] = (result[k] || 0) + (value || 0);
  }
  return result;
}

/**
 * Merge model breakdowns
 */
function mergeModels(a: ModelBreakdown, b: ModelBreakdown): ModelBreakdown {
  const result: ModelBreakdown = { ...a };
  for (const [key, value] of Object.entries(b)) {
    result[key] = (result[key] || 0) + value;
  }
  return result;
}

/**
 * Update analytics with current PR data
 */
function updateAnalytics(
  existing: AnalyticsNote | null,
  prAttributions: NoteAttribution[],
): AnalyticsNote {
  const prStats = aggregatePRStats(prAttributions);
  const diffStats = getPRDiffStats();
  const now = new Date().toISOString();
  const today = now.split("T")[0];

  // Create history entry for this PR
  const historyEntry: PRHistoryEntry = {
    date: today,
    pr: parseInt(PR_NUMBER, 10) || 0,
    title: PR_TITLE.slice(0, 100), // Truncate long titles
    author: PR_AUTHOR,
    added: diffStats.additions,
    removed: diffStats.deletions,
    aiLines: prStats.aiLines,
    providers: Object.keys(prStats.byProvider).length > 0 ? prStats.byProvider : undefined,
    models: Object.keys(prStats.byModel).length > 0 ? prStats.byModel : undefined,
  };

  if (existing) {
    // Update existing analytics
    const newSummary = {
      totalLines: existing.summary.totalLines + diffStats.additions,
      aiLines: existing.summary.aiLines + prStats.aiLines,
      humanLines:
        existing.summary.humanLines +
        (diffStats.additions - prStats.aiLines),
      providers: mergeProviders(
        existing.summary.providers,
        prStats.byProvider,
      ),
      models: mergeModels(existing.summary.models, prStats.byModel),
      updated: now,
    };

    // Update contributor stats
    const contributors = { ...existing.contributors };
    if (!contributors[PR_AUTHOR]) {
      contributors[PR_AUTHOR] = {
        totalLines: 0,
        aiLines: 0,
        providers: {},
        models: {},
        prCount: 0,
      };
    }
    const authorStats = contributors[PR_AUTHOR];
    authorStats.totalLines += diffStats.additions;
    authorStats.aiLines += prStats.aiLines;
    authorStats.providers = mergeProviders(
      authorStats.providers,
      prStats.byProvider,
    );
    authorStats.models = mergeModels(authorStats.models, prStats.byModel);
    authorStats.prCount += 1;

    // Add to history (keep last 100 PRs)
    const history = [historyEntry, ...existing.history].slice(0, 100);

    return {
      version: 2,
      summary: newSummary,
      contributors,
      history,
    };
  }

  // Create new analytics
  const contributors: Record<string, ContributorStats> = {
    [PR_AUTHOR]: {
      totalLines: diffStats.additions,
      aiLines: prStats.aiLines,
      providers: prStats.byProvider,
      models: prStats.byModel,
      prCount: 1,
    },
  };

  return {
    version: 2,
    summary: {
      totalLines: diffStats.additions,
      aiLines: prStats.aiLines,
      humanLines: diffStats.additions - prStats.aiLines,
      providers: prStats.byProvider,
      models: prStats.byModel,
      updated: now,
    },
    contributors,
    history: [historyEntry],
  };
}

/**
 * Collect all attributions from the merge result
 */
function collectMergeAttributions(mergeType: MergeType): NoteAttribution[] {
  if (mergeType === "merge_commit") {
    // For merge commits, notes survive on original commits
    // Collect from all PR commits
    const prCommits = getPRCommits();
    const allAttributions: NoteAttribution[] = [];
    for (const sha of prCommits) {
      const note = readNote(sha);
      if (note?.attributions) {
        allAttributions.push(...note.attributions);
      }
    }
    return allAttributions;
  }

  // For squash/rebase, read from the merge commit(s)
  if (mergeType === "squash" && MERGE_SHA) {
    const note = readNote(MERGE_SHA);
    return note?.attributions || [];
  }

  if (mergeType === "rebase") {
    // Collect from all new commits after rebase
    const newCommits = run(`git rev-list ${BASE_SHA}..HEAD`)
      .split("\n")
      .filter(Boolean);
    const allAttributions: NoteAttribution[] = [];
    for (const sha of newCommits) {
      const note = readNote(sha);
      if (note?.attributions) {
        allAttributions.push(...note.attributions);
      }
    }
    return allAttributions;
  }

  return [];
}

/**
 * Update repository analytics after PR merge
 */
function updateRepositoryAnalytics(mergeType: MergeType): void {
  log("Updating repository analytics...");

  // Collect all attributions from this PR
  const attributions = collectMergeAttributions(mergeType);
  log(`Collected ${attributions.length} attributions from PR`);

  // Read existing analytics
  const existing = readAnalyticsNote();
  if (existing) {
    log(
      `Found existing analytics: ${existing.history.length} PRs, ${existing.summary.totalLines} total lines`,
    );
  } else {
    log("No existing analytics found, creating new");
  }

  // Update analytics
  const updated = updateAnalytics(existing, attributions);

  // Write updated analytics
  if (writeAnalyticsNote(updated)) {
    log(
      `✓ Updated analytics: ${updated.summary.aiLines}/${updated.summary.totalLines} AI lines (${Math.round((updated.summary.aiLines / updated.summary.totalLines) * 100)}%)`,
    );
  }
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
    log("Merge commit detected - notes survive automatically on original commits");
    // Still update analytics for merge commits
    updateRepositoryAnalytics(mergeType);
    log("Done");
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

  // Update repository analytics (runs for all merge types)
  updateRepositoryAnalytics(mergeType);

  log("Done");
}

main().catch((err) => {
  console.error("[agentblame] Error:", err);
  process.exit(1);
});
