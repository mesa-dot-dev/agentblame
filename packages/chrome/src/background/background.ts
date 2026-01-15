/**
 * Agent Blame Background Service Worker
 *
 * Handles extension lifecycle and background tasks
 */

// Debug logging - disabled in production
// eslint-disable-next-line @typescript-eslint/no-unused-vars
function log(..._args: unknown[]): void {
  // Logging disabled for production
}

// Extension installation/update handler
chrome.runtime.onInstalled.addListener(async (details) => {
  log(`Extension ${details.reason}`, details.previousVersion ? `from v${details.previousVersion}` : "");

  if (details.reason === "install") {
    // Fresh install - set default settings
    log("Fresh install, setting default settings");
    await chrome.storage.local.set({
      enabled: true,
    });
  } else if (details.reason === "update") {
    // Update - ensure enabled is set (fix for profiles with missing/corrupt state)
    const storage = await chrome.storage.local.get("enabled");
    if (storage.enabled === undefined) {
      log("Detected missing 'enabled' setting, setting to true");
      await chrome.storage.local.set({ enabled: true });
    } else {
      log(`Existing 'enabled' setting: ${storage.enabled}`);
    }
  }

  // Log current storage state for debugging
  const allStorage = await chrome.storage.local.get(null);
  log("Current storage state:", {
    enabled: allStorage.enabled,
    hasToken: !!allStorage.githubToken,
  });
});

// Listen for tab updates to re-inject content script if needed
chrome.tabs.onUpdated.addListener((_tabId, changeInfo, tab) => {
  if (
    changeInfo.status === "complete" &&
    tab.url?.match(/https:\/\/github\.com\/[^/]+\/[^/]+\/pull\/\d+/)
  ) {
    // Tab loaded a PR page - content script should auto-inject via manifest
  }
});

// Handle messages from content scripts (if needed for cross-origin requests)
chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  // Currently all API calls are made from content script directly
  // This handler is here for future use if we need to proxy requests
  // through the background script for CORS reasons

  if (message.type === "PING") {
    sendResponse({ type: "PONG" });
    return true;
  }

  return false;
});
