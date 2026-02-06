/**
 * Analytics Page Component
 *
 * Full page component showing repository-wide AI attribution analytics.
 * Replaces the main content area when "Agent Blame" is selected in the Insights sidebar.
 * Uses GitHub's Primer CSS for styling.
 */

import {
  type AnalyticsData,
  type AnalyticsHistoryEntry,
  type AnalyticsResult,
  getAnalytics,
  clearAnalyticsCache,
} from "../lib/mockAnalytics";
import { MIN_SUPPORTED_VERSION } from "../types";

const PAGE_CONTAINER_ID = "agentblame-page-container";
const ORIGINAL_CONTENT_ATTR = "data-agentblame-hidden";

// Tool color palette - Soft, pleasant colors that work in light/dark themes
const TOOL_COLOR_PALETTE = [
  "#5B8DEE", // Soft blue (Cursor)
  "#E07B53", // Soft coral/orange (Claude Code)
  "#4DBBAA", // Soft teal (OpenCode)
  "#9B7ED9", // Soft purple
  "#6ABF69", // Soft green
  "#E5A84B", // Soft amber
  "#D97BA2", // Soft rose
  "#5AADCF", // Soft cyan
];

/**
 * Format provider/tool name for display
 */
function formatProviderName(provider: string): string {
  const names: Record<string, string> = {
    cursor: "Cursor",
    claudeCode: "Claude Code",
    claude: "Claude Code",
    opencode: "OpenCode",
    copilot: "Copilot",
    windsurf: "Windsurf",
    aider: "Aider",
    cline: "Cline",
  };
  return names[provider] || provider.replace(/([A-Z])/g, " $1").trim();
}

/**
 * Show the Agent Blame analytics page
 */
export async function showAnalyticsPage(
  owner: string,
  repo: string
): Promise<void> {
  // Check if already showing
  if (document.getElementById(PAGE_CONTAINER_ID)) {
    return;
  }

  // Find the main content area
  const mainContent =
    document.querySelector(".Layout-main") ||
    document.querySelector("main") ||
    document.querySelector('[data-turbo-frame="repo-content-turbo-frame"]') ||
    document.querySelector(".container-xl");

  if (!mainContent) {
    console.log("[Agent Blame] Could not find main content area");
    return;
  }

  // Hide original content (all direct children)
  Array.from(mainContent.children).forEach((child) => {
    if (child.id !== PAGE_CONTAINER_ID) {
      (child as HTMLElement).setAttribute(ORIGINAL_CONTENT_ATTR, "true");
      (child as HTMLElement).style.display = "none";
    }
  });

  // Create page container
  const pageContainer = document.createElement("div");
  pageContainer.id = PAGE_CONTAINER_ID;

  // Show loading state
  pageContainer.innerHTML = renderLoadingState();

  // Insert at the beginning of main content
  mainContent.insertBefore(pageContainer, mainContent.firstChild);

  // Fetch and render analytics
  try {
    const result = await getAnalytics(owner, repo);

    if (!result) {
      pageContainer.innerHTML = renderEmptyState();
      return;
    }

    if (!result.success) {
      // Handle specific error types
      if (result.error.type === "unsupported_version") {
        pageContainer.innerHTML = renderUnsupportedVersionState(result.error.version);
      } else {
        pageContainer.innerHTML = renderErrorState(result.error.message);
      }
      return;
    }

    const analytics = result.data;

    // Store for period filtering
    currentOwner = owner;
    currentRepo = repo;
    currentAnalytics = analytics;

    // Apply current period filter
    const filtered = filterAnalyticsByPeriod(analytics, currentPeriod);
    pageContainer.innerHTML = renderAnalyticsPage(owner, repo, filtered, analytics);
    attachPeriodListeners();
  } catch (error) {
    pageContainer.innerHTML = renderErrorState(
      error instanceof Error ? error.message : "Unknown error"
    );
  }
}

/**
 * Hide the Agent Blame analytics page and restore original content
 */
export function hideAnalyticsPage(): void {
  const pageContainer = document.getElementById(PAGE_CONTAINER_ID);
  if (pageContainer) {
    pageContainer.remove();
  }

  // Restore original content
  document.querySelectorAll(`[${ORIGINAL_CONTENT_ATTR}]`).forEach((el) => {
    (el as HTMLElement).style.display = "";
    el.removeAttribute(ORIGINAL_CONTENT_ATTR);
  });

  // Reset state
  currentOwner = "";
  currentRepo = "";
  currentAnalytics = null;
}

/**
 * Render loading state
 */
function renderLoadingState(): string {
  return `
    <div class="mt-4">
      <div class="Box">
        <div class="Box-header d-flex flex-items-center">
          <div class="anim-pulse rounded-2" style="width: 200px; height: 24px; background: var(--color-canvas-subtle);"></div>
        </div>
        <div class="Box-body">
          <div class="d-flex gap-3 mb-4">
            <div class="anim-pulse rounded-2 flex-1" style="height: 100px; background: var(--color-canvas-subtle);"></div>
            <div class="anim-pulse rounded-2 flex-1" style="height: 100px; background: var(--color-canvas-subtle);"></div>
            <div class="anim-pulse rounded-2 flex-1" style="height: 100px; background: var(--color-canvas-subtle);"></div>
          </div>
          <div class="anim-pulse rounded-2" style="height: 150px; background: var(--color-canvas-subtle);"></div>
        </div>
      </div>
    </div>
  `;
}

/**
 * Render error state
 */
function renderErrorState(message: string): string {
  return `
    <div class="mt-4">
      <div class="Box">
        <div class="Box-body">
          <div class="flash flash-error">
            <svg class="octicon octicon-alert mr-2" viewBox="0 0 16 16" width="16" height="16">
              <path fill-rule="evenodd" d="M8.22 1.754a.25.25 0 00-.44 0L1.698 13.132a.25.25 0 00.22.368h12.164a.25.25 0 00.22-.368L8.22 1.754zm-1.763-.707c.659-1.234 2.427-1.234 3.086 0l6.082 11.378A1.75 1.75 0 0114.082 15H1.918a1.75 1.75 0 01-1.543-2.575L6.457 1.047zM9 11a1 1 0 11-2 0 1 1 0 012 0zm-.25-5.25a.75.75 0 00-1.5 0v2.5a.75.75 0 001.5 0v-2.5z"></path>
            </svg>
            ${escapeHtml(message)}
          </div>
        </div>
      </div>
    </div>
  `;
}

/**
 * Render empty state (no analytics available)
 */
function renderEmptyState(): string {
  return `
    <div class="mt-4">
      <div class="Box">
        <div class="Box-body">
          <div class="blankslate">
            <svg class="blankslate-icon color-fg-muted" viewBox="0 0 24 24" width="48" height="48" fill="none" stroke="currentColor" stroke-width="1.5">
              <path stroke-linecap="round" stroke-linejoin="round" d="M3.75 3v11.25A2.25 2.25 0 006 16.5h2.25M3.75 3h-1.5m1.5 0h16.5m0 0h1.5m-1.5 0v11.25A2.25 2.25 0 0118 16.5h-2.25m-7.5 0h7.5m-7.5 0l-1 3m8.5-3l1 3m0 0l.5 1.5m-.5-1.5h-9.5m0 0l-.5 1.5" />
            </svg>
            <h3 class="blankslate-heading">No Analytics Available</h3>
            <p class="color-fg-muted">
              Analytics will appear here after PRs with AI attribution are merged.
            </p>
            <div class="blankslate-action">
              <a href="https://github.com/mesa-dot-dev/agentblame#setup" target="_blank" class="btn btn-primary">
                Learn how to set up Agent Blame
              </a>
            </div>
          </div>
        </div>
      </div>
    </div>
  `;
}

