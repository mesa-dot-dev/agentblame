/**
 * Analytics Data
 *
 * Types and functions for fetching repository-wide analytics.
 * Uses real API calls to fetch from git notes.
 */

import { getToken } from "./storage";
import { MIN_SUPPORTED_VERSION } from "../types";

// Set to true to enable mock data fallback for development/testing
// Set to false for production to only show real analytics
const USE_MOCK_FALLBACK = false;

// Error types for analytics
export type AnalyticsError = {
  type: "unsupported_version";
  version: number;
  message: string;
} | {
  type: "fetch_error";
  message: string;
};

// ============================================================================
// Analytics Data Types - Consistent Format v3
// ============================================================================

export interface AnalyticsHistoryEntry {
  pr: number;
  title?: string;
  author: string;
  date: string;
  added: number;
  removed: number;
  aiLines: number;
  unknownLines: number;
  commits: number;
  prompts: number;
}

export interface AnalyticsSummary {
  totalLines: number;
  aiLines: number;
  humanLines: number;
  unknownLines: number;
  commits: number;
  prompts: number;
  tools: Record<string, number>;
  models: Record<string, number>;
}

export interface ContributorStats {
  totalLines: number;
  aiLines: number;
  humanLines: number;
  unknownLines: number;
  prs: number;
  commits: number;
  prompts: number;
}

// Trend data - fixed-size arrays for easy chart rendering
export interface TrendBucket {
  end: string; // Most recent slot (YYYY-MM-DDTHH for hourly, YYYY-MM-DD for daily)
  ai: number[]; // AI lines per slot
  human: number[]; // Human lines per slot
  unknown: number[]; // Unknown lines per slot
  commits: number[]; // Commits per slot
  prompts: number[]; // Prompts per slot
  tools: Record<string, number[]>; // Lines per tool per slot
  models: Record<string, number[]>; // Lines per model per slot
}

export interface Trends {
  hourly: TrendBucket; // 72 slots for 3d view (slice -24 for 24h)
  daily: TrendBucket; // 30 slots for 1m view (slice -7 for 1w)
}

export interface AnalyticsData {
  version: number;
  updated: string;
  summary: AnalyticsSummary;
  contributors: Record<string, ContributorStats>;
  history: AnalyticsHistoryEntry[];
  trends?: Trends;
}

// Result type for getAnalytics
export type AnalyticsResult = {
  success: true;
  data: AnalyticsData;
} | {
  success: false;
  error: AnalyticsError;
} | null;

const API_BASE = "https://api.github.com";

// Cache TTL in milliseconds (5 minutes)
const CACHE_TTL = 5 * 60 * 1000;

interface CachedAnalytics {
  data: AnalyticsData;
  fetchedAt: number;
}

// In-memory cache for faster access during same page session
const memoryCache = new Map<string, CachedAnalytics>();

/**
 * Get cached analytics from storage
 */
async function getCachedAnalytics(owner: string, repo: string): Promise<AnalyticsData | null> {
  const cacheKey = `analytics_${owner}_${repo}`;

  // Check memory cache first (instant)
  const memCached = memoryCache.get(cacheKey);
  if (memCached && Date.now() - memCached.fetchedAt < CACHE_TTL) {
    console.log("[Agent Blame] Using memory cache");
    return memCached.data;
  }

  // Check chrome.storage.local
  try {
    const stored = await chrome.storage.local.get(cacheKey);
    if (stored[cacheKey]) {
      const cached = stored[cacheKey] as CachedAnalytics;
      if (Date.now() - cached.fetchedAt < CACHE_TTL) {
        // Update memory cache
        memoryCache.set(cacheKey, cached);
        console.log("[Agent Blame] Using storage cache");
        return cached.data;
      }
    }
  } catch {
    // Storage access failed, continue without cache
  }

  return null;
}

/**
 * Store analytics in cache
 */
