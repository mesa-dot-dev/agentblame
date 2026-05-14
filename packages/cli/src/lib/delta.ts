/**
 * Delta Module v3
 *
 * Handles diff computation and delta storage for attribution tracking.
 * Uses unified diff format for computing what changed between edits.
 *
 * Storage: SQLite table `deltas` in the global agentblame database
 * (migrated from .git/agentblame/working/{base_sha}/deltas.jsonl)
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { structuredPatch } from "diff";
import type { DeltaHunk, EditDelta } from "./types";
import { getAgentBlameGitDir } from "./storage";
import { getDatabase } from "./database";

// =============================================================================
// JSONL → SQLite Migration
// =============================================================================

/**
 * Path to the legacy JSONL delta file (used for migration only).
 * Kept exported for backward compatibility during transition.
 */
export function getDeltasPath(repoRoot: string, baseSha: string): string {
  return path.join(getAgentBlameGitDir(repoRoot), "working", baseSha, "deltas.jsonl");
}

/**
 * Transparently migrate legacy JSONL deltas to SQLite.
 * Called automatically before reads and writes — no user action needed.
 *
 * Strategy:
 * 1. If JSONL file doesn't exist → nothing to migrate
 * 2. If SQLite already has deltas for this base_sha → clean up stale JSONL
 * 3. Otherwise → read JSONL, insert into SQLite in a transaction, delete JSONL
 */
function migrateJsonlIfExists(repoRoot: string, baseSha: string): void {
  const jsonlPath = getDeltasPath(repoRoot, baseSha);
  if (!fs.existsSync(jsonlPath)) {
    return;
  }

  const db = getDatabase();

  // Check if SQLite already has data for this base_sha
  const existing = db.prepare(
    "SELECT COUNT(*) as cnt FROM deltas WHERE base_sha = ?"
  ).get(baseSha) as { cnt: number } | null;

  if (existing && existing.cnt > 0) {
    // SQLite already has data — just clean up the old JSONL file
    try {
      fs.unlinkSync(jsonlPath);
    } catch {
      // Ignore cleanup failures
    }
    return;
  }

  // Read and parse JSONL
  const content = fs.readFileSync(jsonlPath, "utf8");
  const lines = content.trim().split("\n").filter(Boolean);

  const deltas: EditDelta[] = [];
  for (const line of lines) {
    try {
      deltas.push(JSON.parse(line) as EditDelta);
    } catch {
      if (process.env.AGENTBLAME_DEBUG) {
        console.error(`[agentblame] Skipping malformed delta during migration: ${line.slice(0, 80)}`);
      }
    }
  }

  if (deltas.length === 0) {
    // JSONL was empty or all lines were malformed — clean up
    try {
      fs.unlinkSync(jsonlPath);
    } catch {
      // Ignore cleanup failures
    }
    return;
  }

  // Insert all deltas in a single transaction
  const insertStmt = db.prepare(`
    INSERT OR IGNORE INTO deltas (base_sha, file_path, session_id, prompt_id, ts, hunks, after_blob)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `);

  const insertAll = db.transaction((items: EditDelta[]) => {
    for (const delta of items) {
      insertStmt.run(
        baseSha,
        delta.file,
        delta.sessionId,
        delta.promptId,
        delta.ts,
        JSON.stringify(delta.hunks),
        delta.afterBlob ?? null
      );
    }
  });

  insertAll(deltas);

  // Delete the JSONL file after successful migration
  try {
    fs.unlinkSync(jsonlPath);
  } catch {
    // Ignore cleanup failures — data is safely in SQLite
  }

  if (process.env.AGENTBLAME_DEBUG) {
    console.error(
      `[agentblame] Migrated ${deltas.length} deltas from JSONL to SQLite for ${baseSha.slice(0, 8)}`
    );
  }
}

// =============================================================================
// Row Mapping
// =============================================================================

interface DeltaRow {
  id: number;
  base_sha: string;
  file_path: string;
  session_id: string | null;
  prompt_id: number | null;
  ts: string;
  hunks: string;
  after_blob: string | null;
}

