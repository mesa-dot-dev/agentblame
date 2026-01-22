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

// Tool color palette - High contrast colors that work in light/dark themes
const TOOL_COLOR_PALETTE = [
  "#0969da", // Blue
  "#cf222e", // Red
  "#1a7f37", // Green
  "#8250df", // Purple
  "#bf8700", // Gold/Yellow
  "#0550ae", // Dark Blue
  "#bf3989", // Magenta
  "#1b7c83", // Teal
];

/**
 * Format provider/tool name for display
 */
function formatProviderName(provider: string): string {
  const names: Record<string, string> = {
    cursor: "Cursor",
    claudeCode: "Claude Code",
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
    const entryDate = new Date(entry.date).getTime();
    return entryDate >= cutoff;
  });

  // Recalculate summary from filtered history
  let totalLines = 0;
  let aiLines = 0;
  const providers: Record<string, number> = {};
  const models: Record<string, number> = {};
  const contributors: Record<string, typeof analytics.contributors[string]> = {};

  for (const entry of filteredHistory) {
    totalLines += entry.added;
    aiLines += entry.aiLines;

    // Aggregate by provider
    if (entry.providers) {
      for (const [provider, count] of Object.entries(entry.providers)) {
        providers[provider] = (providers[provider] || 0) + count;
      }
    }

    // Aggregate by model
    if (entry.models) {
      for (const [model, count] of Object.entries(entry.models)) {
        models[model] = (models[model] || 0) + count;
      }
    }

    // Aggregate by contributor
    if (!contributors[entry.author]) {
      contributors[entry.author] = {
        totalLines: 0,
        aiLines: 0,
        providers: {},
        models: {},
        prCount: 0,
      };
    }
    const c = contributors[entry.author];
    c.totalLines += entry.added;
    c.aiLines += entry.aiLines;
    c.prCount += 1;
    if (entry.providers) {
      for (const [provider, count] of Object.entries(entry.providers)) {
        c.providers[provider] = (c.providers[provider] || 0) + count;
      }
    }
    if (entry.models) {
      for (const [model, count] of Object.entries(entry.models)) {
        c.models[model] = (c.models[model] || 0) + count;
      }
    }
  }

  return {
    version: 2,
    summary: {
      totalLines: totalLines,
      aiLines: aiLines,
      humanLines: totalLines - aiLines,
      providers: providers as AnalyticsData["summary"]["providers"],
      models: models,
      updated: analytics.summary.updated,
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
    analytics.summary.totalLines > 0
      ? Math.round(
          (analytics.summary.aiLines / analytics.summary.totalLines) * 100
        )
      : 0;

  // Use fullAnalytics for updated if available
  const lastUpdated = fullAnalytics?.summary.updated || analytics.summary.updated;

  return `
    <div>
      <!-- Page Header -->
      <div class="Subhead d-flex flex-justify-between flex-items-center">
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
  const cursorLines = summary.providers.cursor || 0;
  const claudeLines = summary.providers.claudeCode || 0;
  const humanPercent = 100 - aiPercent;

  // Build provider data dynamically
  const providerEntries = Object.entries(summary.providers)
    .filter(([, lines]) => lines > 0)
    .sort(([, a], [, b]) => b - a);
  const totalProviderLines = providerEntries.reduce((sum, [, lines]) => sum + lines, 0);

  // Calculate percentages and assign colors
  const providerData = providerEntries.map(([name, lines], index) => ({
    name: formatProviderName(name),
    lines,
    percent: totalProviderLines > 0 ? Math.round((lines / totalProviderLines) * 100) : 0,
    color: TOOL_COLOR_PALETTE[index % TOOL_COLOR_PALETTE.length],
  }));

  // Build conic-gradient stops
  let gradientStops = "";
  let currentPercent = 0;
  for (const provider of providerData) {
    gradientStops += `${provider.color} ${currentPercent}% ${currentPercent + provider.percent}%, `;
    currentPercent += provider.percent;
  }
  gradientStops = gradientStops.slice(0, -2); // Remove trailing comma

  // Get top models sorted by lines
  const modelEntries = Object.entries(summary.models).sort(
    ([, a], [, b]) => b - a
  );

  // Colors
  const aiColor = "var(--color-severe-fg, #f78166)"; // GitHub's coral orange
  const humanColor = "var(--color-success-fg, #238636)"; // GitHub's addition green

  return `
    <div class="Box mb-4">
      <div class="Box-header">
        <h3 class="Box-title">Repository Overview</h3>
      </div>
      <div class="Box-body">
        <!-- Three Column Layout: Stats | Provider Pie | AI vs Human Pie -->
        <div class="d-flex gap-4 mb-4">
          <!-- Left: AI Stats -->
          <div class="flex-1 text-center p-3">
            <div style="font-size: 48px; font-weight: bold; color: ${aiColor};">${aiPercent}%</div>
            <div class="f5 text-bold mb-1">AI-Written Code</div>
            <div class="f6 color-fg-muted">${summary.aiLines.toLocaleString()} of ${summary.totalLines.toLocaleString()} lines</div>
          </div>

          <!-- Middle: Provider Pie Chart -->
          <div class="flex-1 text-center p-3">
            <div style="width: 100px; height: 100px; border-radius: 50%; margin: 0 auto 12px; background: conic-gradient(${gradientStops || '#6e7781 0% 100%'});"></div>
            <div class="f5 text-bold mb-2">By Tool</div>
            <div class="d-flex flex-justify-center flex-wrap gap-2 f6">
              ${providerData.map(p => `<span><span style="display: inline-block; width: 10px; height: 10px; border-radius: 50%; background: ${p.color}; margin-right: 4px;"></span>${p.name} ${p.percent}%</span>`).join('')}
            </div>
          </div>

          <!-- Right: AI vs Human Pie Chart -->
          <div class="flex-1 text-center p-3">
            <div style="width: 100px; height: 100px; border-radius: 50%; margin: 0 auto 12px; background: conic-gradient(${aiColor} 0% ${aiPercent}%, ${humanColor} ${aiPercent}% 100%);"></div>
            <div class="f5 text-bold mb-2">AI vs Human</div>
            <div class="d-flex flex-justify-center gap-3 f6">
              <span><span style="display: inline-block; width: 10px; height: 10px; border-radius: 50%; background: ${aiColor}; margin-right: 4px;"></span>AI ${aiPercent}%</span>
              <span><span style="display: inline-block; width: 10px; height: 10px; border-radius: 50%; background: ${humanColor}; margin-right: 4px;"></span>Human ${humanPercent}%</span>
            </div>
          </div>
        </div>

        <!-- Model Breakdown -->
        ${
          modelEntries.length > 0
            ? `
        <div>
          <h4 class="f6 color-fg-muted mb-2">By Model</h4>
          <div class="d-flex flex-column gap-3">
            ${(() => {
              const totalLines = modelEntries.reduce((sum, [, l]) => sum + l, 0);
              return modelEntries
                .slice(0, 10)
                .map(([model, lines]) => {
                  const barPercent = totalLines > 0 ? Math.round((lines / totalLines) * 100) : 0;
                  return `
                  <div>
                    <div class="d-flex flex-justify-between mb-1">
                      <span class="f6 text-bold">${escapeHtml(formatModelName(model))}</span>
                      <span class="f6 color-fg-muted">${lines.toLocaleString()} lines</span>
                    </div>
                    <div class="Progress" style="height: 10px;">
                      <span class="Progress-item" style="width: ${barPercent}%; background-color: ${aiColor};"></span>
                    </div>
                  </div>
                `;
                })
                .join("");
            })()}
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
    .sort((a, b) => b.totalLines - a.totalLines);

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
        c.totalLines > 0 ? Math.round((c.aiLines / c.totalLines) * 100) : 0;
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
          ${c.totalLines.toLocaleString()} lines
        </div>
        <div class="f6 color-fg-muted text-right" style="width: 60px;">
          ${c.prCount} PRs
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
  const recentPRs = analytics.history.slice(0, 20);

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
      const aiPercent = pr.added > 0 ? Math.round((pr.aiLines / pr.added) * 100) : 0;
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
            ${escapeHtml(pr.title || `PR #${pr.pr}`)}
          </a>
        </div>
        <span class="f6 color-fg-muted" style="width: 80px;">
          ${escapeHtml(pr.author)}
        </span>
        <span class="f6 color-fg-muted" style="width: 70px; text-align: right;">
          +${pr.added}/-${pr.removed}
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
