/**
 * SQLite Database Module
 *
 * Handles persistent storage of AI edits for attribution matching.
 * Uses Bun's built-in SQLite for high-performance lookups.
 */

import { Database } from "bun:sqlite";
import * as fs from "node:fs";
import * as path from "node:path";
import type { AiProvider, MatchType, CapturedLine } from "./types";

// =============================================================================
// Types
// =============================================================================

export interface DbEdit {
  id: number;
  timestamp: string;
  provider: AiProvider;
  filePath: string;
  model: string | null;
  content: string;
  contentHash: string;
  contentHashNormalized: string;
  editType: string;
  oldContent: string | null;
  status: string;
  matchedCommit: string | null;
  matchedAt: string | null;
}

export interface DbLine {
  id: number;
  editId: number;
  content: string;
  hash: string;
  hashNormalized: string;
  lineNumber: number | null;
  contextBefore: string | null;
  contextAfter: string | null;
}

export interface LineMatchResult {
  edit: DbEdit;
  line: DbLine;
  matchType: MatchType;
  confidence: number;
}

// =============================================================================
// Database Schema
// =============================================================================

const SCHEMA = `
-- Main edits table (one row per AI edit operation)
CREATE TABLE IF NOT EXISTS edits (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    timestamp TEXT NOT NULL,
    provider TEXT NOT NULL,
    file_path TEXT NOT NULL,
    model TEXT,
    content TEXT NOT NULL,
    content_hash TEXT NOT NULL,
    content_hash_normalized TEXT NOT NULL,
    edit_type TEXT NOT NULL,
    old_content TEXT,
    status TEXT DEFAULT 'pending',
    matched_commit TEXT,
    matched_at TEXT,
    session_id TEXT,
    tool_use_id TEXT
);

-- Lines table (one row per line in an edit)
CREATE TABLE IF NOT EXISTS lines (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    edit_id INTEGER NOT NULL,
    content TEXT NOT NULL,
    hash TEXT NOT NULL,
    hash_normalized TEXT NOT NULL,
    line_number INTEGER,
    context_before TEXT,
    context_after TEXT,
    FOREIGN KEY (edit_id) REFERENCES edits(id) ON DELETE CASCADE
);

-- Indexes for fast lookup
CREATE INDEX IF NOT EXISTS idx_lines_hash ON lines(hash);
CREATE INDEX IF NOT EXISTS idx_lines_hash_normalized ON lines(hash_normalized);
CREATE INDEX IF NOT EXISTS idx_lines_line_number ON lines(line_number);
CREATE INDEX IF NOT EXISTS idx_edits_status ON edits(status);
CREATE INDEX IF NOT EXISTS idx_edits_file_path ON edits(file_path);
CREATE INDEX IF NOT EXISTS idx_edits_content_hash ON edits(content_hash);
CREATE INDEX IF NOT EXISTS idx_edits_session_id ON edits(session_id);
`;

// =============================================================================
// Database Connection
// =============================================================================

let dbInstance: Database | null = null;
let currentAgentBlameDir: string | null = null;

/**
 * Set the agentblame directory for database operations.
 * Must be called before using any database functions.
 */
export function setAgentBlameDir(dir: string): void {
  if (currentAgentBlameDir !== dir) {
    // Close existing connection if switching directories
    if (dbInstance) {
      dbInstance.close();
      dbInstance = null;
    }
    currentAgentBlameDir = dir;
  }
}

/**
 * Get the current agentblame directory.
 */
export function getAgentBlameDir(): string | null {
  return currentAgentBlameDir;
}

/**
 * Get the database file path
 */
export function getDbPath(): string {
  if (!currentAgentBlameDir) {
    throw new Error("agentblame directory not set. Call setAgentBlameDir() first.");
  }
  return path.join(currentAgentBlameDir, "agentblame.db");
}

/**
 * Initialize and return the database connection
 */
