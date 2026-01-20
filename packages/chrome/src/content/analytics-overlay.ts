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
  getAnalytics,
} from "../lib/mock-analytics";

const PAGE_CONTAINER_ID = "agentblame-page-container";
const ORIGINAL_CONTENT_ATTR = "data-agentblame-hidden";

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
    const analytics = await getAnalytics(owner, repo);

    if (!analytics) {
      pageContainer.innerHTML = renderEmptyState();
      return;
    }

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

// Period options for filtering
type PeriodOption = "24h" | "1w" | "1m" | "all";

const PERIOD_LABELS: Record<PeriodOption, string> = {
  "24h": "24 hours",
  "1w": "1 week",
  "1m": "1 month",
  "all": "All time",
};

// Current selected period (module-level state)
let currentPeriod: PeriodOption = "1m";
let currentOwner = "";
let currentRepo = "";
let currentAnalytics: AnalyticsData | null = null;

/**
 * Filter analytics data by period
 */
function filterAnalyticsByPeriod(
  analytics: AnalyticsData,
  period: PeriodOption
): AnalyticsData {
  if (period === "all") {
    return analytics;
  }

  const now = Date.now();
  const cutoffs: Record<Exclude<PeriodOption, "all">, number> = {
    "24h": now - 24 * 60 * 60 * 1000,
    "1w": now - 7 * 24 * 60 * 60 * 1000,
    "1m": now - 30 * 24 * 60 * 60 * 1000,
  };

  const cutoff = cutoffs[period];

  // Filter history entries
  const filteredHistory = analytics.history.filter((entry) => {
    const entryDate = new Date(entry.d).getTime();
    return entryDate >= cutoff;
  });

  // Recalculate summary from filtered history
  let totalLines = 0;
  let aiLines = 0;
  const byProvider: Record<string, number> = {};
  const byModel: Record<string, number> = {};
  const contributors: Record<string, typeof analytics.contributors[string]> = {};

  for (const entry of filteredHistory) {
    totalLines += entry.a;
    aiLines += entry.ai;

    // Aggregate by provider
    if (entry.p) {
      for (const [provider, count] of Object.entries(entry.p)) {
        byProvider[provider] = (byProvider[provider] || 0) + count;
      }
    }

    // Aggregate by model
    if (entry.m) {
      for (const [model, count] of Object.entries(entry.m)) {
        byModel[model] = (byModel[model] || 0) + count;
      }
    }

    // Aggregate by contributor
    if (!contributors[entry.author]) {
      contributors[entry.author] = {
        total_lines: 0,
        ai_lines: 0,
        by_provider: {},
        by_model: {},
        pr_count: 0,
      };
    }
    const c = contributors[entry.author];
    c.total_lines += entry.a;
    c.ai_lines += entry.ai;
    c.pr_count += 1;
    if (entry.p) {
      for (const [provider, count] of Object.entries(entry.p)) {
        c.by_provider[provider] = (c.by_provider[provider] || 0) + count;
      }
    }
    if (entry.m) {
      for (const [model, count] of Object.entries(entry.m)) {
        c.by_model[model] = (c.by_model[model] || 0) + count;
      }
    }
  }

  return {
    version: 2,
    summary: {
      total_lines: totalLines,
      ai_lines: aiLines,
      human_lines: totalLines - aiLines,
      by_provider: byProvider as AnalyticsData["summary"]["by_provider"],
      by_model: byModel,
      last_updated: analytics.summary.last_updated,
    },
    contributors,
    history: filteredHistory,
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
 * Attach event listeners to period dropdown
 */
function attachPeriodListeners(): void {
  const dropdown = document.getElementById("agentblame-period-select");
  if (dropdown) {
    dropdown.addEventListener("change", (e) => {
      const select = e.target as HTMLSelectElement;
      handlePeriodChange(select.value as PeriodOption);
    });
  }
}

/**
 * Render the full analytics page with 3 sections
 */
function renderAnalyticsPage(
  owner: string,
  repo: string,
  analytics: AnalyticsData,
  fullAnalytics?: AnalyticsData
): string {
  const aiPercent =
    analytics.summary.total_lines > 0
      ? Math.round(
          (analytics.summary.ai_lines / analytics.summary.total_lines) * 100
        )
      : 0;

  // Use fullAnalytics for last_updated if available
  const lastUpdated = fullAnalytics?.summary.last_updated || analytics.summary.last_updated;

  return `
    <div class="mt-4">
      <!-- Page Header -->
      <div class="Subhead mb-4 d-flex flex-justify-between flex-items-center">
        <div>
          <h2 class="Subhead-heading">Agent Blame</h2>
          <div class="Subhead-description">
            AI code attribution analytics
          </div>
        </div>
        <div>
          <select id="agentblame-period-select" class="form-select">
            ${(Object.keys(PERIOD_LABELS) as PeriodOption[])
              .map(
                (p) =>
                  `<option value="${p}" ${p === currentPeriod ? "selected" : ""}>${PERIOD_LABELS[p]}</option>`
              )
              .join("")}
          </select>
        </div>
      </div>

      <!-- Repository Overview Section -->
      ${renderRepositorySection(analytics, aiPercent)}

      <!-- Contributors Section -->
      ${renderContributorsSection(analytics)}

      <!-- Recent PRs Section -->
      ${renderPullRequestsSection(analytics, owner, repo)}

      <!-- Footer -->
      <div class="f6 color-fg-muted mt-4 pb-4 text-right">
        Last updated: ${formatDate(lastUpdated)}
        &middot;
        <a href="https://github.com/mesa-dot-dev/agentblame" target="_blank" class="Link--muted">
          Powered by Agent Blame
        </a>
      </div>
    </div>
  `;
}

/**
 * Render Repository Overview section
 */
function renderRepositorySection(
  analytics: AnalyticsData,
  aiPercent: number
): string {
  const { summary } = analytics;
  const cursorLines = summary.by_provider.cursor || 0;
  const claudeLines = summary.by_provider.claude_code || 0;
  const humanPercent = 100 - aiPercent;

  // Get top models sorted by lines
  const modelEntries = Object.entries(summary.by_model).sort(
    ([, a], [, b]) => b - a
  );
  const totalModelLines = modelEntries.reduce((sum, [, v]) => sum + v, 0);

  return `
    <div class="Box mb-4">
      <div class="Box-header">
        <h3 class="Box-title">Repository Overview</h3>
      </div>
      <div class="Box-body">
        <!-- Stats Cards -->
        <div class="d-flex gap-3 mb-4">
          <!-- AI Percentage Card -->
          <div class="flex-1 text-center p-3 rounded-2" style="background: var(--color-severe-subtle); border: 1px solid var(--color-severe-muted);">
            <div class="f1 text-bold" style="color: var(--color-severe-fg);">${aiPercent}%</div>
            <div class="f6 color-fg-muted">AI-written code</div>
            <div class="f6 color-fg-muted">${summary.ai_lines.toLocaleString()} of ${summary.total_lines.toLocaleString()} lines</div>
          </div>
          <!-- Cursor Card -->
          <div class="flex-1 text-center p-3 rounded-2 color-bg-subtle">
            <div class="f2 text-bold color-fg-default">${cursorLines.toLocaleString()}</div>
            <div class="f6 color-fg-muted">Cursor</div>
          </div>
          <!-- Claude Card -->
          <div class="flex-1 text-center p-3 rounded-2 color-bg-subtle">
            <div class="f2 text-bold color-fg-default">${claudeLines.toLocaleString()}</div>
            <div class="f6 color-fg-muted">Claude Code</div>
          </div>
        </div>

        <!-- AI/Human Progress Bar -->
        <div class="mb-4">
          <div class="d-flex flex-justify-between f6 mb-1">
            <span style="color: var(--color-severe-fg);">AI ${aiPercent}%</span>
            <span style="color: var(--color-success-fg);">Human ${humanPercent}%</span>
          </div>
          <div class="d-flex rounded-2 overflow-hidden" style="height: 8px;">
            <div style="width: ${aiPercent}%; background: var(--color-severe-fg);"></div>
            <div style="width: ${humanPercent}%; background: var(--color-success-fg);"></div>
          </div>
        </div>

        <!-- Model Breakdown -->
        ${
          modelEntries.length > 0
            ? `
        <div>
          <h4 class="f6 color-fg-muted mb-2">By Model</h4>
          <div class="d-flex flex-column gap-2">
            ${modelEntries
              .slice(0, 5)
              .map(([model, lines]) => {
                const percent =
                  totalModelLines > 0
                    ? Math.round((lines / totalModelLines) * 100)
                    : 0;
                return `
                <div class="d-flex flex-items-center gap-2">
                  <span class="f6" style="width: 140px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis;">${escapeHtml(formatModelName(model))}</span>
                  <span class="Progress flex-1" style="height: 8px;">
                    <span class="Progress-item" style="width: ${percent}%; background: var(--color-severe-fg);"></span>
                  </span>
                  <span class="f6 color-fg-muted" style="width: 50px; text-align: right;">${percent}%</span>
                </div>
              `;
              })
              .join("")}
          </div>
        </div>
        `
            : ""
        }
      </div>
    </div>
  `;
}

/**
 * Render Contributors section
 */
function renderContributorsSection(analytics: AnalyticsData): string {
  const contributors = Object.entries(analytics.contributors)
    .map(([username, stats]) => ({ username, ...stats }))
    .sort((a, b) => b.total_lines - a.total_lines)
    .slice(0, 10);

  if (contributors.length === 0) {
    return `
      <div class="Box mb-4">
        <div class="Box-header">
          <h3 class="Box-title">Contributors</h3>
        </div>
        <div class="Box-body">
          <div class="blankslate">
            <p class="color-fg-muted">No contributor data available yet.</p>
          </div>
        </div>
      </div>
    `;
  }

  const rows = contributors
    .map((c) => {
      const aiPercent =
        c.total_lines > 0 ? Math.round((c.ai_lines / c.total_lines) * 100) : 0;
      const humanPercent = 100 - aiPercent;

      return `
      <div class="Box-row d-flex flex-items-center gap-3">
        <div style="width: 120px;">
          <a href="https://github.com/${c.username}" class="Link--primary text-bold f6">${escapeHtml(c.username)}</a>
        </div>
        <div class="flex-1 d-flex flex-items-center gap-2">
          <span class="f6 color-fg-muted" style="width: 55px;">${aiPercent}% AI</span>
          <div class="d-flex flex-1 rounded-2 overflow-hidden" style="height: 8px; max-width: 200px;">
            <div style="width: ${aiPercent}%; background: var(--color-severe-fg);"></div>
            <div style="width: ${humanPercent}%; background: var(--color-success-fg);"></div>
          </div>
        </div>
        <div class="f6 color-fg-muted text-right" style="width: 90px;">
          ${c.total_lines.toLocaleString()} lines
        </div>
        <div class="f6 color-fg-muted text-right" style="width: 60px;">
          ${c.pr_count} PRs
        </div>
      </div>
    `;
    })
    .join("");

  return `
    <div class="Box mb-4">
      <div class="Box-header d-flex flex-justify-between flex-items-center">
        <h3 class="Box-title">Contributors</h3>
        <span class="Counter">${contributors.length}</span>
      </div>
      ${rows}
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
  const recentPRs = analytics.history.slice(0, 10);

  if (recentPRs.length === 0) {
    return `
      <div class="Box mb-4">
        <div class="Box-header">
          <h3 class="Box-title">Recent Pull Requests</h3>
        </div>
        <div class="Box-body">
          <div class="blankslate">
            <p class="color-fg-muted">No pull request data available yet.</p>
          </div>
        </div>
      </div>
    `;
  }

  const rows = recentPRs
    .map((pr) => {
      const aiPercent = pr.a > 0 ? Math.round((pr.ai / pr.a) * 100) : 0;
      const badgeStyle =
        aiPercent > 50
          ? "background: var(--color-severe-fg); color: white;"
          : aiPercent > 0
            ? "background: var(--color-attention-emphasis); color: white;"
            : "background: var(--color-success-emphasis); color: white;";

      return `
      <div class="Box-row d-flex flex-items-center gap-3">
        <span class="f6 color-fg-muted" style="width: 45px;">#${pr.pr}</span>
        <div class="flex-1 text-truncate">
          <a href="https://github.com/${owner}/${repo}/pull/${pr.pr}" class="Link--primary f6">
            ${escapeHtml(pr.t || `PR #${pr.pr}`)}
          </a>
        </div>
        <span class="f6 color-fg-muted" style="width: 80px;">
          ${escapeHtml(pr.author)}
        </span>
        <span class="f6 color-fg-muted" style="width: 70px; text-align: right;">
          +${pr.a}/-${pr.r}
        </span>
        <span class="Label f6" style="${badgeStyle} width: 60px; text-align: center;">
          ${aiPercent}% AI
        </span>
      </div>
    `;
    })
    .join("");

  return `
    <div class="Box mb-4">
      <div class="Box-header d-flex flex-justify-between flex-items-center">
        <h3 class="Box-title">Recent Pull Requests</h3>
        <span class="Counter">${recentPRs.length}</span>
      </div>
      ${rows}
    </div>
  `;
}

/**
 * Format model name for display
 */
function formatModelName(model: string): string {
  return model
    .replace(/-/g, " ")
    .replace(/\b\w/g, (c) => c.toUpperCase());
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