/**
 * Render unsupported version state
 */
function renderUnsupportedVersionState(foundVersion: number): string {
  return `
    <div class="mt-4">
      <div class="Box">
        <div class="Box-body">
          <div class="blankslate">
            <svg class="blankslate-icon color-fg-attention" viewBox="0 0 16 16" width="48" height="48">
              <path fill="currentColor" fill-rule="evenodd" d="M8.22 1.754a.25.25 0 00-.44 0L1.698 13.132a.25.25 0 00.22.368h12.164a.25.25 0 00.22-.368L8.22 1.754zm-1.763-.707c.659-1.234 2.427-1.234 3.086 0l6.082 11.378A1.75 1.75 0 0114.082 15H1.918a1.75 1.75 0 01-1.543-2.575L6.457 1.047zM9 11a1 1 0 11-2 0 1 1 0 012 0zm-.25-5.25a.75.75 0 00-1.5 0v2.5a.75.75 0 001.5 0v-2.5z"></path>
            </svg>
            <h3 class="blankslate-heading">Unsupported Analytics Format</h3>
            <p class="color-fg-muted">
              This repository uses analytics format v${foundVersion}, but Agent Blame ${MIN_SUPPORTED_VERSION}.0+ is required.
            </p>
            <p class="color-fg-muted mt-2">
              Please update your CLI to the latest version and re-process your commits to use the new format.
            </p>
            <div class="blankslate-action mt-3">
              <a href="https://github.com/mesa-dot-dev/agentblame#upgrading" target="_blank" class="btn btn-primary">
                How to Upgrade
              </a>
            </div>
          </div>
        </div>
      </div>
    </div>
  `;
}

// Period options for filtering - matches CLI TimeRange
type PeriodOption = "24h" | "3d" | "1w" | "1m" | "all";

const PERIOD_LABELS: Record<PeriodOption, string> = {
  "24h": "Past 24 hours",
  "3d": "Past 3 days",
  "1w": "Past week",
  "1m": "Past month",
  "all": "All time",
};

// Current selected period (module-level state)
let currentPeriod: PeriodOption = "all";
let currentOwner = "";
let currentRepo = "";
let currentAnalytics: AnalyticsData | null = null;

/**
 * Filter analytics data by period
 * Uses trends data if available, otherwise filters history
 */
function filterAnalyticsByPeriod(
  analytics: AnalyticsData,
  period: PeriodOption
): AnalyticsData {
  if (period === "all") {
    return analytics;
  }

  // Filter history by date cutoff
  const now = Date.now();
  const cutoffs: Record<Exclude<PeriodOption, "all">, number> = {
    "24h": now - 24 * 60 * 60 * 1000,
    "3d": now - 3 * 24 * 60 * 60 * 1000,
    "1w": now - 7 * 24 * 60 * 60 * 1000,
    "1m": now - 30 * 24 * 60 * 60 * 1000,
  };
  const cutoff = cutoffs[period];

  const filteredHistory = analytics.history.filter((entry) => {
    const entryDate = new Date(entry.date).getTime();
    return entryDate >= cutoff;
  });

  // If we have trends data, use it for summary stats
  if (analytics.trends) {
    const useHourly = period === "24h" || period === "3d";
    const bucket = useHourly ? analytics.trends.hourly : analytics.trends.daily;

    let sliceSize: number;
    if (period === "24h") sliceSize = 24;
    else if (period === "3d") sliceSize = 72;
    else if (period === "1w") sliceSize = 7;
    else sliceSize = 30;

    const sliceStart = Math.max(0, bucket.ai.length - sliceSize);

    const aiLines = bucket.ai.slice(sliceStart).reduce((a, b) => a + b, 0);
    const humanLines = bucket.human.slice(sliceStart).reduce((a, b) => a + b, 0);
    const unknownLines = bucket.unknown.slice(sliceStart).reduce((a, b) => a + b, 0);
    const commits = bucket.commits.slice(sliceStart).reduce((a, b) => a + b, 0);
    const prompts = bucket.prompts.slice(sliceStart).reduce((a, b) => a + b, 0);

    // Aggregate tools and models
    const tools: Record<string, number> = {};
    for (const [name, data] of Object.entries(bucket.tools || {})) {
      tools[name] = data.slice(sliceStart).reduce((a, b) => a + b, 0);
    }

    const models: Record<string, number> = {};
    for (const [name, data] of Object.entries(bucket.models || {})) {
      models[name] = data.slice(sliceStart).reduce((a, b) => a + b, 0);
    }

    return {
      version: analytics.version,
      updated: analytics.updated,
      summary: {
        totalLines: aiLines + humanLines + unknownLines,
        aiLines,
        humanLines,
        unknownLines,
        commits,
        prompts,
        tools,
        models,
      },
      contributors: analytics.contributors,
      history: filteredHistory,
      trends: analytics.trends,
    };
  }

  // Fallback: aggregate from filtered history
  let totalLines = 0;
  let aiLines = 0;
  let unknownLines = 0;
  let commits = 0;
  let prompts = 0;

  for (const entry of filteredHistory) {
    totalLines += entry.added;
    aiLines += entry.aiLines;
    unknownLines += entry.unknownLines;
    commits += entry.commits;
    prompts += entry.prompts;
  }

  return {
    version: analytics.version,
    updated: analytics.updated,
    summary: {
      totalLines,
      aiLines,
      humanLines: totalLines - aiLines - unknownLines,
      unknownLines,
      commits,
      prompts,
      tools: analytics.summary.tools,
      models: analytics.summary.models,
    },
    contributors: analytics.contributors,
    history: filteredHistory,
    trends: analytics.trends,
  };
}

/**
 * Handle period change
 */
function handlePeriodChange(period: PeriodOption): void {
  currentPeriod = period;
  if (currentAnalytics && currentOwner && currentRepo) {
    const filtered = filterAnalyticsByPeriod(currentAnalytics, period);
    const container = document.getElementById(PAGE_CONTAINER_ID);
    if (container) {
      container.innerHTML = renderAnalyticsPage(currentOwner, currentRepo, filtered, currentAnalytics);
      attachPeriodListeners();
    }
  }
}

/**
 * Attach event listeners to period dropdown and refresh button
 */
function attachPeriodListeners(): void {
  const dropdown = document.getElementById("agentblame-period-select");
  if (dropdown) {
    dropdown.addEventListener("change", (e) => {
      const select = e.target as HTMLSelectElement;
      handlePeriodChange(select.value as PeriodOption);
    });
  }

  const refreshBtn = document.getElementById("agentblame-refresh-btn");
  if (refreshBtn) {
    refreshBtn.addEventListener("click", handleRefresh);
  }

  // Attach avatar error handlers (CSP blocks inline onerror)
  const container = document.getElementById(PAGE_CONTAINER_ID);
  if (container) {
    for (const img of container.querySelectorAll<HTMLImageElement>(".ab-avatar-img")) {
      img.addEventListener("error", () => {
        img.style.display = "none";
        const fallback = img.nextElementSibling as HTMLElement | null;
        if (fallback) fallback.style.display = "flex";
      });
    }
  }
}

