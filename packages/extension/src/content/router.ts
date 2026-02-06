/**
 * Agent Blame Content Script Router
 *
 * Single entry point for all GitHub pages. Routes to:
 * - PR attribution (Files Changed tab markers)
 * - Analytics sidebar (Insights pages)
 *
 * Handles navigation detection via History API interception.
 */

import type { GitNotesAttribution, LineAttribution, PromptInfo } from "../types";
import { api } from "../lib/browser";
import { MIN_SUPPORTED_VERSION } from "../types";
import { getToken, isEnabled } from "../lib/storage";
import { GitHubAPI } from "../lib/githubApi";
import { logInfo, logError, logDebug } from "../lib/extensionLogger";
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
  showNoNotesStatus,
  isFilesChangedTab,
  initTooltip,
} from "./githubDom";
import {
  isInsightsPage,
  injectSidebarItem,
  removeSidebarItem,
  handleHashChange,
} from "./analyticsTab";

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

let githubApi: GitHubAPI | null = null;
let isProcessing = false;
let hasProcessedSuccessfully = false;
let wasOnFilesChangedTab = false;
let prObserver: MutationObserver | null = null;
let pendingProcess: ReturnType<typeof setTimeout> | null = null;

async function initPRAttribution(): Promise<void> {
  // Check if enabled
  const enabled = await isEnabled();
  if (!enabled) {
    logDebug("router", "PR attribution disabled");
    return;
  }

  // Check for token
  const token = await getToken();
  if (!token) {
    logDebug("router", "No GitHub token configured");
    return;
  }

  logInfo("router", "Starting PR attribution");

  // Initialize API client
  githubApi = new GitHubAPI(token);

  // Process the page
  await processPRPage();

  // Watch for DOM changes
  setupPRObserver();
}

async function processPRPage(): Promise<void> {
  if (isProcessing) return;

  // Don't reprocess if already showing results
  if (hasProcessedSuccessfully) {
    logDebug("router", "Already processed, skipping");
    return;
  }

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

    if (!githubApi) {
      showError("GitHub API not initialized · check token in extension settings");
      hasProcessedSuccessfully = true;
      return;
    }

    // Get commits using compare API (only needs Contents permission)
    // Falls back to PR API if base/head refs not available
    let commits: string[];
    if (context.baseRef && context.headRef) {
      commits = await githubApi.getCompareCommits(
        context.owner,
        context.repo,
        context.baseRef,
        context.headRef,
      );
    } else {
      // Fallback to PR commits API (needs Pull Requests permission for private repos)
      commits = await githubApi.getPRCommits(
        context.owner,
        context.repo,
        context.prNumber,
      );
    }

    if (commits.length === 0) {
      showError("No commits found for this PR");
      hasProcessedSuccessfully = true;
      return;
    }

    const notesResult = await githubApi.fetchNotesForCommits(
      context.owner,
      context.repo,
      commits,
    );

    hideLoading();

    // Check for API errors (auth, rate limit, etc.)
    if (notesResult.error) {
      showError(notesResult.error.message);
      hasProcessedSuccessfully = true;
      return;
    }

    // Check for unsupported versions
    if (notesResult.hasUnsupportedVersions) {
      const versions = notesResult.unsupportedVersionsFound.join(", ");
      showError(
        `Unsupported attribution format (v${versions}). Agent Blame ${MIN_SUPPORTED_VERSION}.0+ required. Please update your CLI and re-process commits.`
      );
      hasProcessedSuccessfully = true;
      return;
    }

    if (notesResult.notes.size === 0) {
      showNoNotesStatus(notesResult.diagnostics);
      hasProcessedSuccessfully = true;
      return;
    }

    const { lineMap: attributionMap, prompts } = buildAttributionMap(notesResult.notes);

    // Initialize tooltip system for prompt badges
    initTooltip();

    let totalLines = 0;
    let aiGeneratedLines = 0;

    for (const container of containers) {
      const filePath = getFilePath(container);
      const addedLines = getAddedLines(container);

      let fileAiLines = 0;
      let fileTotal = 0;

      // Collect lines with their attributions first
      const linesWithAttr: Array<{
        element: HTMLElement;
        attr: LineAttribution | null;
      }> = [];

      for (const line of addedLines) {
        let lineText = line.element.textContent || "";
        lineText = lineText.replace(/^[+-]/, "").trim();
        if (lineText === "") continue;

        totalLines++;
        fileTotal++;

        const attr = findAttribution(attributionMap, filePath, line.lineNumber);
        linesWithAttr.push({ element: line.element, attr });

        if (attr) {
          fileAiLines++;
          aiGeneratedLines++;
        }
      }

      // Group consecutive AI lines with same prompt, show badge only on middle line
      let i = 0;
      while (i < linesWithAttr.length) {
        const { element, attr } = linesWithAttr[i];

        if (!attr) {
          i++;
          continue;
        }

        // Find consecutive lines with same promptNumber
        const groupStart = i;
        const promptNum = attr.promptNumber;

        while (
          i < linesWithAttr.length &&
          linesWithAttr[i].attr?.promptNumber === promptNum
        ) {
          i++;
        }

        const groupEnd = i;

        // Inject markers: all get gutter bar, only first line gets badge
        for (let j = groupStart; j < groupEnd; j++) {
          const lineAttr = linesWithAttr[j].attr!;
          const showBadge = j === groupStart;

          injectMarker(linesWithAttr[j].element, {
            ...lineAttr,
            promptNumber: showBadge ? lineAttr.promptNumber : undefined,
          });
        }
      }

      if (fileTotal > 0) {
        injectFileBadge(container, fileAiLines, fileTotal);
      }
    }

    injectPRSummary({
      total: totalLines,
      aiGenerated: aiGeneratedLines,
      prompts,
    });

    hasProcessedSuccessfully = true;
    logInfo("router", `PR attribution complete: ${aiGeneratedLines}/${totalLines} lines AI-generated`);
  } catch (error) {
    const errorMsg = error instanceof Error ? error.message : String(error);
    logError("router", `PR attribution failed: ${errorMsg}`);
    showError("Failed to load attribution data");
  } finally {
    isProcessing = false;
  }
}

