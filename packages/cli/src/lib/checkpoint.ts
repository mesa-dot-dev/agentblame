/**
 * Checkpoint Module v3
 *
 * Bulletproof capture of file states before AI edits.
 * This replaces the file watcher approach with a deterministic checkpoint system.
 *
 * Strategy:
 * - Cursor: beforeSubmitPrompt captures modified files, afterFileEdit uses checkpoint
 * - Claude: PreToolUse captures target file, PostToolUse uses checkpoint
 * - OpenCode: tool.execute.before captures target file, tool.execute.after uses checkpoint
 *
 * Storage: .git/agentblame/checkpoints/{conversation_id}.json
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { getAgentBlameGitDir, storeSnapshot, loadSnapshot } from "./storage";

// =============================================================================
// Types
// =============================================================================

export interface FileCheckpoint {
  blobSha: string;
  contentHash: string;  // Fast hash for comparison (detects human edits)
  timestamp: string;
}

export interface Checkpoint {
  conversationId: string;
  timestamp: string;
  files: Record<string, FileCheckpoint>;
}

// =============================================================================
// Hash Helpers
// =============================================================================

/**
 * Compute a fast content hash for comparison
 * Uses SHA256 truncated to 16 chars for efficiency
 */
export function hashContent(content: string): string {
  return createHash("sha256").update(content).digest("hex").slice(0, 16);
}

/**
 * Check if a file has changed since the checkpoint
 * Returns true if the file content differs from the checkpoint
 */
export async function hasFileChanged(
  repoRoot: string,
  conversationId: string,
  filePath: string
): Promise<boolean> {
  const checkpoint = loadCheckpoint(repoRoot, conversationId);
  if (!checkpoint) {
    return false; // No checkpoint, can't detect change
  }

  const fileCheckpoint = checkpoint.files[filePath];
  if (!fileCheckpoint) {
    return false; // File not in checkpoint
  }

  // Read current file content
  const absolutePath = filePath.startsWith("/")
    ? filePath
    : path.join(repoRoot, filePath);

  try {
    const currentContent = fs.readFileSync(absolutePath, "utf8");
    const currentHash = hashContent(currentContent);
    return currentHash !== fileCheckpoint.contentHash;
  } catch {
    return false; // Can't read file
  }
}

/**
 * Get checkpoint content for a file (loads from git blob)
 */
export async function getCheckpointContent(
  repoRoot: string,
  conversationId: string,
  filePath: string
): Promise<string | null> {
  const checkpoint = loadCheckpoint(repoRoot, conversationId);
  if (!checkpoint) {
    return null;
  }

  const fileCheckpoint = checkpoint.files[filePath];
  if (!fileCheckpoint) {
    return null;
  }

  try {
    return await loadSnapshot(repoRoot, fileCheckpoint.blobSha);
  } catch {
    return null;
  }
}

// =============================================================================
// Path Helpers
// =============================================================================

/**
 * Get the checkpoints directory path
 */
export function getCheckpointsDir(repoRoot: string): string {
  return path.join(getAgentBlameGitDir(repoRoot), "checkpoints");
}

/**
 * Get the checkpoint file path for a conversation
 */
export function getCheckpointPath(repoRoot: string, conversationId: string): string {
  // Sanitize conversation ID for filesystem
  const safeId = conversationId.replace(/[^a-zA-Z0-9-_]/g, "_");
  return path.join(getCheckpointsDir(repoRoot), `${safeId}.json`);
}

/**
 * Ensure checkpoints directory exists
 */
export function ensureCheckpointsDir(repoRoot: string): void {
  const dir = getCheckpointsDir(repoRoot);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
}

// =============================================================================
// Checkpoint CRUD
// =============================================================================

/**
 * Save a checkpoint for a conversation
 */
export function saveCheckpoint(repoRoot: string, checkpoint: Checkpoint): void {
  ensureCheckpointsDir(repoRoot);
  const checkpointPath = getCheckpointPath(repoRoot, checkpoint.conversationId);
  fs.writeFileSync(checkpointPath, JSON.stringify(checkpoint, null, 2), "utf8");

  if (process.env.AGENTBLAME_DEBUG) {
    console.error(`[agentblame] Saved checkpoint: ${checkpoint.conversationId} with ${Object.keys(checkpoint.files).length} files`);
  }
}

/**
 * Load a checkpoint for a conversation
 */