export function getDatabase(): Database {
  if (dbInstance) {
    return dbInstance;
  }

  const dbPath = getDbPath();
  const dbDir = path.dirname(dbPath);

  // Ensure directory exists
  if (!fs.existsSync(dbDir)) {
    fs.mkdirSync(dbDir, { recursive: true });
  }

  // Create database connection
  dbInstance = new Database(dbPath);

  // Enable foreign keys and WAL mode for better performance
  dbInstance.exec("PRAGMA foreign_keys = ON");
  dbInstance.exec("PRAGMA journal_mode = WAL");

  // Create tables and indexes
  dbInstance.exec(SCHEMA);

  return dbInstance;
}

/**
 * Close the database connection
 */
export function closeDatabase(): void {
  if (dbInstance) {
    dbInstance.close();
    dbInstance = null;
  }
}

/**
 * Initialize database (creates file and schema if needed)
 * Call this during install to ensure DB is ready
 */
export function initDatabase(): void {
  const db = getDatabase();
  // Database is initialized by getDatabase()
  // Just verify it's working
  db.exec("SELECT 1");
}

// =============================================================================
// Insert Operations (used by capture.ts)
// =============================================================================

export interface InsertEditParams {
  timestamp: string;
  provider: AiProvider;
  filePath: string;
  model: string | null;
  content: string;
  contentHash: string;
  contentHashNormalized: string;
  editType: string;
  oldContent?: string;
  lines: CapturedLine[];
  sessionId?: string;
  toolUseId?: string;
}

/**
 * Insert a new AI edit into the database.
 * Uses an explicit transaction to ensure atomicity - either all data
 * is written (edit + lines) or none. This is especially important
 * when running async hooks where the process could be interrupted.
 */