async function setCachedAnalytics(owner: string, repo: string, data: AnalyticsData): Promise<void> {
  const cacheKey = `analytics_${owner}_${repo}`;
  const cached: CachedAnalytics = { data, fetchedAt: Date.now() };

  // Update memory cache
  memoryCache.set(cacheKey, cached);

  // Update storage cache
  try {
    await chrome.storage.local.set({ [cacheKey]: cached });
  } catch {
    // Storage write failed, memory cache still works
  }
}

/**
 * Clear cached analytics for a repository
 */
export async function clearAnalyticsCache(owner: string, repo: string): Promise<void> {
  const cacheKey = `analytics_${owner}_${repo}`;

  // Clear memory cache
  memoryCache.delete(cacheKey);

  // Clear storage cache
  try {
    await chrome.storage.local.remove(cacheKey);
  } catch {
    // Storage access failed, memory cache still cleared
  }
}

/**
 * Mock analytics data for UI development
 */
export const MOCK_ANALYTICS: AnalyticsData = {
  version: 3,
  updated: new Date().toISOString(),
  summary: {
    totalLines: 15420,
    aiLines: 3847,
    humanLines: 11573,
    unknownLines: 0,
    commits: 45,
    prompts: 68,
    tools: {
      cursor: 2100,
      claude: 1747,
    },
    models: {
      "gpt-4": 1200,
      "gpt-4o": 900,
      "claude-sonnet-4": 1147,
      "claude-opus-4": 600,
    },
  },
  contributors: {
    alice: {
      totalLines: 5000,
      aiLines: 2000,
      humanLines: 3000,
      unknownLines: 0,
      prs: 15,
      commits: 25,
      prompts: 38,
    },
    bob: {
      totalLines: 4000,
      aiLines: 1000,
      humanLines: 3000,
      unknownLines: 0,
      prs: 12,
      commits: 20,
      prompts: 30,
    },
  },
  history: [
    {
      pr: 58,
      title: "Add analytics dashboard",
      author: "alice",
      date: new Date(Date.now() - 0 * 24 * 60 * 60 * 1000).toISOString().split("T")[0],
      added: 450,
      removed: 50,
      aiLines: 280,
      unknownLines: 0,
      commits: 2,
      prompts: 3,
    },
    {
      pr: 57,
      title: "Fix authentication bug",
      author: "bob",
      date: new Date(Date.now() - 1 * 24 * 60 * 60 * 1000).toISOString().split("T")[0],
      added: 120,
      removed: 30,
      aiLines: 45,
      unknownLines: 0,
      commits: 1,
      prompts: 2,
    },
    {
      pr: 56,
      title: "Update dependencies",
      author: "alice",
      date: new Date(Date.now() - 2 * 24 * 60 * 60 * 1000).toISOString().split("T")[0],
      added: 80,
      removed: 20,
      aiLines: 0,
      unknownLines: 0,
      commits: 1,
      prompts: 0,
    },
    {
      pr: 55,
      title: "Implement user settings page",
      author: "bob",
      date: new Date(Date.now() - 3 * 24 * 60 * 60 * 1000).toISOString().split("T")[0],
      added: 320,
      removed: 40,
      aiLines: 200,
      unknownLines: 0,
      commits: 3,
      prompts: 5,
    },
  ],
};

/**
 * Fetch real analytics data from GitHub API (via git notes)
 */
