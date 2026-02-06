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
import { api } from "../lib/browser";
import {
  getTodayLogs,
  getLogDates,
  getLogsForDate,
  clearAllLogs,
  logInfo,
} from "../lib/extensionLogger";

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

// Logs elements
const logsDetails = document.getElementById("logs-details") as HTMLDetailsElement;
const logsDateSelect = document.getElementById("logs-date-select") as HTMLSelectElement;
const logsContent = document.getElementById("logs-content") as HTMLPreElement;
const clearLogsBtn = document.getElementById("clear-logs-btn") as HTMLButtonElement;

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
  const tabs = await api.tabs.query({ active: true, currentWindow: true });
  if (tabs[0]?.id) {
    api.tabs.sendMessage(tabs[0].id, {
      type: "SETTINGS_CHANGED",
      enabled,
    });
  }
}

/**
 * Load logs dates into the select dropdown
 */
async function loadLogsDates(): Promise<void> {
  const dates = await getLogDates();
  logsDateSelect.innerHTML = "";

  if (dates.length === 0) {
    const option = document.createElement("option");
    option.value = "";
    option.textContent = "No logs";
    logsDateSelect.appendChild(option);
    logsContent.textContent = "No logs available.";
    return;
  }

  for (const date of dates) {
    const option = document.createElement("option");
    option.value = date;
    option.textContent = date;
    logsDateSelect.appendChild(option);
  }

  // Load logs for the first date (today)
  await loadLogsForSelectedDate();
}

/**
 * Load logs for the selected date
 */
async function loadLogsForSelectedDate(): Promise<void> {
  const date = logsDateSelect.value;
  if (!date) {
    logsContent.textContent = "No logs available.";
    return;
  }

  const logs = await getLogsForDate(date);
  if (logs.length === 0) {
    logsContent.textContent = "No logs for this date.";
  } else {
    logsContent.textContent = logs.join("\n");
    // Scroll to bottom
    logsContent.scrollTop = logsContent.scrollHeight;
  }
}

/**
 * Handle clear logs button
 */
async function handleClearLogs(): Promise<void> {
  await clearAllLogs();
  logsContent.textContent = "Logs cleared.";
  await loadLogsDates();
}

// Event listeners
saveBtn.addEventListener("click", handleSave);
clearBtn.addEventListener("click", handleClear);
toggleVisibility.addEventListener("click", handleToggleVisibility);
enabledToggle.addEventListener("change", handleEnabledChange);

// Logs event listeners
if (logsDetails) {
  logsDetails.addEventListener("toggle", () => {
    if (logsDetails.open) {
      loadLogsDates();
    }
  });
}

if (logsDateSelect) {
  logsDateSelect.addEventListener("change", loadLogsForSelectedDate);
}

if (clearLogsBtn) {
  clearLogsBtn.addEventListener("click", handleClearLogs);
}

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

// Log popup opened
logInfo("popup", "Popup opened");

// Initialize on load
init();
