/**
 * GitHub DOM manipulation utilities
 */

import type { PRContext, DiffLine, LineAttribution } from "../types";

// Debug logging - disabled in production
// eslint-disable-next-line @typescript-eslint/no-unused-vars
function log(..._args: unknown[]): void {
  // Logging disabled for production
}

/**
 * Extract PR context from the current URL
 */
export function extractPRContext(): PRContext | null {
  const match = window.location.pathname.match(
    /^\/([^/]+)\/([^/]+)\/pull\/(\d+)/,
  );

  if (!match) {
    return null;
  }

  return {
    owner: match[1],
    repo: match[2],
    prNumber: parseInt(match[3], 10),
    commits: [], // Will be populated later
  };
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
  const selectors = [
    ".file", // Standard file container
    '[data-details-container-group="file"]', // Alternative structure
    ".js-file", // JS-enhanced file container
    "diff-layout", // New React-based diff component
    "[data-hpc]", // High performance container
  ];

  for (const selector of selectors) {
    const containers = document.querySelectorAll(selector);
    if (containers.length > 0) {
      log(`Found ${containers.length} containers with selector: ${selector}`);
      return Array.from(containers) as HTMLElement[];
    }
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

  // Try to find path in file header link
  const fileLink = container.querySelector(
    '.file-header a[title], .file-info a[href*="blob"]',
  );
  if (fileLink) {
    return fileLink.getAttribute("title") || fileLink.textContent?.trim() || "";
  }

  // React UI: Look for file name in header with CSS module class
  // Classes look like: DiffFileHeader-module__file-name--xxxxx
  const allElements = container.querySelectorAll("*");
  for (const el of allElements) {
    const className = el.className;
    if (typeof className === "string" && className.includes("file-name")) {
      const text = el.textContent?.trim();
      // Filter out navigation characters and ensure we have a valid file name
      if (text && text.length > 0 && !text.includes("…") && text.includes(".")) {
        // Clean up any special unicode characters GitHub uses for RTL/LTR marks
        const cleanPath = text.replace(/[\u200E\u200F\u202A-\u202E]/g, "").trim();
        if (cleanPath) {
          log(`Found file path via React UI: ${cleanPath}`);
          return cleanPath;
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
  const lineNumCells = row.querySelectorAll('.blob-num, .diff-line-number');
  if (lineNumCells.length >= 2) {
    return lineNumCells[1] as HTMLElement; // Second column = new line numbers
  }
  if (lineNumCells.length === 1) {
    return lineNumCells[0] as HTMLElement;
  }

  // React UI fallback
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
 * Inject AI attribution gutter into a line (on new line number cell)
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
    lineNumCell.setAttribute(
      "title",
      `AI Generated (${attribution.provider}${attribution.model ? ` - ${attribution.model}` : ""})`,
    );
  }
}

/**
 * Remove all AI attribution markers from the page
 */
export function removeAllMarkers(): void {
  // Remove AI gutter classes and titles from line number cells
  const aiGutters = document.querySelectorAll(".ab-gutter-ai");
  aiGutters.forEach((el) => {
    el.classList.remove("ab-gutter-ai");
    el.removeAttribute("title");
  });

  const summaries = document.querySelectorAll(".ab-pr-summary");
  summaries.forEach((s) => {
    s.remove();
  });

  const badges = document.querySelectorAll(".ab-file-badge");
  badges.forEach((b) => {
    b.remove();
  });
}

/**
 * Inject PR summary banner
 * Supports both legacy and React-based GitHub UI
 * Banner should appear right above the diff files area in both UIs
 * If a loading banner already exists, it will be updated with the stats
 */
export function injectPRSummary(stats: {
  total: number;
  aiGenerated: number;
}): void {
  const human = stats.total - stats.aiGenerated;
  const aiPercent =
    stats.total > 0 ? Math.round((stats.aiGenerated / stats.total) * 100) : 0;

  // Get the extension icon URL
  const iconUrl = typeof chrome !== "undefined" && chrome.runtime?.getURL
    ? chrome.runtime.getURL("icons/icon48.png")
    : "";

  const statsHtml = `
    <div class="ab-pr-summary-header">
      ${iconUrl ? `<img src="${iconUrl}" alt="Agent Blame" class="ab-pr-summary-logo" />` : '<span class="ab-pr-summary-icon">✨</span>'}
      <span class="ab-pr-summary-title">Agent Blame</span>
    </div>
    <div class="ab-pr-summary-stats">
      <div class="ab-stat ab-stat-ai">
        <div class="ab-stat-value-row">
          <span class="ab-stat-icon">✨</span>
          <span class="ab-stat-value">${stats.aiGenerated}</span>
        </div>
        <span class="ab-stat-label">AI Generated</span>
      </div>
      <div class="ab-stat-divider"></div>
      <div class="ab-stat ab-stat-human">
        <div class="ab-stat-value-row">
          <span class="ab-stat-icon">👤</span>
          <span class="ab-stat-value">${human}</span>
        </div>
        <span class="ab-stat-label">Human Written</span>
      </div>
      <div class="ab-stat-divider"></div>
      <div class="ab-stat ab-stat-percent ${aiPercent >= 50 ? 'high-ai' : ''}">
        <div class="ab-stat-value-row">
          <span class="ab-stat-value ab-stat-percent-value">${aiPercent}%</span>
        </div>
        <span class="ab-stat-label">AI Code</span>
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

  // Strategy 1: Legacy UI - inject before the first .file container
  const firstFileContainer = document.querySelector(".file");
  if (firstFileContainer?.parentElement) {
    firstFileContainer.parentElement.insertBefore(summary, firstFileContainer);
    log("Injected PR summary banner (legacy UI - before .file)");
    return;
  }

  // Strategy 2: React UI - inject before [data-hpc] container
  const hpc = document.querySelector("[data-hpc]");
  if (hpc?.parentElement) {
    hpc.parentElement.insertBefore(summary, hpc);
    log("Injected PR summary banner (React UI - before [data-hpc])");
    return;
  }

  // Strategy 3: Fallback - try #files_bucket or .pr-toolbar
  const fallbackArea = document.querySelector("#files_bucket, .pr-toolbar, .pull-request-tab-content");
  if (fallbackArea) {
    fallbackArea.insertBefore(summary, fallbackArea.firstChild);
    log("Injected PR summary banner (fallback)");
    return;
  }

  log("Could not find injection point for PR summary banner");
}

/**
 * Inject file badge showing AI percentage
 */
export function injectFileBadge(
  container: HTMLElement,
  aiLines: number,
  totalLines: number,
): void {
  const header = container.querySelector(
    ".file-header, .file-info, [data-tagsearch-path]",
  );

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
  const iconUrl = typeof chrome !== "undefined" && chrome.runtime?.getURL
    ? chrome.runtime.getURL("icons/icon48.png")
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

  // Strategy 1: Legacy UI - inject before the first .file container
  const firstFileContainer = document.querySelector(".file");
  if (firstFileContainer?.parentElement) {
    firstFileContainer.parentElement.insertBefore(summary, firstFileContainer);
    log("Injected PR summary loading banner (legacy UI - before .file)");
    return;
  }

  // Strategy 2: React UI - inject before [data-hpc] container
  const hpc = document.querySelector("[data-hpc]");
  if (hpc?.parentElement) {
    hpc.parentElement.insertBefore(summary, hpc);
    log("Injected PR summary loading banner (React UI - before [data-hpc])");
    return;
  }

  // Strategy 3: Fallback - try #files_bucket or .pr-toolbar
  const fallbackArea = document.querySelector("#files_bucket, .pr-toolbar, .pull-request-tab-content");
  if (fallbackArea) {
    fallbackArea.insertBefore(summary, fallbackArea.firstChild);
    log("Injected PR summary loading banner (fallback)");
    return;
  }

  log("Could not find injection point for PR summary loading banner");
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

  // The loading state in the header will be replaced by injectPRSummary
}

/**
 * Show error message
 */
export function showError(message: string): void {
  hideLoading();

  const headerArea = document.querySelector(
    ".pull-request-tab-content, #files_bucket, .pr-toolbar",
  );

  if (!headerArea) {
    return;
  }

  const error = document.createElement("div");
  error.className = "ab-error";
  error.textContent = `Agent Blame: ${message}`;

  headerArea.insertBefore(error, headerArea.firstChild);
}