/**
 * Handle refresh button click - clear cache and refetch data
 */
async function handleRefresh(): Promise<void> {
  if (!currentOwner || !currentRepo) return;

  const container = document.getElementById(PAGE_CONTAINER_ID);
  if (!container) return;

  // Show loading state
  container.innerHTML = renderLoadingState();

  // Clear cache and refetch
  await clearAnalyticsCache(currentOwner, currentRepo);
  const result = await getAnalytics(currentOwner, currentRepo);

  if (!result) {
    container.innerHTML = renderEmptyState();
    return;
  }

  if (!result.success) {
    if (result.error.type === "unsupported_version") {
      container.innerHTML = renderUnsupportedVersionState(result.error.version);
    } else {
      container.innerHTML = renderErrorState(result.error.message);
    }
    return;
  }

  currentAnalytics = result.data;
  const filtered = filterAnalyticsByPeriod(result.data, currentPeriod);
  container.innerHTML = renderAnalyticsPage(currentOwner, currentRepo, filtered, result.data);
  attachPeriodListeners();
}

/**
 * Render the full analytics page
 */
function renderAnalyticsPage(
  owner: string,
  repo: string,
  filteredAnalytics: AnalyticsData,
  fullAnalytics?: AnalyticsData
): string {
  const analytics = filteredAnalytics;
  const lastUpdated = analytics.updated;

  return `
    <div style="max-width: 1200px;">
      <!-- Page Header with Period Selector -->
      <div class="Subhead d-flex flex-justify-between flex-items-center mb-4">
        <h2 class="Subhead-heading d-flex flex-items-center gap-2 m-0">
          <svg width="24" height="24" viewBox="0 0 240 240" fill="none">
            <circle cx="120" cy="120" r="120" fill="#ffeab4"/>
            <path d="M120.5 1.5C186.774 1.5 240.5 55.2258 240.5 121.5C240.5 180.23 198.309 229.103 142.584 239.47V149.192H142.585V163.281C142.585 153.834 148.351 150.152 155.573 147.927C156.661 147.668 157.734 147.371 158.791 147.038C158.807 147.034 158.824 147.029 158.841 147.025H158.83C177.358 141.161 190.876 124.031 191.341 103.675H191.354V102.68C191.354 102.65 191.354 102.621 191.354 102.592V90.6699C191.354 90.6466 191.354 90.6229 191.354 90.5996V88.8594C191.354 79.0641 184.945 72.9144 175.098 72.9141C165.25 72.9142 158.841 79.0639 158.841 88.8594V102.383C158.82 108.486 153.867 113.428 147.759 113.429C144.902 113.429 142.586 111.113 142.586 108.257V74.4141H142.584V62.1289C142.584 49.0367 134.04 40.8174 120.909 40.8174C107.779 40.8177 99.2344 49.037 99.2344 62.1289V140.807C99.2139 143.645 96.9069 145.941 94.0635 145.941C87.9427 145.941 82.9801 140.979 82.9795 134.858V136.188H82.9785V121.372C82.9785 111.576 76.5695 105.427 66.7217 105.427C56.8743 105.427 50.4658 111.577 50.4658 121.372V136.188H50.4795C50.9442 156.543 64.4624 173.673 82.9902 179.538H82.9785C82.9972 179.543 83.0165 179.548 83.0352 179.553C84.0873 179.885 85.1563 180.18 86.2393 180.438C93.4371 182.654 99.1897 186.314 99.2344 195.684V239.621C43.1041 229.583 0.5 180.517 0.5 121.5C0.5 55.2258 54.2258 1.5 120.5 1.5ZM66.7227 113.429C71.5107 113.429 75.3924 117.311 75.3926 122.099C75.3924 126.887 71.5106 130.768 66.7227 130.769C61.9347 130.768 58.0529 126.887 58.0527 122.099C58.0529 117.311 61.9347 113.429 66.7227 113.429ZM175.098 80.916C179.886 80.9164 183.767 84.798 183.768 89.5859C183.767 94.3739 179.886 98.2555 175.098 98.2559C170.31 98.2557 166.428 94.3741 166.428 89.5859C166.428 84.7979 170.31 80.9161 175.098 80.916ZM120.909 50.5713C126.894 50.5714 131.746 55.4231 131.746 61.4082C131.746 67.3935 126.894 72.2459 120.909 72.2461C114.924 72.2458 110.071 67.3934 110.071 61.4082C110.072 55.4232 114.924 50.5716 120.909 50.5713Z" fill="#b83900"/>
          </svg>
          Agent Blame — Analytics
        </h2>
        <div class="d-flex gap-2 flex-items-center">
          <select id="agentblame-period-select" class="form-select form-select-sm">
            ${(Object.keys(PERIOD_LABELS) as PeriodOption[])
              .map(p => `<option value="${p}" ${p === currentPeriod ? "selected" : ""}>${PERIOD_LABELS[p]}</option>`)
              .join("")}
          </select>
          <button id="agentblame-refresh-btn" class="btn btn-sm" title="Refresh analytics data">
            <svg class="octicon" viewBox="0 0 16 16" width="16" height="16">
              <path fill-rule="evenodd" d="M8 3a5 5 0 1 0 4.546 2.914.75.75 0 0 1 1.363-.613A6.5 6.5 0 1 1 8 1.5v2A.75.75 0 0 1 6.75 4v-.75A.75.75 0 0 1 8 3z"></path>
              <path fill-rule="evenodd" d="M8 0a.75.75 0 0 1 .75.75v3.5a.75.75 0 0 1-1.5 0V.75A.75.75 0 0 1 8 0z"></path>
              <path fill-rule="evenodd" d="M7.47 3.22a.75.75 0 0 1 1.06 0l1.5 1.5a.75.75 0 0 1-1.06 1.06l-1.5-1.5a.75.75 0 0 1 0-1.06z"></path>
            </svg>
            Refresh
          </button>
        </div>
      </div>

      <!-- Summary Stats -->
      ${renderStatsSection(analytics)}

      <!-- Trend Charts -->
      ${renderTrendSection(analytics, fullAnalytics || analytics)}

      <!-- Contributors Section -->
      ${renderContributorsSection(analytics)}

      <!-- Recent PRs Section -->
      ${renderPullRequestsSection(analytics, owner, repo)}

      <!-- Footer -->
      <div class="f6 color-fg-muted mt-4 pb-4 d-flex flex-justify-between flex-items-center">
        <span>Last updated: ${formatDate(lastUpdated)}</span>
        <a href="https://github.com/mesa-dot-dev/agentblame" target="_blank" class="Link--muted d-flex flex-items-center gap-1">
          <svg viewBox="0 0 16 16" width="14" height="14" fill="currentColor">
            <path d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27.68 0 1.36.09 2 .27 1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.013 8.013 0 0016 8c0-4.42-3.58-8-8-8z"/>
          </svg>
          Agent Blame by Mesa.dev
        </a>
      </div>
    </div>
  `;
}

/**
 * Render stats section (filtered by selected period)
 */
