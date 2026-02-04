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
 *   MERGED_AT   - The PR merge timestamp (ISO 8601)
 */

import { execSync, spawnSync } from "node:child_process";
import { buildNote, parseNote } from "./lib/git/gitNotes";
import type {
  Attribution,
  SessionMetadata,
  AnalyticsNote,
  AgentBreakdown,
  ModelBreakdown,
} from "./lib/types";

// Get environment variables
const PR_NUMBER = process.env.PR_NUMBER || "";
const PR_TITLE = process.env.PR_TITLE || "";
const BASE_SHA = process.env.BASE_SHA || "";
const HEAD_SHA = process.env.HEAD_SHA || "";
const MERGE_SHA = process.env.MERGE_SHA || "";
const PR_AUTHOR = process.env.PR_AUTHOR || "unknown";
const MERGED_AT = process.env.MERGED_AT || "";

// Notes refs
const NOTES_REF = "refs/notes/agentblame";
const ANALYTICS_REF = "refs/notes/agentblame-analytics";
const ANALYTICS_ANCHOR = "agentblame-analytics-anchor";

type MergeType = "merge_commit" | "squash" | "rebase";

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
  const mergeCommit = MERGE_SHA;
  if (!mergeCommit) {
    log("No merge commit SHA, assuming rebase");
    return "rebase";
  }

  // Check number of parents
  const parents = run(`git rev-list --parents -n 1 ${mergeCommit}`).split(" ");
  const parentCount = parents.length - 1;

  if (parentCount > 1) {
    log("Detected: Merge commit (multiple parents)");
    return "merge_commit";
  }

  // Single parent - could be squash or rebase
  const commitMsg = run(`git log -1 --format=%s ${mergeCommit}`);
  if (commitMsg.includes(`#${PR_NUMBER}`) || commitMsg.includes(PR_TITLE)) {
    log("Detected: Squash merge (single commit with PR reference)");
    return "squash";
  }

  log("Detected: Rebase merge");
  return "rebase";
}

/**
 * Get all commits that were in the PR
 */
function getPRCommits(): string[] {
  const output = run(`git rev-list ${BASE_SHA}..${HEAD_SHA}`);
  if (!output) return [];
  return output.split("\n").filter(Boolean);
}

/**
 * Read attribution note from a commit (v3 format)
 */
function readNote(sha: string): Attribution | null {
  const note = run(`git notes --ref=${NOTES_REF} show ${sha} 2>/dev/null`);
  if (!note) return null;
  return parseNote(note);
}

/**
 * Write attribution note to a commit (v3 format)
 */
