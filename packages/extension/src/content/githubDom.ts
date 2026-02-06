/**
 * GitHub DOM manipulation utilities
 */

import type { PRContext, DiffLine, LineAttribution, GitNotesAttribution, SessionMetadata, PromptEntry, PromptInfo } from "../types";
import { api } from "../lib/browser";

// Debug logging - disabled in production
// eslint-disable-next-line @typescript-eslint/no-unused-vars
function log(..._args: unknown[]): void {
  // Uncomment for debugging: console.log("[AgentBlame DOM]", ...args);
}

/**
 * Extract PR context from the current URL and DOM
 */
export function extractPRContext(): PRContext | null {
  const match = window.location.pathname.match(
    /^\/([^/]+)\/([^/]+)\/pull\/(\d+)/,
  );

  if (!match) {
    return null;
  }

  // Extract base and head refs from DOM for compare API
  const { baseRef, headRef } = extractBaseHeadRefs();

  return {
    owner: match[1],
    repo: match[2],
    prNumber: parseInt(match[3], 10),
    commits: [], // Will be populated later
    baseRef,
    headRef,
  };
}

/**
 * Extract base and head refs from GitHub PR page DOM
 * Used for compare API to avoid needing Pull Requests permission
 */
function extractBaseHeadRefs(): { baseRef?: string; headRef?: string } {
  // Strategy 1: Look for commit-ref spans (common GitHub UI pattern)
  // Format: "base-repo:base-branch ... head-repo:head-branch" or just "branch"
  const commitRefs = document.querySelectorAll(".commit-ref");
  if (commitRefs.length >= 2) {
    const baseRef = commitRefs[0].textContent?.trim();
    const headRef = commitRefs[1].textContent?.trim();
    if (baseRef && headRef) {
      return { baseRef, headRef };
    }
  }

  // Strategy 2: Look for the compare range in the page
  // GitHub shows "base...head" in various places
  const compareRange = document.querySelector("[data-pjax='#repo-content-pjax-container']");
  if (compareRange) {
    const href = compareRange.getAttribute("href");
    const rangeMatch = href?.match(/compare\/([^.]+)\.\.\.(.+)/);
    if (rangeMatch) {
      return { baseRef: rangeMatch[1], headRef: rangeMatch[2] };
    }
  }

  // Strategy 3: Look for specific data attributes
  const baseElement = document.querySelector("[data-base-ref]");
  const headElement = document.querySelector("[data-head-ref]");
  if (baseElement && headElement) {
    return {
      baseRef: baseElement.getAttribute("data-base-ref") || undefined,
      headRef: headElement.getAttribute("data-head-ref") || undefined,
    };
  }

  // Strategy 4: Parse from the PR header text
  // "user wants to merge X commits into base from head"
  const prHeader = document.querySelector(".gh-header-meta");
  if (prHeader) {
    const spans = prHeader.querySelectorAll(".commit-ref");
    if (spans.length >= 2) {
      const baseRef = spans[0].textContent?.trim();
      const headRef = spans[1].textContent?.trim();
      if (baseRef && headRef) {
        return { baseRef, headRef };
      }
    }
  }

  return {};
}

/**
 * Check if we're on the "Files changed" tab
 */
export function isFilesChangedTab(): boolean {
  const pathname = window.location.pathname;
  // Old UI uses /files, new UI uses /changes
  return pathname.includes("/files") || pathname.includes("/changes");
}

/**
 * Get all diff file containers
 * GitHub wraps each file in a container with class "file" that contains both
 * the header (with data-tagsearch-path) and the diff table
 */
