/**
 * Storage Module v3
 *
 * Handles file snapshot storage using git blobs and working log management.
 * Uses git's native object store for snapshots (deduplication, compression, gc-managed).
 *
 * Storage locations:
 * - .git/agentblame/agentblame.db - SQLite database
 * - .git/agentblame/working/{base_sha}/snapshots.jsonl - Snapshot chain
 * - .git/agentblame/working/{base_sha}/INITIAL - Uncommitted attributions
 * - .git/objects/ - Git blob storage (via git hash-object)
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { spawn } from "node:child_process";
import type { SnapshotEntry, InitialFile, Snapshot } from "./types";

// =============================================================================
// Git Blob Storage
// =============================================================================

/**
 * Store content as a git blob and return its SHA
 * Uses git hash-object -w --stdin for native storage
 */
export async function storeSnapshot(
  repoRoot: string,
  content: string
): Promise<string> {
  return new Promise((resolve, reject) => {
    const proc = spawn("git", ["hash-object", "-w", "--stdin"], {
      cwd: repoRoot,
      stdio: ["pipe", "pipe", "pipe"],
    });

    let stdout = "";
    let stderr = "";

    proc.stdout.on("data", (data) => {
      stdout += data.toString();
    });

    proc.stderr.on("data", (data) => {
      stderr += data.toString();
    });

    proc.on("close", (code) => {
      if (code === 0) {
        resolve(stdout.trim());
      } else {
        reject(new Error(`git hash-object failed: ${stderr}`));
      }
    });

    proc.on("error", (err) => {
      reject(err);
    });

    // Write content to stdin and close
    proc.stdin.write(content);
    proc.stdin.end();
  });
}

/**
 * Load content from a git blob by SHA
 * Uses git cat-file blob <sha>
 */
export async function loadSnapshot(
  repoRoot: string,
  blobSha: string
): Promise<string> {
  return new Promise((resolve, reject) => {
    const proc = spawn("git", ["cat-file", "blob", blobSha], {
      cwd: repoRoot,
      stdio: ["ignore", "pipe", "pipe"],
    });

    let stdout = "";
    let stderr = "";

    proc.stdout.on("data", (data) => {
      stdout += data.toString();
    });

    proc.stderr.on("data", (data) => {
      stderr += data.toString();
    });

    proc.on("close", (code) => {
      if (code === 0) {
        resolve(stdout);
      } else {
        reject(new Error(`git cat-file failed: ${stderr}`));
      }
    });

    proc.on("error", (err) => {
      reject(err);
    });
  });
}

/**
 * Batch load multiple blobs in a single git process
 * Uses git cat-file --batch for efficiency
 * Returns a Map of blobSha -> content
 */