function renderStatsSection(analytics: AnalyticsData): string {
  const { summary } = analytics;
  const unknownLines = summary.unknownLines || 0;
  const aiPercent = summary.totalLines > 0
    ? Math.round((summary.aiLines / summary.totalLines) * 100)
    : 0;
  const humanPercent = summary.totalLines > 0
    ? Math.round((summary.humanLines / summary.totalLines) * 100)
    : 0;

  // Prompt efficiency: commits / prompts (higher = better, 1.0 = ideal)
  const efficiency = summary.prompts > 0 ? (summary.commits / summary.prompts) : 0;
  const efficiencyStr = efficiency > 0 ? efficiency.toFixed(2) : "—";

  // Build tool breakdown
  const toolEntries = Object.entries(summary.tools || {})
    .filter(([, lines]) => lines > 0)
    .sort(([, a], [, b]) => b - a);

  // Build model breakdown (top 5)
  const modelEntries = Object.entries(summary.models || {})
    .sort(([, a], [, b]) => b - a)
    .slice(0, 5);

  // Colors
  const aiColor = "#E07B53";
  const humanColor = "#57AB5A";

  return `
    <!-- Stats Cards Grid -->
    <div class="mb-4" style="display: grid; grid-template-columns: repeat(4, 1fr); gap: 16px;">

      <!-- AI-Generated Card -->
      <div style="background: linear-gradient(135deg, rgba(224, 123, 83, 0.15) 0%, rgba(224, 123, 83, 0.05) 100%); border: 1px solid rgba(224, 123, 83, 0.3); border-radius: 12px; padding: 20px; position: relative; overflow: hidden;">
        <div style="position: absolute; top: -20px; right: -20px; width: 80px; height: 80px; background: rgba(224, 123, 83, 0.1); border-radius: 50%;"></div>
        <div style="position: relative;">
          <div style="font-size: 11px; font-weight: 600; text-transform: uppercase; letter-spacing: 0.5px; color: ${aiColor}; opacity: 0.8; margin-bottom: 8px;">AI-Generated</div>
          <div style="display: flex; align-items: baseline; gap: 4px;">
            <span style="font-size: 36px; font-weight: 800; color: ${aiColor}; line-height: 1; letter-spacing: -2px;">${aiPercent}</span>
            <span style="font-size: 18px; font-weight: 700; color: ${aiColor}; opacity: 0.7;">%</span>
          </div>
          <div style="font-size: 13px; color: var(--color-fg-muted); margin-top: 4px;">${summary.aiLines.toLocaleString()} lines</div>
        </div>
      </div>

      <!-- Human-Written Card -->
      <div style="background: linear-gradient(135deg, rgba(87, 171, 90, 0.15) 0%, rgba(87, 171, 90, 0.05) 100%); border: 1px solid rgba(87, 171, 90, 0.3); border-radius: 12px; padding: 20px; position: relative; overflow: hidden;">
        <div style="position: absolute; top: -20px; right: -20px; width: 80px; height: 80px; background: rgba(87, 171, 90, 0.1); border-radius: 50%;"></div>
        <div style="position: relative;">
          <div style="font-size: 11px; font-weight: 600; text-transform: uppercase; letter-spacing: 0.5px; color: ${humanColor}; opacity: 0.8; margin-bottom: 8px;">Human-Written</div>
          <div style="display: flex; align-items: baseline; gap: 4px;">
            <span style="font-size: 36px; font-weight: 800; color: ${humanColor}; line-height: 1; letter-spacing: -2px;">${humanPercent}</span>
            <span style="font-size: 18px; font-weight: 700; color: ${humanColor}; opacity: 0.7;">%</span>
          </div>
          <div style="font-size: 13px; color: var(--color-fg-muted); margin-top: 4px;">${summary.humanLines.toLocaleString()} lines</div>
        </div>
      </div>

      <!-- Total Lines Card -->
      <div style="background: linear-gradient(135deg, rgba(163, 113, 247, 0.15) 0%, rgba(163, 113, 247, 0.05) 100%); border: 1px solid rgba(163, 113, 247, 0.3); border-radius: 12px; padding: 20px; position: relative; overflow: hidden;">
        <div style="position: absolute; top: -20px; right: -20px; width: 80px; height: 80px; background: rgba(163, 113, 247, 0.1); border-radius: 50%;"></div>
        <div style="position: relative;">
          <div style="font-size: 11px; font-weight: 600; text-transform: uppercase; letter-spacing: 0.5px; color: #A371F7; opacity: 0.8; margin-bottom: 8px;">Total Lines</div>
          <div style="font-size: 36px; font-weight: 800; color: #A371F7; line-height: 1; letter-spacing: -2px;">${summary.totalLines.toLocaleString()}</div>
          <div style="font-size: 13px; color: var(--color-fg-muted); margin-top: 4px;">tracked in repository</div>
        </div>
      </div>

      <!-- Prompt Efficiency Card -->
      <div style="background: linear-gradient(135deg, rgba(83, 155, 245, 0.15) 0%, rgba(83, 155, 245, 0.05) 100%); border: 1px solid rgba(83, 155, 245, 0.3); border-radius: 12px; padding: 20px; position: relative; overflow: hidden;">
        <div style="position: absolute; top: -20px; right: -20px; width: 80px; height: 80px; background: rgba(83, 155, 245, 0.1); border-radius: 50%;"></div>
        <div style="position: relative;">
          <div style="font-size: 11px; font-weight: 600; text-transform: uppercase; letter-spacing: 0.5px; color: #539BF5; opacity: 0.8; margin-bottom: 8px;">Efficiency</div>
          <div style="font-size: 36px; font-weight: 800; color: #539BF5; line-height: 1; letter-spacing: -2px;">${efficiencyStr}</div>
          <div style="font-size: 13px; color: var(--color-fg-muted); margin-top: 4px;">${summary.commits} commits · ${summary.prompts} prompts</div>
        </div>
      </div>

    </div>

    <!-- Distribution Bar -->
    <div class="Box mb-4">
      <div class="Box-body" style="padding: 16px 20px;">
        <div style="display: flex; align-items: center; gap: 16px;">
          <div style="flex: 1;">
            <div style="display: flex; height: 10px; border-radius: 5px; overflow: hidden; background: var(--color-canvas-subtle);">
              <div style="width: ${aiPercent}%; background: ${aiColor}; transition: width 0.3s ease;"></div>
              <div style="width: ${humanPercent}%; background: ${humanColor}; transition: width 0.3s ease;"></div>
            </div>
          </div>
          <div style="display: flex; gap: 16px; flex-shrink: 0;">
            <div style="display: flex; align-items: center; gap: 6px;">
              <span style="width: 10px; height: 10px; border-radius: 3px; background: ${aiColor};"></span>
              <span style="font-size: 12px; color: var(--color-fg-muted);">AI ${aiPercent}%</span>
            </div>
            <div style="display: flex; align-items: center; gap: 6px;">
              <span style="width: 10px; height: 10px; border-radius: 3px; background: ${humanColor};"></span>
              <span style="font-size: 12px; color: var(--color-fg-muted);">Human ${humanPercent}%</span>
            </div>
          </div>
        </div>
      </div>
    </div>

    <!-- Breakdown Cards Row -->
    ${toolEntries.length > 0 || modelEntries.length > 0 ? `
    <div class="mb-4" style="display: grid; grid-template-columns: ${toolEntries.length > 0 && modelEntries.length > 0 ? '1fr 1fr' : '1fr'}; gap: 16px;">
      ${toolEntries.length > 0 ? `
      <div class="Box">
        <div class="Box-header">
          <h3 class="Box-title f5">By Tool</h3>
        </div>
        <div>
          ${toolEntries.map(([name, lines], i) => {
            const percent = summary.aiLines > 0 ? Math.round((lines / summary.aiLines) * 100) : 0;
            const color = TOOL_COLOR_PALETTE[i % TOOL_COLOR_PALETTE.length];
            return `
          <div class="Box-row d-flex flex-items-center" style="gap: 10px; padding: 10px 16px;">
            <span style="width: 8px; height: 8px; border-radius: 50%; background: ${color}; flex-shrink: 0;"></span>
            <span class="f6 text-bold" style="width: 90px; flex-shrink: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;">${formatProviderName(name)}</span>
            <div style="flex: 1; height: 6px; background: var(--color-neutral-muted); border-radius: 3px; overflow: hidden;">
              <div style="width: ${percent}%; height: 100%; background: ${color}; border-radius: 3px;"></div>
            </div>
            <span class="f6 color-fg-muted" style="min-width: 75px; text-align: right; font-variant-numeric: tabular-nums;">${percent}% · ${lines.toLocaleString()}</span>
          </div>
            `;
          }).join('')}
        </div>
      </div>
      ` : ''}

      ${modelEntries.length > 0 ? `
      <div class="Box">
        <div class="Box-header">
          <h3 class="Box-title f5">Top Models</h3>
        </div>
        <div>
          ${modelEntries.map(([name, lines], i) => {
            const percent = summary.aiLines > 0 ? Math.round((lines / summary.aiLines) * 100) : 0;
            const color = TOOL_COLOR_PALETTE[(toolEntries.length + i) % TOOL_COLOR_PALETTE.length];
            return `
          <div class="Box-row d-flex flex-items-center" style="gap: 10px; padding: 10px 16px;">
            <span style="width: 8px; height: 8px; border-radius: 50%; background: ${color}; flex-shrink: 0;"></span>
            <span class="f6 text-bold" style="width: 130px; flex-shrink: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;" title="${escapeHtml(name)}">${escapeHtml(name)}</span>
            <div style="flex: 1; height: 6px; background: var(--color-neutral-muted); border-radius: 3px; overflow: hidden;">
              <div style="width: ${percent}%; height: 100%; background: ${color}; border-radius: 3px;"></div>
            </div>
            <span class="f6 color-fg-muted" style="min-width: 75px; text-align: right; font-variant-numeric: tabular-nums;">${percent}% · ${lines.toLocaleString()}</span>
          </div>
            `;
          }).join('')}
        </div>
      </div>
      ` : ''}
    </div>
    ` : ''}
  `;
}