export function getDiffContainers(): HTMLElement[] {
  // Try multiple selectors for GitHub's various diff layouts
  // Order matters - try more specific selectors first
  const selectors = [
    ".file", // Standard file container
    '[data-details-container-group="file"]', // Alternative structure
    ".js-file", // JS-enhanced file container
    "diff-layout", // New React-based diff component
    '[role="region"][id^="diff-"]', // New GitHub UI (2026+)
  ];

  for (const selector of selectors) {
    const containers = document.querySelectorAll(selector);
    if (containers.length > 0) {
      log(`Found ${containers.length} containers with selector: ${selector}`);
      return Array.from(containers) as HTMLElement[];
    }
  }

  // React UI: [data-hpc] is a parent container - find individual file sections within it
  const hpcContainer = document.querySelector("[data-hpc]");
  if (hpcContainer) {
    // New React UI: Each file's diff is in a separate table
    // Find tables that contain diff lines and use them as containers
    const tables = hpcContainer.querySelectorAll("table");
    if (tables.length > 0) {
      const diffTables: HTMLElement[] = [];
      for (const table of tables) {
        // Only include tables that have diff content (diff-line-row or diff-text-cell)
        if (table.querySelector("tr.diff-line-row, .diff-text-cell")) {
          diffTables.push(table as HTMLElement);
        }
      }
      if (diffTables.length > 0) {
        log(`Found ${diffTables.length} diff tables as file containers`);
        return diffTables;
      }
    }

    // Try to find file containers using copilot-diff-entry (used in some new UI versions)
    const copilotEntries = hpcContainer.querySelectorAll("copilot-diff-entry");
    if (copilotEntries.length > 0) {
      log(`Found ${copilotEntries.length} copilot-diff-entry elements`);
      return Array.from(copilotEntries) as HTMLElement[];
    }

    // Fallback: Return the [data-hpc] container itself
    log(`Fallback: returning [data-hpc] as single container`);
    return [hpcContainer as HTMLElement];
  }

  // Fallback: find data-tagsearch-path and traverse up to find container
  const pathElements = document.querySelectorAll("[data-tagsearch-path]");
  log(`Fallback: found ${pathElements.length} path elements`);

  const containers: HTMLElement[] = [];

  for (const pathEl of pathElements) {
    // Walk up to find a container that has diff lines
    let current = pathEl.parentElement;
    let depth = 0;
    while (current && current !== document.body && depth < 10) {
      if (current.querySelector(".blob-code-addition, .blob-code-deletion, [data-code-marker]")) {
        containers.push(current);
        break;
      }
      current = current.parentElement;
      depth++;
    }
  }

  if (containers.length === 0) {
    // Debug: log what IS on the page to help diagnose
    log("Debug: Page structure analysis:");
    log("  - #files element:", !!document.querySelector("#files"));
    log("  - #diff element:", !!document.querySelector("#diff"));
    log("  - .diff-view:", document.querySelectorAll(".diff-view").length);
    log("  - [data-tagsearch-path]:", pathElements.length);
    log("  - .blob-code-addition:", document.querySelectorAll(".blob-code-addition").length);
    log("  - copilot-diff-entry:", document.querySelectorAll("copilot-diff-entry").length);
    log("  - react-app:", document.querySelectorAll("react-app").length);
    log("  - file-tree:", document.querySelectorAll("[data-target*='file-tree']").length);
  }

  return containers;
}

/**
 * Get the file path from a diff container
 * Supports both legacy and React-based GitHub UI
 */
export function getFilePath(container: HTMLElement): string {
  // First check if the container itself has the path
  const directPath = container.getAttribute("data-tagsearch-path");
  if (directPath) {
    return directPath;
  }

  // Otherwise find it within the container
  const pathElement = container.querySelector("[data-tagsearch-path]");
  if (pathElement) {
    return pathElement.getAttribute("data-tagsearch-path") || "";
  }

  // New UI: data-file-path attribute on expand button
  const filePathEl = container.querySelector("[data-file-path]");
  if (filePathEl) {
    return filePathEl.getAttribute("data-file-path") || "";
  }

  // Try to find path in file header link
  const fileLink = container.querySelector(
    '.file-header a[title], .file-info a[href*="blob"]',
  );
  if (fileLink) {
    return fileLink.getAttribute("title") || fileLink.textContent?.trim() || "";
  }

  // React UI: For table containers, look for the file path in parent/sibling structure
  // The file header with the path is often a sibling or in an ancestor's child
  let current: HTMLElement | null = container;
  for (let depth = 0; depth < 10 && current; depth++) {
    const parent = current.parentElement;
    if (!parent) break;

    // Check if parent or any sibling has the path
    const pathInParent = parent.querySelector("[data-tagsearch-path]");
    if (pathInParent) {
      // Make sure this path element is associated with our container
      // by checking if the path element's container (going up) matches our container's parent
      const path = pathInParent.getAttribute("data-tagsearch-path") || "";

      // Find the closest common ancestor between pathInParent and container
      // If pathInParent is within the same file block, use it
      let pathAncestor: HTMLElement | null = pathInParent as HTMLElement;
      for (let i = 0; i < 10 && pathAncestor; i++) {
        if (pathAncestor === parent) {
          return path;
        }
        pathAncestor = pathAncestor.parentElement;
      }
    }

    current = parent;
  }

  // React UI: Look for file name in elements with "file-name" in class
  // Search in container and parents
  const searchContexts = [container, container.parentElement, container.parentElement?.parentElement].filter(Boolean) as HTMLElement[];
  for (const ctx of searchContexts) {
    const allElements = ctx.querySelectorAll("*");
    for (const el of allElements) {
      const className = el.className;
      if (typeof className === "string" && className.includes("file-name")) {
        const text = el.textContent?.trim();
        // Filter out navigation characters and ensure we have a valid file name
        if (text && text.length > 0 && !text.includes("…") && text.includes(".")) {
          // Clean up any special unicode characters GitHub uses for RTL/LTR marks
          const cleanPath = text.replace(/[\u200E\u200F\u202A-\u202E]/g, "").trim();
          if (cleanPath) {
            return cleanPath;
          }
        }
      }
    }
  }

  // Try data-path attribute as last resort
  const dataPathEl = container.querySelector("[data-path]");
  if (dataPathEl) {
    return dataPathEl.getAttribute("data-path") || "";
  }

  return "";
}