function writeNote(
  sha: string,
  attribution: Attribution,
  sessions: Record<string, SessionMetadata>
): boolean {
  const noteContent = buildNote(attribution, sessions);
  try {
    const result = spawnSync(
      "git",
      ["notes", `--ref=${NOTES_REF}`, "add", "-f", "-m", noteContent, sha],
      { encoding: "utf8" }
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
 * Get diff hunks from a commit
 */
function getCommitHunks(sha: string): Array<{
  path: string;
  startLine: number;
  endLine: number;
  lines: Array<{ lineNumber: number; content: string }>;
}> {
  const diff = run(`git diff-tree -p ${sha}`);
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
 * Collected data from PR commits
 */
interface PRAttributionData {
  sessions: Record<string, SessionMetadata>;
  fileRanges: Map<
    string,
    Map<string, Array<{ startLine: number; endLine: number; content: string[] }>>
  >;
}

/**
 * Collect attributions from PR commits
 */
function collectPRAttributions(prCommits: string[]): PRAttributionData {
  const allSessions: Record<string, SessionMetadata> = {};
  const fileRanges = new Map<
    string,
    Map<string, Array<{ startLine: number; endLine: number; content: string[] }>>
  >();

  for (const sha of prCommits) {
    const note = readNote(sha);
    if (!note) continue;

    // Collect sessions
    for (const [sessionId, session] of Object.entries(note.sessions)) {
      if (!allSessions[sessionId]) {
        allSessions[sessionId] = session;
      }
    }

    // Get content from the commit diff
    const hunks = getCommitHunks(sha);
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
 * Find where content appears in a merge commit
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
 * Match content and build attribution for a merge commit
 */
function buildMergeAttribution(
  mergeSha: string,
  prData: PRAttributionData
): { attribution: Attribution; matchCount: number } | null {
  const mergeHunks = getCommitHunks(mergeSha);

  // Build content index from merge commit
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

  const attribution: Attribution = {
    version: 3,
    timestamp: new Date().toISOString(),
    sessions: prData.sessions,
    files: {},
  };

  let matchCount = 0;

  for (const [filePath, sessionRanges] of prData.fileRanges) {
    // Try to find matching path
    let targetPath = filePath;
    if (!mergeContentIndex.has(filePath)) {
      const matchingPath = Array.from(mergeContentIndex.keys()).find(
        (p) => p.endsWith(filePath) || filePath.endsWith(p)
      );
      if (!matchingPath) continue;
      targetPath = matchingPath;
    }

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

        const matchedLines = findContentMatch(targetContent, range.content);

        if (matchedLines) {
          attribution.files[targetPath].aiRanges.push({
            sessionId,
            startLine: matchedLines.start,
            endLine: matchedLines.end,
          });
          matchCount++;
          log(`  Matched: ${targetPath}:${matchedLines.start}-${matchedLines.end}`);
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
 * Handle squash merge
 */
function handleSquashMerge(prCommits: string[]): void {
  log(`Transferring notes from ${prCommits.length} PR commits to squash commit ${MERGE_SHA}`);

  const prData = collectPRAttributions(prCommits);

  if (Object.keys(prData.sessions).length === 0) {
    log("No attributions found in PR commits");
    return;
  }

  log(`Found ${Object.keys(prData.sessions).length} sessions`);

  const result = buildMergeAttribution(MERGE_SHA, prData);

  if (!result) {
    log("No attributions matched to squash commit");
    return;
  }

  if (writeNote(MERGE_SHA, result.attribution, prData.sessions)) {
    log(`✓ Attached ${result.matchCount} attribution range(s) to squash commit`);
  }
}

/**
 * Handle rebase merge
 */
function handleRebaseMerge(prCommits: string[]): void {
  log(`Handling rebase merge: ${prCommits.length} original commits`);

  const prData = collectPRAttributions(prCommits);

  if (Object.keys(prData.sessions).length === 0) {
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
    const result = buildMergeAttribution(newSha, prData);

    if (result && result.matchCount > 0) {
      if (writeNote(newSha, result.attribution, prData.sessions)) {
        log(`  ✓ ${newSha.slice(0, 7)}: ${result.matchCount} range(s)`);
        totalTransferred += result.matchCount;
      }
    }
  }

  log(`✓ Transferred ${totalTransferred} range(s) across ${newCommits.length} commits`);
}

// =============================================================================
// Analytics
// =============================================================================

/**
 * Get the root commit SHA
 */
function getRootCommit(): string {
  return run("git rev-list --max-parents=0 HEAD").split("\n")[0] || "";
}

/**
 * Get or create the analytics anchor tag
 */
function getOrCreateAnalyticsAnchor(): string {
  const existingTag = run(`git rev-parse ${ANALYTICS_ANCHOR} 2>/dev/null`);
  if (existingTag) {
    return existingTag;
  }

  const rootSha = getRootCommit();
  if (!rootSha) {
    log("Warning: Could not find root commit for analytics anchor");
    return "";
  }

  const result = spawnSync("git", ["tag", ANALYTICS_ANCHOR, rootSha], {
    encoding: "utf8",
  });

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

  const note = run(`git notes --ref=${ANALYTICS_REF} show ${anchorSha} 2>/dev/null`);
  if (!note) return null;

  try {
    return JSON.parse(note) as AnalyticsNote;
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
    { encoding: "utf8" }
  );

  if (result.status !== 0) {
    log(`Failed to write analytics note: ${result.stderr}`);
    return false;
  }

  return true;
}

/**
 * Get PR diff stats
 */
function getPRDiffStats(): { additions: number; deletions: number } {
  const diff = run(`git diff ${BASE_SHA}..${MERGE_SHA || "HEAD"}`);
  if (!diff) return { additions: 0, deletions: 0 };

  let additions = 0;
  let deletions = 0;

  for (const line of diff.split("\n")) {
    if (line.startsWith("+") && !line.startsWith("+++")) {
      const content = line.slice(1).trim();
      if (content !== "") additions++;
    } else if (line.startsWith("-") && !line.startsWith("---")) {
      const content = line.slice(1).trim();
      if (content !== "") deletions++;
    }
  }

  return { additions, deletions };
}

/**
 * Compute stats from collected attributions
 */
function computePRStats(prData: PRAttributionData): {
  aiLines: number;
  prompts: number;
  byAgent: AgentBreakdown;
  byModel: ModelBreakdown;
} {
  let aiLines = 0;
  let prompts = 0;
  const byAgent: AgentBreakdown = {};
  const byModel: ModelBreakdown = {};
  const countedSessions = new Set<string>();

  for (const [_, sessionRanges] of prData.fileRanges) {
    for (const [sessionId, ranges] of sessionRanges) {
      const session = prData.sessions[sessionId];
      if (!session) continue;

      for (const range of ranges) {
        const lineCount = range.endLine - range.startLine + 1;
        aiLines += lineCount;

        // Agent breakdown
        const agent = session.agent;
        if (agent === "cursor" || agent === "claude" || agent === "opencode") {
          byAgent[agent] = (byAgent[agent] || 0) + lineCount;
        }

        // Model breakdown
        if (session.model) {
          byModel[session.model] = (byModel[session.model] || 0) + lineCount;
        }
      }

      // Count prompts from session metadata (only once per session)
      if (!countedSessions.has(sessionId) && session.prompts) {
        prompts += session.prompts.length;
        countedSessions.add(sessionId);
      }
    }
  }

  return { aiLines, prompts, byAgent, byModel };
}

/**
 * Merge agent breakdowns
 */
function mergeAgents(a: AgentBreakdown, b: AgentBreakdown): AgentBreakdown {
  const result: AgentBreakdown = { ...a };
  for (const [key, value] of Object.entries(b)) {
    const k = key as keyof AgentBreakdown;
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
 * Update analytics with PR data
 */
function updateAnalytics(
  existing: AnalyticsNote | null,
  prData: PRAttributionData,
  commitCount: number
): AnalyticsNote {
  const prStats = computePRStats(prData);
  const diffStats = getPRDiffStats();
  const now = MERGED_AT || new Date().toISOString();

  // Determine if this PR was tracked (has session data)
  const isTracked = Object.keys(prData.sessions).length > 0;

  // If tracked: we know AI vs Human
  // If untracked: all lines are unknown
  const aiLines = prStats.aiLines;
  const humanLines = isTracked ? diffStats.additions - prStats.aiLines : 0;
  const unknownLines = isTracked ? 0 : diffStats.additions;

  // Create PR entry
  const prEntry = {
    number: parseInt(PR_NUMBER, 10) || 0,
    title: PR_TITLE.slice(0, 100),
    author: PR_AUTHOR,
    aiLines,
    humanLines,
    unknownLines,
    prompts: prStats.prompts,
    commits: commitCount,
    mergedAt: now,
  };

  if (existing) {
    // Update existing
    existing.summary.aiLines += aiLines;
    existing.summary.humanLines += humanLines;
    existing.summary.unknownLines = (existing.summary.unknownLines || 0) + unknownLines;
    existing.summary.totalLines = existing.summary.aiLines + existing.summary.humanLines + existing.summary.unknownLines;
    existing.summary.prompts = (existing.summary.prompts || 0) + prStats.prompts;
    existing.summary.byAgent = mergeAgents(existing.summary.byAgent, prStats.byAgent);
    existing.summary.byModel = mergeModels(existing.summary.byModel, prStats.byModel);

    // Update contributor
    if (!existing.contributors[PR_AUTHOR]) {
      existing.contributors[PR_AUTHOR] = {
        commits: 0,
        prs: 0,
        prompts: 0,
        aiLines: 0,
        humanLines: 0,
        unknownLines: 0,
        topModels: [],
      };
    }
    const contributor = existing.contributors[PR_AUTHOR];
    contributor.commits += 1;
    contributor.prs = (contributor.prs || 0) + 1;
    contributor.prompts = (contributor.prompts || 0) + prStats.prompts;
    contributor.aiLines += aiLines;
    contributor.humanLines += humanLines;
    contributor.unknownLines = (contributor.unknownLines || 0) + unknownLines;

    // Update top models
    const modelCounts = new Map<string, number>();
    for (const model of contributor.topModels) {
      modelCounts.set(model, (modelCounts.get(model) || 0) + 1);
    }
    for (const [model, count] of Object.entries(prStats.byModel)) {
      modelCounts.set(model, (modelCounts.get(model) || 0) + count);
    }
    contributor.topModels = Array.from(modelCounts.entries())
      .sort((a, b) => b[1] - a[1])
      .slice(0, 3)
      .map(([model]) => model);

    // Add PR to recent list
    if (!existing.recentPRs) {
      existing.recentPRs = [];
    }
    existing.recentPRs.unshift(prEntry);
    if (existing.recentPRs.length > 100) {
      existing.recentPRs = existing.recentPRs.slice(0, 100);
    }

    // Update time series
    const hour = now.slice(0, 13); // YYYY-MM-DDTHH
    const date = now.slice(0, 10); // YYYY-MM-DD

    if (!existing.timeSeries) {
      existing.timeSeries = { hourly: [], daily: [] };
    }

    // Update or add hourly data point
    const existingHourly = existing.timeSeries.hourly.find(h => h.hour === hour);
    if (existingHourly) {
      existingHourly.aiLines += aiLines;
      existingHourly.humanLines += humanLines;
      existingHourly.unknownLines = (existingHourly.unknownLines || 0) + unknownLines;
      existingHourly.prompts = (existingHourly.prompts || 0) + prStats.prompts;
      existingHourly.commits += 1;
      for (const [agent, count] of Object.entries(prStats.byAgent)) {
        if (count !== undefined) {
          existingHourly.byAgent[agent] = (existingHourly.byAgent[agent] || 0) + count;
        }
      }
      for (const [model, count] of Object.entries(prStats.byModel)) {
        if (count !== undefined) {
          existingHourly.byModel[model] = (existingHourly.byModel[model] || 0) + count;
        }
      }
    } else {
      existing.timeSeries.hourly.unshift({
        hour,
        aiLines,
        humanLines,
        unknownLines,
        prompts: prStats.prompts,
        byAgent: { ...prStats.byAgent },
        byModel: { ...prStats.byModel },
        commits: 1,
      });
      // Keep only last 72 hours
      if (existing.timeSeries.hourly.length > 72) {
        existing.timeSeries.hourly = existing.timeSeries.hourly.slice(0, 72);
      }
    }

    // Update or add daily data point
    const existingDaily = existing.timeSeries.daily.find(d => d.date === date);
    if (existingDaily) {
      existingDaily.aiLines += aiLines;
      existingDaily.humanLines += humanLines;
      existingDaily.unknownLines = (existingDaily.unknownLines || 0) + unknownLines;
      existingDaily.prompts = (existingDaily.prompts || 0) + prStats.prompts;
      existingDaily.commits += 1;
      for (const [agent, count] of Object.entries(prStats.byAgent)) {
        if (count !== undefined) {
          existingDaily.byAgent[agent] = (existingDaily.byAgent[agent] || 0) + count;
        }
      }
      for (const [model, count] of Object.entries(prStats.byModel)) {
        if (count !== undefined) {
          existingDaily.byModel[model] = (existingDaily.byModel[model] || 0) + count;
        }
      }
    } else {
      existing.timeSeries.daily.unshift({
        date,
        aiLines,
        humanLines,
        unknownLines,
        prompts: prStats.prompts,
        byAgent: { ...prStats.byAgent },
        byModel: { ...prStats.byModel },
        commits: 1,
      });
      // Keep only last 30 days
      if (existing.timeSeries.daily.length > 30) {
        existing.timeSeries.daily = existing.timeSeries.daily.slice(0, 30);
      }
    }

    existing.updated = now;
    return existing;
  }

  // Create time series data point
  const hour = now.slice(0, 13); // YYYY-MM-DDTHH
  const date = now.slice(0, 10); // YYYY-MM-DD

  const hourlyDataPoint = {
    hour,
    aiLines,
    humanLines,
    unknownLines,
    prompts: prStats.prompts,
    byAgent: prStats.byAgent,
    byModel: prStats.byModel,
    commits: 1,
  };

  const dailyDataPoint = {
    date,
    aiLines,
    humanLines,
    unknownLines,
    prompts: prStats.prompts,
    byAgent: prStats.byAgent,
    byModel: prStats.byModel,
    commits: 1,
  };

  // Create new analytics
  return {
    v: 3,
    updated: now,
    summary: {
      totalLines: diffStats.additions,
      aiLines,
      humanLines,
      unknownLines,
      prompts: prStats.prompts,
      byAgent: prStats.byAgent,
      byModel: prStats.byModel,
    },
    contributors: {
      [PR_AUTHOR]: {
        commits: 1,
        prs: 1,
        prompts: prStats.prompts,
        aiLines,
        humanLines,
        unknownLines,
        topModels: Object.keys(prStats.byModel).slice(0, 3),
      },
    },
    recentPRs: [prEntry],
    timeSeries: {
      hourly: [hourlyDataPoint],
      daily: [dailyDataPoint],
    },
  };
}

/**
 * Collect attributions from merge result
 */
function collectMergeAttributions(mergeType: MergeType): PRAttributionData {
  if (mergeType === "merge_commit") {
    // For merge commits, notes survive on original commits
    const prCommits = getPRCommits();
    return collectPRAttributions(prCommits);
  }

  if (mergeType === "squash" && MERGE_SHA) {
    const note = readNote(MERGE_SHA);
    if (!note) {
      return { sessions: {}, fileRanges: new Map() };
    }

    // Convert note back to PRAttributionData format
    const fileRanges = new Map<
      string,
      Map<string, Array<{ startLine: number; endLine: number; content: string[] }>>
    >();

    for (const [filePath, fileAttr] of Object.entries(note.files)) {
      const sessionMap = new Map<
        string,
        Array<{ startLine: number; endLine: number; content: string[] }>
      >();

      for (const range of fileAttr.aiRanges) {
        if (!sessionMap.has(range.sessionId)) {
          sessionMap.set(range.sessionId, []);
        }
        sessionMap.get(range.sessionId)!.push({
          startLine: range.startLine,
          endLine: range.endLine,
          content: [], // Content not needed for analytics
        });
      }

      fileRanges.set(filePath, sessionMap);
    }

    return { sessions: note.sessions, fileRanges };
  }

  if (mergeType === "rebase") {
    // Collect from all new commits after rebase
    const newCommits = run(`git rev-list ${BASE_SHA}..HEAD`)
      .split("\n")
      .filter(Boolean);

    const allSessions: Record<string, SessionMetadata> = {};
    const fileRanges = new Map<
      string,
      Map<string, Array<{ startLine: number; endLine: number; content: string[] }>>
    >();

    for (const sha of newCommits) {
      const note = readNote(sha);
      if (!note) continue;

      // Merge sessions
      for (const [sessionId, session] of Object.entries(note.sessions)) {
        if (!allSessions[sessionId]) {
          allSessions[sessionId] = session;
        }
      }

      // Merge file ranges
      for (const [filePath, fileAttr] of Object.entries(note.files)) {
        if (!fileRanges.has(filePath)) {
          fileRanges.set(filePath, new Map());
        }
        const sessionMap = fileRanges.get(filePath)!;

        for (const range of fileAttr.aiRanges) {
          if (!sessionMap.has(range.sessionId)) {
            sessionMap.set(range.sessionId, []);
          }
          sessionMap.get(range.sessionId)!.push({
            startLine: range.startLine,
            endLine: range.endLine,
            content: [],
          });
        }
      }
    }

    return { sessions: allSessions, fileRanges };
  }

  return { sessions: {}, fileRanges: new Map() };
}

/**
 * Update repository analytics after PR merge
 */
function updateRepositoryAnalytics(mergeType: MergeType): void {
  log("Updating repository analytics...");

  const prData = collectMergeAttributions(mergeType);
  log(`Collected ${Object.keys(prData.sessions).length} sessions from PR`);

  const commitCount = getPRCommits().length;

  let existing = readAnalyticsNote();

  // Check if existing analytics is v2 format (incompatible) - if so, start fresh
  if (existing && (!existing.v || existing.v < 3)) {
    log("Found v2 analytics, migrating to v3 format...");
    existing = null; // Start fresh with v3
  }

  if (existing) {
    const prCount = existing.recentPRs?.length || 0;
    log(`Found existing analytics: ${prCount} PRs, ${existing.summary?.totalLines || 0} total lines`);
  } else {
    log("No existing analytics found, creating new");
  }

  const updated = updateAnalytics(existing, prData, commitCount);

  if (writeAnalyticsNote(updated)) {
    const pct = updated.summary.totalLines > 0
      ? Math.round((updated.summary.aiLines / updated.summary.totalLines) * 100)
      : 0;
    log(`✓ Updated analytics: ${updated.summary.aiLines}/${updated.summary.totalLines} AI lines (${pct}%)`);
  }
}

/**
 * Main entry point
 */
async function main(): Promise<void> {
  log("Agent Blame - Transfer Notes");
  log(`PR #${PR_NUMBER}: ${PR_TITLE}`);
  log(`Base: ${BASE_SHA.slice(0, 7)}, Head: ${HEAD_SHA.slice(0, 7)}, Merge: ${MERGE_SHA.slice(0, 7)}`);

  // Detect merge type
  const mergeType = detectMergeType();

  if (mergeType === "merge_commit") {
    log("Merge commit detected - notes survive automatically on original commits");
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

  // Update repository analytics
  updateRepositoryAnalytics(mergeType);

  log("Done");
}

main().catch((err) => {
  console.error("[agentblame] Error:", err);
  process.exit(1);
});