async function fetchRealAnalytics(
  owner: string,
  repo: string,
): Promise<AnalyticsResult> {
  const token = await getToken();
  if (!token) {
    console.log("[Agent Blame] No token, cannot fetch real analytics");
    return null;
  }

  try {
    // First, get the analytics notes ref
    const refResponse = await fetch(
      `${API_BASE}/repos/${owner}/${repo}/git/refs/notes/agentblame-analytics`,
      {
        headers: {
          Authorization: `token ${token}`,
          Accept: "application/vnd.github.v3+json",
        },
      },
    );

    if (!refResponse.ok) {
      if (refResponse.status === 404) {
        console.log("[Agent Blame] No analytics notes found for this repo");
        return null;
      }
      return {
        success: false,
        error: {
          type: "fetch_error",
          message: `Failed to fetch analytics ref: ${refResponse.status}`,
        },
      };
    }

    const ref = await refResponse.json();
    const commitSha = ref.object.sha;

    // Get the commit to find the tree
    const commitResponse = await fetch(
      `${API_BASE}/repos/${owner}/${repo}/git/commits/${commitSha}`,
      {
        headers: {
          Authorization: `token ${token}`,
          Accept: "application/vnd.github.v3+json",
        },
      },
    );

    if (!commitResponse.ok) {
      return {
        success: false,
        error: {
          type: "fetch_error",
          message: `Failed to fetch analytics commit: ${commitResponse.status}`,
        },
      };
    }

    const commit = await commitResponse.json();
    const treeSha = commit.tree.sha;

    // Get the tree to find the anchor note
    const treeResponse = await fetch(
      `${API_BASE}/repos/${owner}/${repo}/git/trees/${treeSha}?recursive=1`,
      {
        headers: {
          Authorization: `token ${token}`,
          Accept: "application/vnd.github.v3+json",
        },
      },
    );

    if (!treeResponse.ok) {
      return {
        success: false,
        error: {
          type: "fetch_error",
          message: `Failed to fetch analytics tree: ${treeResponse.status}`,
        },
      };
    }

    const tree = await treeResponse.json();

    // Find the first blob in the tree (should be the analytics note)
    const blobEntry = tree.tree.find((entry: { type: string }) => entry.type === "blob");
    if (!blobEntry) {
      console.log("[Agent Blame] No analytics blob found in tree");
      return null;
    }

    // Get the blob content
    const blobResponse = await fetch(
      `${API_BASE}/repos/${owner}/${repo}/git/blobs/${blobEntry.sha}`,
      {
        headers: {
          Authorization: `token ${token}`,
          Accept: "application/vnd.github.v3+json",
        },
      },
    );

    if (!blobResponse.ok) {
      return {
        success: false,
        error: {
          type: "fetch_error",
          message: `Failed to fetch analytics blob: ${blobResponse.status}`,
        },
      };
    }

    const blob = await blobResponse.json();

    // Decode base64 content
    const content = atob(blob.content.replace(/\n/g, ""));
    const analytics = JSON.parse(content);

    // Check version - support both 'v' (CLI format) and 'version' (legacy)
    const version = analytics.v || analytics.version || 0;

    // Validate version - must be >= MIN_SUPPORTED_VERSION
    if (version < MIN_SUPPORTED_VERSION) {
      console.log("[Agent Blame] Unsupported analytics version:", version);
      return {
        success: false,
        error: {
          type: "unsupported_version",
          version,
          message: `Unsupported analytics format (v${version}). Agent Blame ${MIN_SUPPORTED_VERSION}.0+ required.`,
        },
      };
    }

    // Normalize the data structure
    const normalizedAnalytics = normalizeAnalyticsData(analytics);

    console.log("[Agent Blame] Successfully fetched real analytics");
    return { success: true, data: normalizedAnalytics };
  } catch (error) {
    console.error("[Agent Blame] Error fetching analytics:", error);
    return {
      success: false,
      error: {
        type: "fetch_error",
        message: error instanceof Error ? error.message : "Unknown error",
      },
    };
  }
}

/**
 * Normalize analytics data from storage format
 * Handles both CLI format (byAgent, byModel, timeSeries, recentPRs) and
 * Chrome format (tools, models, trends, history)
 */
