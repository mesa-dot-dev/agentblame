/**
 * Analytics Module v3
 *
 * Manages repository-wide analytics stored as a git note on the root commit.
 * Provides aggregated stats and time-series data for trending.
 *
 * Storage: refs/notes/agentblame-analytics (attached to root commit)
 */

import { spawn } from "node:child_process";
import { getRootCommit } from "./storage";
import type {
  AnalyticsNote,
  AnalyticsSummary,
  ContributorStats,
  PREntry,
  AgentBreakdown,
  ModelBreakdown,
  SessionMetadata,
  AiAgent,
  HourlyDataPoint,
  DailyDataPoint,
  TimeSeries,
} from "./types";

// =============================================================================
// Constants
// =============================================================================

const ANALYTICS_REF = "refs/notes/agentblame-analytics";
const MAX_HOURLY_POINTS = 72; // Keep 72 hours (for 24h and 3d views)
const MAX_DAILY_POINTS = 30; // Keep 30 days (for 1w and 1m views)

// =============================================================================
// Date Helpers
// =============================================================================

/**
 * Get current hour in YYYY-MM-DDTHH format
 */
function getCurrentHour(): string {
  const now = new Date();
  return now.toISOString().slice(0, 13); // "2026-01-29T14"
}

/**
 * Get today's date in YYYY-MM-DD format
 */
function getToday(): string {
  return new Date().toISOString().split("T")[0];
}

// =============================================================================
// Analytics Note Read/Write
// =============================================================================

/**
 * Get the analytics anchor commit (root commit)
 */
export async function getAnalyticsAnchor(
  repoRoot: string
): Promise<string | null> {
  return getRootCommit(repoRoot);
}

/**
 * Read the analytics note
 */
export async function readAnalyticsNote(
  repoRoot: string
): Promise<AnalyticsNote | null> {
  const anchor = await getAnalyticsAnchor(repoRoot);
  if (!anchor) return null;

  return new Promise((resolve) => {
    const proc = spawn("git", ["notes", "--ref", ANALYTICS_REF, "show", anchor], {
      cwd: repoRoot,
      stdio: ["ignore", "pipe", "pipe"],
    });

    let stdout = "";

    proc.stdout.on("data", (data) => {
      stdout += data.toString();
    });

    proc.on("close", (code) => {
      if (code === 0 && stdout.trim()) {
        try {
          const note = JSON.parse(stdout);
          resolve(note as AnalyticsNote);
        } catch {
          resolve(null);
        }
      } else {
        resolve(null);
      }
    });

    proc.on("error", () => {
      resolve(null);
    });
  });
}

/**
 * Write the analytics note
 */
export async function writeAnalyticsNote(
  repoRoot: string,
  analytics: AnalyticsNote
): Promise<boolean> {
  const anchor = await getAnalyticsAnchor(repoRoot);
  if (!anchor) return false;

  const content = JSON.stringify(analytics, null, 2);

  return new Promise((resolve) => {
    const proc = spawn(
      "git",
      ["notes", "--ref", ANALYTICS_REF, "add", "-f", "-m", content, anchor],
      {
        cwd: repoRoot,
        stdio: ["ignore", "ignore", "pipe"],
      }
    );

    proc.on("close", (code) => {
      resolve(code === 0);
    });

    proc.on("error", () => {
      resolve(false);
    });
  });
}

// =============================================================================
// Analytics Computation
// =============================================================================

/**
 * Stats for a single commit
 */
export interface CommitStats {
  aiLines: number;
  humanLines: number;
  byAgent: AgentBreakdown;
  byModel: ModelBreakdown;
  sessions: string[];
}

/**
 * Compute stats from a commit's attribution
 */
