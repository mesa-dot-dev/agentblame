/**
 * SQLite Database Module v3
 *
 * Handles persistent storage of sessions, prompts, and tool calls.
 * Uses Bun's built-in SQLite for high-performance lookups.
 */

import { Database } from "bun:sqlite";
import * as fs from "node:fs";
import * as path from "node:path";
import { createHash } from "node:crypto";
import type { AiAgent } from "./types";

// =============================================================================
// Types
// =============================================================================

export interface DbSession {
  id: string;
  agent: AiAgent;
  model: string | null;
  conversationId: string | null;
  createdAt: string;
  firstCommitSha: string | null;
  firstCommitAt: string | null;
}

export interface DbPrompt {
  id: number;
  sessionId: string;
  content: string | null;  // null when storePromptContent is false
  contentHash: string;     // SHA256 hash for deduplication
  timestamp: string;
}

export interface DbToolCall {
  id: number;
  sessionId: string;
  toolName: string;
  filePath: string | null;
  timestamp: string;
}

// =============================================================================
// Database Schema
// =============================================================================

const SCHEMA = `
-- Sessions: One per AI conversation
CREATE TABLE IF NOT EXISTS sessions (
    id TEXT PRIMARY KEY,
    agent TEXT NOT NULL,
    model TEXT,
    conversation_id TEXT,
    created_at TEXT NOT NULL,
    first_commit_sha TEXT,
    first_commit_at TEXT
);

-- Prompts: User messages that triggered AI actions
CREATE TABLE IF NOT EXISTS prompts (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    session_id TEXT NOT NULL,
    content TEXT,
    content_hash TEXT NOT NULL,
    timestamp TEXT NOT NULL,
    FOREIGN KEY (session_id) REFERENCES sessions(id)
);

-- Tool Calls: What the AI did (minimal for counting per prompt)
CREATE TABLE IF NOT EXISTS tool_calls (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    session_id TEXT NOT NULL,
    tool_name TEXT NOT NULL,
    file_path TEXT,
    timestamp TEXT NOT NULL,
    FOREIGN KEY (session_id) REFERENCES sessions(id)
);

-- Indexes
CREATE INDEX IF NOT EXISTS idx_sessions_agent ON sessions(agent, conversation_id);
CREATE INDEX IF NOT EXISTS idx_prompts_session ON prompts(session_id);
CREATE INDEX IF NOT EXISTS idx_tool_calls_session ON tool_calls(session_id);
CREATE INDEX IF NOT EXISTS idx_tool_calls_file ON tool_calls(file_path);
CREATE INDEX IF NOT EXISTS idx_tool_calls_timestamp ON tool_calls(timestamp);
`;

// =============================================================================
// Database Connection
// =============================================================================

let dbInstance: Database | null = null;
let currentDbPath: string | null = null;

/**
 * Set the database path directly.
 */
export function setDatabasePath(dbPath: string): void {
  if (currentDbPath !== dbPath) {
    if (dbInstance) {
      dbInstance.close();
      dbInstance = null;
    }
    currentDbPath = dbPath;
  }
}

/**
 * Get the database file path
 */
