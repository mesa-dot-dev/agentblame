/**
 * File Watcher Module v3
 *
 * @deprecated This module is deprecated. Use checkpoint.ts instead.
 *
 * The file watcher approach is not bulletproof because:
 * 1. File watchers can miss rapid changes
 * 2. Race conditions between AI edits and human edits
 * 3. Platform-specific behavior differences
 *
 * The checkpoint-based approach (checkpoint.ts) is bulletproof because:
 * 1. beforeSubmitPrompt/PreToolUse captures state BEFORE AI acts
 * 2. afterFileEdit/PostToolUse captures state AFTER AI acts
 * 3. No race conditions - deterministic capture at hook boundaries
 *
 * This module is kept for backward compatibility but should not be used.
 */

import { watch, type FSWatcher } from "node:fs";
import * as fs from "node:fs";
import * as path from "node:path";
import {
  captureFileSnapshot,
  getGitHead,
  readFileContent,
  getAgentBlameGitDir,
} from "./storage";

// =============================================================================
// File Watcher Class
// =============================================================================

export class FileWatcher {
  private watcher: FSWatcher | null = null;
  private repoRoot: string;
  private aiEditInProgress = new Set<string>();
  private debounceTimers = new Map<string, NodeJS.Timeout>();
  private debounceMs: number;
  private lastCapturedBlobs = new Map<string, string>(); // Avoid duplicate captures

  constructor(repoRoot: string, options?: { debounceMs?: number }) {
    this.repoRoot = repoRoot;
    this.debounceMs = options?.debounceMs ?? 500;
  }

  /**
   * Start watching the repository for file changes
   */
  start(): void {
    if (this.watcher) {
      return; // Already watching
    }

    try {
      this.watcher = watch(
        this.repoRoot,
        { recursive: true },
        (event, filename) => {
          if (!filename) return;
          if (this.shouldIgnore(filename)) return;

          // Debounce rapid changes
          this.debounce(filename, async () => {
            await this.handleFileChange(filename);
          });
        }
      );

      this.watcher.on("error", (err) => {
        console.error("[agentblame] Watcher error:", err.message);
      });
    } catch (err) {
      console.error("[agentblame] Failed to start watcher:", err);
    }
  }

  /**
   * Stop watching
   */
  stop(): void {
    if (this.watcher) {
      this.watcher.close();
      this.watcher = null;
    }

    // Clear all pending debounce timers
    for (const timer of this.debounceTimers.values()) {
      clearTimeout(timer);
    }
    this.debounceTimers.clear();
  }

  /**
   * Mark a file as being edited by AI (called by capture hook)
   */
  markAIEditStart(filePath: string): void {
    const normalized = this.normalizePath(filePath);
    this.aiEditInProgress.add(normalized);
  }

  /**
   * Mark AI edit as complete
   */
  markAIEditEnd(filePath: string): void {
    const normalized = this.normalizePath(filePath);
    this.aiEditInProgress.delete(normalized);
  }

  /**
   * Check if an AI edit is in progress for a file
   */
  isAIEditInProgress(filePath: string): boolean {
    const normalized = this.normalizePath(filePath);
    return this.aiEditInProgress.has(normalized);
  }

  /**
   * Handle a file change event
   */
  private async handleFileChange(relativePath: string): Promise<void> {
    const absolutePath = path.join(this.repoRoot, relativePath);
    const normalized = this.normalizePath(relativePath);

    // Skip if AI edit in progress (already captured by hook)
    if (this.aiEditInProgress.has(normalized)) {
      return;
    }

    // Skip if file doesn't exist (was deleted)
    if (!fs.existsSync(absolutePath)) {
      return;
    }

    // Skip directories
    try {
      const stat = fs.statSync(absolutePath);
      if (stat.isDirectory()) return;
    } catch {
      return;
    }

    // Read file content
    const content = readFileContent(absolutePath);
    if (content === null) return;

    // Get current HEAD
    const baseSha = await getGitHead(this.repoRoot);
    if (!baseSha) return;

    // Capture as human edit
    try {
      const blobSha = await captureFileSnapshot(
        this.repoRoot,
        baseSha,
        relativePath,
        content,
        null, // No session (human edit)
        "human_edit"
      );

      // Track to avoid duplicate captures
      this.lastCapturedBlobs.set(normalized, blobSha);
    } catch (err) {
      // Silent failure - don't interrupt user workflow
      if (process.env.AGENTBLAME_DEBUG) {
        console.error("[agentblame] Failed to capture human edit:", err);
      }
    }
  }