/**
 * Get all added lines in a diff container
 * Supports both legacy GitHub UI and new React-based UI
 */
export function getAddedLines(container: HTMLElement): DiffLine[] {
  const lines: DiffLine[] = [];
  const filePath = getFilePath(container);

  // Try legacy UI first (uses .blob-code-addition class)
  const legacyLines = getAddedLinesLegacy(container, filePath);
  if (legacyLines.length > 0) {
    log(`Found ${legacyLines.length} lines using legacy UI selectors`);
    return legacyLines;
  }

  // Try new React UI (uses tr.diff-line-row with CSS variable styles)
  const reactLines = getAddedLinesReactUI(container, filePath);
  if (reactLines.length > 0) {
    log(`Found ${reactLines.length} lines using React UI selectors`);
    return reactLines;
  }

  log("No added lines found with any selector strategy");
  return lines;
}

/**
 * Get added lines using legacy GitHub UI selectors
 */
function getAddedLinesLegacy(container: HTMLElement, filePath: string): DiffLine[] {
  const lines: DiffLine[] = [];

  // Find all table rows that represent additions
  // Works for both unified and split view
  const allRows = container.querySelectorAll("tr");

  for (const tr of allRows) {
    // Check if this row is an addition
    const isAddition =
      tr.classList.contains("blob-code-addition") ||
      tr.querySelector(".blob-code-addition") !== null ||
      tr.querySelector("td.blob-num-addition") !== null;

    if (!isAddition) {
      continue;
    }

    // Get the line number - need the NEW line number (right side in unified, or the addition side in split)
    let lineNumber = 0;

    // For unified view: look for the second line number cell (new line number)
    // For split view: look for the addition line number cell
    const lineNumCells = tr.querySelectorAll("[data-line-number]");

    if (lineNumCells.length >= 2) {
      // Unified view: second cell is the new line number
      const newLineCell = lineNumCells[1] as HTMLElement;
      lineNumber = parseInt(
        newLineCell.getAttribute("data-line-number") || "0",
        10,
      );
    } else if (lineNumCells.length === 1) {
      // Split view or single column: use the only line number
      const lineCell = lineNumCells[0] as HTMLElement;
      lineNumber = parseInt(
        lineCell.getAttribute("data-line-number") || "0",
        10,
      );
    }

    // Fallback: try .blob-num-addition
    if (lineNumber === 0) {
      const additionNumCell = tr.querySelector(".blob-num-addition") as HTMLElement;
      if (additionNumCell) {
        lineNumber = parseInt(
          additionNumCell.getAttribute("data-line-number") ||
            additionNumCell.textContent?.trim() ||
            "0",
          10,
        );
      }
    }

    // Find the code element to attach marker to
    // IMPORTANT: In split view, we must specifically target .blob-code-addition
    // to avoid matching the left side (old code)
    let codeElement = tr.querySelector("td.blob-code-addition") as HTMLElement;

    // Fallback for unified view or other layouts
    if (!codeElement) {
      codeElement = tr.querySelector(
        ".blob-code-addition, .blob-code-inner",
      ) as HTMLElement;
    }

    if (lineNumber > 0 && codeElement) {
      lines.push({
        filePath,
        lineNumber,
        element: codeElement,
        type: "added",
      });
    }
  }

  return lines;
}