function normalizeAnalyticsData(raw: Record<string, unknown>): AnalyticsData {
  const summary = raw.summary as Record<string, unknown> || {};

  // Handle both CLI format (byAgent/byModel) and Chrome format (tools/models)
  const tools = (summary.tools as Record<string, number>) ||
                (summary.byAgent as Record<string, number>) ||
                {};
  const models = (summary.models as Record<string, number>) ||
                 (summary.byModel as Record<string, number>) ||
                 {};

  // Calculate commits from contributors if not in summary
  let commits = (summary.commits as number) || 0;
  const contributors = raw.contributors as Record<string, unknown> | undefined;
  if (!commits && contributors) {
    for (const stats of Object.values(contributors)) {
      const s = stats as Record<string, unknown>;
      commits += (s.commits as number) || 0;
    }
  }

  return {
    version: (raw.v as number) || (raw.version as number) || 3,
    updated: (raw.updated as string) || new Date().toISOString(),
    summary: {
      totalLines: (summary.totalLines as number) || 0,
      aiLines: (summary.aiLines as number) || 0,
      humanLines: (summary.humanLines as number) || 0,
      unknownLines: (summary.unknownLines as number) || 0,
      commits,
      prompts: (summary.prompts as number) || 0,
      tools,
      models,
    },
    contributors: normalizeContributors(contributors),
    // Handle both CLI format (recentPRs) and Chrome format (history)
    history: normalizeHistory((raw.history as unknown[]) || (raw.recentPRs as unknown[])),
    // Handle both CLI format (timeSeries) and Chrome format (trends)
    trends: normalizeTrends(
      (raw.trends as Record<string, unknown>) ||
      normalizeTimeSeriestoTrends(raw.timeSeries as Record<string, unknown>)
    ),
  };
}

/**
 * Convert CLI timeSeries format to Chrome trends format
 * CLI: { hourly: [{hour, aiLines, humanLines, byAgent, byModel, commits}], daily: [...] }
 * Chrome: { hourly: {end, ai: [], human: [], commits: [], tools: {}, models: {}}, daily: {...} }
 */
function normalizeTimeSeriestoTrends(
  timeSeries: Record<string, unknown> | undefined
): Record<string, unknown> | undefined {
  if (!timeSeries) return undefined;

  const hourlyData = timeSeries.hourly as Array<Record<string, unknown>> | undefined;
  const dailyData = timeSeries.daily as Array<Record<string, unknown>> | undefined;

  return {
    hourly: convertDataPointsToTrendBucket(hourlyData, 72, "hour"),
    daily: convertDataPointsToTrendBucket(dailyData, 30, "date"),
  };
}

/**
 * Convert array of data points to TrendBucket format
 */
