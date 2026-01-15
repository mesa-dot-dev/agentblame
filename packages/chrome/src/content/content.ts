/**
 * Agent Blame Content Script
 *
 * Runs on GitHub PR pages to show AI attribution markers
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

// State
let api: GitHubAPI | null = null;
let isProcessing = false;
let hasProcessedSuccessfully = false;
let wasOnFilesChangedTab = false;
let observer: MutationObserver | null = null;
let pendingProcess: ReturnType<typeof setTimeout> | null = null;

// Debug logging - disabled in production
// eslint-disable-next-line @typescript-eslint/no-unused-vars
function log(..._args: unknown[]): void {
  // Logging disabled for production
}

// eslint-disable-next-line @typescript-eslint/no-unused-vars
function logError(..._args: unknown[]): void {
  // Logging disabled for production
}

/**
 * Initialize the content script
 */
async function init(): Promise<void> {
  log("Content script initializing...");

  // Check if enabled
  const enabled = await isEnabled();
  if (!enabled) {
    log("Extension is disabled in settings");
    return;
  }

  // Check for token
  const token = await getToken();
  if (!token) {
    log("No GitHub token configured - open extension popup to set one");
    return;
  }

  log("Token found, initializing API client");

  // Initialize API client
  api = new GitHubAPI(token);

  // Process the page
  await processPage();

  // Watch for DOM changes (GitHub uses pjax/turbo for navigation)
  setupObserver();
}

/**
 * Process the current page
 */
async function processPage(): Promise<void> {
  if (isProcessing) {
    log("Already processing, skipping");
    return;
  }

  // Only process on Files Changed tab
  const onFilesTab = isFilesChangedTab();

  // Track tab state changes
  if (!onFilesTab) {
    if (wasOnFilesChangedTab) {
      // User navigated away from Files Changed tab - clean up
      log("Left Files Changed tab, removing markers");
      removeAllMarkers();
      hasProcessedSuccessfully = false;
    }
    wasOnFilesChangedTab = false;
    return;
  }

  wasOnFilesChangedTab = true;
  isProcessing = true;

  try {
    // Extract PR context
    const context = extractPRContext();
    if (!context) {
      log("Not on a PR page or could not extract PR context");
      return;
    }

    log(`Processing PR #${context.prNumber} in ${context.owner}/${context.repo}`);

    // Only process if we can see diff containers
    const containers = getDiffContainers();
    if (containers.length === 0) {
      log("No diff containers found - waiting for MutationObserver to detect changes");
      return;
    }

    log(`Found ${containers.length} diff container(s)`);
    showLoading();

    // Get PR commits
    if (!api) {
      log("API client not initialized");
      hideLoading();
      return;
    }

    const commits = await api.getPRCommits(
      context.owner,
      context.repo,
      context.prNumber,
    );
    if (commits.length === 0) {
      log("No commits found for PR");
      hideLoading();
      return;
    }

    log(`Fetching notes for ${commits.length} commit(s)`);

    // Fetch notes for all commits
    const notes = await api.fetchNotesForCommits(
      context.owner,
      context.repo,
      commits,
    );

    hideLoading();

    if (notes.size === 0) {
      log("No attribution notes found for any commits");
      return;
    }

    log(`Found notes for ${notes.size} commit(s)`);

    // Build attribution lookup
    const attributionMap = buildAttributionMap(notes);

    // Process each diff container
    let totalLines = 0;
    let aiGeneratedLines = 0;

    for (const container of containers) {
      const filePath = getFilePath(container);
      const addedLines = getAddedLines(container);

      let fileAiLines = 0;
      let fileTotal = 0;

      for (const line of addedLines) {
        // Skip empty lines (whitespace-only) from counting
        // In new UI, empty lines show as "+" (diff marker only)
        let lineText = line.element.textContent || "";
        lineText = lineText.replace(/^[+-]/, "").trim();
        if (lineText === "") {
          continue;
        }

        totalLines++;
        fileTotal++;

        const attr = findAttribution(attributionMap, filePath, line.lineNumber);
        if (attr) {
          injectMarker(line.element, attr);
          fileAiLines++;
          aiGeneratedLines++;
        }
      }

      // Add file badge (only if there are non-empty lines)
      if (fileTotal > 0) {
        injectFileBadge(container, fileAiLines, fileTotal);
      }
    }

    // Add PR summary
    injectPRSummary({
      total: totalLines,
      aiGenerated: aiGeneratedLines,
    });

    log(`Done: ${aiGeneratedLines}/${totalLines} lines attributed to AI`);
    hasProcessedSuccessfully = true;
  } catch (error) {
    logError("Error processing page:", error);
    showError("Failed to load attribution data");
  } finally {
    isProcessing = false;
  }
}

/**
 * Build a lookup map from notes
 * Map key: "filepath:lineNumber"
 */