export function computeCommitStats(
  sessions: Record<string, SessionMetadata>,
  fileAttributions: Record<
    string,
    {
      aiRanges: Array<{
        sessionId: string;
        startLine: number;
        endLine: number;
      }>;
      humanRanges: Array<{ startLine: number; endLine: number }>;
    }
  >
): CommitStats {
  const stats: CommitStats = {
    aiLines: 0,
    humanLines: 0,
    byAgent: {},
    byModel: {},
    sessions: [],
  };

  const sessionIds = new Set<string>();

  for (const file of Object.values(fileAttributions)) {
    for (const range of file.aiRanges) {
      const lineCount = range.endLine - range.startLine + 1;
      stats.aiLines += lineCount;

      const session = sessions[range.sessionId];
      if (session) {
        sessionIds.add(range.sessionId);

        const agent = session.agent;
        if (agent === "cursor" || agent === "claude" || agent === "opencode") {
          stats.byAgent[agent] = (stats.byAgent[agent] || 0) + lineCount;
        }

        if (session.model) {
          stats.byModel[session.model] = (stats.byModel[session.model] || 0) + lineCount;
        }
      }
    }

    for (const range of file.humanRanges) {
      stats.humanLines += range.endLine - range.startLine + 1;
    }
  }

  stats.sessions = Array.from(sessionIds);

  return stats;
}

// =============================================================================
// Time-Series Management
// =============================================================================

/**
 * Create empty time-series data
 */
function createEmptyTimeSeries(): TimeSeries {
  return {
    hourly: [],
    daily: [],
  };
}

/**
 * Merge agent breakdowns
 */
function mergeAgentBreakdown(a: AgentBreakdown, b: AgentBreakdown): AgentBreakdown {
  const result: AgentBreakdown = { ...a };
  for (const [agent, count] of Object.entries(b)) {
    if (count !== undefined) {
      const key = agent as AiAgent;
      result[key] = (result[key] || 0) + count;
    }
  }
  return result;
}

/**
 * Merge model breakdowns
 */
function mergeModelBreakdown(a: ModelBreakdown, b: ModelBreakdown): ModelBreakdown {
  const result: ModelBreakdown = { ...a };
  for (const [model, count] of Object.entries(b)) {
    result[model] = (result[model] || 0) + count;
  }
  return result;
}

/**
 * Update hourly time-series with new commit stats
 */
function updateHourlyTimeSeries(
  hourly: HourlyDataPoint[],
  commitStats: CommitStats,
  hour: string
): HourlyDataPoint[] {
  // Find or create this hour's entry
  let hourEntry = hourly.find((h) => h.hour === hour);

  if (!hourEntry) {
    hourEntry = {
      hour,
      aiLines: 0,
      humanLines: 0,
      unknownLines: 0,
      prompts: 0,
      byAgent: {},
      byModel: {},
      commits: 0,
    };
    hourly.push(hourEntry);
  }

  // Update hour's entry
  hourEntry.aiLines += commitStats.aiLines;
  hourEntry.humanLines += commitStats.humanLines;
  hourEntry.byAgent = mergeAgentBreakdown(hourEntry.byAgent, commitStats.byAgent);
  hourEntry.byModel = mergeModelBreakdown(hourEntry.byModel, commitStats.byModel);
  hourEntry.commits += 1;

  // Sort by hour descending (most recent first)
  hourly.sort((a, b) => b.hour.localeCompare(a.hour));

  // Keep only last N hours
  return hourly.slice(0, MAX_HOURLY_POINTS);
}

/**
 * Update daily time-series with new commit stats
 */
function updateDailyTimeSeries(
  daily: DailyDataPoint[],
  commitStats: CommitStats,
  date: string
): DailyDataPoint[] {
  // Find or create today's entry
  let todayEntry = daily.find((d) => d.date === date);

  if (!todayEntry) {
    todayEntry = {
      date,
      aiLines: 0,
      humanLines: 0,
      unknownLines: 0,
      prompts: 0,
      byAgent: {},
      byModel: {},
      commits: 0,
    };
    daily.push(todayEntry);
  }

  // Update today's entry
  todayEntry.aiLines += commitStats.aiLines;
  todayEntry.humanLines += commitStats.humanLines;
  todayEntry.byAgent = mergeAgentBreakdown(todayEntry.byAgent, commitStats.byAgent);
  todayEntry.byModel = mergeModelBreakdown(todayEntry.byModel, commitStats.byModel);
  todayEntry.commits += 1;

  // Sort by date descending (most recent first)
  daily.sort((a, b) => b.date.localeCompare(a.date));

  // Keep only last N days
  return daily.slice(0, MAX_DAILY_POINTS);
}

