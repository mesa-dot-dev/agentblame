/**
 * Agent Blame Content Script Router
 *
 * Single entry point for all GitHub pages. Routes to:
 * - PR attribution (Files Changed tab markers)
 * - Analytics sidebar (Insights pages)
 *
 * Handles navigation detection via History API interception.
 */

import type { GitNotesAttribution, LineAttribution } from "../types";
import { getToken, isEnabled } from "../lib/storage";
import { GitHubAPI } from "../lib/github-api";
import {
  extractPRContext,
  getDiffContainers,
  getFilePath,
  getAddedLines,
  injectMarker,
  removeAllMarkers,
  injectPRSummary,
  injectFileBadge,
  showLoading,
  hideLoading,
  showError,
  isFilesChangedTab,
} from "./github-dom";
import {
  isInsightsPage,
  injectSidebarItem,
  removeSidebarItem,
  handleHashChange,
} from "./analytics-tab";

// =============================================================================
// URL Detection
// =============================================================================

function isRepoPage(): boolean {
  return /^https:\/\/github\.com\/[^/]+\/[^/]+/.test(window.location.href);
}

function isPRPage(): boolean {
  return /^https:\/\/github\.com\/[^/]+\/[^/]+\/pull\/\d+/.test(window.location.href);
}

// =============================================================================
// PR Attribution State & Logic
// =============================================================================

let api: GitHubAPI | null = null;
let isProcessing = false;
let hasProcessedSuccessfully = false;
let wasOnFilesChangedTab = false;
let prObserver: MutationObserver | null = null;
let pendingProcess: ReturnType<typeof setTimeout> | null = null;

async function initPRAttribution(): Promise<void> {
  // Check if enabled
  const enabled = await isEnabled();
  if (!enabled) return;

  // Check for token
  const token = await getToken();
  if (!token) return;

  // Initialize API client
  api = new GitHubAPI(token);

  // Process the page
  await processPRPage();

  // Watch for DOM changes
  setupPRObserver();
}

async function processPRPage(): Promise<void> {
  if (isProcessing) return;

  const onFilesTab = isFilesChangedTab();

  if (!onFilesTab) {
    if (wasOnFilesChangedTab) {
      removeAllMarkers();
      hasProcessedSuccessfully = false;
    }
    wasOnFilesChangedTab = false;
    return;
  }

  wasOnFilesChangedTab = true;
  isProcessing = true;

  try {
    const context = extractPRContext();
    if (!context) return;

    const containers = getDiffContainers();
    if (containers.length === 0) return;

    showLoading();

    if (!api) {
      hideLoading();
      return;
    }

    const commits = await api.getPRCommits(
      context.owner,
      context.repo,
      context.prNumber,
    );
    if (commits.length === 0) {
      hideLoading();
      return;
    }

    const notes = await api.fetchNotesForCommits(
      context.owner,
      context.repo,
      commits,
    );

    hideLoading();

    if (notes.size === 0) return;

    const attributionMap = buildAttributionMap(notes);

    let totalLines = 0;
    let aiGeneratedLines = 0;

    for (const container of containers) {
      const filePath = getFilePath(container);
      const addedLines = getAddedLines(container);

      let fileAiLines = 0;
      let fileTotal = 0;

      for (const line of addedLines) {
        let lineText = line.element.textContent || "";
        lineText = lineText.replace(/^[+-]/, "").trim();
        if (lineText === "") continue;

        totalLines++;
        fileTotal++;

        const attr = findAttribution(attributionMap, filePath, line.lineNumber);
        if (attr) {
          injectMarker(line.element, attr);
          fileAiLines++;
          aiGeneratedLines++;
        }
      }

      if (fileTotal > 0) {
        injectFileBadge(container, fileAiLines, fileTotal);
      }
    }

    injectPRSummary({
      total: totalLines,
      aiGenerated: aiGeneratedLines,
    });

    hasProcessedSuccessfully = true;
  } catch (error) {
    showError("Failed to load attribution data");
  } finally {
    isProcessing = false;
  }
}

function buildAttributionMap(
  notes: Map<string, GitNotesAttribution>,
): Map<string, LineAttribution> {
  const map = new Map<string, LineAttribution>();

  for (const [_commitSha, note] of notes) {
    if (!note.attributions) continue;

    for (const attr of note.attributions) {
      for (let line = attr.startLine; line <= attr.endLine; line++) {
        const key = `${attr.path}:${line}`;
        map.set(key, {
          category: attr.category,
          provider: attr.provider,
          model: attr.model,
        });
      }
    }
  }

  return map;
}