/**
 * Get added lines using new React-based GitHub UI selectors
 * This UI uses:
 * - tr.diff-line-row for each line
 * - CSS variable --diffBlob-additionLine-bgColor in style for additions
 * - data-grid-cell-id="diff-{hash}-{oldLine}-{newLine}-{index}" for line numbers
 * - .diff-text-cell for code content
 */
function getAddedLinesReactUI(container: HTMLElement, filePath: string): DiffLine[] {
  const lines: DiffLine[] = [];

  // Find all diff line rows in the React UI
  const diffRows = container.querySelectorAll("tr.diff-line-row");

  for (const tr of diffRows) {
    // Check if this row is an addition by looking for the addition background CSS variable
    const textCell = tr.querySelector(".diff-text-cell") as HTMLElement;
    if (!textCell) {
      continue;
    }

    const style = textCell.getAttribute("style") || "";
    const isAddition = style.includes("--diffBlob-additionLine-bgColor") ||
                       style.includes("--diffBlob-addition-");

    if (!isAddition) {
      continue;
    }

    // Get line number from data-grid-cell-id attribute
    // Format: diff-{hash}-{oldLine}-{newLine}-{columnIndex}
    // For additions, oldLine is "empty", newLine has the actual line number
    let lineNumber = 0;

    const lineNumCell = tr.querySelector(".diff-line-number") as HTMLElement;
    if (lineNumCell) {
      const gridCellId = lineNumCell.getAttribute("data-grid-cell-id") || "";
      const parts = gridCellId.split("-");
      if (parts.length >= 3) {
        // Get the newLine value (second to last part)
        const newLineStr = parts[parts.length - 2];
        if (newLineStr && newLineStr !== "empty") {
          lineNumber = parseInt(newLineStr, 10);
        }
      }
    }

    // Also try getting line number from the text cell's data-grid-cell-id
    if (lineNumber === 0) {
      const textGridCellId = textCell.getAttribute("data-grid-cell-id") || "";
      const parts = textGridCellId.split("-");
      if (parts.length >= 3) {
        const newLineStr = parts[parts.length - 2];
        if (newLineStr && newLineStr !== "empty") {
          lineNumber = parseInt(newLineStr, 10);
        }
      }
    }

    if (lineNumber > 0 && textCell) {
      lines.push({
        filePath,
        lineNumber,
        element: textCell,
        type: "added",
      });
    }
  }

  return lines;
}

/**
 * Get the row element (tr) from a code element
 */
function getRowElement(element: HTMLElement): HTMLElement | null {
  let current: HTMLElement | null = element;
  while (current && current.tagName !== "TR") {
    current = current.parentElement;
  }
  return current;
}

/**
 * Find the new line number cell (second line number column in unified view)
 * This is where we want to place the gutter - before the new line numbers
 */
function findNewLineNumberCell(element: HTMLElement): HTMLElement | null {
  const row = getRowElement(element);
  if (!row) return null;

  // In unified view: two blob-num cells, we want the second one (new line number)
  const lineNumCells = row.querySelectorAll('.blob-num, .diff-line-number, .new-diff-line-number');
  if (lineNumCells.length >= 2) {
    return lineNumCells[1] as HTMLElement; // Second column = new line numbers
  }
  if (lineNumCells.length === 1) {
    return lineNumCells[0] as HTMLElement;
  }

  // Fallback
  const diffLineNum = row.querySelector('[data-line-number]') as HTMLElement;
  return diffLineNum;
}

/**
 * Check if a line already has an AI attribution gutter
 */
export function hasMarker(element: HTMLElement): boolean {
  const lineNumCell = findNewLineNumberCell(element);
  if (!lineNumCell) return false;
  return lineNumCell.classList.contains("ab-gutter-ai");
}

/**
 * Inject AI attribution marker into a line
 * Shows orange gutter bar with hover tooltip for prompt details
 */