/**
 * Update time-series data with new commit stats
 */
function updateTimeSeries(
  timeSeries: TimeSeries | undefined,
  commitStats: CommitStats
): TimeSeries {
  const ts = timeSeries || createEmptyTimeSeries();
  const hour = getCurrentHour();
  const today = getToday();

  return {
    hourly: updateHourlyTimeSeries([...ts.hourly], commitStats, hour),
    daily: updateDailyTimeSeries([...ts.daily], commitStats, today),
  };
}

// =============================================================================
// Merge Analytics
// =============================================================================

/**
 * Merge commit stats into existing analytics
 */
export function mergeAnalytics(
  existing: AnalyticsNote | null,
  commitStats: CommitStats,
  commitAuthor?: string
): AnalyticsNote {
  const base: AnalyticsNote = existing || {
    v: 3,
    updated: new Date().toISOString(),
    summary: {
      totalLines: 0,
      aiLines: 0,
      humanLines: 0,
      unknownLines: 0,
      prompts: 0,
      byAgent: {},
      byModel: {},
    },
    contributors: {},
    recentPRs: [],
    timeSeries: createEmptyTimeSeries(),
  };

  // Update summary
  base.summary.aiLines += commitStats.aiLines;
  base.summary.humanLines += commitStats.humanLines;
  base.summary.totalLines = base.summary.aiLines + base.summary.humanLines;

  // Merge agent breakdown
  for (const [agent, count] of Object.entries(commitStats.byAgent)) {
    if (count !== undefined) {
      const key = agent as AiAgent;
      base.summary.byAgent[key] = (base.summary.byAgent[key] || 0) + count;
    }
  }

  // Merge model breakdown
  for (const [model, count] of Object.entries(commitStats.byModel)) {
    base.summary.byModel[model] = (base.summary.byModel[model] || 0) + count;
  }

  // Update contributor stats
  if (commitAuthor) {
    if (!base.contributors[commitAuthor]) {
      base.contributors[commitAuthor] = {
        commits: 0,
        prs: 0,
        prompts: 0,
        aiLines: 0,
        humanLines: 0,
        unknownLines: 0,
        topModels: [],
      };
    }

    const contributor = base.contributors[commitAuthor];
    contributor.commits += 1;
    contributor.aiLines += commitStats.aiLines;
    contributor.humanLines += commitStats.humanLines;

    // Update top models
    const modelCounts = new Map<string, number>();
    for (const model of contributor.topModels) {
      modelCounts.set(model, (modelCounts.get(model) || 0) + 1);
    }
    for (const [model, count] of Object.entries(commitStats.byModel)) {
      modelCounts.set(model, (modelCounts.get(model) || 0) + count);
    }

    contributor.topModels = Array.from(modelCounts.entries())
      .sort((a, b) => b[1] - a[1])
      .slice(0, 3)
      .map(([model]) => model);
  }

  // Update time-series
  base.timeSeries = updateTimeSeries(base.timeSeries, commitStats);

  base.updated = new Date().toISOString();

  return base;
}

/**
 * Add a PR entry to analytics
 */
export function addPREntry(
  analytics: AnalyticsNote,
  pr: PREntry
): AnalyticsNote {
  analytics.recentPRs.unshift(pr);

  if (analytics.recentPRs.length > 100) {
    analytics.recentPRs = analytics.recentPRs.slice(0, 100);
  }

  analytics.updated = new Date().toISOString();

  return analytics;
}

// =============================================================================
// Update Analytics (main entry point)
// =============================================================================

/**
 * Update analytics after a commit is processed
 */
export async function updateAnalytics(
  repoRoot: string,
  commitStats: CommitStats,
  commitAuthor?: string
): Promise<boolean> {
  try {
    const existing = await readAnalyticsNote(repoRoot);
    const updated = mergeAnalytics(existing, commitStats, commitAuthor);
    return await writeAnalyticsNote(repoRoot, updated);
  } catch (err) {
    if (process.env.AGENTBLAME_DEBUG) {
      console.error("[agentblame] Failed to update analytics:", err);
    }
    return false;
  }
}

// =============================================================================
// Time Range Types
// =============================================================================