export async function loadSnapshotsBatch(
  repoRoot: string,
  blobShas: string[]
): Promise<Map<string, string>> {
  if (blobShas.length === 0) {
    return new Map();
  }

  // For single blob, use regular method
  if (blobShas.length === 1) {
    const content = await loadSnapshot(repoRoot, blobShas[0]);
    return new Map([[blobShas[0], content]]);
  }

  return new Promise((resolve, reject) => {
    const proc = spawn("git", ["cat-file", "--batch"], {
      cwd: repoRoot,
      stdio: ["pipe", "pipe", "pipe"],
    });

    const results = new Map<string, string>();
    let buffer = Buffer.alloc(0);
    let currentSha: string | null = null;
    let expectedSize = 0;
    let headerParsed = false;

    proc.stdout.on("data", (data: Buffer) => {
      buffer = Buffer.concat([buffer, data]);

      // Process buffer
      while (buffer.length > 0) {
        if (!headerParsed) {
          // Look for header line: <sha> <type> <size>\n
          const newlineIdx = buffer.indexOf(10); // '\n'
          if (newlineIdx === -1) break;

          const headerLine = buffer.subarray(0, newlineIdx).toString();
          buffer = buffer.subarray(newlineIdx + 1);

          // Parse header: "sha blob size" or "sha missing"
          const parts = headerLine.split(" ");
          if (parts.length >= 3 && parts[1] === "blob") {
            const size = parseInt(parts[2], 10);
            if (!isNaN(size) && size >= 0) {
              currentSha = parts[0];
              expectedSize = size;
              headerParsed = true;
            } else {
              // Invalid size, skip this blob
              currentSha = null;
              headerParsed = false;
            }
          } else {
            // Missing or not a blob, skip
            currentSha = null;
            headerParsed = false;
          }
        } else {
          // Read content + trailing newline
          if (buffer.length >= expectedSize + 1) {
            const content = buffer.subarray(0, expectedSize).toString();
            buffer = buffer.subarray(expectedSize + 1); // +1 for trailing newline

            if (currentSha) {
              results.set(currentSha, content);
            }

            currentSha = null;
            expectedSize = 0;
            headerParsed = false;
          } else {
            break; // Need more data
          }
        }
      }
    });

    proc.stderr.on("data", (data) => {
      // Ignore stderr for batch mode
    });

    proc.on("close", (code) => {
      if (code === 0) {
        resolve(results);
      } else {
        reject(new Error(`git cat-file --batch failed`));
      }
    });

    proc.on("error", (err) => {
      reject(err);
    });

    // Write all SHAs to stdin
    for (const sha of blobShas) {
      proc.stdin.write(sha + "\n");
    }
    proc.stdin.end();
  });
}

/**
 * Check if a blob exists in the git object store
 */
export async function blobExists(
  repoRoot: string,
  blobSha: string
): Promise<boolean> {
  return new Promise((resolve) => {
    const proc = spawn("git", ["cat-file", "-e", blobSha], {
      cwd: repoRoot,
      stdio: ["ignore", "ignore", "ignore"],
    });

    proc.on("close", (code) => {
      resolve(code === 0);
    });

    proc.on("error", () => {
      resolve(false);
    });
  });
}

// =============================================================================
// Path Helpers
// =============================================================================

/**
 * Get the agentblame directory inside .git
 */
export function getAgentBlameGitDir(repoRoot: string): string {
  return path.join(repoRoot, ".git", "agentblame");
}

/**
 * Get the working directory for a specific base SHA
 */
export function getWorkingDir(repoRoot: string, baseSha: string): string {
  return path.join(getAgentBlameGitDir(repoRoot), "working", baseSha);
}

/**
 * Get the snapshots.jsonl path for a base SHA
 */
export function getSnapshotsPath(repoRoot: string, baseSha: string): string {
  return path.join(getWorkingDir(repoRoot, baseSha), "snapshots.jsonl");
}

/**
 * Get the INITIAL file path for a base SHA
 */
export function getInitialPath(repoRoot: string, baseSha: string): string {
  return path.join(getWorkingDir(repoRoot, baseSha), "INITIAL");
}

/**
 * Get the database path
 */
export function getDatabasePath(repoRoot: string): string {
  return path.join(getAgentBlameGitDir(repoRoot), "agentblame.db");
}

/**
 * Ensure the agentblame directory structure exists
 */
export function ensureAgentBlameDirs(repoRoot: string): void {
  const agentBlameDir = getAgentBlameGitDir(repoRoot);
  const workingDir = path.join(agentBlameDir, "working");

  if (!fs.existsSync(agentBlameDir)) {
    fs.mkdirSync(agentBlameDir, { recursive: true });
  }
  if (!fs.existsSync(workingDir)) {
    fs.mkdirSync(workingDir, { recursive: true });
  }
}

/**
 * Ensure working directory for a base SHA exists
 */
export function ensureWorkingDir(repoRoot: string, baseSha: string): void {
  const workingDir = getWorkingDir(repoRoot, baseSha);
  if (!fs.existsSync(workingDir)) {
    fs.mkdirSync(workingDir, { recursive: true });
  }
}