export function injectMarker(
  element: HTMLElement,
  attribution: LineAttribution,
): void {
  if (hasMarker(element)) {
    return;
  }

  const lineNumCell = findNewLineNumberCell(element);
  if (lineNumCell) {
    lineNumCell.classList.add("ab-gutter-ai");

    // Store tooltip data as data attributes on the gutter cell
    lineNumCell.dataset.agent = attribution.provider;
    if (attribution.model) {
      lineNumCell.dataset.model = attribution.model;
    }
    if (attribution.promptContent) {
      lineNumCell.dataset.content = attribution.promptContent;
    }
    if (attribution.promptNumber != null) {
      lineNumCell.dataset.promptNum = String(attribution.promptNumber);
    }
  }
}

/**
 * Remove all AI attribution markers from the page
 */
export function removeAllMarkers(): void {
  // Hide tooltip first
  cleanupTooltip();

  // Remove AI gutter classes and data attributes from line number cells
  const aiGutters = document.querySelectorAll(".ab-gutter-ai");
  aiGutters.forEach((el) => {
    el.classList.remove("ab-gutter-ai");
    el.removeAttribute("title");
    // Clean up data attributes
    if (el instanceof HTMLElement) {
      delete el.dataset.agent;
      delete el.dataset.model;
      delete el.dataset.content;
      delete el.dataset.promptNum;
    }
  });

  // Remove PR summaries, but preserve status banners (no-attribution messages)
  const summaries = document.querySelectorAll(".ab-pr-summary:not(.ab-pr-summary-status)");
  summaries.forEach((s) => {
    s.remove();
  });

  const badges = document.querySelectorAll(".ab-file-badge");
  badges.forEach((b) => {
    b.remove();
  });
}

/**
 * Format tool name for display
 */
function formatToolName(tool: string): string {
  const names: Record<string, string> = {
    edit: "Edit",
    write: "Write",
    read: "Read",
    bash: "Bash",
    glob: "Glob",
    grep: "Grep",
    multiedit: "MultiEdit",
  };
  return names[tool.toLowerCase()] || tool;
}

/**
 * Format provider name for display
 */
function formatProviderName(provider: string): string {
  const names: Record<string, string> = {
    cursor: "Cursor",
    claude: "Claude Code",
    opencode: "OpenCode",
  };
  return names[provider.toLowerCase()] || provider;
}

/**
 * Get provider color
 */
function getProviderColor(provider: string): string {
  const colors: Record<string, string> = {
    cursor: "#5B8DEE",
    claude: "#E07B53",
    opencode: "#4DBBAA",
  };
  return colors[provider.toLowerCase()] || "#6e7781";
}

/**
 * Truncate text with ellipsis
 */
function truncateText(text: string, maxLength: number): string {
  if (text.length <= maxLength) return text;
  return text.substring(0, maxLength - 3) + "...";
}

/**
 * Inject PR summary banner with metrics
 * Prompts are shown on hover over P1/P2 badges in the gutter
 */
export function injectPRSummary(stats: {
  total: number;
  aiGenerated: number;
  prompts?: PromptInfo[];
  notes?: Map<string, GitNotesAttribution>;
  commits?: string[];
}): void {
  const human = stats.total - stats.aiGenerated;
  const aiPercent =
    stats.total > 0 ? Math.round((stats.aiGenerated / stats.total) * 100) : 0;

  // Get the extension icon URL
  const iconUrl = api.runtime?.getURL
    ? api.runtime.getURL("icons/icon48.png")
    : "";

  // Colors
  const aiColor = "#b86540";
  const humanColor = "#238636";

  const statsHtml = `
    <div class="ab-pr-summary-container">
      <div class="ab-pr-summary-header">
        <div class="ab-header-left">
          ${iconUrl ? `<img src="${iconUrl}" alt="Agent Blame" class="ab-pr-summary-logo" />` : ""}
          <span class="ab-pr-summary-title">Agent Blame</span>
        </div>
        <div class="ab-header-right">
          <span class="ab-metric ab-metric-ai" style="color: ${aiColor};">AI: ${stats.aiGenerated} (${aiPercent}%)</span>
          <span class="ab-metric-divider">│</span>
          <span class="ab-metric ab-metric-human" style="color: ${humanColor};">Human: ${human} (${100 - aiPercent}%)</span>
        </div>
      </div>
    </div>
  `;

  // Check if a loading banner already exists - update it in place
  const existingSummary = document.querySelector(".ab-pr-summary");
  if (existingSummary) {
    existingSummary.classList.remove("ab-pr-summary-loading");
    existingSummary.innerHTML = statsHtml;
    log("Updated existing PR summary banner with stats");
    return;
  }

  // Create new banner
  const summary = document.createElement("div");
  summary.className = "ab-pr-summary";
  summary.innerHTML = statsHtml;

  const injectionPoint = findBannerInjectionPoint();
  if (injectionPoint) {
    injectionPoint.parent.insertBefore(summary, injectionPoint.before);
    log("Injected PR summary banner");
  } else {
    log("Could not find injection point for PR summary banner");
  }
}