export function loadCheckpoint(repoRoot: string, conversationId: string): Checkpoint | null {
  const checkpointPath = getCheckpointPath(repoRoot, conversationId);

  if (!fs.existsSync(checkpointPath)) {
    return null;
  }

  try {
    const content = fs.readFileSync(checkpointPath, "utf8");
    return JSON.parse(content) as Checkpoint;
  } catch {
    return null;
  }
}

/**
 * Update a checkpoint with a new file state
 */
export function updateCheckpointFile(
  repoRoot: string,
  conversationId: string,
  filePath: string,
  blobSha: string,
  contentHash: string
): void {
  let checkpoint = loadCheckpoint(repoRoot, conversationId);

  if (!checkpoint) {
    checkpoint = {
      conversationId,
      timestamp: new Date().toISOString(),
      files: {},
    };
  }

  checkpoint.files[filePath] = {
    blobSha,
    contentHash,
    timestamp: new Date().toISOString(),
  };

  saveCheckpoint(repoRoot, checkpoint);
}

/**
 * Update checkpoint with content (computes hash and stores blob)
 */
export async function updateCheckpointWithContent(
  repoRoot: string,
  conversationId: string,
  filePath: string,
  content: string
): Promise<void> {
  const blobSha = await storeSnapshot(repoRoot, content);
  const contentHash = hashContent(content);
  updateCheckpointFile(repoRoot, conversationId, filePath, blobSha, contentHash);
}

/**
 * Get the "before" blob for a file from checkpoint
 * Returns null if no checkpoint exists for this file
 */
export function getCheckpointBlob(
  repoRoot: string,
  conversationId: string,
  filePath: string
): string | null {
  const checkpoint = loadCheckpoint(repoRoot, conversationId);

  if (!checkpoint) {
    return null;
  }

  return checkpoint.files[filePath]?.blobSha || null;
}

/**
 * Delete a checkpoint (cleanup after commit or session end)
 */
export function deleteCheckpoint(repoRoot: string, conversationId: string): void {
  const checkpointPath = getCheckpointPath(repoRoot, conversationId);

  if (fs.existsSync(checkpointPath)) {
    fs.unlinkSync(checkpointPath);
  }
}

/**
 * Clean up old checkpoints (older than specified hours)
 */
export function cleanupOldCheckpoints(repoRoot: string, maxAgeHours: number = 24): number {
  const dir = getCheckpointsDir(repoRoot);

  if (!fs.existsSync(dir)) {
    return 0;
  }

  const now = Date.now();
  const maxAgeMs = maxAgeHours * 60 * 60 * 1000;
  let cleaned = 0;

  try {
    const files = fs.readdirSync(dir);

    for (const file of files) {
      if (!file.endsWith(".json")) continue;

      const filePath = path.join(dir, file);
      const stat = fs.statSync(filePath);

      if (now - stat.mtimeMs > maxAgeMs) {
        fs.unlinkSync(filePath);
        cleaned++;
      }
    }
  } catch {
    // Silent failure
  }

  return cleaned;
}

// =============================================================================
// Git Status Helpers
// =============================================================================

/**
 * Get list of modified files from git status (staged + unstaged)
 * These are files that may have human edits since last commit
 */
export async function getGitModifiedFiles(repoRoot: string): Promise<string[]> {
  return new Promise((resolve) => {
    const proc = spawn("git", ["status", "--porcelain", "-z"], {
      cwd: repoRoot,
      stdio: ["ignore", "pipe", "pipe"],
    });

    let stdout = "";

    proc.stdout.on("data", (data) => {
      stdout += data.toString();
    });

    proc.on("close", (code) => {
      if (code !== 0) {
        resolve([]);
        return;
      }

      // Parse git status output (NUL-separated)
      const files: string[] = [];
      const entries = stdout.split("\0").filter(Boolean);

      for (const entry of entries) {
        // Format: XY filename (where XY is status codes)
        if (entry.length < 4) continue;

        const status = entry.substring(0, 2);
        const filePath = entry.substring(3);

        // Include modified, added, and renamed files (not deleted)
        if (status.includes("M") || status.includes("A") || status.includes("R") || status === "??") {
          // For renamed files, use the new name (after ->)
          const actualPath = filePath.includes(" -> ")
            ? filePath.split(" -> ")[1]
            : filePath;
          files.push(actualPath);
        }
      }

      resolve(files);
    });

    proc.on("error", () => {
      resolve([]);
    });
  });
}

/**
 * Read file content from disk
 */
function readFileContent(filePath: string): string | null {
  try {
    return fs.readFileSync(filePath, "utf8");
  } catch {
    return null;
  }
}