// =============================================================================
// Working Log (snapshots.jsonl)
// =============================================================================

/**
 * Append an entry to the working log
 */
export function appendToWorkingLog(
  repoRoot: string,
  baseSha: string,
  entry: SnapshotEntry
): void {
  ensureWorkingDir(repoRoot, baseSha);
  const logPath = getSnapshotsPath(repoRoot, baseSha);
  const line = JSON.stringify(entry) + "\n";
  fs.appendFileSync(logPath, line, "utf8");
}

/**
 * Read all entries from the working log
 */
export function readWorkingLog(
  repoRoot: string,
  baseSha: string
): SnapshotEntry[] {
  const logPath = getSnapshotsPath(repoRoot, baseSha);

  if (!fs.existsSync(logPath)) {
    return [];
  }

  const content = fs.readFileSync(logPath, "utf8");
  const lines = content.trim().split("\n").filter(Boolean);

  return lines.map((line) => JSON.parse(line) as SnapshotEntry);
}

/**
 * Read entries from the working log filtered by file path
 * More efficient than readWorkingLog + filter for single file queries
 */
export function readWorkingLogForFile(
  repoRoot: string,
  baseSha: string,
  filePath: string
): SnapshotEntry[] {
  const logPath = getSnapshotsPath(repoRoot, baseSha);

  if (!fs.existsSync(logPath)) {
    return [];
  }

  const content = fs.readFileSync(logPath, "utf8");
  const results: SnapshotEntry[] = [];

  // Quick string check before JSON parse
  const filePattern = `"file":"${filePath}"`;

  for (const line of content.split("\n")) {
    if (!line) continue;

    // Fast rejection: skip lines that don't contain the file path
    if (!line.includes(filePattern)) continue;

    const entry = JSON.parse(line) as SnapshotEntry;
    if (entry.file === filePath) {
      results.push(entry);
    }
  }

  return results;
}

/**
 * Get the last snapshot entry for a file (for dedup checking)
 */
export function getLastSnapshotForFile(
  repoRoot: string,
  baseSha: string,
  filePath: string
): SnapshotEntry | null {
  const logPath = getSnapshotsPath(repoRoot, baseSha);

  if (!fs.existsSync(logPath)) {
    return null;
  }

  const content = fs.readFileSync(logPath, "utf8");
  const filePattern = `"file":"${filePath}"`;
  let lastEntry: SnapshotEntry | null = null;

  for (const line of content.split("\n")) {
    if (!line) continue;
    if (!line.includes(filePattern)) continue;

    const entry = JSON.parse(line) as SnapshotEntry;
    if (entry.file === filePath) {
      lastEntry = entry;
    }
  }

  return lastEntry;
}

/**
 * Get the snapshot chain for a specific file
 * Returns snapshots in chronological order (oldest first)
 * Prepends the original git content (baseSha) as the first entry with sessionId: null
 */
export async function getSnapshotChainForFile(
  repoRoot: string,
  baseSha: string,
  filePath: string
): Promise<Snapshot[]> {
  // Use filtered read for efficiency
  const entries = readWorkingLogForFile(repoRoot, baseSha, filePath);

  const aiSnapshots = entries.map((entry) => ({
    timestamp: entry.ts,
    filePath: entry.file,
    blobSha: entry.blob,
    sessionId: entry.session,
    type: entry.type,
  }));

  if (aiSnapshots.length === 0) {
    return [];
  }

  // Get the original content from git (before any AI edits)
  const originalBlob = await getFileBlobAtCommit(repoRoot, baseSha, filePath);

  if (originalBlob) {
    // Prepend the original content as a snapshot with sessionId: null
    const originalSnapshot: Snapshot = {
      timestamp: new Date(0).toISOString(), // Earliest possible time
      filePath,
      blobSha: originalBlob,
      sessionId: null,
      type: "human_edit",
    };
    return [originalSnapshot, ...aiSnapshots];
  }

  // File is NEW (didn't exist before AI edits)
  // Return just AI snapshots - trace algorithm handles this case by
  // attributing lines that exist in all snapshots to the first AI snapshot
  return aiSnapshots;
}

