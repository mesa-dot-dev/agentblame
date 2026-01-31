/**
 * Delta Module v3
 *
 * Handles diff computation and delta storage for attribution tracking.
 * Uses unified diff format for computing what changed between edits.
 *
 * Storage: .git/agentblame/working/{base_sha}/deltas.jsonl
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { structuredPatch } from "diff";
import type { DeltaHunk, EditDelta } from "./types";
import { getAgentBlameGitDir, ensureWorkingDir } from "./storage";

// =============================================================================
// Path Helpers
// =============================================================================

/**
 * Get the deltas.jsonl path for a base SHA
 */
export function getDeltasPath(repoRoot: string, baseSha: string): string {
  return path.join(getAgentBlameGitDir(repoRoot), "working", baseSha, "deltas.jsonl");
}

// =============================================================================
// Diff Computation
// =============================================================================

/**
 * Compute unified diff hunks between two strings
 * Returns array of DeltaHunk describing what changed
 */
export function computeDiff(before: string, after: string): DeltaHunk[] {
  // Handle edge cases
  if (before === after) {
    return [];
  }

  // Use structuredPatch from 'diff' library
  const patch = structuredPatch("file", "file", before, after, "", "", {
    context: 0, // No context lines needed
  });

  return patch.hunks.map((hunk) => ({
    oldStart: hunk.oldStart,
    oldCount: hunk.oldLines,
    newStart: hunk.newStart,
    newCount: hunk.newLines,
  }));
}

/**
 * Compute diff and return detailed line information
 * Useful for debugging and testing
 */
export function computeDiffDetailed(
  before: string,
  after: string
): {
  hunks: DeltaHunk[];
  additions: number;
  deletions: number;
} {
  const hunks = computeDiff(before, after);

  let additions = 0;
  let deletions = 0;

  for (const hunk of hunks) {
    additions += hunk.newCount;
    deletions += hunk.oldCount;
  }

  return { hunks, additions, deletions };
}

// =============================================================================
// Delta Storage (Append-Only)
// =============================================================================

/**
 * Append a delta to the working log
 * Deltas are stored in JSONL format for append-only writes
 */
export function appendDelta(
  repoRoot: string,
  baseSha: string,
  delta: EditDelta
): void {
  ensureWorkingDir(repoRoot, baseSha);
  const deltasPath = getDeltasPath(repoRoot, baseSha);
  const line = JSON.stringify(delta) + "\n";
  fs.appendFileSync(deltasPath, line, "utf8");

  if (process.env.AGENTBLAME_DEBUG) {
    const author = delta.sessionId ? `AI:${delta.sessionId.slice(0, 8)}` : "human";
    console.error(
      `[agentblame] Delta appended: ${delta.file} by ${author} (${delta.hunks.length} hunks)`
    );
  }
}

/**
 * Read all deltas for a base SHA
 * Optionally filter by file path
 */
export function readDeltas(
  repoRoot: string,
  baseSha: string,
  file?: string
): EditDelta[] {
  const deltasPath = getDeltasPath(repoRoot, baseSha);

  if (!fs.existsSync(deltasPath)) {
    return [];
  }

  const content = fs.readFileSync(deltasPath, "utf8");
  const lines = content.trim().split("\n").filter(Boolean);

  const deltas: EditDelta[] = [];

  for (const line of lines) {
    try {
      const delta = JSON.parse(line) as EditDelta;

      // Filter by file if specified
      if (file && delta.file !== file) {
        continue;
      }

      deltas.push(delta);
    } catch {
      // Skip malformed lines
      if (process.env.AGENTBLAME_DEBUG) {
        console.error(`[agentblame] Skipping malformed delta line: ${line}`);
      }
    }
  }

  return deltas;
}

/**
 * Read deltas for a specific file (more efficient than filtering all)
 */