export function getDbPath(): string {
  if (!currentDbPath) {
    throw new Error("Database path not set. Call setDatabasePath() first.");
  }
  return currentDbPath;
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

  if (!fs.existsSync(dbDir)) {
    fs.mkdirSync(dbDir, { recursive: true });
  }

  dbInstance = new Database(dbPath);
  dbInstance.exec("PRAGMA foreign_keys = ON");
  dbInstance.exec("PRAGMA journal_mode = WAL");
  dbInstance.exec("PRAGMA busy_timeout = 5000");
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
 * Initialize database
 */
export function initDatabase(): void {
  const db = getDatabase();
  db.exec("SELECT 1");
}

/**
 * Reset database (drop and recreate tables)
 */
export function resetDatabase(): void {
  const db = getDatabase();
  db.exec("DROP TABLE IF EXISTS tool_calls");
  db.exec("DROP TABLE IF EXISTS prompts");
  db.exec("DROP TABLE IF EXISTS sessions");
  db.exec(SCHEMA);
}

// =============================================================================
// Session ID Generation
// =============================================================================

/**
 * Generate a stable session ID from agent and conversation ID
 */
export function generateSessionId(agent: AiAgent, conversationId: string): string {
  const hash = createHash("sha256");
  hash.update(`${agent}:${conversationId}`);
  return hash.digest("hex").substring(0, 16);
}

// =============================================================================
// Session Operations
// =============================================================================

export interface UpsertSessionParams {
  id: string;
  agent: AiAgent;
  model?: string | null;
  conversationId?: string | null;
}

/**
 * Upsert a session
 */
export function upsertSession(params: UpsertSessionParams): void {
  const db = getDatabase();
  const stmt = db.prepare(`
    INSERT INTO sessions (id, agent, model, conversation_id, created_at)
    VALUES (?, ?, ?, ?, ?)
    ON CONFLICT(id) DO UPDATE SET
      model = COALESCE(excluded.model, sessions.model)
  `);
  stmt.run(
    params.id,
    params.agent,
    params.model ?? null,
    params.conversationId ?? null,
    new Date().toISOString()
  );
}

/**
 * Get a session by ID
 */
export function getSession(sessionId: string): DbSession | null {
  const db = getDatabase();
  const stmt = db.prepare("SELECT * FROM sessions WHERE id = ?");
  const row = stmt.get(sessionId) as any;
  if (!row) return null;
  return rowToSession(row);
}

/**
 * Update session with first commit info
 */
export function updateSessionFirstCommit(sessionId: string, commitSha: string): void {
  const db = getDatabase();
  const stmt = db.prepare(`
    UPDATE sessions
    SET first_commit_sha = COALESCE(first_commit_sha, ?),
        first_commit_at = COALESCE(first_commit_at, ?)
    WHERE id = ?
  `);
  stmt.run(commitSha, new Date().toISOString(), sessionId);
}

/**
 * Get recent sessions
 */
export function getRecentSessions(limit = 5): DbSession[] {
  const db = getDatabase();
  const stmt = db.prepare(`SELECT * FROM sessions ORDER BY created_at DESC LIMIT ?`);
  const rows = stmt.all(limit) as any[];
  return rows.map(rowToSession);
}

// =============================================================================
// Prompt Operations
// =============================================================================

export interface InsertPromptParams {
  sessionId: string;
  content: string | null;  // null when not storing content
  contentHash: string;     // SHA256 hash for deduplication
  timestamp?: string;
}

/**
 * Insert a new prompt
 */
export function insertPrompt(params: InsertPromptParams): number {
  const db = getDatabase();
  const stmt = db.prepare(`
    INSERT INTO prompts (session_id, content, content_hash, timestamp)
    VALUES (?, ?, ?, ?)
  `);
  const result = stmt.run(
    params.sessionId,
    params.content,
    params.contentHash,
    params.timestamp ?? new Date().toISOString()
  );
  return Number(result.lastInsertRowid);
}

/**
 * Generate a hash for prompt content (for deduplication)
 */
export function hashPromptContent(content: string): string {
  return createHash('sha256').update(content).digest('hex').substring(0, 16);
}

/**
 * Get prompts for a session
 */
export function getPromptsForSession(sessionId: string): DbPrompt[] {
  const db = getDatabase();
  const stmt = db.prepare("SELECT * FROM prompts WHERE session_id = ? ORDER BY timestamp ASC");
  const rows = stmt.all(sessionId) as any[];
  return rows.map(rowToPrompt);
}

/**
 * Get the most recent prompt for a session
 */
export function getLatestPromptForSession(sessionId: string): DbPrompt | null {
  const db = getDatabase();
  const stmt = db.prepare(`
    SELECT * FROM prompts WHERE session_id = ? ORDER BY timestamp DESC LIMIT 1
  `);
  const row = stmt.get(sessionId) as any;
  return row ? rowToPrompt(row) : null;
}

/**
 * Get all prompts for a session concatenated into one string
 * Useful for displaying the full conversation context in CLI
 */
export function getConcatenatedPromptsForSession(sessionId: string): string | null {
  const prompts = getPromptsForSession(sessionId);
  if (prompts.length === 0) return null;

  if (prompts.length === 1) {
    return prompts[0].content ?? "[content not stored]";
  }

  // Concatenate with separator showing it's multiple prompts
  return prompts
    .map((p, i) => `[${i + 1}] ${p.content ?? '[not stored]'}`)
    .join(" → ");
}

/**
 * Get all prompts for a session with their associated tool call summaries
 * Tool calls are grouped by the prompt that triggered them (based on timestamps)
 * Used for git notes and analytics
 */
export function getPromptsWithToolCounts(sessionId: string): Array<{
  id: number;
  timestamp: string;
  content: string | null;
  tools?: Record<string, number>;
  duration?: number;
}> | null {
  const prompts = getPromptsForSession(sessionId);
  if (prompts.length === 0) return null;

  const toolCalls = getToolCallsForSession(sessionId);

  const result: Array<{
    id: number;
    timestamp: string;
    content: string | null;
    tools?: Record<string, number>;
    duration?: number;
  }> = [];

  for (let i = 0; i < prompts.length; i++) {
    const prompt = prompts[i];
    const promptTime = new Date(prompt.timestamp).getTime();
    const nextPromptTime = i < prompts.length - 1
      ? new Date(prompts[i + 1].timestamp).getTime()
      : Infinity;

    // Find tool calls between this prompt and the next
    const toolsForPrompt = toolCalls.filter((tc) => {
      const tcTime = new Date(tc.timestamp).getTime();
      return tcTime >= promptTime && tcTime < nextPromptTime;
    });

    // Count tools
    const tools: Record<string, number> = {};
    for (const tool of toolsForPrompt) {
      tools[tool.toolName] = (tools[tool.toolName] || 0) + 1;
    }

    // Calculate duration until next prompt (or last tool call)
    let duration: number | undefined;
    if (i < prompts.length - 1) {
      duration = Math.round((nextPromptTime - promptTime) / 1000);
    } else if (toolsForPrompt.length > 0) {
      // Last prompt: duration until last tool call
      const lastToolTime = new Date(toolsForPrompt[toolsForPrompt.length - 1].timestamp).getTime();
      duration = Math.round((lastToolTime - promptTime) / 1000);
    }

    result.push({
      id: prompt.id,
      timestamp: prompt.timestamp,
      content: prompt.content,
      tools: Object.keys(tools).length > 0 ? tools : undefined,
      duration,
    });
  }

  return result;
}

/**
 * Check if a prompt already exists (by hash)
 */
export function promptExists(sessionId: string, contentHash: string): boolean {
  const db = getDatabase();
  const stmt = db.prepare(`SELECT 1 FROM prompts WHERE session_id = ? AND content_hash = ? LIMIT 1`);
  const result = stmt.get(sessionId, contentHash);
  if (process.env.AGENTBLAME_DEBUG) {
    console.error(`[agentblame] promptExists query result:`, result, `type:`, typeof result);
  }
  return result !== undefined && result !== null;
}

// =============================================================================
// Tool Call Operations
// =============================================================================

export interface InsertToolCallParams {
  sessionId: string;
  toolName: string;
  filePath?: string | null;
  timestamp?: string;
}

/**
 * Insert a new tool call
 */
export function insertToolCall(params: InsertToolCallParams): number {
  const db = getDatabase();
  const stmt = db.prepare(`
    INSERT INTO tool_calls (session_id, tool_name, file_path, timestamp)
    VALUES (?, ?, ?, ?)
  `);
  const result = stmt.run(
    params.sessionId,
    params.toolName,
    params.filePath ?? null,
    params.timestamp ?? new Date().toISOString()
  );
  return Number(result.lastInsertRowid);
}

/**
 * Get tool calls for a session
 */
export function getToolCallsForSession(sessionId: string): DbToolCall[] {
  const db = getDatabase();
  const stmt = db.prepare("SELECT * FROM tool_calls WHERE session_id = ? ORDER BY timestamp ASC");
  const rows = stmt.all(sessionId) as any[];
  return rows.map(rowToToolCall);
}

/**
 * Get unique tool names used in a session
 */
export function getToolNamesForSession(sessionId: string): string[] {
  const db = getDatabase();
  const stmt = db.prepare(`SELECT DISTINCT tool_name FROM tool_calls WHERE session_id = ? ORDER BY tool_name`);
  const rows = stmt.all(sessionId) as any[];
  return rows.map((r) => r.tool_name);
}

/**
 * Get tool call counts for a session
 * Returns a map of tool_name -> count
 */
export function getToolCountsForSession(sessionId: string): Record<string, number> {
  const db = getDatabase();
  const stmt = db.prepare(`
    SELECT tool_name, COUNT(*) as count
    FROM tool_calls
    WHERE session_id = ?
    GROUP BY tool_name
  `);
  const rows = stmt.all(sessionId) as any[];
  const counts: Record<string, number> = {};
  for (const row of rows) {
    counts[row.tool_name] = row.count;
  }
  return counts;
}

/**
 * Get session duration in seconds (last tool call - session start)
 * Returns null if no tool calls
 */
export function getSessionDuration(sessionId: string): number | null {
  const db = getDatabase();

  // Get session start time
  const session = db.prepare("SELECT created_at FROM sessions WHERE id = ?").get(sessionId) as any;
  if (!session) return null;

  // Get last tool call time
  const lastToolCall = db.prepare(`
    SELECT MAX(timestamp) as last_ts
    FROM tool_calls
    WHERE session_id = ?
  `).get(sessionId) as any;

  if (!lastToolCall?.last_ts) return null;

  const startTime = new Date(session.created_at).getTime();
  const endTime = new Date(lastToolCall.last_ts).getTime();

  return Math.round((endTime - startTime) / 1000);
}

// =============================================================================
// Cleanup Operations
// =============================================================================

/**
 * Clean up old entries (sessions without commits older than maxAgeDays)
 */
export function cleanupOldEntries(maxAgeDays = 30): { removed: number; kept: number } {
  const db = getDatabase();
  const beforeCount = (db.prepare("SELECT COUNT(*) as count FROM sessions").get() as any).count;

  db.prepare(`
    DELETE FROM sessions
    WHERE first_commit_sha IS NULL
    AND datetime(created_at) < datetime('now', '-' || ? || ' days')
  `).run(maxAgeDays);

  const afterCount = (db.prepare("SELECT COUNT(*) as count FROM sessions").get() as any).count;
  return { removed: beforeCount - afterCount, kept: afterCount };
}

/**
 * Get stats for status display
 */
export function getStats(): { sessions: number; prompts: number; toolCalls: number } {
  const db = getDatabase();
  const sessions = (db.prepare("SELECT COUNT(*) as count FROM sessions").get() as any).count;
  const prompts = (db.prepare("SELECT COUNT(*) as count FROM prompts").get() as any).count;
  const toolCalls = (db.prepare("SELECT COUNT(*) as count FROM tool_calls").get() as any).count;
  return { sessions, prompts, toolCalls };
}

// =============================================================================
// Helpers
// =============================================================================

function rowToSession(row: any): DbSession {
  return {
    id: row.id,
    agent: row.agent as AiAgent,
    model: row.model,
    conversationId: row.conversation_id,
    createdAt: row.created_at,
    firstCommitSha: row.first_commit_sha,
    firstCommitAt: row.first_commit_at,
  };
}

function rowToPrompt(row: any): DbPrompt {
  return {
    id: row.id,
    sessionId: row.session_id,
    content: row.content,
    contentHash: row.content_hash,
    timestamp: row.timestamp,
  };
}

function rowToToolCall(row: any): DbToolCall {
  return {
    id: row.id,
    sessionId: row.session_id,
    toolName: row.tool_name,
    filePath: row.file_path,
    timestamp: row.timestamp,
  };
}