/**
 * Render trend charts section
 */
function renderTrendSection(filteredAnalytics: AnalyticsData, fullAnalytics: AnalyticsData): string {
  const trendData = getTrendDataForPeriod(fullAnalytics, currentPeriod);

  // Get tool data for the chart
  const toolEntries = Object.entries(fullAnalytics.summary.tools || {})
    .filter(([, lines]) => lines > 0)
    .sort(([, a], [, b]) => b - a);

  const toolColors = toolEntries.map(([name], i) => ({
    name,
    displayName: formatProviderName(name),
    color: TOOL_COLOR_PALETTE[i % TOOL_COLOR_PALETTE.length],
  }));

  // Get model data for the chart (top 5)
  const modelEntries = Object.entries(fullAnalytics.summary.models)
    .sort(([, a], [, b]) => b - a)
    .slice(0, 5);

  const modelColors = modelEntries.map(([name], i) => ({
    name,
    displayName: name,
    color: TOOL_COLOR_PALETTE[(toolEntries.length + i) % TOOL_COLOR_PALETTE.length],
  }));

  // Build series for charts
  const toolSeries = toolColors.map(t => ({
    data: trendData.tools[t.name] || [],
    color: t.color,
    label: t.displayName,
  }));

  const modelSeries = modelColors.map(m => ({
    data: trendData.models[m.name] || [],
    color: m.color,
    label: m.displayName,
  }));

  // Compute prompt efficiency trend (commits / prompts, higher = better)
  const ratioData = trendData.commits.map((c, i) =>
    trendData.prompts[i] > 0 ? c / trendData.prompts[i] : 0
  );

  const aiColor = "#E07B53";
  const ratioColor = "#C69026";

  return `
    <!-- AI Code Percentage -->
    <div class="Box mb-4">
      <div class="Box-header d-flex flex-justify-between flex-items-center">
        <h3 class="Box-title f5">AI Code Percentage</h3>
        <div class="d-flex flex-items-center gap-2 f6 color-fg-muted">
          <span style="display: inline-block; width: 20px; height: 3px; background: ${aiColor}; border-radius: 2px;"></span>
          AI %
        </div>
      </div>
      <div class="Box-body">
        ${renderTrendLine(trendData.aiPercent, aiColor, 700, 100, 0.15, "%")}
        <div class="d-flex flex-justify-between f6 color-fg-muted mt-2" style="padding: 0 4px 0 53px;">
          <span>${trendData.labels[0] || ''}</span>
          <span>${trendData.labels[trendData.labels.length - 1] || ''}</span>
        </div>
      </div>
    </div>

    <!-- Prompt Efficiency -->
    <div class="Box mb-4">
      <div class="Box-header d-flex flex-justify-between flex-items-center">
        <h3 class="Box-title f5">Prompt Efficiency</h3>
        <div class="d-flex flex-items-center gap-2 f6 color-fg-muted">
          <span style="display: inline-block; width: 20px; height: 3px; background: ${ratioColor}; border-radius: 2px;"></span>
          Commits per Prompt (1.0 = ideal)
        </div>
      </div>
      <div class="Box-body">
        ${ratioData.some(v => v > 0)
          ? renderTrendLine(ratioData, ratioColor, 700, 100, 0.15, "")
          : '<div class="text-center color-fg-muted f6 p-3">No ratio data for this period</div>'
        }
        <div class="d-flex flex-justify-between f6 color-fg-muted mt-2" style="padding: 0 4px 0 53px;">
          <span>${trendData.labels[0] || ''}</span>
          <span>${trendData.labels[trendData.labels.length - 1] || ''}</span>
        </div>
      </div>
    </div>

    <!-- Tool Usage -->
    ${toolColors.length > 0 ? `
    <div class="Box mb-4">
      <div class="Box-header d-flex flex-justify-between flex-items-center">
        <h3 class="Box-title f5">Tool Usage</h3>
        <div class="d-flex flex-wrap gap-3 f6">
          ${toolColors.map(t => `
            <span class="d-flex flex-items-center gap-1">
              <span style="display: inline-block; width: 20px; height: 3px; background: ${t.color}; border-radius: 2px;"></span>
              ${t.displayName}
            </span>
          `).join('')}
        </div>
      </div>
      <div class="Box-body">
        ${toolSeries.some(s => s.data.some(v => v > 0))
          ? renderMultiTrendLine(toolSeries, 700, 100, " lines")
          : '<div class="text-center color-fg-muted f6 p-3">No tool data for this period</div>'
        }
        <div class="d-flex flex-justify-between f6 color-fg-muted mt-2" style="padding: 0 4px 0 53px;">
          <span>${trendData.labels[0] || ''}</span>
          <span>${trendData.labels[trendData.labels.length - 1] || ''}</span>
        </div>
      </div>
    </div>
    ` : ''}

    <!-- Model Usage -->
    ${modelColors.length > 0 ? `
    <div class="Box mb-4">
      <div class="Box-header d-flex flex-justify-between flex-items-center">
        <h3 class="Box-title f5">Model Usage</h3>
        <div class="d-flex flex-wrap gap-3 f6">
          ${modelColors.map(m => `
            <span class="d-flex flex-items-center gap-1" title="${escapeHtml(m.name)}">
              <span style="display: inline-block; width: 20px; height: 3px; background: ${m.color}; border-radius: 2px;"></span>
              ${escapeHtml(m.displayName)}
            </span>
          `).join('')}
        </div>
      </div>
      <div class="Box-body">
        ${modelSeries.some(s => s.data.some(v => v > 0))
          ? renderMultiTrendLine(modelSeries, 700, 100, " lines")
          : '<div class="text-center color-fg-muted f6 p-3">No model data for this period</div>'
        }
        <div class="d-flex flex-justify-between f6 color-fg-muted mt-2" style="padding: 0 4px 0 53px;">
          <span>${trendData.labels[0] || ''}</span>
          <span>${trendData.labels[trendData.labels.length - 1] || ''}</span>
        </div>
      </div>
    </div>
    ` : ''}
  `;
}

