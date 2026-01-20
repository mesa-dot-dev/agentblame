/**
 * Analytics Entry Point
 *
 * Content script entry point for GitHub Insights pages.
 * Injects the "Agent Blame" item into the Insights sidebar.
 */

import {
  isInsightsPage,
  injectSidebarItem,
  removeSidebarItem,
  handleHashChange,
} from "./analytics-tab";

// Track if we've already set up listeners (avoid duplicates)
let listenersInitialized = false;

/**
 * Check if current URL could navigate to insights pages
 * (i.e., we're on a repo page)
 */
function isRepoPage(): boolean {
  // Match: github.com/owner/repo or github.com/owner/repo/*
  return /^https:\/\/github\.com\/[^/]+\/[^/]+/.test(window.location.href);
}

/**
 * Initialize analytics sidebar injection
 */
function init(): void {
  // Quick exit if not on a repo page - no setup needed
  if (!isRepoPage()) {
    return;
  }

  // Only set up listeners once
  if (listenersInitialized) {
    return;
  }
  listenersInitialized = true;

  // On insights page - inject immediately
  if (isInsightsPage()) {
    setTimeout(() => injectSidebarItem(), 500);
  }

  // Lightweight setup - only what's needed for navigation detection
  setupHistoryListener();
  setupHashListener();
  setupTurboListener();
}

/**
 * Handle hash changes (for #agent-blame navigation)
 */
function setupHashListener(): void {
  window.addEventListener("hashchange", () => {
    handleHashChange();
  });

  // Handle popstate for back/forward
  window.addEventListener("popstate", () => {
    handleNavigation();
  });
}

/**
 * Handle GitHub's Turbo Drive navigation
 */
function setupTurboListener(): void {
  // Turbo Drive fires these events on navigation
  document.addEventListener("turbo:load", () => {
    console.log("[Agent Blame] Turbo load");
    handleNavigation();
  });

  document.addEventListener("turbo:render", () => {
    console.log("[Agent Blame] Turbo render");
    handleNavigation();
  });

  // Also handle the older pjax events (some GitHub pages still use these)
  document.addEventListener("pjax:end", () => {
    console.log("[Agent Blame] PJAX end");
    handleNavigation();
  });
}

/**
 * Handle navigation by intercepting History API
 */
function setupHistoryListener(): void {
  // Intercept pushState
  const originalPushState = history.pushState.bind(history);
  history.pushState = (...args) => {
    originalPushState(...args);
    console.log("[Agent Blame] pushState:", window.location.href);
    setTimeout(handleNavigation, 100);
  };

  // Intercept replaceState
  const originalReplaceState = history.replaceState.bind(history);
  history.replaceState = (...args) => {
    originalReplaceState(...args);
    console.log("[Agent Blame] replaceState:", window.location.href);
    setTimeout(handleNavigation, 100);
  };
}

/**
 * Handle navigation - inject or remove sidebar item based on current page
 */
function handleNavigation(): void {
  if (isInsightsPage()) {
    setTimeout(() => injectSidebarItem(), 200);
  } else {
    removeSidebarItem();
  }
}

// Initialize when DOM is ready
if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", init);
} else {
  init();
}