/**
 * Inject file badge showing AI percentage
 */
export function injectFileBadge(
  container: HTMLElement,
  aiLines: number,
  totalLines: number,
): void {
  // Try to find header within the container (classic UI)
  let header = container.querySelector(
    ".file-header, .file-info, [data-tagsearch-path]",
  );

  // New UI: use the main header flex container (badge uses CSS order to appear at end)
  if (!header) {
    const filePathButton = container.querySelector("[data-file-path]");
    if (filePathButton) {
      header = filePathButton.closest('[class*="diff-file-header"]');
    }
  }

  // Fallback: container is a <table> and the file header is a previous sibling
  if (!header) {
    let current: HTMLElement | null = container;
    for (let depth = 0; depth < 5 && current && !header; depth++) {
      let sibling = current.previousElementSibling;
      while (sibling) {
        if (sibling instanceof HTMLElement) {
          const nested = sibling.querySelector(
            "[data-tagsearch-path], .file-header, .file-info, [data-file-path]",
          );
          if (nested) {
            // For data-file-path, use its parent section as the header
            const fp = nested.closest("[data-file-path]");
            header = fp ? fp.parentElement : nested;
            break;
          }
        }
        sibling = sibling.previousElementSibling;
      }
      current = current.parentElement;
    }
  }

  if (!header || header.querySelector(".ab-file-badge")) {
    return;
  }

  if (aiLines === 0) {
    return;
  }

  const percent = Math.round((aiLines / totalLines) * 100);
  const badge = document.createElement("span");
  badge.className = `ab-file-badge${percent >= 50 ? " high-ai" : ""}`;
  badge.textContent = `✨ ${percent}% AI`;

  header.appendChild(badge);
}

/**
 * Show loading state - displays the Agent Blame header with a loading indicator
 */
export function showLoading(): void {
  // Don't inject if already present (either loading or loaded)
  if (document.querySelector(".ab-pr-summary")) {
    return;
  }

  const summary = document.createElement("div");
  summary.className = "ab-pr-summary ab-pr-summary-loading";

  // Get the extension icon URL
  const iconUrl = api.runtime?.getURL
    ? api.runtime.getURL("icons/icon48.png")
    : "";

  summary.innerHTML = `
    <div class="ab-pr-summary-header">
      ${iconUrl ? `<img src="${iconUrl}" alt="Agent Blame" class="ab-pr-summary-logo" />` : '<span class="ab-pr-summary-icon">✨</span>'}
      <span class="ab-pr-summary-title">Agent Blame</span>
    </div>
    <div class="ab-pr-summary-stats ab-pr-summary-stats-loading">
      <div class="ab-loading-spinner"></div>
      <span class="ab-loading-text">Loading attribution...</span>
    </div>
  `;

  const injectionPoint = findBannerInjectionPoint();
  if (injectionPoint) {
    injectionPoint.parent.insertBefore(summary, injectionPoint.before);
    log("Injected PR summary loading banner");
  } else {
    log("Could not find injection point for PR summary loading banner");
  }
}

/**
 * Hide loading state - removes loading indicator from the header
 * Note: The header itself stays, only the loading indicator is removed
 */
export function hideLoading(): void {
  // Remove old-style standalone loading element if present
  const standaloneLoading = document.querySelector(".ab-loading:not(.ab-loading-spinner)");
  if (standaloneLoading) {
    standaloneLoading.remove();
  }

  // Remove loading summary if present (when we exit early without calling injectPRSummary)
  const loadingSummary = document.querySelector(".ab-pr-summary-loading");
  if (loadingSummary) {
    loadingSummary.remove();
  }
}