/**
 * Generate SVG trend line chart with y-axis labels (rendered as HTML)
 */
function renderTrendLine(
  data: number[],
  color: string,
  width: number = 300,
  height: number = 100,
  fillOpacity: number = 0.1,
  unit: string = ""
): string {
  if (data.length === 0) {
    return `<div style="height: ${height}px; display: flex; align-items: center; justify-content: center;" class="color-fg-muted f6">No data</div>`;
  }

  const max = Math.max(...data, 1);
  const min = Math.min(...data, 0);
  const range = max - min || 1;

  const padding = 4;
  const chartWidth = width;
  const chartHeight = height - padding * 2;

  // Generate points for SVG (0 to width)
  const points = data.map((value, i) => {
    const x = padding + (i / (data.length - 1 || 1)) * (chartWidth - padding * 2);
    const y = padding + chartHeight - ((value - min) / range) * chartHeight;
    return `${x},${y}`;
  }).join(' ');

  // Generate fill polygon (area under the line)
  const fillPoints = `${padding},${height - padding} ${points} ${chartWidth - padding},${height - padding}`;

  // Format y-axis values
  const formatValue = (v: number) => {
    if (v >= 1000) return (v / 1000).toFixed(1) + 'k';
    if (v >= 100) return Math.round(v).toString();
    if (Number.isInteger(v)) return v.toString();
    if (v >= 10) return Math.round(v).toString();
    return v.toFixed(1);
  };

  const maxLabel = formatValue(max) + unit;
  const midValue = (max + min) / 2;
  const midLabel = formatValue(midValue) + unit;
  const minLabel = formatValue(min) + unit;

  return `
    <div style="display: flex; gap: 8px;">
      <!-- Y-axis labels -->
      <div style="display: flex; flex-direction: column; justify-content: space-between; width: 45px; flex-shrink: 0; padding: ${padding}px 0;">
        <span class="f6 color-fg-muted" style="text-align: right;">${maxLabel}</span>
        <span class="f6 color-fg-muted" style="text-align: right;">${midLabel}</span>
        <span class="f6 color-fg-muted" style="text-align: right;">${minLabel}</span>
      </div>
      <!-- Chart -->
      <div style="flex: 1;">
        <svg width="100%" height="${height}" viewBox="0 0 ${width} ${height}" preserveAspectRatio="none" style="display: block;">
          <defs>
            <linearGradient id="gradient-${color.replace('#', '')}" x1="0%" y1="0%" x2="0%" y2="100%">
              <stop offset="0%" style="stop-color:${color};stop-opacity:${fillOpacity * 2}" />
              <stop offset="100%" style="stop-color:${color};stop-opacity:0" />
            </linearGradient>
          </defs>
          <!-- Horizontal grid lines -->
          <line x1="${padding}" y1="${padding}" x2="${chartWidth - padding}" y2="${padding}" stroke="#8b949e" stroke-width="0.5" opacity="0.3" stroke-dasharray="3,3" />
          <line x1="${padding}" y1="${padding + chartHeight / 2}" x2="${chartWidth - padding}" y2="${padding + chartHeight / 2}" stroke="#8b949e" stroke-width="0.5" opacity="0.3" stroke-dasharray="3,3" />
          <line x1="${padding}" y1="${height - padding}" x2="${chartWidth - padding}" y2="${height - padding}" stroke="#8b949e" stroke-width="0.5" opacity="0.3" stroke-dasharray="3,3" />
          <!-- Vertical grid lines -->
          ${[1, 2, 3, 4].map(i => {
            const x = padding + (i / 5) * (chartWidth - padding * 2);
            return `<line x1="${x}" y1="${padding}" x2="${x}" y2="${height - padding}" stroke="#8b949e" stroke-width="0.5" opacity="0.3" stroke-dasharray="3,3" />`;
          }).join('\n          ')}
          <polygon points="${fillPoints}" fill="url(#gradient-${color.replace('#', '')})" />
          <polyline points="${points}" fill="none" stroke="${color}" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" />
        </svg>
      </div>
    </div>
  `;
}

/**
 * Generate multi-line SVG trend chart with y-axis labels (rendered as HTML)
 */
