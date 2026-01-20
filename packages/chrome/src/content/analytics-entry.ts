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

let observer: MutationObserver | null = null;

/**
 * Initialize analytics sidebar injection
 */
function init(): void {
  console.log("[Agent Blame] Analytics entry loaded on:", window.location.href);
  console.log("[Agent Blame] isInsightsPage:", isInsightsPage());

  if (isInsightsPage()) {
    // Wait a bit for GitHub to fully render the page
    setTimeout(() => {
      console.log("[Agent Blame] Injecting sidebar item...");
      injectSidebarItem();
    }, 500);
  }

  // Watch for DOM changes (GitHub uses dynamic rendering)
  setupObserver();

  // Handle hash changes for navigation
  setupHashListener();

  // Handle GitHub's Turbo navigation
  setupTurboListener();
}

/**
 * Setup MutationObserver for dynamic content
 */
function setupObserver(): void {
  if (observer) {
    observer.disconnect();
  }

  observer = new MutationObserver(() => {
    if (isInsightsPage()) {
      injectSidebarItem();
    } else {
      removeSidebarItem();
    }
  });

  // Observe the sidebar area for changes
  const sidebar = document.querySelector(".Layout-sidebar");
  if (sidebar) {
    observer.observe(sidebar, { childList: true, subtree: true });
  }

  // Also observe body for major page changes
  observer.observe(document.body, {
    childList: true,
    subtree: false,
  });
}

/**
 * Handle hash changes (for #agent-blame navigation)
 */
function setupHashListener(): void {
  window.addEventListener("hashchange", () => {
    console.log("[Agent Blame] Hash changed to:", window.location.hash);
    handleHashChange();
  });

  // Also handle popstate for back/forward
  window.addEventListener("popstate", () => {
    console.log("[Agent Blame] Popstate - hash:", window.location.hash);
    handleHashChange();
  });
}

/**
 * Handle GitHub's Turbo Drive navigation
 */
function setupTurboListener(): void {
  // Turbo Drive fires these events on navigation
  document.addEventListener("turbo:load", () => {
    console.log("[Agent Blame] Turbo load");
    if (isInsightsPage()) {
      setTimeout(() => injectSidebarItem(), 100);
    }
  });

  document.addEventListener("turbo:render", () => {
    console.log("[Agent Blame] Turbo render");
    if (isInsightsPage()) {
      setTimeout(() => injectSidebarItem(), 100);
    }
  });

  // Also handle the older pjax events (some GitHub pages still use these)
  document.addEventListener("pjax:end", () => {
    console.log("[Agent Blame] PJAX end");
    if (isInsightsPage()) {
      setTimeout(() => injectSidebarItem(), 100);
    }
  });
}

// Initialize when DOM is ready
if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", init);
} else {
  init();
}