/**
 * Show error message in the Agent Blame header
 */
export function showError(message: string): void {
  // Get the extension icon URL
  const iconUrl = api.runtime?.getURL
    ? api.runtime.getURL("icons/icon48.png")
    : "";

  // Check if loading header exists - update it instead of removing
  const existingSummary = document.querySelector(".ab-pr-summary");
  if (existingSummary) {
    existingSummary.classList.remove("ab-pr-summary-loading");
    existingSummary.classList.add("ab-pr-summary-error");
    existingSummary.innerHTML = `
      <div class="ab-pr-summary-header">
        ${iconUrl ? `<img src="${iconUrl}" alt="Agent Blame" class="ab-pr-summary-logo" />` : '<span class="ab-pr-summary-icon">✨</span>'}
        <span class="ab-pr-summary-title">Agent Blame</span>
      </div>
      <div class="ab-pr-summary-stats ab-pr-summary-stats-error">
        <span class="ab-error-icon">⚠️</span>
        <span class="ab-error-text">${escapeHtml(message)}</span>
      </div>
    `;
    return;
  }

  // No existing header - create a new one with error
  const summary = document.createElement("div");
  summary.className = "ab-pr-summary ab-pr-summary-error";
  summary.innerHTML = `
    <div class="ab-pr-summary-header">
      ${iconUrl ? `<img src="${iconUrl}" alt="Agent Blame" class="ab-pr-summary-logo" />` : '<span class="ab-pr-summary-icon">✨</span>'}
      <span class="ab-pr-summary-title">Agent Blame</span>
    </div>
    <div class="ab-pr-summary-stats ab-pr-summary-stats-error">
      <span class="ab-error-icon">⚠️</span>
      <span class="ab-error-text">${escapeHtml(message)}</span>
    </div>
  `;

  const injectionPoint = findBannerInjectionPoint();
  if (injectionPoint) {
    injectionPoint.parent.insertBefore(summary, injectionPoint.before);
  }
}

/**
 * Show status when no notes are found
 */
export function showNoNotesStatus(diagnostics: {
  notesRefExists: boolean;
  totalCommits: number;
  commitsWithNotes: number;
}): void {
  // Get the extension icon URL
  const iconUrl = api.runtime?.getURL
    ? api.runtime.getURL("icons/icon48.png")
    : "";

  // Build clear, debuggable status message
  let statusMessage: string;

  if (!diagnostics.notesRefExists) {
    statusMessage = "No git notes found · run 'agentblame init' and push notes";
  } else if (diagnostics.commitsWithNotes === 0) {
    statusMessage = `No notes for ${diagnostics.totalCommits} commit${diagnostics.totalCommits === 1 ? "" : "s"} · notes may not be pushed`;
  } else {
    statusMessage = `Notes found for ${diagnostics.commitsWithNotes}/${diagnostics.totalCommits} commits`;
  }

  const statusHtml = `
    <div class="ab-pr-summary-container">
      <div class="ab-pr-summary-header">
        <div class="ab-header-left">
          ${iconUrl ? `<img src="${iconUrl}" alt="Agent Blame" class="ab-pr-summary-logo" />` : ""}
          <span class="ab-pr-summary-title">Agent Blame</span>
        </div>
        <div class="ab-header-right ab-status-info">
          <span class="ab-status-text">${escapeHtml(statusMessage)}</span>
        </div>
      </div>
    </div>
  `;

  // Check if loading header exists - update it instead of removing
  const existingSummary = document.querySelector(".ab-pr-summary");
  if (existingSummary) {
    existingSummary.classList.remove("ab-pr-summary-loading");
    existingSummary.classList.add("ab-pr-summary-status");
    existingSummary.innerHTML = statusHtml;
    return;
  }

  // Create new banner
  const summary = document.createElement("div");
  summary.className = "ab-pr-summary ab-pr-summary-status";
  summary.innerHTML = statusHtml;

  const injectionPoint = findBannerInjectionPoint();
  if (injectionPoint) {
    injectionPoint.parent.insertBefore(summary, injectionPoint.before);
  }
}

/**
 * Find an injection point for summary/loading banners
 */