/**
 * Supported time ranges for analytics
 */
export type TimeRange = "24h" | "3d" | "1w" | "1m" | "all";

/**
 * Unified data point for trend queries
 */
export interface TrendDataPoint {
  label: string; // Display label (hour or date)
  aiLines: number;
  humanLines: number;
  byAgent: AgentBreakdown;
  byModel: ModelBreakdown;
  commits: number;
}

// =============================================================================
// Trend Queries
// =============================================================================

/**
 * Get hourly trend data for a specific number of hours
 */
export function getHourlyTrend(
  analytics: AnalyticsNote,
  hours: number = 24
): HourlyDataPoint[] {
  if (!analytics.timeSeries?.hourly) {
    return [];
  }

  return analytics.timeSeries.hourly.slice(0, hours);
}

/**
 * Get daily trend data for a specific number of days
 */
export function getDailyTrend(
  analytics: AnalyticsNote,
  days: number = 30
): DailyDataPoint[] {
  if (!analytics.timeSeries?.daily) {
    return [];
  }

  return analytics.timeSeries.daily.slice(0, days);
}

/**
 * Get trend data for a specific time range
 * Returns unified TrendDataPoint array
 */
export function getTrendForRange(
  analytics: AnalyticsNote,
  range: TimeRange
): TrendDataPoint[] {
  switch (range) {
    case "24h": {
      const hourly = getHourlyTrend(analytics, 24);
      return hourly.map((h) => ({
        label: h.hour.slice(11), // Just "HH"
        aiLines: h.aiLines,
        humanLines: h.humanLines,
        byAgent: h.byAgent,
        byModel: h.byModel,
        commits: h.commits,
      }));
    }
    case "3d": {
      const hourly = getHourlyTrend(analytics, 72);
      return hourly.map((h) => ({
        label: h.hour.slice(5), // "MM-DDTHH"
        aiLines: h.aiLines,
        humanLines: h.humanLines,
        byAgent: h.byAgent,
        byModel: h.byModel,
        commits: h.commits,
      }));
    }
    case "1w": {
      const daily = getDailyTrend(analytics, 7);
      return daily.map((d) => ({
        label: d.date.slice(5), // "MM-DD"
        aiLines: d.aiLines,
        humanLines: d.humanLines,
        byAgent: d.byAgent,
        byModel: d.byModel,
        commits: d.commits,
      }));
    }
    case "1m": {
      const daily = getDailyTrend(analytics, 30);
      return daily.map((d) => ({
        label: d.date.slice(5), // "MM-DD"
        aiLines: d.aiLines,
        humanLines: d.humanLines,
        byAgent: d.byAgent,
        byModel: d.byModel,
        commits: d.commits,
      }));
    }
    case "all":
    default: {
      // For "all", return daily data (up to 30 days) + summary
      const daily = getDailyTrend(analytics, 30);
      return daily.map((d) => ({
        label: d.date,
        aiLines: d.aiLines,
        humanLines: d.humanLines,
        byAgent: d.byAgent,
        byModel: d.byModel,
        commits: d.commits,
      }));
    }
  }
}

/**
 * Calculate AI percentage trend for a time range
 */
export function getAIPercentTrend(
  analytics: AnalyticsNote,
  range: TimeRange = "1m"
): Array<{ label: string; percent: number }> {
  const trend = getTrendForRange(analytics, range);

  return trend.map((d) => {
    const total = d.aiLines + d.humanLines;
    return {
      label: d.label,
      percent: total > 0 ? Math.round((d.aiLines / total) * 100) : 0,
    };
  });
}

/**
 * Get tool (agent) usage trend for a time range
 */
export function getToolTrend(
  analytics: AnalyticsNote,
  range: TimeRange = "1m"
): Array<{ label: string; cursor: number; claude: number; opencode: number }> {
  const trend = getTrendForRange(analytics, range);

  return trend.map((d) => ({
    label: d.label,
    cursor: d.byAgent.cursor || 0,
    claude: d.byAgent.claude || 0,
    opencode: d.byAgent.opencode || 0,
  }));
}

/**
 * Get model usage trend (top N models) for a time range
 */
