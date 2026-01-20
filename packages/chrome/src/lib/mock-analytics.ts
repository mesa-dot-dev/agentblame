/**
 * Analytics Data
 *
 * Types and functions for fetching repository-wide analytics.
 * Uses real API calls to fetch from git notes.
 */

import { getToken } from "./storage";

// Set to true to enable mock data fallback for development/testing
// Set to false for production to only show real analytics
const USE_MOCK_FALLBACK = false;

export interface AnalyticsHistoryEntry {
  d: string; // date (ISO)
  pr: number; // pr_number
  t?: string; // pr_title (optional)
  author: string; // PR author
  a: number; // lines_added
  r: number; // lines_removed
  ai: number; // ai_lines_added
  p?: Record<string, number>; // by_provider
  m?: Record<string, number>; // by_model
}

export interface AnalyticsSummary {
  total_lines: number;
  ai_lines: number;
  human_lines: number;
  by_provider: {
    cursor?: number;
    claude_code?: number;
  };
  by_model: Record<string, number>;
  last_updated: string;
}

export interface ContributorStats {
  total_lines: number;
  ai_lines: number;
  by_provider: Record<string, number>;
  by_model: Record<string, number>;
  pr_count: number;
}

export interface AnalyticsData {
  version: 2;
  summary: AnalyticsSummary;
  contributors: Record<string, ContributorStats>;
  history: AnalyticsHistoryEntry[];
}

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
 * Mock analytics data for UI development
 */
export const MOCK_ANALYTICS: AnalyticsData = {
  version: 2,
  summary: {
    total_lines: 15420,
    ai_lines: 3847,
    human_lines: 11573,
    by_provider: {
      cursor: 2100,
      claude_code: 1747,
    },
    by_model: {
      "gpt-4": 1200,
      "gpt-4o": 900,
      "claude-3.5-sonnet": 1147,
      "claude-3-opus": 600,
    },
    last_updated: new Date().toISOString(),
  },
  contributors: {
    alice: {
      total_lines: 5000,
      ai_lines: 2000,
      by_provider: { cursor: 1200, claude_code: 800 },
      by_model: { "gpt-4": 800, "claude-3.5-sonnet": 1200 },
      pr_count: 15,
    },
    bob: {
      total_lines: 4000,
      ai_lines: 1000,
      by_provider: { cursor: 600, claude_code: 400 },
      by_model: { "gpt-4o": 600, "claude-3-opus": 400 },
      pr_count: 12,
    },
  },
  history: [
    {
      d: new Date(Date.now() - 0 * 24 * 60 * 60 * 1000).toISOString().split("T")[0],
      pr: 58,
      t: "Add analytics dashboard",
      author: "alice",
      a: 450,
      r: 50,
      ai: 280,
      p: { cursor: 280 },
      m: { "gpt-4": 280 },
    },
    {
      d: new Date(Date.now() - 1 * 24 * 60 * 60 * 1000).toISOString().split("T")[0],
      pr: 57,
      t: "Fix authentication bug",
      author: "bob",
      a: 120,
      r: 30,
      ai: 45,
      p: { claude_code: 45 },
      m: { "claude-3.5-sonnet": 45 },
    },
    {
      d: new Date(Date.now() - 2 * 24 * 60 * 60 * 1000).toISOString().split("T")[0],
      pr: 56,
      t: "Update dependencies",
      author: "alice",
      a: 80,
      r: 20,
      ai: 0,
    },
    {
      d: new Date(Date.now() - 3 * 24 * 60 * 60 * 1000).toISOString().split("T")[0],
      pr: 55,
      t: "Implement user settings page",
      author: "bob",
      a: 320,
      r: 40,
      ai: 200,
      p: { cursor: 120, claude_code: 80 },
      m: { "gpt-4": 120, "claude-3.5-sonnet": 80 },
    },
    {
      d: new Date(Date.now() - 5 * 24 * 60 * 60 * 1000).toISOString().split("T")[0],
      pr: 54,
      t: "Add API rate limiting",
      author: "alice",
      a: 180,
      r: 10,
      ai: 150,
      p: { cursor: 150 },
      m: { "gpt-4o": 150 },
    },
    {
      d: new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString().split("T")[0],
      pr: 53,
      t: "Refactor database queries",
      author: "bob",
      a: 250,
      r: 180,
      ai: 180,
      p: { claude_code: 180 },
      m: { "claude-3-opus": 180 },
    },
    {
      d: new Date(Date.now() - 10 * 24 * 60 * 60 * 1000).toISOString().split("T")[0],
      pr: 52,
      t: "Add user authentication",
      author: "alice",
      a: 400,
      r: 60,
      ai: 320,
      p: { cursor: 200, claude_code: 120 },
      m: { "gpt-4": 200, "claude-3.5-sonnet": 120 },
    },
    {
      d: new Date(Date.now() - 14 * 24 * 60 * 60 * 1000).toISOString().split("T")[0],
      pr: 51,
      t: "Initial project setup",
      author: "bob",
      a: 600,
      r: 0,
      ai: 400,
      p: { cursor: 250, claude_code: 150 },
      m: { "gpt-4": 150, "gpt-4o": 100, "claude-3.5-sonnet": 100, "claude-3-opus": 50 },
    },
  ],
};

/**
 * Fetch real analytics data from GitHub API (via git notes)
 */
async function fetchRealAnalytics(
  owner: string,
  repo: string,
): Promise<AnalyticsData | null> {
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
      throw new Error(`Failed to fetch analytics ref: ${refResponse.status}`);
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
      throw new Error(`Failed to fetch analytics commit: ${commitResponse.status}`);
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
      throw new Error(`Failed to fetch analytics tree: ${treeResponse.status}`);
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
      throw new Error(`Failed to fetch analytics blob: ${blobResponse.status}`);
    }

    const blob = await blobResponse.json();

    // Decode base64 content
    const content = atob(blob.content.replace(/\n/g, ""));
    const analytics = JSON.parse(content);

    // Validate version
    if (analytics.version !== 2) {
      console.log("[Agent Blame] Invalid analytics version:", analytics.version);
      return null;
    }

    console.log("[Agent Blame] Successfully fetched real analytics");
    return analytics as AnalyticsData;
  } catch (error) {
    console.error("[Agent Blame] Error fetching analytics:", error);
    return null;
  }
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
): Promise<AnalyticsData | null> {
  // Check cache first
  const cached = await getCachedAnalytics(owner, repo);
  if (cached) {
    return cached;
  }

  // Try to fetch real analytics
  const realData = await fetchRealAnalytics(owner, repo);
  if (realData) {
    // Cache the result
    await setCachedAnalytics(owner, repo, realData);
    return realData;
  }

  // Fall back to mock data only if enabled
  if (USE_MOCK_FALLBACK) {
    console.log("[Agent Blame] Using mock analytics data (fallback enabled)");
    return MOCK_ANALYTICS;
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