function renderMultiTrendLine(
  series: Array<{ data: number[]; color: string; label: string }>,
  width: number = 300,
  height: number = 100,
  unit: string = ""
): string {
  const allData = series.flatMap(s => s.data);
  if (allData.length === 0) {
    return `<div style="height: ${height}px; display: flex; align-items: center; justify-content: center;" class="color-fg-muted f6">No data</div>`;
  }

  const max = Math.max(...allData, 1);
  const min = 0; // Always start from 0 for comparison
  const range = max - min || 1;

  const padding = 4;
  const chartWidth = width;
  const chartHeight = height - padding * 2;

  const lines = series.map(({ data, color }) => {
    if (data.length === 0) return '';

    const points = data.map((value, i) => {
      const x = padding + (i / (data.length - 1 || 1)) * (chartWidth - padding * 2);
      const y = padding + chartHeight - ((value - min) / range) * chartHeight;
      return `${x},${y}`;
    }).join(' ');

    return `<polyline points="${points}" fill="none" stroke="${color}" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" />`;
  }).join('');

  // Format y-axis values
  const formatValue = (v: number) => {
    if (v >= 1000) return (v / 1000).toFixed(1) + 'k';
    if (v >= 100) return Math.round(v).toString();
    if (Number.isInteger(v)) return v.toString();
    if (v >= 10) return Math.round(v).toString();
    return v.toFixed(1);
  };

  const maxLabel = formatValue(max) + unit;
  const midLabel = formatValue(max / 2) + unit;
  const minLabel = "0";

  return `
    <div style="display: flex; gap: 8px;">
      <!-- Y-axis labels -->
      <div style="display: flex; flex-direction: column; justify-content: space-between; width: 45px; flex-shrink: 0; padding: ${padding}px 0;">
        <span class="f6 color-fg-muted" style="text-align: right;">${maxLabel}</span>
        <span class="f6 color-fg-muted" style="text-align: right;">${midLabel}</span>
        <span class="f6 color-fg-muted" style="text-align: right;">${minLabel}</span>
      </div>
      <!-- Chart -->
      <div style="flex: 1;">
        <svg width="100%" height="${height}" viewBox="0 0 ${width} ${height}" preserveAspectRatio="none" style="display: block;">
          <!-- Horizontal grid lines -->
          <line x1="${padding}" y1="${padding}" x2="${chartWidth - padding}" y2="${padding}" stroke="#8b949e" stroke-width="0.5" opacity="0.3" stroke-dasharray="3,3" />
          <line x1="${padding}" y1="${padding + chartHeight / 2}" x2="${chartWidth - padding}" y2="${padding + chartHeight / 2}" stroke="#8b949e" stroke-width="0.5" opacity="0.3" stroke-dasharray="3,3" />
          <line x1="${padding}" y1="${height - padding}" x2="${chartWidth - padding}" y2="${height - padding}" stroke="#8b949e" stroke-width="0.5" opacity="0.3" stroke-dasharray="3,3" />
          <!-- Vertical grid lines -->
          ${[1, 2, 3, 4].map(i => {
            const x = padding + (i / 5) * (chartWidth - padding * 2);
            return `<line x1="${x}" y1="${padding}" x2="${x}" y2="${height - padding}" stroke="#8b949e" stroke-width="0.5" opacity="0.3" stroke-dasharray="3,3" />`;
          }).join('\n          ')}
          ${lines}
        </svg>
      </div>
    </div>
  `;
}

/**
 * Trend data result type
 */
interface TrendResult {
  aiPercent: number[];
  commits: number[];
  prompts: number[];
  tools: Record<string, number[]>;
  models: Record<string, number[]>;
  labels: string[];
}

/**
 * Generate labels from end date working backwards
 * For hourly data > 24 slots, include date; otherwise just hour
 */
function generateLabels(end: string, count: number, isHourly: boolean): string[] {
  const labels: string[] = [];
  const endDate = new Date(end + (isHourly ? ':00:00Z' : 'T00:00:00Z'));

  for (let i = count - 1; i >= 0; i--) {
    const d = new Date(endDate.getTime() - i * (isHourly ? 60 * 60 * 1000 : 24 * 60 * 60 * 1000));
    if (isHourly) {
      if (count > 24) {
        // For 3-day view, include month-day and hour
        labels.push(`${(d.getMonth() + 1)}/${d.getDate()} ${d.getHours().toString().padStart(2, '0')}:00`);
      } else {
        // For 24-hour view, just show hour
        labels.push(d.getHours().toString().padStart(2, '0') + ':00');
      }
    } else {
      labels.push(`${(d.getMonth() + 1).toString().padStart(2, '0')}-${d.getDate().toString().padStart(2, '0')}`);
    }
  }

  return labels;
}

/**
 * Get trend data for the selected period
 * Uses pre-computed arrays from trends, just slices for the period
 */
function getTrendDataForPeriod(analytics: AnalyticsData, period: PeriodOption): TrendResult {
  const emptyResult: TrendResult = {
    aiPercent: [],
    commits: [],
    prompts: [],
    tools: {},
    models: {},
    labels: [],
  };

  if (!analytics.trends) {
    return emptyResult;
  }

  // Determine which bucket and how many slots to use
  const useHourly = period === "24h" || period === "3d";
  const bucket = useHourly ? analytics.trends.hourly : analytics.trends.daily;

  if (!bucket) {
    return emptyResult;
  }

  // Determine slice size
  let sliceSize: number;
  if (period === "24h") sliceSize = 24;
  else if (period === "3d") sliceSize = 72;
  else if (period === "1w") sliceSize = 7;
  else sliceSize = 30; // 1m or all

  // Slice from end of arrays (most recent data)
  const sliceStart = Math.max(0, bucket.ai.length - sliceSize);

  const ai = bucket.ai.slice(sliceStart);
  const human = bucket.human.slice(sliceStart);
  const commits = bucket.commits.slice(sliceStart);
  const prompts = bucket.prompts.slice(sliceStart);

  // Compute AI percent from ai and human
  const aiPercent = ai.map((a, i) => {
    const total = a + human[i];
    return total > 0 ? Math.round((a / total) * 100) : 0;
  });

  // Slice tool and model data
  const tools: Record<string, number[]> = {};
  for (const [name, data] of Object.entries(bucket.tools || {})) {
    tools[name] = data.slice(sliceStart);
  }

  const models: Record<string, number[]> = {};
  for (const [name, data] of Object.entries(bucket.models || {})) {
    models[name] = data.slice(sliceStart);
  }

  // Generate labels from end date
  const labels = generateLabels(bucket.end, ai.length, useHourly);

  return {
    aiPercent,
    commits,
    prompts,
    tools,
    models,
    labels,
  };
}

/**
 * Render Contributors section
 */
