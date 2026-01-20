/**
 * Analytics Sidebar Injection
 *
 * Injects "Agent Blame" as a sidebar item in GitHub's Insights page,
 * positioned after "Pulse". Only shows if analytics data exists for the repo.
 */

import { showAnalyticsPage, hideAnalyticsPage } from "./analytics-overlay";
import { checkAnalyticsExist } from "../lib/mock-analytics";

const SIDEBAR_ITEM_ID = "agentblame-sidebar-item";

/**
 * Check if we're on an Insights page
 */
export function isInsightsPage(): boolean {
  const path = window.location.pathname;

  // Match Insights pages: /owner/repo/pulse, /owner/repo/graphs/*, etc.
  const insightsPatterns = [
    /^\/[^/]+\/[^/]+\/pulse/,
    /^\/[^/]+\/[^/]+\/graphs/,
    /^\/[^/]+\/[^/]+\/community/,
    /^\/[^/]+\/[^/]+\/network/,
    /^\/[^/]+\/[^/]+\/forks/,
  ];

  return insightsPatterns.some((pattern) => pattern.test(path));
}

/**
 * Check if we're on the Agent Blame page (virtual)
 */
export function isAgentBlamePage(): boolean {
  return window.location.hash === "#agent-blame";
}

/**
 * Extract owner and repo from current URL
 */
export function extractRepoContext(): { owner: string; repo: string } | null {
  const path = window.location.pathname;
  const match = path.match(/^\/([^/]+)\/([^/]+)/);

  if (!match) {
    return null;
  }

  return {
    owner: match[1],
    repo: match[2],
  };
}

/**
 * Find the Insights sidebar
 */
function findInsightsSidebar(): Element | null {
  // GitHub's Insights sidebar has various selectors depending on the page
  // Try multiple selectors
  const selectors = [
    // New GitHub UI
    'nav[aria-label="Insights"]',
    // Insights menu
    '.menu[aria-label="Insights"]',
    // Generic sidebar in insights pages
    '.Layout-sidebar nav',
    '.Layout-sidebar .menu',
    // Fallback: look for the menu containing "Pulse" link
    '.menu:has(a[href$="/pulse"])',
  ];

  for (const selector of selectors) {
    try {
      const element = document.querySelector(selector);
      if (element) {
        return element;
      }
    } catch {
      // :has() may not be supported in all browsers
      continue;
    }
  }

  // Last resort: find by looking for Pulse link's parent menu
  const pulseLink = document.querySelector('a[href$="/pulse"]');
  if (pulseLink) {
    const menu = pulseLink.closest(".menu, nav, ul");
    if (menu) {
      return menu;
    }
  }

  return null;
}

// Track repos we've already checked (to avoid repeated API calls)
const checkedRepos = new Map<string, boolean>();

// Guard against concurrent injection attempts
let isInjecting = false;

/**
 * Inject the Agent Blame sidebar item (only if analytics exist)
 */