function convertDataPointsToTrendBucket(
  dataPoints: Array<Record<string, unknown>> | undefined,
  size: number,
  timeKey: "hour" | "date"
): Record<string, unknown> {
  if (!dataPoints || dataPoints.length === 0) {
    return {
      end: timeKey === "hour"
        ? new Date().toISOString().slice(0, 13)
        : new Date().toISOString().slice(0, 10),
      ai: new Array(size).fill(0),
      human: new Array(size).fill(0),
      unknown: new Array(size).fill(0),
      commits: new Array(size).fill(0),
      prompts: new Array(size).fill(0),
      tools: {},
      models: {},
    };
  }

  // Data points are sorted most recent first, we need oldest first for arrays
  const sorted = [...dataPoints].reverse();

  // Pad with zeros at the beginning to reach desired size
  const padSize = Math.max(0, size - sorted.length);

  const ai: number[] = new Array(padSize).fill(0);
  const human: number[] = new Array(padSize).fill(0);
  const unknown: number[] = new Array(padSize).fill(0);
  const commits: number[] = new Array(padSize).fill(0);
  const prompts: number[] = new Array(padSize).fill(0);
  const tools: Record<string, number[]> = {};
  const models: Record<string, number[]> = {};

  // Collect all tool/model keys first
  const allToolKeys = new Set<string>();
  const allModelKeys = new Set<string>();
  for (const dp of sorted) {
    const byAgent = dp.byAgent as Record<string, number> | undefined;
    const byModel = dp.byModel as Record<string, number> | undefined;
    if (byAgent) Object.keys(byAgent).forEach(k => allToolKeys.add(k));
    if (byModel) Object.keys(byModel).forEach(k => allModelKeys.add(k));
  }

  // Initialize tool/model arrays with padding
  for (const key of allToolKeys) {
    tools[key] = new Array(padSize).fill(0);
  }
  for (const key of allModelKeys) {
    models[key] = new Array(padSize).fill(0);
  }

  // Fill in data from data points
  for (const dp of sorted) {
    ai.push((dp.aiLines as number) || 0);
    human.push((dp.humanLines as number) || 0);
    unknown.push((dp.unknownLines as number) || 0);
    commits.push((dp.commits as number) || 0);
    prompts.push((dp.prompts as number) || 0);

    const byAgent = dp.byAgent as Record<string, number> | undefined;
    const byModel = dp.byModel as Record<string, number> | undefined;

    for (const key of allToolKeys) {
      tools[key].push(byAgent?.[key] || 0);
    }
    for (const key of allModelKeys) {
      models[key].push(byModel?.[key] || 0);
    }
  }

  // Get the end timestamp from the most recent data point
  const mostRecent = dataPoints[0];
  const end = (mostRecent[timeKey] as string) || (timeKey === "hour"
    ? new Date().toISOString().slice(0, 13)
    : new Date().toISOString().slice(0, 10));

  return { end, ai, human, unknown, commits, prompts, tools, models };
}

/**
 * Normalize trends data
 */
function normalizeTrends(trends: Record<string, unknown> | undefined): Trends | undefined {
  if (!trends) return undefined;

  const hourly = trends.hourly as Record<string, unknown> | undefined;
  const daily = trends.daily as Record<string, unknown> | undefined;

  return {
    hourly: normalizeTrendBucket(hourly, 72),
    daily: normalizeTrendBucket(daily, 30),
  };
}

/**
 * Normalize a single trend bucket
 */
function normalizeTrendBucket(bucket: Record<string, unknown> | undefined, size: number): TrendBucket {
  if (!bucket) {
    return {
      end: new Date().toISOString().slice(0, 13),
      ai: new Array(size).fill(0),
      human: new Array(size).fill(0),
      unknown: new Array(size).fill(0),
      commits: new Array(size).fill(0),
      prompts: new Array(size).fill(0),
      tools: {},
      models: {},
    };
  }

  return {
    end: (bucket.end as string) || new Date().toISOString().slice(0, 13),
    ai: (bucket.ai as number[]) || new Array(size).fill(0),
    human: (bucket.human as number[]) || new Array(size).fill(0),
    unknown: (bucket.unknown as number[]) || new Array(size).fill(0),
    commits: (bucket.commits as number[]) || new Array(size).fill(0),
    prompts: (bucket.prompts as number[]) || new Array(size).fill(0),
    tools: (bucket.tools as Record<string, number[]>) || {},
    models: (bucket.models as Record<string, number[]>) || {},
  };
}

/**
 * Normalize contributors
 * Handles CLI format (email keys, topModels) and Chrome format (username keys, prs/prompts)
 */
function normalizeContributors(
  contributors: Record<string, unknown> | undefined
): Record<string, ContributorStats> {
  if (!contributors) return {};

  const result: Record<string, ContributorStats> = {};
  for (const [key, stats] of Object.entries(contributors)) {
    const s = stats as Record<string, unknown>;

    // Extract username from email if needed (e.g., "user@gmail.com" -> "user")
    // Keep as-is if it doesn't look like an email
    const username = key.includes("@") ? key.split("@")[0] : key;

    const aiLines = (s.aiLines as number) || 0;
    const humanLines = (s.humanLines as number) || 0;
    const unknownLines = (s.unknownLines as number) || 0;

    result[username] = {
      totalLines: (s.totalLines as number) || (aiLines + humanLines + unknownLines),
      aiLines,
      humanLines,
      unknownLines,
      prs: (s.prs as number) || 0,
      commits: (s.commits as number) || 0,
      prompts: (s.prompts as number) || 0,
    };
  }
  return result;
}