function rowToDelta(row: DeltaRow): EditDelta {
  return {
    ts: row.ts,
    file: row.file_path,
    sessionId: row.session_id,
    promptId: row.prompt_id,
    hunks: JSON.parse(row.hunks) as DeltaHunk[],
    afterBlob: row.after_blob ?? undefined,
  };
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
// Delta Storage (SQLite-backed, Append-Only)
// =============================================================================

/**
 * Append a delta to the SQLite deltas table.
 * Automatically migrates any legacy JSONL data first.
 */
export function appendDelta(
  repoRoot: string,
  baseSha: string,
  delta: EditDelta
): void {
  // Ensure legacy data is migrated before writing
  migrateJsonlIfExists(repoRoot, baseSha);

  const db = getDatabase();
  const stmt = db.prepare(`
    INSERT INTO deltas (base_sha, file_path, session_id, prompt_id, ts, hunks, after_blob)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `);

  stmt.run(
    baseSha,
    delta.file,
    delta.sessionId,
    delta.promptId,
    delta.ts,
    JSON.stringify(delta.hunks),
    delta.afterBlob ?? null
  );

  if (process.env.AGENTBLAME_DEBUG) {
    const author = delta.sessionId ? `AI:${delta.sessionId.slice(0, 8)}` : "human";
    console.error(
      `[agentblame] Delta appended: ${delta.file} by ${author} (${delta.hunks.length} hunks)`
    );
  }
}

/**
 * Read all deltas for a base SHA, ordered by insertion order (id).
 * Optionally filter by file path.
 */
export function readDeltas(
  repoRoot: string,
  baseSha: string,
  file?: string
): EditDelta[] {
  // Ensure legacy data is migrated before reading
  migrateJsonlIfExists(repoRoot, baseSha);

  const db = getDatabase();
  let rows: DeltaRow[];

  if (file) {
    const stmt = db.prepare(
      "SELECT * FROM deltas WHERE base_sha = ? AND file_path = ? ORDER BY id ASC"
    );
    rows = stmt.all(baseSha, file) as DeltaRow[];
  } else {
    const stmt = db.prepare(
      "SELECT * FROM deltas WHERE base_sha = ? ORDER BY id ASC"
    );
    rows = stmt.all(baseSha) as DeltaRow[];
  }

  return rows.map(rowToDelta);
}

/**
 * Read deltas for a specific file.
 * Uses indexed lookup on (base_sha, file_path) — O(log N) instead of O(N).
 */
export function readDeltasForFile(
  repoRoot: string,
  baseSha: string,
  filePath: string
): EditDelta[] {
  // Ensure legacy data is migrated before reading
  migrateJsonlIfExists(repoRoot, baseSha);

  const db = getDatabase();
  const stmt = db.prepare(
    "SELECT * FROM deltas WHERE base_sha = ? AND file_path = ? ORDER BY id ASC"
  );
  const rows = stmt.all(baseSha, filePath) as DeltaRow[];

  if (process.env.AGENTBLAME_DEBUG) {
    console.error(`[agentblame] readDeltasForFile: ${filePath} → ${rows.length} deltas`);
  }

  return rows.map(rowToDelta);
}

/**
 * Get all unique files that have deltas for a base SHA.
 */
export function getFilesWithDeltas(repoRoot: string, baseSha: string): string[] {
  migrateJsonlIfExists(repoRoot, baseSha);

  const db = getDatabase();
  const stmt = db.prepare(
    "SELECT DISTINCT file_path FROM deltas WHERE base_sha = ? ORDER BY file_path"
  );
  const rows = stmt.all(baseSha) as Array<{ file_path: string }>;

  return rows.map((r) => r.file_path);
}

/**
 * Get the most recent AI delta for a file (if any).
 * Used to detect if another AI tool recently edited a file.
 */
export function getLastAIDeltaForFile(
  repoRoot: string,
  baseSha: string,
  filePath: string
): EditDelta | null {
  migrateJsonlIfExists(repoRoot, baseSha);

  const db = getDatabase();
  const stmt = db.prepare(
    `SELECT * FROM deltas
     WHERE base_sha = ? AND file_path = ? AND session_id IS NOT NULL
     ORDER BY id DESC LIMIT 1`
  );
  const row = stmt.get(baseSha, filePath) as DeltaRow | null;

  return row ? rowToDelta(row) : null;
}

/**
 * Get the most recent delta for a file (AI or human).
 * Used to get the latest known state of a file.
 */
export function getLastDeltaForFile(
  repoRoot: string,
  baseSha: string,
  filePath: string
): EditDelta | null {
  migrateJsonlIfExists(repoRoot, baseSha);

  const db = getDatabase();
  const stmt = db.prepare(
    `SELECT * FROM deltas
     WHERE base_sha = ? AND file_path = ?
     ORDER BY id DESC LIMIT 1`
  );
  const row = stmt.get(baseSha, filePath) as DeltaRow | null;

  return row ? rowToDelta(row) : null;
}

/**
 * Clear all deltas for a base SHA (after commit processing).
 * Also cleans up any legacy JSONL file that may still exist.
 */
export function clearDeltas(repoRoot: string, baseSha: string): void {
  const db = getDatabase();
  db.prepare("DELETE FROM deltas WHERE base_sha = ?").run(baseSha);

  // Clean up legacy JSONL if it still exists
  const jsonlPath = getDeltasPath(repoRoot, baseSha);
  if (fs.existsSync(jsonlPath)) {
    try {
      fs.unlinkSync(jsonlPath);
    } catch {
      // Ignore cleanup failures
    }
  }
}

/**
 * Get delta statistics for a base SHA.
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
  migrateJsonlIfExists(repoRoot, baseSha);

  const db = getDatabase();

  // Get aggregate counts via SQL for efficiency
  const counts = db.prepare(`
    SELECT
      COUNT(*) as total,
      COUNT(CASE WHEN session_id IS NOT NULL THEN 1 END) as ai_count,
      COUNT(CASE WHEN session_id IS NULL THEN 1 END) as human_count,
      COUNT(DISTINCT file_path) as file_count
    FROM deltas
    WHERE base_sha = ?
  `).get(baseSha) as { total: number; ai_count: number; human_count: number; file_count: number };

  // For hunks additions/deletions we need to parse JSON, but this is only
  // called for status display (not hot path), so it's acceptable.
  const rows = db.prepare(
    "SELECT hunks FROM deltas WHERE base_sha = ?"
  ).all(baseSha) as Array<{ hunks: string }>;

  let totalAdditions = 0;
  let totalDeletions = 0;

  for (const row of rows) {
    try {
      const hunks = JSON.parse(row.hunks) as DeltaHunk[];
      for (const hunk of hunks) {
        totalAdditions += hunk.newCount;
        totalDeletions += hunk.oldCount;
      }
    } catch {
      // Skip malformed hunks
    }
  }

  return {
    totalDeltas: counts.total,
    aiDeltas: counts.ai_count,
    humanDeltas: counts.human_count,
    files: counts.file_count,
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