function buildAttributionMap(
  notes: Map<string, GitNotesAttribution>,
): Map<string, LineAttribution> {
  const map = new Map<string, LineAttribution>();

  for (const [_commitSha, note] of notes) {
    if (!note.attributions) continue;

    for (const attr of note.attributions) {
      // Add entry for each line in the range
      for (let line = attr.start_line; line <= attr.end_line; line++) {
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

/**
 * Find attribution for a specific line
 */
function findAttribution(
  map: Map<string, LineAttribution>,
  filePath: string,
  lineNumber: number,
): LineAttribution | null {
  // Try exact match
  const key = `${filePath}:${lineNumber}`;
  const exactMatch = map.get(key);
  if (exactMatch) {
    return exactMatch;
  }

  // Try with different path formats
  // GitHub might use different path formats than what we stored
  const variants = [
    filePath,
    filePath.replace(/^\//, ""),
    `/${filePath}`,
    filePath.split("/").slice(-1)[0], // Just filename
  ];

  for (const variant of variants) {
    const variantKey = `${variant}:${lineNumber}`;
    const variantMatch = map.get(variantKey);
    if (variantMatch) {
      return variantMatch;
    }
  }

  return null;
}

/**
 * Setup MutationObserver to handle dynamic content and tab changes
 *
 * GitHub loads diff content dynamically and uses client-side navigation for tabs.
 * We watch for:
 * 1. New diff content being loaded
 * 2. Tab changes (user switching between Conversation, Commits, Checks, Files changed)
 */
function setupObserver(): void {
  if (observer) {
    observer.disconnect();
  }

  observer = new MutationObserver((mutations) => {
    // Check for tab changes by looking at aria-selected changes or tab panel visibility
    const hasTabChange = mutations.some((m) => {
      // Check for attribute changes on tab items
      if (m.type === "attributes" && m.attributeName === "aria-selected") {
        return true;
      }
      // Check for significant DOM additions that might indicate tab content change
      for (const node of Array.from(m.addedNodes)) {
        if (node instanceof HTMLElement) {
          // Tab panel content being added
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

    // Always check for tab changes - this handles returning to Files Changed
    if (hasTabChange) {
      if (pendingProcess) {
        clearTimeout(pendingProcess);
      }
      pendingProcess = setTimeout(() => {
        pendingProcess = null;
        log("Tab change detected, checking if on Files Changed...");
        // Reset processing state to allow re-processing
        hasProcessedSuccessfully = false;
        processPage();
      }, 150);
      return;
    }

    // If already processed and on Files Changed, don't reprocess for minor DOM changes
    if (hasProcessedSuccessfully && wasOnFilesChangedTab) {
      return;
    }

    // Check if significant diff content was added
    const hasSignificantChanges = mutations.some((m) => {
      for (const node of Array.from(m.addedNodes)) {
        if (node instanceof HTMLElement) {
          // Look for any element that might be diff-related
          const dominated = node.querySelectorAll('*').length;
          if (dominated > 10) {
            return true;
          }
          // Also check for specific diff-related patterns
          if (
            node.matches?.("[data-tagsearch-path], .file, .diff-table, [data-hpc], .js-diff-load-container, tr.diff-line-row") ||
            node.querySelector?.("[data-tagsearch-path], .file, .diff-table, .blob-code-addition, tr.diff-line-row")
          ) {
            return true;
          }
        }
      }
      return false;
    });

    if (hasSignificantChanges) {
      if (pendingProcess) {
        clearTimeout(pendingProcess);
      }
      pendingProcess = setTimeout(() => {
        pendingProcess = null;
        log("MutationObserver detected new content, reprocessing...");
        processPage();
      }, 200);
    }
  });

  observer.observe(document.body, {
    childList: true,
    subtree: true,
    attributes: true,
    attributeFilter: ["aria-selected"],
  });

  log("MutationObserver set up to watch for DOM changes and tab switches");
}

/**
 * Reset state for a new page
 */
function resetState(): void {
  hasProcessedSuccessfully = false;
  wasOnFilesChangedTab = false;
  if (pendingProcess) {
    clearTimeout(pendingProcess);
    pendingProcess = null;
  }
  removeAllMarkers();
}

/**
 * Handle URL changes (GitHub uses History API)
 */
function setupNavigationListener(): void {
  // Listen for popstate (back/forward)
  window.addEventListener("popstate", () => {
    log("Navigation: popstate");
    resetState();
    setTimeout(() => processPage(), 100);
  });

  // Override pushState and replaceState to detect navigation
  const originalPushState = history.pushState.bind(history);
  const originalReplaceState = history.replaceState.bind(history);

  history.pushState = (...args) => {
    originalPushState(...args);
    log("Navigation: pushState");
    resetState();
    setTimeout(() => processPage(), 100);
  };

  history.replaceState = (...args) => {
    originalReplaceState(...args);
    log("Navigation: replaceState");
    resetState();
    setTimeout(() => processPage(), 100);
  };
}

/**
 * Listen for messages from popup
 */
chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  log("Received message:", message.type);
  if (message.type === "SETTINGS_CHANGED") {
    if (message.enabled) {
      log("Settings changed: enabled");
      init();
    } else {
      log("Settings changed: disabled");
      removeAllMarkers();
      // Clean up observer when disabled
      if (observer) {
        observer.disconnect();
        observer = null;
      }
    }
    sendResponse({ success: true });
  }
  return true;
});

// Initialize when DOM is ready
log("Content script loaded, readyState:", document.readyState);

if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", () => {
    log("DOMContentLoaded fired");
    setupNavigationListener();
    init();
  });
} else {
  setupNavigationListener();
  init();
}
