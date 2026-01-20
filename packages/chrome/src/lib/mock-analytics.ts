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
  date: string;
  pr: number;
  title?: string;
  author: string;
  added: number;
  removed: number;
  aiLines: number;
  providers?: Record<string, number>;
  models?: Record<string, number>;
}

export interface AnalyticsSummary {
  totalLines: number;
  aiLines: number;
  humanLines: number;
  providers: {
    cursor?: number;
    claudeCode?: number;
  };
  models: Record<string, number>;
  updated: string;
}

export interface ContributorStats {
  totalLines: number;
  aiLines: number;
  providers: Record<string, number>;
  models: Record<string, number>;
  prCount: number;
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
    totalLines: 15420,
    aiLines: 3847,
    humanLines: 11573,
    providers: {
      cursor: 2100,
      claudeCode: 1747,
    },
    models: {
      "gpt-4": 1200,
      "gpt-4o": 900,
      "claude-3.5-sonnet": 1147,
      "claude-3-opus": 600,
    },
    updated: new Date().toISOString(),
  },
  contributors: {
    alice: {
      totalLines: 5000,
      aiLines: 2000,
      providers: { cursor: 1200, claudeCode: 800 },
      models: { "gpt-4": 800, "claude-3.5-sonnet": 1200 },
      prCount: 15,
    },
    bob: {
      totalLines: 4000,
      aiLines: 1000,
      providers: { cursor: 600, claudeCode: 400 },
      models: { "gpt-4o": 600, "claude-3-opus": 400 },
      prCount: 12,
    },
  },
  history: [
    {
      date: new Date(Date.now() - 0 * 24 * 60 * 60 * 1000).toISOString().split("T")[0],
      pr: 58,
      title: "Add analytics dashboard",
      author: "alice",
      added: 450,
      removed: 50,
      aiLines: 280,
      providers: { cursor: 280 },
      models: { "gpt-4": 280 },
    },
    {
      date: new Date(Date.now() - 1 * 24 * 60 * 60 * 1000).toISOString().split("T")[0],
      pr: 57,
      title: "Fix authentication bug",
      author: "bob",
      added: 120,
      removed: 30,
      aiLines: 45,
      providers: { claudeCode: 45 },
      models: { "claude-3.5-sonnet": 45 },
    },
    {
      date: new Date(Date.now() - 2 * 24 * 60 * 60 * 1000).toISOString().split("T")[0],
      pr: 56,
      title: "Update dependencies",
      author: "alice",
      added: 80,
      removed: 20,
      aiLines: 0,
    },
    {
      date: new Date(Date.now() - 3 * 24 * 60 * 60 * 1000).toISOString().split("T")[0],
      pr: 55,
      title: "Implement user settings page",
      author: "bob",
      added: 320,
      removed: 40,
      aiLines: 200,
      providers: { cursor: 120, claudeCode: 80 },
      models: { "gpt-4": 120, "claude-3.5-sonnet": 80 },
    },
    {
      date: new Date(Date.now() - 5 * 24 * 60 * 60 * 1000).toISOString().split("T")[0],
      pr: 54,
      title: "Add API rate limiting",
      author: "alice",
      added: 180,
      removed: 10,
      aiLines: 150,
      providers: { cursor: 150 },
      models: { "gpt-4o": 150 },
    },
    {
      date: new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString().split("T")[0],
      pr: 53,
      title: "Refactor database queries",
      author: "bob",
      added: 250,
      removed: 180,
      aiLines: 180,
      providers: { claudeCode: 180 },
      models: { "claude-3-opus": 180 },
    },
    {
      date: new Date(Date.now() - 10 * 24 * 60 * 60 * 1000).toISOString().split("T")[0],
      pr: 52,
      title: "Add user authentication",
      author: "alice",
      added: 400,
      removed: 60,
      aiLines: 320,
      providers: { cursor: 200, claudeCode: 120 },
      models: { "gpt-4": 200, "claude-3.5-sonnet": 120 },
    },
    {
      date: new Date(Date.now() - 14 * 24 * 60 * 60 * 1000).toISOString().split("T")[0],
      pr: 51,
      title: "Initial project setup",
      author: "bob",
      added: 600,
      removed: 0,
      aiLines: 400,
      providers: { cursor: 250, claudeCode: 150 },
      models: { "gpt-4": 150, "gpt-4o": 100, "claude-3.5-sonnet": 100, "claude-3-opus": 50 },
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
      console.log("[Agent Blame] Unsupported analytics version:", analytics.version);
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