interface AttributionResult {
  lineMap: Map<string, LineAttribution>;
  prompts: PromptInfo[];
}

function buildAttributionMap(
  notes: Map<string, GitNotesAttribution>,
): AttributionResult {
  const lineMap = new Map<string, LineAttribution>();
  const prompts: PromptInfo[] = [];

  // Build prompt index map: sessionId:promptId -> P1, P2, etc.
  const promptIndexMap = new Map<string, string>();
  const promptNumberMap = new Map<string, number>();
  let promptCounter = 1;

  for (const [_commitSha, note] of notes) {
    // V3 format: uses files with aiRanges
    if (note.files && note.sessions) {
      // First pass: collect all unique prompts and assign indices
      for (const [sessionId, session] of Object.entries(note.sessions)) {
        if (session.prompts && Array.isArray(session.prompts)) {
          for (const prompt of session.prompts) {
            const promptKey = `${sessionId}:${prompt.id ?? "null"}`;
            if (!promptIndexMap.has(promptKey)) {
              const promptIdx = `P${promptCounter}`;
              promptIndexMap.set(promptKey, promptIdx);
              promptNumberMap.set(promptKey, promptCounter);
              prompts.push({
                index: promptIdx,
                agent: session.agent,
                model: session.model,
                content: prompt.content,
                tools: prompt.tools,
              });
              promptCounter++;
            }
          }
        } else if (session.prompts && typeof session.prompts === "string") {
          // Legacy string format
          const promptKey = `${sessionId}:null`;
          if (!promptIndexMap.has(promptKey)) {
            const promptIdx = `P${promptCounter}`;
            promptIndexMap.set(promptKey, promptIdx);
            promptNumberMap.set(promptKey, promptCounter);
            prompts.push({
              index: promptIdx,
              agent: session.agent,
              model: session.model,
              content: session.prompts,
            });
            promptCounter++;
          }
        }
      }

      // Second pass: build line attribution
      for (const [filePath, fileAttr] of Object.entries(note.files)) {
        for (const range of fileAttr.aiRanges) {
          const session = note.sessions[range.sessionId];

          // Extract prompt content for tooltip
          let promptContent: string | undefined;
          if (session?.prompts && Array.isArray(session.prompts) && range.promptId != null) {
            const prompt = session.prompts.find(p => p.id === range.promptId);
            if (prompt?.content) {
              promptContent = prompt.content;
            }
          } else if (session?.prompts && typeof session.prompts === 'string') {
            promptContent = session.prompts;
          }

          // Look up prompt number for this range
          const promptKey = `${range.sessionId}:${range.promptId ?? "null"}`;
          const promptNumber = promptNumberMap.get(promptKey);

          // Add entry for each line in the range
          for (let line = range.startLine; line <= range.endLine; line++) {
            const key = `${filePath}:${line}`;
            lineMap.set(key, {
              category: "ai_generated",
              provider: session?.agent || "unknown",
              model: session?.model || null,
              sessionId: range.sessionId,
              promptContent,
              promptNumber,
            });
          }
        }
      }
    }
  }

  return { lineMap, prompts };
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
      // Only reset if we actually left the files tab
      const stillOnFilesTab = isFilesChangedTab();
      if (hasProcessedSuccessfully && stillOnFilesTab) {
        logDebug("router", "Tab change detected but still on Files Changed, ignoring");
        return;
      }

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
              '[data-tagsearch-path], .file, .diff-table, [data-hpc], .js-diff-load-container, tr.diff-line-row, [role="region"][id^="diff-"], [data-file-path]',
            ) ||
            node.querySelector?.(
              '[data-tagsearch-path], .file, .diff-table, .blob-code-addition, tr.diff-line-row, [role="region"][id^="diff-"], [data-file-path]',
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

api.runtime.onMessage.addListener((message, _sender, sendResponse) => {
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

  logInfo("router", `Initialized on ${window.location.pathname}`);

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
