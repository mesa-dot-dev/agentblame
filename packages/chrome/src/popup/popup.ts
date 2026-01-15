/**
 * Agent Blame Popup Script
 */

import {
  getToken,
  setToken,
  removeToken,
  isEnabled,
  setEnabled,
  validateToken,
} from "../lib/storage";

// DOM Elements - these are guaranteed to exist in popup.html
const statusIndicator = document.getElementById("status-indicator");
const statusText = statusIndicator?.querySelector(".status-text");
const tokenInput = document.getElementById("token-input") as HTMLInputElement;
const toggleVisibility = document.getElementById("toggle-visibility");
const saveBtn = document.getElementById("save-btn") as HTMLButtonElement;
const clearBtn = document.getElementById("clear-btn") as HTMLButtonElement;
const tokenStatus = document.getElementById("token-status");
const enabledToggle = document.getElementById(
  "enabled-toggle",
) as HTMLInputElement;

if (!statusIndicator || !statusText || !toggleVisibility || !tokenStatus) {
  throw new Error("Required DOM elements not found");
}

/**
 * Update the status indicator
 */
function updateStatus(
  state: "connected" | "disconnected" | "disabled",
  message: string,
): void {
  statusIndicator.className = `status ${state}`;
  statusText.textContent = message;
}

/**
 * Show a token status message
 */
function showMessage(message: string, type: "success" | "error"): void {
  tokenStatus.textContent = message;
  tokenStatus.className = `message ${type}`;

  // Clear message after 3 seconds
  setTimeout(() => {
    tokenStatus.textContent = "";
    tokenStatus.className = "message";
  }, 3000);
}

/**
 * Initialize the popup
 */
async function init(): Promise<void> {
  // Load current state
  const [token, enabled] = await Promise.all([getToken(), isEnabled()]);

  // Set toggle state
  enabledToggle.checked = enabled;

  // Update status based on token and enabled state
  if (!enabled) {
    updateStatus("disabled", "Attribution disabled");
  } else if (token) {
    // Validate the token
    const valid = await validateToken(token);
    if (valid) {
      updateStatus("connected", "Connected to GitHub");
      tokenInput.value = "••••••••••••••••••••";
    } else {
      updateStatus("disconnected", "Invalid token");
    }
  } else {
    updateStatus("disconnected", "No token configured");
  }
}

/**
 * Handle save button click
 */
async function handleSave(): Promise<void> {
  const token = tokenInput.value.trim();

  if (!token || token.includes("•")) {
    showMessage("Please enter a valid token", "error");
    return;
  }

  // Validate token format
  if (!token.startsWith("ghp_") && !token.startsWith("github_pat_")) {
    showMessage("Token should start with ghp_ or github_pat_", "error");
    return;
  }

  saveBtn.disabled = true;
  saveBtn.textContent = "Validating...";

  try {
    const valid = await validateToken(token);

    if (valid) {
      await setToken(token);
      tokenInput.value = "••••••••••••••••••••";
      tokenInput.type = "password";
      showMessage("Token saved successfully!", "success");
      updateStatus("connected", "Connected to GitHub");
    } else {
      showMessage("Invalid token - check permissions", "error");
      updateStatus("disconnected", "Invalid token");
    }
  } catch {
    showMessage("Failed to validate token", "error");
  } finally {
    saveBtn.disabled = false;
    saveBtn.textContent = "Save";
  }
}

/**
 * Handle clear button click
 */
async function handleClear(): Promise<void> {
  await removeToken();
  tokenInput.value = "";
  tokenInput.type = "password";
  showMessage("Token removed", "success");
  updateStatus("disconnected", "No token configured");
}

/**
 * Handle visibility toggle
 */
function handleToggleVisibility(): void {
  if (tokenInput.type === "password") {
    tokenInput.type = "text";
  } else {
    tokenInput.type = "password";
  }
}

/**
 * Handle enabled toggle change
 */
async function handleEnabledChange(): Promise<void> {
  const enabled = enabledToggle.checked;
  await setEnabled(enabled);

  if (enabled) {
    const token = await getToken();
    if (token) {
      updateStatus("connected", "Connected to GitHub");
    } else {
      updateStatus("disconnected", "No token configured");
    }
  } else {
    updateStatus("disabled", "Attribution disabled");
  }

  // Notify content scripts to update
  chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
    if (tabs[0]?.id) {
      chrome.tabs.sendMessage(tabs[0].id, {
        type: "SETTINGS_CHANGED",
        enabled,
      });
    }
  });
}

// Event listeners
saveBtn.addEventListener("click", handleSave);
clearBtn.addEventListener("click", handleClear);
toggleVisibility.addEventListener("click", handleToggleVisibility);
enabledToggle.addEventListener("change", handleEnabledChange);

// Allow Enter key to save
tokenInput.addEventListener("keydown", (e) => {
  if (e.key === "Enter") {
    handleSave();
  }
});

// Clear masked value on focus
tokenInput.addEventListener("focus", () => {
  if (tokenInput.value.includes("•")) {
    tokenInput.value = "";
  }
});

// Initialize on load
init();
