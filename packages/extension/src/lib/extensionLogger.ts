/**
 * Extension Logger
 *
 * Logs extension events to chrome.storage.local organized by date.
 * Provides a simple interface for logging and retrieving logs.
 */

import { api } from "./browser";

export type LogLevel = "debug" | "info" | "warn" | "error";

const MAX_LOGS_PER_DAY = 500;
const MAX_DAYS_TO_KEEP = 7;

/**
 * Get today's date as YYYY-MM-DD
 */
function getToday(): string {
  return new Date().toISOString().split("T")[0];
}

/**
 * Format a log entry
 */
function formatEntry(level: LogLevel, category: string, message: string): string {
  const timestamp = new Date().toISOString();
  return `[${timestamp}] [${level.toUpperCase()}] [${category}] ${message}`;
}

/**
 * Log a message
 */
export async function log(
  level: LogLevel,
  category: string,
  message: string
): Promise<void> {
  try {
    const today = getToday();
    const key = `logs_${today}`;

    const result = await api.storage.local.get(key);
    const existingLogs: string[] = result[key] || [];

    const entry = formatEntry(level, category, message);
    existingLogs.push(entry);

    // Keep only the most recent logs
    const trimmedLogs = existingLogs.slice(-MAX_LOGS_PER_DAY);

    await api.storage.local.set({ [key]: trimmedLogs });

    // Clean up old logs
    await cleanupOldLogs();
  } catch {
    // Silent failure - don't break the extension
    console.error("Failed to write log:", message);
  }
}

/**
 * Clean up logs older than MAX_DAYS_TO_KEEP
 */
async function cleanupOldLogs(): Promise<void> {
  try {
    const result = await api.storage.local.get(null);
    const keysToRemove: string[] = [];

    const cutoffDate = new Date();
    cutoffDate.setDate(cutoffDate.getDate() - MAX_DAYS_TO_KEEP);
    const cutoffStr = cutoffDate.toISOString().split("T")[0];

    for (const key of Object.keys(result)) {
      if (key.startsWith("logs_")) {
        const dateStr = key.replace("logs_", "");
        if (dateStr < cutoffStr) {
          keysToRemove.push(key);
        }
      }
    }

    if (keysToRemove.length > 0) {
      await api.storage.local.remove(keysToRemove);
    }
  } catch {
    // Silent failure
  }
}

/**
 * Get logs for today
 */
export async function getTodayLogs(): Promise<string[]> {
  try {
    const today = getToday();
    const key = `logs_${today}`;
    const result = await api.storage.local.get(key);
    return result[key] || [];
  } catch {
    return [];
  }
}

/**
 * Get all available log dates
 */
export async function getLogDates(): Promise<string[]> {
  try {
    const result = await api.storage.local.get(null);
    const dates: string[] = [];

    for (const key of Object.keys(result)) {
      if (key.startsWith("logs_")) {
        dates.push(key.replace("logs_", ""));
      }
    }

    return dates.sort().reverse();
  } catch {
    return [];
  }
}

/**
 * Get logs for a specific date
 */
export async function getLogsForDate(date: string): Promise<string[]> {
  try {
    const key = `logs_${date}`;
    const result = await api.storage.local.get(key);
    return result[key] || [];
  } catch {
    return [];
  }
}

/**
 * Clear all logs
 */
export async function clearAllLogs(): Promise<void> {
  try {
    const result = await api.storage.local.get(null);
    const keysToRemove: string[] = [];

    for (const key of Object.keys(result)) {
      if (key.startsWith("logs_")) {
        keysToRemove.push(key);
      }
    }

    if (keysToRemove.length > 0) {
      await api.storage.local.remove(keysToRemove);
    }
  } catch {
    // Silent failure
  }
}

// Convenience functions
export const logInfo = (category: string, message: string) =>
  log("info", category, message);

export const logDebug = (category: string, message: string) =>
  log("debug", category, message);

export const logWarn = (category: string, message: string) =>
  log("warn", category, message);

export const logError = (category: string, message: string) =>
  log("error", category, message);