export function getModelTrend(
  analytics: AnalyticsNote,
  range: TimeRange = "1m",
  topN: number = 5
): Array<{ label: string; models: Record<string, number> }> {
  const trend = getTrendForRange(analytics, range);

  // Find top N models across all data points
  const modelTotals = new Map<string, number>();
  for (const d of trend) {
    for (const [model, count] of Object.entries(d.byModel)) {
      modelTotals.set(model, (modelTotals.get(model) || 0) + count);
    }
  }

  const topModels = Array.from(modelTotals.entries())
    .sort((a, b) => b[1] - a[1])
    .slice(0, topN)
    .map(([model]) => model);

  return trend.map((d) => {
    const models: Record<string, number> = {};
    for (const model of topModels) {
      models[model] = d.byModel[model] || 0;
    }
    return { label: d.label, models };
  });
}

/**
 * Get commit activity trend for a time range
 */
export function getCommitTrend(
  analytics: AnalyticsNote,
  range: TimeRange = "1m"
): Array<{ label: string; commits: number; aiLines: number; humanLines: number }> {
  const trend = getTrendForRange(analytics, range);

  return trend.map((d) => ({
    label: d.label,
    commits: d.commits,
    aiLines: d.aiLines,
    humanLines: d.humanLines,
  }));
}

/**
 * Get summary stats for a time range
 */
export function getRangeSummary(
  analytics: AnalyticsNote,
  range: TimeRange
): { aiLines: number; humanLines: number; commits: number; byAgent: AgentBreakdown; byModel: ModelBreakdown } {
  if (range === "all") {
    return {
      aiLines: analytics.summary.aiLines,
      humanLines: analytics.summary.humanLines,
      commits: Object.values(analytics.contributors).reduce((sum, c) => sum + c.commits, 0),
      byAgent: analytics.summary.byAgent,
      byModel: analytics.summary.byModel,
    };
  }

  const trend = getTrendForRange(analytics, range);

  const result = {
    aiLines: 0,
    humanLines: 0,
    commits: 0,
    byAgent: {} as AgentBreakdown,
    byModel: {} as ModelBreakdown,
  };

  for (const d of trend) {
    result.aiLines += d.aiLines;
    result.humanLines += d.humanLines;
    result.commits += d.commits;
    result.byAgent = mergeAgentBreakdown(result.byAgent, d.byAgent);
    result.byModel = mergeModelBreakdown(result.byModel, d.byModel);
  }

  return result;
}

// =============================================================================
// Analytics Queries
// =============================================================================

/**
 * Get summary statistics
 */
export async function getSummary(
  repoRoot: string
): Promise<AnalyticsSummary | null> {
  const analytics = await readAnalyticsNote(repoRoot);
  return analytics?.summary || null;
}

/**
 * Get contributor statistics
 */
export async function getContributorStats(
  repoRoot: string,
  email: string
): Promise<ContributorStats | null> {
  const analytics = await readAnalyticsNote(repoRoot);
  return analytics?.contributors[email] || null;
}

/**
 * Get recent PRs
 */
export async function getRecentPRs(
  repoRoot: string,
  limit = 10
): Promise<PREntry[]> {
  const analytics = await readAnalyticsNote(repoRoot);
  return analytics?.recentPRs.slice(0, limit) || [];
}

/**
 * Calculate AI percentage
 */
export function calculateAIPercentage(summary: AnalyticsSummary): number {
  if (summary.totalLines === 0) return 0;
  return Math.round((summary.aiLines / summary.totalLines) * 100);
}

// =============================================================================
// Analytics Display Helpers
// =============================================================================

/**
 * Format analytics summary for display
 */
