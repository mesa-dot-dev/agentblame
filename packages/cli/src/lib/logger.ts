/**
 * Logger Module
 *
 * Logs agentblame operations to ~/.agentblame/logs/YYYY-MM-DD.log
 * Each day gets a new log file.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { getGlobalLogsDir } from "./database";

export type LogLevel = "debug" | "info" | "warn" | "error";

/**
 * Get today's log file path
 */
function getLogFilePath(): string {
  const today = new Date().toISOString().split("T")[0]; // YYYY-MM-DD
  return path.join(getGlobalLogsDir(), `${today}.log`);
}

/**
 * Format a log entry
 */
function formatLogEntry(
  level: LogLevel,
  command: string,
  message: string,
  context?: Record<string, unknown>
): string {
  const timestamp = new Date().toISOString();
  const contextStr = context ? ` ${JSON.stringify(context)}` : "";
  return `[${timestamp}] [${level.toUpperCase()}] [${command}] ${message}${contextStr}\n`;
}

/**
 * Write a log entry to today's log file.
 * Only logs if setup has been run (logs directory exists).
 */
export function log(
  level: LogLevel,
  command: string,
  message: string,
  context?: Record<string, unknown>
): void {
  try {
    const logsDir = getGlobalLogsDir();
    if (!fs.existsSync(logsDir)) {
      return; // Setup not run, skip logging
    }
    const logPath = getLogFilePath();
    const entry = formatLogEntry(level, command, message, context);
    fs.appendFileSync(logPath, entry, "utf8");
  } catch {
    // Silently fail - logging should never break the main flow
  }
}

/**
 * Log an info message
 */
export function logInfo(
  command: string,
  message: string,
  context?: Record<string, unknown>
): void {
  log("info", command, message, context);
}

/**
 * Log a debug message
 */
export function logDebug(
  command: string,
  message: string,
  context?: Record<string, unknown>
): void {
  log("debug", command, message, context);
}

/**
 * Log a warning message
 */
export function logWarn(
  command: string,
  message: string,
  context?: Record<string, unknown>
): void {
  log("warn", command, message, context);
}

/**
 * Log an error message
 */
export function logError(
  command: string,
  message: string,
  context?: Record<string, unknown>
): void {
  log("error", command, message, context);
}

/**
 * Log command start
 */
export function logCommandStart(
  command: string,
  context?: Record<string, unknown>
): void {
  logInfo(command, "Command started", context);
}

/**
 * Log command success
 */
export function logCommandSuccess(
  command: string,
  context?: Record<string, unknown>
): void {
  logInfo(command, "Command completed successfully", context);
}

/**
 * Log command failure
 */
export function logCommandError(
  command: string,
  error: unknown,
  context?: Record<string, unknown>
): void {
  const errorMessage = error instanceof Error ? error.message : String(error);
  logError(command, `Command failed: ${errorMessage}`, context);
}

/**
 * Get recent log entries (for debugging)
 */
export function getRecentLogs(lines = 50): string[] {
  try {
    const logPath = getLogFilePath();
    if (!fs.existsSync(logPath)) {
      return [];
    }
    const content = fs.readFileSync(logPath, "utf8");
    const allLines = content.trim().split("\n");
    return allLines.slice(-lines);
  } catch {
    return [];
  }
}

/**
 * Get all log files
 */
export function getLogFiles(): string[] {
  try {
    const logsDir = getGlobalLogsDir();
    if (!fs.existsSync(logsDir)) {
      return [];
    }
    return fs
      .readdirSync(logsDir)
      .filter((f) => f.endsWith(".log"))
      .sort()
      .reverse();
  } catch {
    return [];
  }
}