export function readDeltasForFile(
  repoRoot: string,
  baseSha: string,
  filePath: string
): EditDelta[] {
  const deltasPath = getDeltasPath(repoRoot, baseSha);

  if (!fs.existsSync(deltasPath)) {
    if (process.env.AGENTBLAME_DEBUG) {
      console.error(`[agentblame] readDeltasForFile: no deltas file at ${deltasPath}`);
    }
    return [];
  }

  const content = fs.readFileSync(deltasPath, "utf8");
  const results: EditDelta[] = [];

  // Quick string check before JSON parse
  const filePattern = `"file":"${filePath}"`;

  if (process.env.AGENTBLAME_DEBUG) {
    console.error(`[agentblame] readDeltasForFile: searching for "${filePath}"`);
    console.error(`[agentblame]   pattern: ${filePattern}`);
  }

  for (const line of content.split("\n")) {
    if (!line) continue;

    // Fast rejection: skip lines that don't contain the file path
    if (!line.includes(filePattern)) {
      if (process.env.AGENTBLAME_DEBUG && line.includes(filePath.split("/").pop() || "")) {
        // Log if we're missing due to path format difference
        try {
          const delta = JSON.parse(line) as EditDelta;
          console.error(`[agentblame]   MISMATCH: delta has "${delta.file}", looking for "${filePath}"`);
        } catch {}
      }
      continue;
    }

    try {
      const delta = JSON.parse(line) as EditDelta;
      if (delta.file === filePath) {
        results.push(delta);
        if (process.env.AGENTBLAME_DEBUG) {
          console.error(`[agentblame]   FOUND: ${delta.sessionId?.slice(0,8)} ${delta.file}`);
        }
      }
    } catch {
      // Skip malformed lines
    }
  }

  if (process.env.AGENTBLAME_DEBUG) {
    console.error(`[agentblame]   total found: ${results.length}`);
  }

  return results;
}

/**
 * Get all unique files that have deltas
 */
export function getFilesWithDeltas(repoRoot: string, baseSha: string): string[] {
  const deltas = readDeltas(repoRoot, baseSha);
  const files = new Set<string>();

  for (const delta of deltas) {
    files.add(delta.file);
  }

  return Array.from(files);
}

/**
 * Get the most recent AI delta for a file (if any)
 * Used to detect if another AI tool recently edited a file
 */
export function getLastAIDeltaForFile(
  repoRoot: string,
  baseSha: string,
  filePath: string
): EditDelta | null {
  const deltas = readDeltasForFile(repoRoot, baseSha, filePath);

  // Find the most recent AI delta (has sessionId)
  for (let i = deltas.length - 1; i >= 0; i--) {
    if (deltas[i].sessionId !== null) {
      return deltas[i];
    }
  }

  return null;
}

/**
 * Get the most recent delta for a file (AI or human)
 * Used to get the latest known state of a file
 */
export function getLastDeltaForFile(
  repoRoot: string,
  baseSha: string,
  filePath: string
): EditDelta | null {
  const deltas = readDeltasForFile(repoRoot, baseSha, filePath);
  return deltas.length > 0 ? deltas[deltas.length - 1] : null;
}

/**
 * Clear deltas for a base SHA (after commit)
 */
export function clearDeltas(repoRoot: string, baseSha: string): void {
  const deltasPath = getDeltasPath(repoRoot, baseSha);

  if (fs.existsSync(deltasPath)) {
    fs.unlinkSync(deltasPath);
  }
}

/**
 * Get delta statistics for a base SHA
 */
export function getDeltaStats(
  repoRoot: string,
  baseSha: string
): {
  totalDeltas: number;
  aiDeltas: number;
  humanDeltas: number;
  files: number;
  totalAdditions: number;
  totalDeletions: number;
} {
  const deltas = readDeltas(repoRoot, baseSha);
  const files = new Set<string>();

  let aiDeltas = 0;
  let humanDeltas = 0;
  let totalAdditions = 0;
  let totalDeletions = 0;

  for (const delta of deltas) {
    files.add(delta.file);

    if (delta.sessionId) {
      aiDeltas++;
    } else {
      humanDeltas++;
    }

    for (const hunk of delta.hunks) {
      totalAdditions += hunk.newCount;
      totalDeletions += hunk.oldCount;
    }
  }

  return {
    totalDeltas: deltas.length,
    aiDeltas,
    humanDeltas,
    files: files.size,
    totalAdditions,
    totalDeletions,
  };
}

// =============================================================================
// Delta Creation Helpers
// =============================================================================

/**
 * Create an AI edit delta
 */
export function createAIDelta(
  file: string,
  sessionId: string,
  promptId: number | null,
  hunks: DeltaHunk[],
  afterBlob?: string
): EditDelta {
  return {
    ts: new Date().toISOString(),
    file,
    sessionId,
    promptId,
    hunks,
    afterBlob,
  };
}

/**
 * Create a human edit delta
 */
export function createHumanDelta(file: string, hunks: DeltaHunk[], afterBlob?: string): EditDelta {
  return {
    ts: new Date().toISOString(),
    file,
    sessionId: null,
    promptId: null,
    hunks,
    afterBlob,
  };
}