function renderContributorsSection(analytics: AnalyticsData): string {
  const contributors = Object.entries(analytics.contributors)
    .map(([username, stats]) => ({ username, ...stats }))
    .sort((a, b) => b.totalLines - a.totalLines);

  if (contributors.length === 0) {
    return `
      <div class="Box mb-4">
        <div class="Box-header">
          <h3 class="Box-title f3">Contributors</h3>
        </div>
        <div class="Box-body">
          <div class="blankslate" style="border: 1px dashed var(--color-border-default); border-radius: 6px; padding: 24px;">
            <p class="color-fg-muted f6">No contributor data available for this period.</p>
          </div>
        </div>
      </div>
    `;
  }

  const aiColor = "#E07B53";
  const humanColor = "#57AB5A";

  const rows = contributors
    .slice(0, 10)
    .map((c, index) => {
      const aiPercent =
        c.totalLines > 0 ? Math.round((c.aiLines / c.totalLines) * 100) : 0;
      const humanPercent = 100 - aiPercent;

      // Prompt efficiency: commits / prompts (higher = better)
      const efficiency = c.prompts > 0 ? (c.commits / c.prompts) : 0;
      const efficiencyStr = efficiency > 0 ? efficiency.toFixed(2) : "0";
      const ratioColor = efficiency >= 0.67 ? "#57AB5A" : efficiency >= 0.4 ? "#C69026" : "#8b949e";

      // GitHub avatar URL - works for any username (not emails)
      const isEmail = c.username.includes('@');
      const avatarUrl = isEmail ? '' : `https://github.com/${encodeURIComponent(c.username)}.png?size=64`;
      const initial = c.username.charAt(0).toUpperCase();

      return `
      <div class="d-flex flex-items-center gap-3 py-3 px-3 ${index > 0 ? 'border-top' : ''}">
        <div style="width: 32px; height: 32px; flex-shrink: 0; position: relative;">
          ${!isEmail ? `
          <img
            src="${avatarUrl}"
            alt="${escapeHtml(c.username)}"
            class="ab-avatar-img"
            style="width: 32px; height: 32px; border-radius: 50%; background: var(--color-canvas-subtle); position: absolute; top: 0; left: 0;"
          />
          ` : ''}
          <div style="width: 32px; height: 32px; border-radius: 50%; background: var(--color-canvas-subtle); ${isEmail ? 'display: flex' : 'display: none'}; align-items: center; justify-content: center; font-size: 14px; font-weight: 600; color: var(--color-fg-muted);">
            ${escapeHtml(initial)}
          </div>
        </div>
        <div style="min-width: 120px; flex-shrink: 0;">
          <a href="https://github.com/${escapeHtml(c.username)}" class="Link--primary text-bold f6" target="_blank">${escapeHtml(c.username)}</a>
          <div class="f6 color-fg-muted">${c.prs} PRs, ${c.commits} commits</div>
        </div>
        <div class="flex-1 d-flex flex-items-center gap-3">
          <div class="d-flex flex-1 rounded-2 overflow-hidden" style="height: 8px; max-width: 150px; background: var(--color-canvas-subtle);">
            <div style="width: ${aiPercent}%; background: ${aiColor}; transition: width 0.3s ease;"></div>
            <div style="width: ${humanPercent}%; background: ${humanColor}; transition: width 0.3s ease;"></div>
          </div>
          <span class="f6" style="width: 55px; color: ${aiColor}; font-weight: 600;">${aiPercent}% AI</span>
        </div>
        <div class="f6 text-center" style="min-width: 60px;">
          <span class="text-bold" style="color: ${ratioColor};">${efficiencyStr}</span>
        </div>
        <div class="f6 text-right" style="min-width: 80px;">
          <span class="text-bold">${c.totalLines.toLocaleString()}</span>
          <span class="color-fg-muted"> lines</span>
        </div>
      </div>
    `;
    })
    .join("");

  return `
    <div class="Box mb-4">
      <div class="Box-header d-flex flex-justify-between flex-items-center">
        <h3 class="Box-title f3">Contributors</h3>
        <span class="Counter Counter--secondary">${contributors.length}</span>
      </div>
      <div style="max-height: 400px; overflow-y: auto;">
        ${rows}
      </div>
      ${contributors.length > 10 ? `
      <div class="Box-footer text-center f6 color-fg-muted" style="background: var(--color-canvas-subtle); border-top: 1px solid var(--color-border-default); padding: 12px;">
        Showing top 10 of ${contributors.length} contributors
      </div>
      ` : ''}
    </div>
  `;
}

/**
 * Render Recent PRs section
 */
function renderPullRequestsSection(
  analytics: AnalyticsData,
  owner: string,
  repo: string
): string {
  const recentPRs = analytics.history.slice(0, 15);

  if (recentPRs.length === 0) {
    return `
      <div class="Box mb-4">
        <div class="Box-header">
          <h3 class="Box-title f3">Recent Activity</h3>
        </div>
        <div class="Box-body">
          <div class="blankslate" style="border: 1px dashed var(--color-border-default); border-radius: 6px; padding: 24px;">
            <p class="color-fg-muted f6">No activity data available for this period.</p>
          </div>
        </div>
      </div>
    `;
  }

  const aiColor = "#E07B53";
  const humanColor = "#57AB5A";

  const rows = recentPRs
    .map((pr, index) => {
      const aiPercent = pr.added > 0 ? Math.round((pr.aiLines / pr.added) * 100) : 0;
      const humanPercent = 100 - aiPercent;

      // Prompt efficiency: commits / prompts (higher = better)
      const efficiency = pr.prompts > 0 ? (pr.commits / pr.prompts) : 0;
      const efficiencyStr = efficiency > 0 ? efficiency.toFixed(2) : "0";
      const ratioColor = efficiency >= 0.67 ? "#57AB5A" : efficiency >= 0.4 ? "#C69026" : "#8b949e";

      // Badge color based on AI percentage
      let badgeColor = humanColor;
      let badgeText = "Human";
      if (aiPercent > 75) {
        badgeColor = aiColor;
        badgeText = `${aiPercent}% AI`;
      } else if (aiPercent > 25) {
        badgeColor = "#C69026"; // Amber for mixed
        badgeText = `${aiPercent}% AI`;
      } else if (aiPercent > 0) {
        badgeColor = humanColor;
        badgeText = `${aiPercent}% AI`;
      }

      const dateStr = pr.date ? formatDate(pr.date).split(',')[0] : '';

      return `
      <div class="d-flex flex-items-center gap-3 py-3 px-3 ${index > 0 ? 'border-top' : ''}">
        <div style="min-width: 50px;">
          <a href="https://github.com/${owner}/${repo}/pull/${pr.pr}" class="Link--primary f6 text-bold" target="_blank">#${pr.pr}</a>
        </div>
        <div class="flex-1" style="min-width: 0;">
          <a href="https://github.com/${owner}/${repo}/pull/${pr.pr}" class="Link--primary f6 d-block text-truncate" target="_blank" title="${escapeHtml(pr.title || `PR #${pr.pr}`)}">
            ${escapeHtml(pr.title || `PR #${pr.pr}`)}
          </a>
          <div class="f6 color-fg-muted d-flex gap-2">
            <span>${escapeHtml(pr.author)}</span>
            ${dateStr ? `<span>•</span><span>${dateStr}</span>` : ''}
          </div>
        </div>
        <div class="d-flex flex-items-center gap-2" style="min-width: 140px;">
          <div class="d-flex rounded-2 overflow-hidden" style="width: 60px; height: 6px; background: var(--color-canvas-subtle);">
            <div style="width: ${aiPercent}%; background: ${aiColor};"></div>
            <div style="width: ${humanPercent}%; background: ${humanColor};"></div>
          </div>
          <span class="Label f6" style="background: ${badgeColor}20; color: ${badgeColor}; border: 1px solid ${badgeColor}40; min-width: 55px; text-align: center;">
            ${badgeText}
          </span>
        </div>
        <div class="f6 text-center" style="min-width: 50px;" title="${pr.commits} commits, ${pr.prompts} prompts">
          <span style="color: ${ratioColor}; font-weight: 600;">${efficiencyStr}</span>
        </div>
        <div class="f6 text-right color-fg-muted" style="min-width: 70px;">
          <span class="color-fg-success">+${pr.added}</span>
          <span>/</span>
          <span class="color-fg-danger">-${pr.removed}</span>
        </div>
      </div>
    `;
    })
    .join("");

  return `
    <div class="Box mb-4">
      <div class="Box-header d-flex flex-justify-between flex-items-center">
        <h3 class="Box-title f3">Recent Activity</h3>
        <span class="Counter Counter--secondary">${recentPRs.length}</span>
      </div>
      <div style="max-height: 500px; overflow-y: auto;">
        ${rows}
      </div>
    </div>
  `;
}

/**
 * Format date for display
 */
function formatDate(dateStr: string): string {
  try {
    const date = new Date(dateStr);
    return date.toLocaleDateString("en-US", {
      year: "numeric",
      month: "short",
      day: "numeric",
      hour: "2-digit",
      minute: "2-digit",
    });
  } catch {
    return dateStr;
  }
}

/**
 * Escape HTML to prevent XSS
 */
function escapeHtml(str: string): string {
  const div = document.createElement("div");
  div.textContent = str;
  return div.innerHTML;
}