// =============================================================================
// Checkpoint Capture Functions
// =============================================================================

/**
 * Capture checkpoint for Cursor's beforeSubmitPrompt
 * Captures all modified files (from git status) since they may have human edits
 */
export async function captureBeforePromptCheckpoint(
  repoRoot: string,
  conversationId: string
): Promise<Checkpoint> {
  const checkpoint: Checkpoint = {
    conversationId,
    timestamp: new Date().toISOString(),
    files: {},
  };

  // Get all modified files from git status
  const modifiedFiles = await getGitModifiedFiles(repoRoot);

  if (process.env.AGENTBLAME_DEBUG) {
    console.error(`[agentblame] beforeSubmitPrompt: ${modifiedFiles.length} modified files`);
  }

  // Capture each modified file's current state
  for (const relativePath of modifiedFiles) {
    const absolutePath = path.join(repoRoot, relativePath);
    const content = readFileContent(absolutePath);

    if (content === null) continue;

    try {
      const blobSha = await storeSnapshot(repoRoot, content);
      const contentHash = hashContent(content);
      checkpoint.files[relativePath] = {
        blobSha,
        contentHash,
        timestamp: new Date().toISOString(),
      };
    } catch {
      // Skip files that fail to store
    }
  }

  saveCheckpoint(repoRoot, checkpoint);
  return checkpoint;
}

/**
 * Capture checkpoint for a single file (Claude PreToolUse / OpenCode tool.execute.before)
 * More efficient than capturing all modified files since we know the target
 */
export async function captureFileCheckpoint(
  repoRoot: string,
  conversationId: string,
  filePath: string
): Promise<string | null> {
  // Make path relative if absolute
  const relativePath = filePath.startsWith(repoRoot)
    ? filePath.slice(repoRoot.length + 1)
    : filePath;

  const absolutePath = filePath.startsWith("/")
    ? filePath
    : path.join(repoRoot, filePath);

  const content = readFileContent(absolutePath);

  if (content === null) {
    // File doesn't exist yet (new file)
    return null;
  }

  try {
    const blobSha = await storeSnapshot(repoRoot, content);
    const contentHash = hashContent(content);
    updateCheckpointFile(repoRoot, conversationId, relativePath, blobSha, contentHash);

    if (process.env.AGENTBLAME_DEBUG) {
      console.error(`[agentblame] PreToolUse checkpoint: ${relativePath} -> ${blobSha.slice(0, 8)}`);
    }

    return blobSha;
  } catch (err) {
    if (process.env.AGENTBLAME_DEBUG) {
      console.error(`[agentblame] Failed to capture file checkpoint:`, err);
    }
    return null;
  }
}

/**
 * Get the "before" blob for a file, using checkpoint if available, else git HEAD
 */
export async function getBeforeBlob(
  repoRoot: string,
  conversationId: string,
  filePath: string
): Promise<string | null> {
  // Make path relative
  const relativePath = filePath.startsWith(repoRoot)
    ? filePath.slice(repoRoot.length + 1)
    : filePath;

  // First, check checkpoint
  const checkpointBlob = getCheckpointBlob(repoRoot, conversationId, relativePath);
  if (checkpointBlob) {
    if (process.env.AGENTBLAME_DEBUG) {
      console.error(`[agentblame] Using checkpoint blob for ${relativePath}: ${checkpointBlob.slice(0, 8)}`);
    }
    return checkpointBlob;
  }

  // Fall back to git HEAD
  return getFileBlobAtHead(repoRoot, relativePath);
}

/**
 * Get the blob SHA for a file at HEAD
 */
async function getFileBlobAtHead(repoRoot: string, filePath: string): Promise<string | null> {
  return new Promise((resolve) => {
    const proc = spawn("git", ["ls-tree", "HEAD", filePath], {
      cwd: repoRoot,
      stdio: ["ignore", "pipe", "pipe"],
    });

    let stdout = "";

    proc.stdout.on("data", (data) => {
      stdout += data.toString();
    });

    proc.on("close", (code) => {
      if (code === 0 && stdout.trim()) {
        // Output format: mode type blob\tpath
        const parts = stdout.trim().split(/\s+/);
        if (parts.length >= 3) {
          resolve(parts[2]); // The blob SHA
        } else {
          resolve(null);
        }
      } else {
        resolve(null);
      }
    });

    proc.on("error", () => {
      resolve(null);
    });
  });
}