/**
 * Get the blob SHA for a file at a specific commit
 */
async function getFileBlobAtCommit(
  repoRoot: string,
  commitSha: string,
  filePath: string
): Promise<string | null> {
  const { spawn } = await import("node:child_process");

  return new Promise((resolve) => {
    const proc = spawn("git", ["ls-tree", commitSha, filePath], {
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

/**
 * Get all files that have been modified since base SHA
 */
export function getModifiedFiles(repoRoot: string, baseSha: string): string[] {
  const entries = readWorkingLog(repoRoot, baseSha);
  const files = new Set<string>();

  for (const entry of entries) {
    files.add(entry.file);
  }

  return Array.from(files);
}

/**
 * Clear the working log for a base SHA
 */
export function clearWorkingLog(repoRoot: string, baseSha: string): void {
  const logPath = getSnapshotsPath(repoRoot, baseSha);
  if (fs.existsSync(logPath)) {
    fs.unlinkSync(logPath);
  }
}

// =============================================================================
// INITIAL File (Uncommitted Attributions)
// =============================================================================

/**
 * Read the INITIAL file
 */
export function readInitialFile(
  repoRoot: string,
  baseSha: string
): InitialFile | null {
  const initialPath = getInitialPath(repoRoot, baseSha);

  if (!fs.existsSync(initialPath)) {
    return null;
  }

  try {
    const content = fs.readFileSync(initialPath, "utf8");
    return JSON.parse(content) as InitialFile;
  } catch {
    return null;
  }
}

/**
 * Write the INITIAL file
 */
export function writeInitialFile(
  repoRoot: string,
  baseSha: string,
  data: InitialFile
): void {
  ensureWorkingDir(repoRoot, baseSha);
  const initialPath = getInitialPath(repoRoot, baseSha);
  fs.writeFileSync(initialPath, JSON.stringify(data, null, 2), "utf8");
}

/**
 * Update INITIAL file with new attribution
 */
export function updateInitialFile(
  repoRoot: string,
  baseSha: string,
  filePath: string,
  blobSha: string,
  sessionId: string,
  lines: [number, number]
): void {
  let initial = readInitialFile(repoRoot, baseSha);

  if (!initial) {
    initial = {
      baseSha,
      files: {},
    };
  }

  if (!initial.files[filePath]) {
    initial.files[filePath] = {
      blobSha,
      attributions: [],
    };
  }

  // Update blob SHA to latest
  initial.files[filePath].blobSha = blobSha;

  // Add attribution (merge overlapping ranges later during commit processing)
  initial.files[filePath].attributions.push({
    lines,
    sessionId,
  });

  writeInitialFile(repoRoot, baseSha, initial);
}

/**
 * Clear the INITIAL file
 */
export function clearInitialFile(repoRoot: string, baseSha: string): void {
  const initialPath = getInitialPath(repoRoot, baseSha);
  if (fs.existsSync(initialPath)) {
    fs.unlinkSync(initialPath);
  }
}

// =============================================================================
// Working Directory Cleanup
// =============================================================================

/**
 * Clean up working directory for a base SHA (after commit)
 */
export function cleanupWorkingDir(repoRoot: string, baseSha: string): void {
  const workingDir = getWorkingDir(repoRoot, baseSha);

  if (fs.existsSync(workingDir)) {
    fs.rmSync(workingDir, { recursive: true });
  }
}

/**
 * Get all base SHAs that have working directories
 */
export function getActiveBaseShas(repoRoot: string): string[] {
  const workingBaseDir = path.join(getAgentBlameGitDir(repoRoot), "working");

  if (!fs.existsSync(workingBaseDir)) {
    return [];
  }

  try {
    return fs.readdirSync(workingBaseDir).filter((name) => {
      const stat = fs.statSync(path.join(workingBaseDir, name));
      return stat.isDirectory();
    });
  } catch {
    return [];
  }
}

/**
 * Smart cleanup of old working directories.
 * Only cleans up if:
 * 1. The commit is an ancestor of HEAD (we've moved past it)
 * 2. The commit has git notes (deltas were processed)
 *
 * This preserves deltas for:
 * - Current HEAD (uncommitted changes)
 * - Reset/recommit scenarios
 * - Stashed changes
 */
export async function cleanupProcessedWorkingDirs(repoRoot: string, currentBaseSha: string): Promise<void> {
  const baseShas = getActiveBaseShas(repoRoot);

  for (const baseSha of baseShas) {
    // Never clean up current baseSha
    if (baseSha === currentBaseSha) {
      continue;
    }

    // Check if this commit is an ancestor of HEAD and has been processed (has notes)
    const isAncestor = await isAncestorOf(repoRoot, baseSha, currentBaseSha);
    const hasNotes = await commitHasNotes(repoRoot, baseSha);

    if (isAncestor && hasNotes) {
      cleanupWorkingDir(repoRoot, baseSha);
      if (process.env.AGENTBLAME_DEBUG) {
        console.error(`[agentblame] Cleaned up processed working dir: ${baseSha.slice(0, 8)}`);
      }
    } else if (process.env.AGENTBLAME_DEBUG) {
      console.error(`[agentblame] Keeping working dir: ${baseSha.slice(0, 8)} (ancestor=${isAncestor}, hasNotes=${hasNotes})`);
    }
  }
}

/**
 * Check if commitA is an ancestor of commitB
 */
async function isAncestorOf(repoRoot: string, commitA: string, commitB: string): Promise<boolean> {
  return new Promise((resolve) => {
    const proc = spawn("git", ["merge-base", "--is-ancestor", commitA, commitB], {
      cwd: repoRoot,
      stdio: ["ignore", "ignore", "ignore"],
    });
    proc.on("close", (code) => {
      resolve(code === 0);
    });
    proc.on("error", () => {
      resolve(false);
    });
  });
}

/**
 * Check if a commit has agentblame git notes
 */
async function commitHasNotes(repoRoot: string, commitSha: string): Promise<boolean> {
  return new Promise((resolve) => {
    const proc = spawn("git", ["notes", "--ref=agentblame", "show", commitSha], {
      cwd: repoRoot,
      stdio: ["ignore", "ignore", "ignore"],
    });
    proc.on("close", (code) => {
      resolve(code === 0);
    });
    proc.on("error", () => {
      resolve(false);
    });
  });
}

/**
 * Clean up stale working directories (for commits that no longer exist)
 */
export async function cleanupStaleWorkingDirs(repoRoot: string): Promise<{
  cleaned: string[];
  kept: string[];
}> {
  const baseShas = getActiveBaseShas(repoRoot);
  const cleaned: string[] = [];
  const kept: string[] = [];

  for (const baseSha of baseShas) {
    // Check if commit exists
    const exists = await commitExists(repoRoot, baseSha);

    if (!exists) {
      cleanupWorkingDir(repoRoot, baseSha);
      cleaned.push(baseSha);
    } else {
      kept.push(baseSha);
    }
  }

  return { cleaned, kept };
}

/**
 * Check if a commit exists in the repository
 */
async function commitExists(
  repoRoot: string,
  commitSha: string
): Promise<boolean> {
  return new Promise((resolve) => {
    const proc = spawn("git", ["cat-file", "-e", commitSha], {
      cwd: repoRoot,
      stdio: ["ignore", "ignore", "ignore"],
    });

    proc.on("close", (code) => {
      resolve(code === 0);
    });

    proc.on("error", () => {
      resolve(false);
    });
  });
}

// =============================================================================
// Git HEAD Operations
// =============================================================================

/**
 * Get the current HEAD commit SHA
 */
export async function getGitHead(repoRoot: string): Promise<string | null> {
  return new Promise((resolve) => {
    const proc = spawn("git", ["rev-parse", "HEAD"], {
      cwd: repoRoot,
      stdio: ["ignore", "pipe", "pipe"],
    });

    let stdout = "";

    proc.stdout.on("data", (data) => {
      stdout += data.toString();
    });

    proc.on("close", (code) => {
      if (code === 0) {
        resolve(stdout.trim());
      } else {
        resolve(null);
      }
    });

    proc.on("error", () => {
      resolve(null);
    });
  });
}

/**
 * Get the parent commit SHA
 */
export async function getParentCommit(
  repoRoot: string,
  commitSha: string
): Promise<string | null> {
  return new Promise((resolve) => {
    const proc = spawn("git", ["rev-parse", `${commitSha}^`], {
      cwd: repoRoot,
      stdio: ["ignore", "pipe", "pipe"],
    });

    let stdout = "";

    proc.stdout.on("data", (data) => {
      stdout += data.toString();
    });

    proc.on("close", (code) => {
      if (code === 0) {
        resolve(stdout.trim());
      } else {
        // No parent (initial commit)
        resolve(null);
      }
    });

    proc.on("error", () => {
      resolve(null);
    });
  });
}

/**
 * Get file content at a specific commit
 */
export async function getFileAtCommit(
  repoRoot: string,
  commitSha: string,
  filePath: string
): Promise<string | null> {
  return new Promise((resolve) => {
    const proc = spawn("git", ["show", `${commitSha}:${filePath}`], {
      cwd: repoRoot,
      stdio: ["ignore", "pipe", "pipe"],
    });

    let stdout = "";

    proc.stdout.on("data", (data) => {
      stdout += data.toString();
    });

    proc.on("close", (code) => {
      if (code === 0) {
        resolve(stdout);
      } else {
        resolve(null);
      }
    });

    proc.on("error", () => {
      resolve(null);
    });
  });
}

/**
 * Get the root commit (first commit in repository)
 */
export async function getRootCommit(repoRoot: string): Promise<string | null> {
  return new Promise((resolve) => {
    const proc = spawn("git", ["rev-list", "--max-parents=0", "HEAD"], {
      cwd: repoRoot,
      stdio: ["ignore", "pipe", "pipe"],
    });

    let stdout = "";

    proc.stdout.on("data", (data) => {
      stdout += data.toString();
    });

    proc.on("close", (code) => {
      if (code === 0) {
        const commits = stdout.trim().split("\n");
        resolve(commits[0] || null);
      } else {
        resolve(null);
      }
    });

    proc.on("error", () => {
      resolve(null);
    });
  });
}

// =============================================================================
// File Content Helpers
// =============================================================================

/**
 * Read current file content from working directory
 */
export function readFileContent(filePath: string): string | null {
  try {
    return fs.readFileSync(filePath, "utf8");
  } catch {
    return null;
  }
}

/**
 * Check if file exists
 */
export function fileExists(filePath: string): boolean {
  return fs.existsSync(filePath);
}

/**
 * Store file content as snapshot and update working log
 */
export async function captureFileSnapshot(
  repoRoot: string,
  baseSha: string,
  filePath: string,
  content: string,
  sessionId: string | null,
  type: "ai_edit" | "human_edit"
): Promise<string> {
  // Store content as git blob
  const blobSha = await storeSnapshot(repoRoot, content);

  // Append to working log
  const entry: SnapshotEntry = {
    ts: new Date().toISOString(),
    file: filePath,
    blob: blobSha,
    session: sessionId,
    type,
  };

  appendToWorkingLog(repoRoot, baseSha, entry);

  return blobSha;
}