function findAttribution(
  map: Map<string, LineAttribution>,
  filePath: string,
  lineNumber: number,
): LineAttribution | null {
  const key = `${filePath}:${lineNumber}`;
  const exactMatch = map.get(key);
  if (exactMatch) return exactMatch;

  const variants = [
    filePath,
    filePath.replace(/^\//, ""),
    `/${filePath}`,
    filePath.split("/").slice(-1)[0],
  ];

  for (const variant of variants) {
    const variantKey = `${variant}:${lineNumber}`;
    const variantMatch = map.get(variantKey);
    if (variantMatch) return variantMatch;
  }

  return null;
}

function setupPRObserver(): void {
  if (prObserver) {
    prObserver.disconnect();
  }

  prObserver = new MutationObserver((mutations) => {
    const hasTabChange = mutations.some((m) => {
      if (m.type === "attributes" && m.attributeName === "aria-selected") {
        return true;
      }
      for (const node of Array.from(m.addedNodes)) {
        if (node instanceof HTMLElement) {
          if (
            node.matches?.('[role="tabpanel"], [data-tab-container]') ||
            node.querySelector?.('[role="tabpanel"]')
          ) {
            return true;
          }
        }
      }
      return false;
    });

    if (hasTabChange) {
      if (pendingProcess) clearTimeout(pendingProcess);
      pendingProcess = setTimeout(() => {
        pendingProcess = null;
        hasProcessedSuccessfully = false;
        processPRPage();
      }, 150);
      return;
    }

    if (hasProcessedSuccessfully && wasOnFilesChangedTab) return;

    const hasSignificantChanges = mutations.some((m) => {
      for (const node of Array.from(m.addedNodes)) {
        if (node instanceof HTMLElement) {
          const dominated = node.querySelectorAll("*").length;
          if (dominated > 10) return true;
          if (
            node.matches?.(
              "[data-tagsearch-path], .file, .diff-table, [data-hpc], .js-diff-load-container, tr.diff-line-row",
            ) ||
            node.querySelector?.(
              "[data-tagsearch-path], .file, .diff-table, .blob-code-addition, tr.diff-line-row",
            )
          ) {
            return true;
          }
        }
      }
      return false;
    });

    if (hasSignificantChanges) {
      if (pendingProcess) clearTimeout(pendingProcess);
      pendingProcess = setTimeout(() => {
        pendingProcess = null;
        processPRPage();
      }, 200);
    }
  });

  prObserver.observe(document.body, {
    childList: true,
    subtree: true,
    attributes: true,
    attributeFilter: ["aria-selected"],
  });
}

function resetPRState(): void {
  hasProcessedSuccessfully = false;
  wasOnFilesChangedTab = false;
  if (pendingProcess) {
    clearTimeout(pendingProcess);
    pendingProcess = null;
  }
  removeAllMarkers();
}

function cleanupPR(): void {
  if (prObserver) {
    prObserver.disconnect();
    prObserver = null;
  }
  resetPRState();
}

// =============================================================================
// Analytics Sidebar Logic
// =============================================================================

function initAnalytics(): void {
  if (isInsightsPage()) {
    setTimeout(() => injectSidebarItem(), 500);
  }
}

function cleanupAnalytics(): void {
  removeSidebarItem();
}

// =============================================================================
// Navigation Handling
// =============================================================================

let lastPageType: "pr" | "insights" | "other" = "other";

function detectPageType(): "pr" | "insights" | "other" {
  if (isPRPage()) return "pr";
  if (isInsightsPage()) return "insights";
  return "other";
}

function handleNavigation(): void {
  const newPageType = detectPageType();

  // Clean up previous page type if changed
  if (lastPageType !== newPageType) {
    if (lastPageType === "pr") {
      cleanupPR();
    } else if (lastPageType === "insights") {
      cleanupAnalytics();
    }
  }

  lastPageType = newPageType;

  // Initialize for new page type
  if (newPageType === "pr") {
    initPRAttribution();
  } else if (newPageType === "insights") {
    initAnalytics();
  }
}

function setupNavigationListener(): void {
  // Listen for popstate (back/forward)
  window.addEventListener("popstate", () => {
    setTimeout(handleNavigation, 100);
  });

  // Handle hash changes for analytics
  window.addEventListener("hashchange", () => {
    handleHashChange();
  });

  // Intercept pushState
  const originalPushState = history.pushState.bind(history);
  history.pushState = (...args) => {
    originalPushState(...args);
    setTimeout(handleNavigation, 100);
  };

  // Intercept replaceState
  const originalReplaceState = history.replaceState.bind(history);
  history.replaceState = (...args) => {
    originalReplaceState(...args);
    setTimeout(handleNavigation, 100);
  };

  // Turbo Drive events
  document.addEventListener("turbo:load", () => handleNavigation());
  document.addEventListener("turbo:render", () => handleNavigation());
  document.addEventListener("pjax:end", () => handleNavigation());
}

// =============================================================================
// Message Handling
// =============================================================================

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message.type === "SETTINGS_CHANGED") {
    if (message.enabled) {
      handleNavigation();
    } else {
      cleanupPR();
      cleanupAnalytics();
    }
    sendResponse({ success: true });
  }
  return true;
});

// =============================================================================
// Initialization
// =============================================================================

function init(): void {
  // Quick exit if not on a repo page
  if (!isRepoPage()) return;

  // Set up navigation listener (once)
  setupNavigationListener();

  // Handle current page
  handleNavigation();
}

// Initialize when DOM is ready
if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", init);
} else {
  init();
}