  /**
   * Check if a path should be ignored
   */
  private shouldIgnore(relativePath: string): boolean {
    // Ignore git directory
    if (relativePath.startsWith(".git")) return true;
    if (relativePath.includes("/.git/")) return true;

    // Ignore node_modules
    if (relativePath.includes("node_modules")) return true;

    // Ignore common build outputs
    if (relativePath.includes("/dist/")) return true;
    if (relativePath.includes("/build/")) return true;
    if (relativePath.includes("/.next/")) return true;

    // Ignore agentblame's own files
    if (relativePath.includes(".agentblame")) return true;

    // Ignore common generated files
    if (relativePath.endsWith(".lock")) return true;
    if (relativePath.endsWith("-lock.json")) return true;
    if (relativePath.endsWith(".log")) return true;

    // Ignore binary files by extension
    const binaryExtensions = [
      ".png",
      ".jpg",
      ".jpeg",
      ".gif",
      ".ico",
      ".webp",
      ".mp3",
      ".mp4",
      ".wav",
      ".avi",
      ".mov",
      ".pdf",
      ".zip",
      ".tar",
      ".gz",
      ".rar",
      ".7z",
      ".exe",
      ".dll",
      ".so",
      ".dylib",
      ".wasm",
      ".ttf",
      ".woff",
      ".woff2",
      ".eot",
    ];

    const ext = path.extname(relativePath).toLowerCase();
    if (binaryExtensions.includes(ext)) return true;

    return false;
  }

  /**
   * Debounce a function call for a specific key
   */
  private debounce(key: string, fn: () => Promise<void>): void {
    const existing = this.debounceTimers.get(key);
    if (existing) {
      clearTimeout(existing);
    }

    const timer = setTimeout(async () => {
      this.debounceTimers.delete(key);
      try {
        await fn();
      } catch (err) {
        if (process.env.AGENTBLAME_DEBUG) {
          console.error("[agentblame] Debounced function error:", err);
        }
      }
    }, this.debounceMs);

    this.debounceTimers.set(key, timer);
  }

  /**
   * Normalize path for comparison
   */
  private normalizePath(filePath: string): string {
    // Remove leading ./ or /
    return filePath.replace(/^\.?\//, "").replace(/\\/g, "/");
  }
}

// =============================================================================
// Global Watcher Instance
// =============================================================================

let globalWatcher: FileWatcher | null = null;

/**
 * Start the global file watcher for a repository
 */
export function startWatcher(repoRoot: string): FileWatcher {
  if (globalWatcher) {
    globalWatcher.stop();
  }

  globalWatcher = new FileWatcher(repoRoot);
  globalWatcher.start();

  return globalWatcher;
}

/**
 * Stop the global file watcher
 */
export function stopWatcher(): void {
  if (globalWatcher) {
    globalWatcher.stop();
    globalWatcher = null;
  }
}

/**
 * Get the global file watcher
 */
export function getWatcher(): FileWatcher | null {
  return globalWatcher;
}

/**
 * Mark AI edit start (for coordination with capture hook)
 */
export function markAIEditStart(filePath: string): void {
  if (globalWatcher) {
    globalWatcher.markAIEditStart(filePath);
  }
}

/**
 * Mark AI edit end
 */
export function markAIEditEnd(filePath: string): void {
  if (globalWatcher) {
    globalWatcher.markAIEditEnd(filePath);
  }
}

// =============================================================================
// Watcher State Persistence
// =============================================================================

/**
 * Save watcher state to disk (for daemon mode)
 */
export function saveWatcherState(repoRoot: string): void {
  const stateFile = path.join(getAgentBlameGitDir(repoRoot), "watcher.json");

  const state = {
    running: globalWatcher !== null,
    pid: process.pid,
    startedAt: new Date().toISOString(),
  };

  try {
    fs.writeFileSync(stateFile, JSON.stringify(state, null, 2), "utf8");
  } catch {
    // Silent failure
  }
}

/**
 * Load watcher state from disk
 */
export function loadWatcherState(
  repoRoot: string
): { running: boolean; pid: number; startedAt: string } | null {
  const stateFile = path.join(getAgentBlameGitDir(repoRoot), "watcher.json");

  try {
    if (fs.existsSync(stateFile)) {
      const content = fs.readFileSync(stateFile, "utf8");
      return JSON.parse(content);
    }
  } catch {
    // Silent failure
  }

  return null;
}

/**
 * Clear watcher state
 */
export function clearWatcherState(repoRoot: string): void {
  const stateFile = path.join(getAgentBlameGitDir(repoRoot), "watcher.json");

  try {
    if (fs.existsSync(stateFile)) {
      fs.unlinkSync(stateFile);
    }
  } catch {
    // Silent failure
  }
}

// =============================================================================
// Check if watcher should be running
// =============================================================================

/**
 * Check if another watcher process is running
 */
export function isWatcherRunning(repoRoot: string): boolean {
  const state = loadWatcherState(repoRoot);

  if (!state || !state.running) {
    return false;
  }

  // Check if the process is still alive
  try {
    process.kill(state.pid, 0); // Signal 0 checks if process exists
    return true;
  } catch {
    // Process doesn't exist
    clearWatcherState(repoRoot);
    return false;
  }
}