export async function injectSidebarItem(): Promise<void> {
  // Check if already injected or injection in progress
  if (document.getElementById(SIDEBAR_ITEM_ID) || isInjecting) {
    return;
  }

  isInjecting = true;

  try {
    const context = extractRepoContext();
    if (!context) {
      return;
    }

    const repoKey = `${context.owner}/${context.repo}`;

    // Check if we've already verified this repo has no analytics
    if (checkedRepos.has(repoKey) && !checkedRepos.get(repoKey)) {
      console.log("[Agent Blame] Skipping - already checked, no analytics for this repo");
      return;
    }

    // Check if analytics exist for this repo (only if not already checked)
    if (!checkedRepos.has(repoKey)) {
      const hasAnalytics = await checkAnalyticsExist(context.owner, context.repo);
      checkedRepos.set(repoKey, hasAnalytics);

      if (!hasAnalytics) {
        console.log("[Agent Blame] No analytics found, not showing sidebar item");
        return;
      }
    }

    // Double-check not injected (in case another call completed while we were checking analytics)
    if (document.getElementById(SIDEBAR_ITEM_ID)) {
      return;
    }

    const sidebar = findInsightsSidebar();
    if (!sidebar) {
      console.log("[Agent Blame] Could not find Insights sidebar");
      return;
    }

    // Find the Pulse link to insert after
    const pulseLink = sidebar.querySelector('a[href$="/pulse"]');
    if (!pulseLink) {
      console.log("[Agent Blame] Could not find Pulse link in sidebar");
      return;
    }

    // Determine the structure - is it a menu-item or just links?
    const pulseItem = pulseLink.closest(".menu-item") || pulseLink;
    const isMenuItem = pulseItem.classList.contains("menu-item");

    // Create the sidebar item
    const sidebarItem = document.createElement("a");
    sidebarItem.id = SIDEBAR_ITEM_ID;
    sidebarItem.href = `/${context.owner}/${context.repo}/pulse#agent-blame`;

    if (isMenuItem) {
      // Use GitHub's menu-item styling
      sidebarItem.className = "menu-item";
    } else {
      // Copy classes from Pulse link
      sidebarItem.className = pulseLink.className;
    }

    sidebarItem.textContent = "Agent Blame";

    // Handle click - show the Agent Blame page
    sidebarItem.addEventListener("click", (e) => {
      e.preventDefault();
      e.stopPropagation();

      // Update URL hash
      window.history.pushState(null, "", `/${context.owner}/${context.repo}/pulse#agent-blame`);

      // Remove active state from other items
      sidebar.querySelectorAll(".selected, [aria-current='page']").forEach((el) => {
        el.classList.remove("selected");
        el.removeAttribute("aria-current");
      });

      // Add active state to our item
      sidebarItem.classList.add("selected");
      sidebarItem.setAttribute("aria-current", "page");

      // Show the Agent Blame page
      showAnalyticsPage(context.owner, context.repo);
    });

    // Insert after Pulse
    if (pulseItem.nextSibling) {
      pulseItem.parentNode?.insertBefore(sidebarItem, pulseItem.nextSibling);
    } else {
      pulseItem.parentNode?.appendChild(sidebarItem);
    }

    console.log("[Agent Blame] Sidebar item injected");

    // If URL already has #agent-blame, show the page
    if (isAgentBlamePage()) {
      // Remove active state from other items
      sidebar.querySelectorAll(".selected, [aria-current='page']").forEach((el) => {
        el.classList.remove("selected");
        el.removeAttribute("aria-current");
      });
      sidebarItem.classList.add("selected");
      sidebarItem.setAttribute("aria-current", "page");
      showAnalyticsPage(context.owner, context.repo);
    }
  } finally {
    isInjecting = false;
  }
}

/**
 * Remove the Agent Blame sidebar item
 */
export function removeSidebarItem(): void {
  const item = document.getElementById(SIDEBAR_ITEM_ID);
  if (item) {
    item.remove();
  }
  hideAnalyticsPage();
}

/**
 * Handle hash changes (back/forward navigation)
 */
export function handleHashChange(): void {
  const context = extractRepoContext();
  if (!context) return;

  if (isAgentBlamePage()) {
    showAnalyticsPage(context.owner, context.repo);

    // Update sidebar selection
    const sidebar = findInsightsSidebar();
    if (sidebar) {
      sidebar.querySelectorAll(".selected, [aria-current='page']").forEach((el) => {
        el.classList.remove("selected");
        el.removeAttribute("aria-current");
      });
      const sidebarItem = document.getElementById(SIDEBAR_ITEM_ID);
      if (sidebarItem) {
        sidebarItem.classList.add("selected");
        sidebarItem.setAttribute("aria-current", "page");
      }
    }
  } else {
    hideAnalyticsPage();

    // Restore original sidebar selection based on current path
    const sidebar = findInsightsSidebar();
    if (sidebar) {
      const sidebarItem = document.getElementById(SIDEBAR_ITEM_ID);
      if (sidebarItem) {
        sidebarItem.classList.remove("selected");
        sidebarItem.removeAttribute("aria-current");
      }
    }
  }
}