export function insertEdit(params: InsertEditParams): number {
  const db = getDatabase();

  const editStmt = db.prepare(`
    INSERT INTO edits (
      timestamp, provider, file_path, model, content,
      content_hash, content_hash_normalized, edit_type, old_content,
      session_id, tool_use_id
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);

  const lineStmt = db.prepare(`
    INSERT INTO lines (edit_id, content, hash, hash_normalized, line_number, context_before, context_after)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `);

  // Wrap in transaction for atomicity
  db.exec("BEGIN TRANSACTION");
  try {
    const result = editStmt.run(
      params.timestamp,
      params.provider,
      params.filePath,
      params.model,
      params.content,
      params.contentHash,
      params.contentHashNormalized,
      params.editType,
      params.oldContent || null,
      params.sessionId || null,
      params.toolUseId || null
    );

    const editId = Number(result.lastInsertRowid);

    // Insert lines with line numbers and context
    for (const line of params.lines) {
      lineStmt.run(
        editId,
        line.content,
        line.hash,
        line.hashNormalized,
        line.lineNumber || null,
        line.contextBefore || null,
        line.contextAfter || null
      );
    }

    db.exec("COMMIT");
    return editId;
  } catch (err) {
    db.exec("ROLLBACK");
    throw err;
  }
}

// =============================================================================
// Query Operations (used by process.ts for matching)
// =============================================================================

/**
 * Find a line match by exact hash
 * Returns the edit and line if found, with same-file matches preferred
 */
export function findByExactHash(
  hash: string,
  filePath: string
): LineMatchResult | null {
  const db = getDatabase();

  // First try same-file match
  const sameFileStmt = db.prepare(`
    SELECT
      l.id as line_id, l.edit_id, l.content as line_content,
      l.hash, l.hash_normalized, l.line_number, l.context_before, l.context_after,
      e.*
    FROM lines l
    JOIN edits e ON l.edit_id = e.id
    WHERE l.hash = ? AND (
      e.file_path = ? OR
      e.file_path LIKE ? OR
      ? LIKE '%' || substr(e.file_path, instr(e.file_path, '/') + 1)
    )
    ORDER BY e.timestamp DESC
    LIMIT 1
  `);

  const fileName = filePath.split("/").pop() || "";
  let row = sameFileStmt.get(hash, filePath, `%${fileName}`, filePath) as any;

  // If no same-file match, try any match
  if (!row) {
    const anyStmt = db.prepare(`
      SELECT
        l.id as line_id, l.edit_id, l.content as line_content,
        l.hash, l.hash_normalized, l.line_number, l.context_before, l.context_after,
        e.*
      FROM lines l
      JOIN edits e ON l.edit_id = e.id
      WHERE l.hash = ?
      ORDER BY e.timestamp DESC
      LIMIT 1
    `);
    row = anyStmt.get(hash) as any;
  }

  if (!row) return null;

  return {
    edit: rowToEdit(row),
    line: {
      id: row.line_id,
      editId: row.edit_id,
      content: row.line_content,
      hash: row.hash,
      hashNormalized: row.hash_normalized,
      lineNumber: row.line_number,
      contextBefore: row.context_before,
      contextAfter: row.context_after,
    },
    matchType: "exact_hash",
    confidence: 1.0,
  };
}

/**
 * Find a line match by normalized hash
 */
export function findByNormalizedHash(
  hashNormalized: string,
  filePath: string
): LineMatchResult | null {
  const db = getDatabase();

  const fileName = filePath.split("/").pop() || "";

  // First try same-file match
  const sameFileStmt = db.prepare(`
    SELECT
      l.id as line_id, l.edit_id, l.content as line_content,
      l.hash, l.hash_normalized, l.line_number, l.context_before, l.context_after,
      e.*
    FROM lines l
    JOIN edits e ON l.edit_id = e.id
    WHERE l.hash_normalized = ? AND (
      e.file_path = ? OR
      e.file_path LIKE ? OR
      ? LIKE '%' || substr(e.file_path, instr(e.file_path, '/') + 1)
    )
    ORDER BY e.timestamp DESC
    LIMIT 1
  `);

  let row = sameFileStmt.get(hashNormalized, filePath, `%${fileName}`, filePath) as any;

  if (!row) {
    const anyStmt = db.prepare(`
      SELECT
        l.id as line_id, l.edit_id, l.content as line_content,
        l.hash, l.hash_normalized, l.line_number, l.context_before, l.context_after,
        e.*
      FROM lines l
      JOIN edits e ON l.edit_id = e.id
      WHERE l.hash_normalized = ?
      ORDER BY e.timestamp DESC
      LIMIT 1
    `);
    row = anyStmt.get(hashNormalized) as any;
  }

  if (!row) return null;

  return {
    edit: rowToEdit(row),
    line: {
      id: row.line_id,
      editId: row.edit_id,
      content: row.line_content,
      hash: row.hash,
      hashNormalized: row.hash_normalized,
      lineNumber: row.line_number,
      contextBefore: row.context_before,
      contextAfter: row.context_after,
    },
    matchType: "normalized_hash",
    confidence: 0.95,
  };
}

/**
 * Find edits for a specific file (used for substring matching fallback)
 */
export function findEditsByFile(filePath: string): DbEdit[] {
  const db = getDatabase();
  const fileName = filePath.split("/").pop() || "";

  const stmt = db.prepare(`
    SELECT * FROM edits
    WHERE file_path = ? OR
          file_path LIKE ? OR
          ? LIKE '%' || substr(file_path, instr(file_path, '/') + 1)
    ORDER BY timestamp DESC
  `);

  const rows = stmt.all(filePath, `%${fileName}`, filePath) as any[];
  return rows.map(rowToEdit);
}

/**
 * Get lines for a specific edit
 */
export function getEditLines(editId: number): DbLine[] {
  const db = getDatabase();
  const stmt = db.prepare(`SELECT * FROM lines WHERE edit_id = ?`);
  const rows = stmt.all(editId) as any[];
  return rows.map(row => ({
    id: row.id,
    editId: row.edit_id,
    content: row.content,
    hash: row.hash,
    hashNormalized: row.hash_normalized,
    lineNumber: row.line_number,
    contextBefore: row.context_before,
    contextAfter: row.context_after,
  }));
}

/**
 * Find a line match using exact matching only:
 * 1. Exact hash match (confidence: 1.0)
 * 2. Normalized hash match (confidence: 0.95) - handles formatter whitespace changes
 *
 * No substring/fuzzy matching - if hash doesn't match, it's human code.
 * Philosophy: "If user modified AI code, it's human code"
 */
export function findLineMatch(
  lineContent: string,
  lineHash: string,
  lineHashNormalized: string,
  filePath: string
): LineMatchResult | null {
  // Strategy 1: Exact hash - perfect match
  let match = findByExactHash(lineHash, filePath);
  if (match) return match;

  // Strategy 2: Normalized hash - handles whitespace changes from formatters
  match = findByNormalizedHash(lineHashNormalized, filePath);
  if (match) return match;

  // No match = human code (either written by human or modified from AI)
  return null;
}

// =============================================================================
// Update Operations
// =============================================================================

/**
 * Mark an edit as matched to a commit
 */
export function markEditAsMatched(editId: number, commitSha: string): void {
  const db = getDatabase();
  const stmt = db.prepare(`
    UPDATE edits
    SET status = 'matched', matched_commit = ?, matched_at = ?
    WHERE id = ?
  `);
  stmt.run(commitSha, new Date().toISOString(), editId);
}

/**
 * Mark multiple edits as matched
 */
export function markEditsAsMatched(editIds: number[], commitSha: string): void {
  const db = getDatabase();
  const timestamp = new Date().toISOString();

  const stmt = db.prepare(`
    UPDATE edits
    SET status = 'matched', matched_commit = ?, matched_at = ?
    WHERE id = ?
  `);

  db.exec("BEGIN TRANSACTION");
  try {
    for (const editId of editIds) {
      stmt.run(commitSha, timestamp, editId);
    }
    db.exec("COMMIT");
  } catch (err) {
    db.exec("ROLLBACK");
    throw err;
  }
}

// =============================================================================
// Cleanup Operations
// =============================================================================

/**
 * Clean up old entries
 * - Removes matched entries older than maxAgeDays
 * - Removes unmatched entries older than expireDays
 */
export function cleanupOldEntries(
  maxAgeDays = 7,
  expireDays = 30
): { removed: number; kept: number } {
  const db = getDatabase();

  // Count before
  const beforeCount = (db.prepare("SELECT COUNT(*) as count FROM edits").get() as any).count;

  // Delete old matched entries
  db.prepare(`
    DELETE FROM edits
    WHERE status = 'matched'
    AND datetime(matched_at) < datetime('now', '-' || ? || ' days')
  `).run(maxAgeDays);

  // Delete old unmatched entries
  db.prepare(`
    DELETE FROM edits
    WHERE (status IS NULL OR status = 'pending')
    AND datetime(timestamp) < datetime('now', '-' || ? || ' days')
  `).run(expireDays);

  // Count after
  const afterCount = (db.prepare("SELECT COUNT(*) as count FROM edits").get() as any).count;

  return {
    removed: beforeCount - afterCount,
    kept: afterCount,
  };
}

/**
 * Get count of pending edits
 */
export function getPendingEditCount(): number {
  const db = getDatabase();
  const result = db.prepare(`
    SELECT COUNT(*) as count FROM edits
    WHERE status IS NULL OR status = 'pending'
  `).get() as any;
  return result.count;
}

/**
 * Get recent pending edits for status display
 */
export function getRecentPendingEdits(limit = 5): DbEdit[] {
  const db = getDatabase();
  const stmt = db.prepare(`
    SELECT * FROM edits
    WHERE status IS NULL OR status = 'pending'
    ORDER BY timestamp DESC
    LIMIT ?
  `);
  const rows = stmt.all(limit) as any[];
  return rows.map(rowToEdit);
}

// =============================================================================
// Helpers
// =============================================================================

function rowToEdit(row: any): DbEdit {
  return {
    id: row.id,
    timestamp: row.timestamp,
    provider: row.provider as AiProvider,
    filePath: row.file_path,
    model: row.model,
    content: row.content,
    contentHash: row.content_hash,
    contentHashNormalized: row.content_hash_normalized,
    editType: row.edit_type,
    oldContent: row.old_content,
    status: row.status,
    matchedCommit: row.matched_commit,
    matchedAt: row.matched_at,
  };
}