function findBannerInjectionPoint(): { parent: Element; before: Element | null } | null {
  // Strategy 1: Legacy UI - inject before the first .file container
  const firstFileContainer = document.querySelector(".file");
  if (firstFileContainer?.parentElement) {
    return { parent: firstFileContainer.parentElement, before: firstFileContainer };
  }

  // Strategy 2: New UI - inject before first file region
  const firstNewUIContainer = document.querySelector('[role="region"][id^="diff-"]');
  if (firstNewUIContainer?.parentElement) {
    return { parent: firstNewUIContainer.parentElement, before: firstNewUIContainer };
  }

  // Strategy 3: React UI - inject before [data-hpc] container
  const hpc = document.querySelector("[data-hpc]");
  if (hpc?.parentElement) {
    return { parent: hpc.parentElement, before: hpc };
  }

  // Strategy 4: Fallback
  const fallbackArea = document.querySelector("#files_bucket, .pr-toolbar, .pull-request-tab-content");
  if (fallbackArea) {
    return { parent: fallbackArea, before: fallbackArea.firstChild as Element | null };
  }

  return null;
}

/**
 * Escape HTML to prevent XSS
 */
function escapeHtml(str: string): string {
  const div = document.createElement("div");
  div.textContent = str;
  return div.innerHTML;
}

// Singleton tooltip element
let tooltipElement: HTMLElement | null = null;
let tooltipTimeout: ReturnType<typeof setTimeout> | null = null;

/**
 * Initialize the prompt tooltip system using event delegation
 * Single event listener for all prompt badges - performant approach
 */
export function initTooltip(): void {
  // Only initialize once
  if (tooltipElement) {
    return;
  }

  // Create tooltip element
  tooltipElement = document.createElement("div");
  tooltipElement.className = "ab-prompt-tooltip";
  tooltipElement.style.display = "none";
  document.body.appendChild(tooltipElement);

  // Event delegation - single listener for all badges
  document.addEventListener("mouseenter", handleTooltipShow, true);
  document.addEventListener("mouseleave", handleTooltipHide, true);
}

/**
 * Handle showing tooltip on gutter hover
 */
function handleTooltipShow(e: Event): void {
  const target = e.target as HTMLElement;
  if (!target.classList?.contains("ab-gutter-ai")) {
    return;
  }

  // Clear any pending hide
  if (tooltipTimeout) {
    clearTimeout(tooltipTimeout);
    tooltipTimeout = null;
  }

  const { agent, model, content } = target.dataset;
  if (!tooltipElement) {
    return;
  }

  // Build tooltip content
  const agentDisplay = formatProviderName(agent || "unknown");
  const modelDisplay = model ? ` (${truncateText(model, 25)})` : "";
  const contentDisplay = content || "[prompt content not stored]";

  tooltipElement.innerHTML = `
    <div class="ab-tooltip-header">
      <span class="ab-tooltip-agent">${escapeHtml(agentDisplay)}${escapeHtml(modelDisplay)}</span>
    </div>
    <div class="ab-tooltip-content">${escapeHtml(contentDisplay)}</div>
  `;

  // Position tooltip near the gutter
  const rect = target.getBoundingClientRect();
  const tooltipWidth = 320;

  // Position to the right of the gutter cell
  let left = rect.right + 8;
  if (left + tooltipWidth > window.innerWidth - 20) {
    left = rect.left - tooltipWidth - 8;
  }

  // Ensure it doesn't go off screen on the left
  if (left < 20) {
    left = 20;
  }

  // Vertical centering with the gutter
  let top = rect.top + window.scrollY - 10;

  // Ensure it doesn't go off screen on top
  if (top < window.scrollY + 10) {
    top = window.scrollY + 10;
  }

  tooltipElement.style.left = `${left}px`;
  tooltipElement.style.top = `${top}px`;
  tooltipElement.style.display = "block";
}

/**
 * Handle hiding tooltip when leaving gutter
 */
function handleTooltipHide(e: Event): void {
  const target = e.target as HTMLElement;
  if (!target.classList?.contains("ab-gutter-ai")) {
    return;
  }

  // Small delay before hiding to prevent flicker
  tooltipTimeout = setTimeout(() => {
    if (tooltipElement) {
      tooltipElement.style.display = "none";
    }
  }, 100);
}

/**
 * Clean up tooltip when removing markers
 */
export function cleanupTooltip(): void {
  if (tooltipElement) {
    tooltipElement.style.display = "none";
  }
}