export function formatSummary(summary: AnalyticsSummary): string {
  const aiPercent = calculateAIPercentage(summary);
  const lines: string[] = [];

  lines.push(`Total Lines: ${summary.totalLines.toLocaleString()}`);
  lines.push(`AI Lines: ${summary.aiLines.toLocaleString()} (${aiPercent}%)`);
  lines.push(`Human Lines: ${summary.humanLines.toLocaleString()}`);

  if (Object.keys(summary.byAgent).length > 0 && summary.aiLines > 0) {
    lines.push("");
    lines.push("By Agent:");
    for (const [agent, count] of Object.entries(summary.byAgent)) {
      if (count !== undefined) {
        const percent = Math.round((count / summary.aiLines) * 100);
        lines.push(`  ${agent}: ${count.toLocaleString()} (${percent}%)`);
      }
    }
  }

  if (Object.keys(summary.byModel).length > 0 && summary.aiLines > 0) {
    lines.push("");
    lines.push("By Model:");
    const sortedModels = Object.entries(summary.byModel)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 5);
    for (const [model, count] of sortedModels) {
      const percent = Math.round((count / summary.aiLines) * 100);
      lines.push(`  ${model}: ${count.toLocaleString()} (${percent}%)`);
    }
  }

  return lines.join("\n");
}

/**
 * Format contributor stats for display
 */
export function formatContributorStats(
  email: string,
  stats: ContributorStats
): string {
  const total = stats.aiLines + stats.humanLines;
  const aiPercent = total > 0 ? Math.round((stats.aiLines / total) * 100) : 0;

  const lines: string[] = [];

  lines.push(`Contributor: ${email}`);
  lines.push(`Commits: ${stats.commits}`);
  lines.push(`AI Lines: ${stats.aiLines.toLocaleString()} (${aiPercent}%)`);
  lines.push(`Human Lines: ${stats.humanLines.toLocaleString()}`);

  if (stats.topModels.length > 0) {
    lines.push(`Top Models: ${stats.topModels.join(", ")}`);
  }

  return lines.join("\n");
}

/**
 * Format trend data as ASCII sparkline
 */
export function formatSparkline(values: number[], width: number = 20): string {
  if (values.length === 0) return "";

  const max = Math.max(...values);
  const min = Math.min(...values);
  const range = max - min || 1;

  const blocks = ["▁", "▂", "▃", "▄", "▅", "▆", "▇", "█"];

  // Sample values to fit width
  const step = Math.max(1, Math.floor(values.length / width));
  const sampled: number[] = [];
  for (let i = 0; i < values.length && sampled.length < width; i += step) {
    sampled.push(values[i]);
  }

  return sampled
    .map((v) => {
      const normalized = (v - min) / range;
      const index = Math.min(blocks.length - 1, Math.floor(normalized * blocks.length));
      return blocks[index];
    })
    .join("");
}

/**
 * Get display label for time range
 */
function getRangeLabel(range: TimeRange): string {
  switch (range) {
    case "24h": return "Past 24 hours";
    case "3d": return "Past 3 days";
    case "1w": return "Past week";
    case "1m": return "Past month";
    case "all": return "All time";
  }
}

/**
 * Format trend summary for display
 */
export function formatTrendSummary(analytics: AnalyticsNote, range: TimeRange = "1m"): string {
  const lines: string[] = [];
  const trend = getTrendForRange(analytics, range);
  const rangeLabel = getRangeLabel(range);

  if (trend.length === 0 && range !== "all") {
    return "No trend data available yet.";
  }

  // AI vs Human trend
  const aiPercents = trend.map((d) => {
    const total = d.aiLines + d.humanLines;
    return total > 0 ? Math.round((d.aiLines / total) * 100) : 0;
  }).reverse(); // Oldest first for sparkline

  if (aiPercents.length > 0) {
    lines.push(`AI % (${rangeLabel}): ${formatSparkline(aiPercents)}`);

    // Current vs average
    const currentAI = aiPercents[aiPercents.length - 1] || 0;
    const avgAI = Math.round(aiPercents.reduce((a, b) => a + b, 0) / aiPercents.length);
    const trendDir = currentAI > avgAI ? "↑" : currentAI < avgAI ? "↓" : "→";
    lines.push(`  Current: ${currentAI}%  Avg: ${avgAI}%  ${trendDir}`);
  }

  // Commit activity
  const commits = trend.map((d) => d.commits).reverse();
  if (commits.length > 0) {
    lines.push("");
    lines.push(`Commits (${rangeLabel}): ${formatSparkline(commits)}`);
    lines.push(`  Total: ${commits.reduce((a, b) => a + b, 0)}`);
  }

  // Tool breakdown
  const toolTrend = getToolTrend(analytics, range);
  if (toolTrend.length > 0) {
    const cursorTotal = toolTrend.reduce((a, d) => a + d.cursor, 0);
    const claudeTotal = toolTrend.reduce((a, d) => a + d.claude, 0);
    const opencodeTotal = toolTrend.reduce((a, d) => a + d.opencode, 0);
    const toolTotal = cursorTotal + claudeTotal + opencodeTotal;

    if (toolTotal > 0) {
      lines.push("");
      lines.push(`Tool Usage (${rangeLabel}):`);
      if (cursorTotal > 0) {
        lines.push(`  Cursor: ${cursorTotal} lines (${Math.round((cursorTotal / toolTotal) * 100)}%)`);
      }
      if (claudeTotal > 0) {
        lines.push(`  Claude: ${claudeTotal} lines (${Math.round((claudeTotal / toolTotal) * 100)}%)`);
      }
      if (opencodeTotal > 0) {
        lines.push(`  OpenCode: ${opencodeTotal} lines (${Math.round((opencodeTotal / toolTotal) * 100)}%)`);
      }
    }
  }

  return lines.join("\n");
}