/**
 * Normalize history entries
 * Handles CLI format (number, mergedAt, humanLines) and Chrome format (pr, date, author, added, removed)
 */
function normalizeHistory(history: unknown[] | undefined): AnalyticsHistoryEntry[] {
  if (!history) return [];

  return history.map((entry) => {
    const e = entry as Record<string, unknown>;

    // Handle CLI format "number" vs Chrome format "pr"
    const pr = (e.pr as number) || (e.number as number) || 0;

    // Handle CLI format "mergedAt" vs Chrome format "date"
    const date = (e.date as string) || (e.mergedAt as string) || new Date().toISOString();

    // Calculate added from aiLines + humanLines + unknownLines if not provided
    const aiLines = (e.aiLines as number) || 0;
    const humanLines = (e.humanLines as number) || 0;
    const unknownLines = (e.unknownLines as number) || 0;
    const added = (e.added as number) || (aiLines + humanLines + unknownLines);

    return {
      pr,
      title: (e.title as string) || undefined,
      author: (e.author as string) || "unknown",
      date: date.split("T")[0], // Normalize to YYYY-MM-DD
      added,
      removed: (e.removed as number) || 0,
      aiLines,
      unknownLines,
      commits: (e.commits as number) || 0,
      prompts: (e.prompts as number) || 0,
    };
  });
}

/**
 * Check if analytics exist for a repository (without fetching full data)
 * Returns true if analytics notes ref exists
 */
export async function checkAnalyticsExist(
  owner: string,
  repo: string,
): Promise<boolean> {
  const token = await getToken();
  if (!token) {
    console.log("[Agent Blame] No token, cannot check analytics");
    return false;
  }

  try {
    const response = await fetch(
      `${API_BASE}/repos/${owner}/${repo}/git/refs/notes/agentblame-analytics`,
      {
        headers: {
          Authorization: `token ${token}`,
          Accept: "application/vnd.github.v3+json",
        },
      },
    );

    if (response.ok) {
      console.log("[Agent Blame] Analytics exist for this repo");
      return true;
    }

    if (response.status === 404) {
      console.log("[Agent Blame] No analytics found for this repo");
      return false;
    }

    console.log("[Agent Blame] Error checking analytics:", response.status);
    return false;
  } catch (error) {
    console.error("[Agent Blame] Error checking analytics:", error);
    return false;
  }
}

/**
 * Get analytics data for a repository
 * Uses caching, tries real API, optionally falls back to mock data
 */
export async function getAnalytics(
  owner: string,
  repo: string,
): Promise<AnalyticsResult> {
  // Check cache first
  const cached = await getCachedAnalytics(owner, repo);
  if (cached) {
    return { success: true, data: cached };
  }

  // Try to fetch real analytics
  const result = await fetchRealAnalytics(owner, repo);

  // Handle successful fetch
  if (result?.success) {
    // Cache the result
    await setCachedAnalytics(owner, repo, result.data);
    return result;
  }

  // If there was an error (not just null), return it
  if (result?.success === false) {
    return result;
  }

  // Fall back to mock data only if enabled
  if (USE_MOCK_FALLBACK) {
    console.log("[Agent Blame] Using mock analytics data (fallback enabled)");
    return { success: true, data: MOCK_ANALYTICS };
  }

  console.log("[Agent Blame] No analytics available (mock fallback disabled)");
  return null;
}

/**
 * Get mock analytics data (for development/testing)
 */
export function getMockAnalytics(): Promise<AnalyticsData> {
  // Simulate network delay
  return new Promise((resolve) => {
    setTimeout(() => resolve(MOCK_ANALYTICS), 300);
  });
}
