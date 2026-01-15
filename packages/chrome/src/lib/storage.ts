/**
 * Chrome storage wrapper for Agent Blame settings
 */

import type { AgentBlameStorage } from "../types";

// Debug logging - disabled in production
// eslint-disable-next-line @typescript-eslint/no-unused-vars
function log(..._args: unknown[]): void {
  // Logging disabled for production
}

const STORAGE_KEYS = {
  TOKEN: "githubToken",
  ENABLED: "enabled",
} as const;

/**
 * Get the GitHub token from storage
 */
export async function getToken(): Promise<string | null> {
  const result = await chrome.storage.local.get(STORAGE_KEYS.TOKEN);
  const token = result[STORAGE_KEYS.TOKEN] || null;
  log("getToken:", token ? `${token.slice(0, 8)}...` : "null");
  return token;
}

/**
 * Save the GitHub token to storage
 */
export async function setToken(token: string): Promise<void> {
  await chrome.storage.local.set({ [STORAGE_KEYS.TOKEN]: token });
}

/**
 * Remove the GitHub token from storage
 */
export async function removeToken(): Promise<void> {
  await chrome.storage.local.remove(STORAGE_KEYS.TOKEN);
}

/**
 * Check if extension is enabled
 */
export async function isEnabled(): Promise<boolean> {
  const result = await chrome.storage.local.get(STORAGE_KEYS.ENABLED);
  // Default to enabled if not set
  const enabled = result[STORAGE_KEYS.ENABLED] !== false;
  log("isEnabled:", enabled, "(raw value:", result[STORAGE_KEYS.ENABLED], ")");
  return enabled;
}

/**
 * Set enabled state
 */
export async function setEnabled(enabled: boolean): Promise<void> {
  await chrome.storage.local.set({ [STORAGE_KEYS.ENABLED]: enabled });
}

/**
 * Get all Agent Blame storage data
 */
export async function getAll(): Promise<AgentBlameStorage> {
  const result = await chrome.storage.local.get([
    STORAGE_KEYS.TOKEN,
    STORAGE_KEYS.ENABLED,
  ]);
  return {
    githubToken: result[STORAGE_KEYS.TOKEN],
    enabled: result[STORAGE_KEYS.ENABLED] !== false,
  };
}

/**
 * Validate a GitHub token by making a test API call
 */
export async function validateToken(token: string): Promise<boolean> {
  try {
    const response = await fetch("https://api.github.com/user", {
      headers: {
        Authorization: `token ${token}`,
        Accept: "application/vnd.github.v3+json",
      },
    });
    return response.ok;
  } catch {
    return false;
  }
}
