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
  if (!enabled) return;

  // Check for token
  const token = await getToken();
  if (!token) return;

  // Initialize API client
  githubApi = new GitHubAPI(token);

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

    if (!githubApi) {
      hideLoading();
      return;
    }

    const commits = await githubApi.getPRCommits(
      context.owner,
      context.repo,
      context.prNumber,
    );
    if (commits.length === 0) {
      hideLoading();
      return;
    }

    const notesResult = await githubApi.fetchNotesForCommits(
      context.owner,
      context.repo,
      commits,
    );

    hideLoading();

    // Check for unsupported versions
    if (notesResult.hasUnsupportedVersions) {
      const versions = notesResult.unsupportedVersionsFound.join(", ");
      showError(
        `Unsupported attribution format (v${versions}). Agent Blame ${MIN_SUPPORTED_VERSION}.0+ required. Please update your CLI and re-process commits.`
      );
      return;
    }

    if (notesResult.notes.size === 0) return;

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
      prompts,
    });

    hasProcessedSuccessfully = true;
  } catch (error) {
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

          // Add entry for each line in the range
          for (let line = range.startLine; line <= range.endLine; line++) {
            const key = `${filePath}:${line}`;
            lineMap.set(key, {
              category: "ai_generated",
              provider: session?.agent || "unknown",
              model: session?.model || null,
              sessionId: range.sessionId,
              promptContent,
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