// =============================================================================
// Analytics Initialization
// =============================================================================

/**
 * Initialize analytics note if it doesn't exist
 */
export async function initAnalytics(repoRoot: string): Promise<boolean> {
  const existing = await readAnalyticsNote(repoRoot);

  if (!existing) {
    const initial: AnalyticsNote = {
      v: 3,
      updated: new Date().toISOString(),
      summary: {
        totalLines: 0,
        aiLines: 0,
        humanLines: 0,
        unknownLines: 0,
        prompts: 0,
        byAgent: {},
        byModel: {},
      },
      contributors: {},
      recentPRs: [],
      timeSeries: createEmptyTimeSeries(),
    };

    return await writeAnalyticsNote(repoRoot, initial);
  }

  return true;
}

/**
 * Reset analytics to initial state
 */
export async function resetAnalytics(repoRoot: string): Promise<boolean> {
  const initial: AnalyticsNote = {
    v: 3,
    updated: new Date().toISOString(),
    summary: {
      totalLines: 0,
      aiLines: 0,
      humanLines: 0,
      unknownLines: 0,
      prompts: 0,
      byAgent: {},
      byModel: {},
    },
    contributors: {},
    recentPRs: [],
    timeSeries: createEmptyTimeSeries(),
  };

  return await writeAnalyticsNote(repoRoot, initial);
}

// =============================================================================
// Git Config for Analytics Notes
// =============================================================================

/**
 * Configure git to push analytics notes
 */
export async function configureAnalyticsSync(
  repoRoot: string
): Promise<boolean> {
  return new Promise((resolve) => {
    const proc = spawn(
      "git",
      [
        "config",
        "--local",
        "--add",
        "remote.origin.push",
        `+${ANALYTICS_REF}:${ANALYTICS_REF}`,
      ],
      {
        cwd: repoRoot,
        stdio: ["ignore", "ignore", "ignore"],
      }
    );

    proc.on("close", (code) => {
      resolve(code === 0);
    });

    proc.on("error", () => {
      resolve(false);
    });
  });
}

/**
 * Fetch analytics notes from remote
 */
export async function fetchAnalyticsNotes(repoRoot: string): Promise<boolean> {
  return new Promise((resolve) => {
    const proc = spawn(
      "git",
      ["fetch", "origin", `${ANALYTICS_REF}:${ANALYTICS_REF}`],
      {
        cwd: repoRoot,
        stdio: ["ignore", "ignore", "ignore"],
      }
    );

    proc.on("close", (code) => {
      resolve(code === 0);
    });

    proc.on("error", () => {
      resolve(false);
    });
  });
}

/**
 * Push analytics notes to remote
 */
export async function pushAnalyticsNotes(repoRoot: string): Promise<boolean> {
  return new Promise((resolve) => {
    const proc = spawn("git", ["push", "origin", ANALYTICS_REF], {
      cwd: repoRoot,
      stdio: ["ignore", "ignore", "ignore"],
    });

    proc.on("close", (code) => {
      resolve(code === 0);
    });

    proc.on("error", () => {
      resolve(false);
    });
  });
}
