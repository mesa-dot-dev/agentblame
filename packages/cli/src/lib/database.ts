/**
 * SQLite Database Module v3
 *
 * Handles persistent storage of sessions, prompts, and tool calls.
 * Uses Bun's built-in SQLite for high-performance lookups.
 *
 * Database is stored globally at ~/.agentblame/agentblame.db
 * Each session is namespaced by repo identifier.
 */

import { Database } from "bun:sqlite";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { createHash } from "node:crypto";
import type { AiAgent } from "./types";

// =============================================================================
// Types
// =============================================================================

export interface DbSession {
  id: string;
  repo: string;  // Repo identifier for namespacing
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
-- Sessions: One per AI conversation, namespaced by repo
CREATE TABLE IF NOT EXISTS sessions (
    id TEXT PRIMARY KEY,
    repo TEXT NOT NULL,
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

-- Enabled repos: Track which repos have agentblame enabled
CREATE TABLE IF NOT EXISTS enabled_repos (
    repo TEXT PRIMARY KEY,
    enabled_at TEXT NOT NULL
);

-- Deltas: Append-only edit deltas for attribution replay
CREATE TABLE IF NOT EXISTS deltas (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    base_sha TEXT NOT NULL,
    file_path TEXT NOT NULL,
    session_id TEXT,
    prompt_id INTEGER,
    ts TEXT NOT NULL,
    hunks TEXT NOT NULL,
    after_blob TEXT
);

-- Indexes
CREATE INDEX IF NOT EXISTS idx_sessions_repo ON sessions(repo);
CREATE INDEX IF NOT EXISTS idx_sessions_agent ON sessions(agent, conversation_id);
CREATE INDEX IF NOT EXISTS idx_prompts_session ON prompts(session_id);
CREATE INDEX IF NOT EXISTS idx_tool_calls_session ON tool_calls(session_id);
CREATE INDEX IF NOT EXISTS idx_tool_calls_file ON tool_calls(file_path);
CREATE INDEX IF NOT EXISTS idx_tool_calls_timestamp ON tool_calls(timestamp);
CREATE INDEX IF NOT EXISTS idx_deltas_file ON deltas(base_sha, file_path);
CREATE UNIQUE INDEX IF NOT EXISTS idx_deltas_dedup ON deltas(base_sha, file_path, ts, hunks);
`;

// =============================================================================
// Global Paths
// =============================================================================

/**
 * Get the global agentblame directory (~/.agentblame/)
 */
export function getGlobalAgentBlameDir(): string {
  return path.join(os.homedir(), ".agentblame");
}

/**
 * Get the global database path (~/.agentblame/agentblame.db)
 */
export function getGlobalDbPath(): string {
  return path.join(getGlobalAgentBlameDir(), "agentblame.db");
}

/**
 * Get the global logs directory (~/.agentblame/logs/)
 */
export function getGlobalLogsDir(): string {
  return path.join(getGlobalAgentBlameDir(), "logs");
}

/**
 * Ensure the global agentblame directory structure exists
 */
export function ensureGlobalAgentBlameDir(): void {
  const globalDir = getGlobalAgentBlameDir();
  const logsDir = getGlobalLogsDir();

  if (!fs.existsSync(globalDir)) {
    fs.mkdirSync(globalDir, { recursive: true });
  }
  if (!fs.existsSync(logsDir)) {
    fs.mkdirSync(logsDir, { recursive: true });
  }
}

/**
 * Generate a repo identifier from the repo root path
 * Uses the git remote URL if available, otherwise the path
 */
export function getRepoIdentifier(repoRoot: string): string {
  // Try to get remote URL first
  try {
    const { execSync } = require("node:child_process");
    const remoteUrl = execSync("git remote get-url origin", {
      cwd: repoRoot,
      encoding: "utf8",
      stdio: ["pipe", "pipe", "pipe"],
    }).trim();

    if (remoteUrl) {
      // Normalize the URL: remove .git suffix, convert to lowercase
      // Examples: git@github.com:org/repo.git -> github.com/org/repo
      //           https://github.com/org/repo.git -> github.com/org/repo
      let normalized = remoteUrl
        .replace(/\.git$/, "")
        .replace(/^git@/, "")
        .replace(/^https?:\/\//, "")
        .replace(":", "/")
        .toLowerCase();
      return normalized;
    }
  } catch {
    // No remote, fall back to path
  }

  // Fall back to repo path
  return repoRoot;
}

// =============================================================================
// Database Connection
// =============================================================================

let dbInstance: Database | null = null;
let currentDbPath: string | null = null;

/**
 * Set the database path directly.
 * For most cases, use initGlobalDatabase() instead.
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
 * Initialize the global database
 * This is the primary way to initialize the database.
 * Throws if DB doesn't exist - user must run 'setup' first.
 */
export function initGlobalDatabase(): void {
  const dbPath = getGlobalDbPath();
  if (!fs.existsSync(dbPath)) {
    throw new Error("Database not found. Run 'bunx @mesadev/agentblame@latest setup' first.");
  }
  setDatabasePath(dbPath);
  initDatabase();
}

/**
 * Get the database file path
 * Throws if DB not initialized - user must run 'setup' first.
 */
export function getDbPath(): string {
  if (!currentDbPath) {
    throw new Error("Database not initialized. Run 'bunx @mesadev/agentblame@latest setup' first.");
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

  // Run migrations to ensure schema is up to date
  runMigrations(dbInstance);

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
  db.exec("DROP TABLE IF EXISTS enabled_repos");
  db.exec("DROP TABLE IF EXISTS deltas");
  db.exec(SCHEMA);
}

/**
 * Migrate old database schema to new schema (internal use)
 * Adds 'repo' column to sessions if it doesn't exist
 */
function runMigrations(db: Database): void {
  // Check if repo column exists
  const tableInfo = db.prepare("PRAGMA table_info(sessions)").all() as any[];
  const hasRepoColumn = tableInfo.some((col) => col.name === "repo");

  if (!hasRepoColumn) {
    // Add repo column with default value (empty string for legacy data)
    db.exec("ALTER TABLE sessions ADD COLUMN repo TEXT NOT NULL DEFAULT ''");
  }

  // Ensure enabled_repos table exists
  db.exec(`
    CREATE TABLE IF NOT EXISTS enabled_repos (
      repo TEXT PRIMARY KEY,
      enabled_at TEXT NOT NULL
    )
  `);

  // Create new indexes if they don't exist
  db.exec("CREATE INDEX IF NOT EXISTS idx_sessions_repo ON sessions(repo)");

  // Ensure deltas table exists (added in v3.2)
  db.exec(`
    CREATE TABLE IF NOT EXISTS deltas (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      base_sha TEXT NOT NULL,
      file_path TEXT NOT NULL,
      session_id TEXT,
      prompt_id INTEGER,
      ts TEXT NOT NULL,
      hunks TEXT NOT NULL,
      after_blob TEXT
    )
  `);
  db.exec("CREATE INDEX IF NOT EXISTS idx_deltas_file ON deltas(base_sha, file_path)");
  db.exec("CREATE UNIQUE INDEX IF NOT EXISTS idx_deltas_dedup ON deltas(base_sha, file_path, ts, hunks)");
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
  repo: string;  // Repo identifier for namespacing
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
    INSERT INTO sessions (id, repo, agent, model, conversation_id, created_at)
    VALUES (?, ?, ?, ?, ?, ?)
    ON CONFLICT(id) DO UPDATE SET
      model = COALESCE(excluded.model, sessions.model)
  `);
  stmt.run(
    params.id,
    params.repo,
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

/**
 * Get stats for a specific repo
 */
export function getStatsForRepo(repo: string): { sessions: number; prompts: number; toolCalls: number } {
  const db = getDatabase();
  const sessions = (db.prepare("SELECT COUNT(*) as count FROM sessions WHERE repo = ?").get(repo) as any).count;
  const prompts = (db.prepare(`
    SELECT COUNT(*) as count FROM prompts
    WHERE session_id IN (SELECT id FROM sessions WHERE repo = ?)
  `).get(repo) as any).count;
  const toolCalls = (db.prepare(`
    SELECT COUNT(*) as count FROM tool_calls
    WHERE session_id IN (SELECT id FROM sessions WHERE repo = ?)
  `).get(repo) as any).count;
  return { sessions, prompts, toolCalls };
}

// =============================================================================
// Enabled Repos Operations
// =============================================================================

/**
 * Register a repo as enabled
 */
export function enableRepo(repo: string): void {
  const db = getDatabase();
  const stmt = db.prepare(`
    INSERT INTO enabled_repos (repo, enabled_at)
    VALUES (?, ?)
    ON CONFLICT(repo) DO UPDATE SET enabled_at = excluded.enabled_at
  `);
  stmt.run(repo, new Date().toISOString());
}

/**
 * Unregister a repo
 */
export function disableRepo(repo: string): void {
  const db = getDatabase();
  db.prepare("DELETE FROM enabled_repos WHERE repo = ?").run(repo);
}

/**
 * Check if a repo is enabled
 */
export function isRepoEnabled(repo: string): boolean {
  const db = getDatabase();
  const result = db.prepare("SELECT 1 FROM enabled_repos WHERE repo = ? LIMIT 1").get(repo);
  return result !== undefined && result !== null;
}

/**
 * Get all enabled repos
 */
export function getEnabledRepos(): Array<{ repo: string; enabledAt: string }> {
  const db = getDatabase();
  const rows = db.prepare("SELECT repo, enabled_at FROM enabled_repos ORDER BY enabled_at DESC").all() as any[];
  return rows.map(row => ({ repo: row.repo, enabledAt: row.enabled_at }));
}

/**
 * Wipe all data and recreate fresh database
 * Used by 'agentblame clean'
 */
export function wipeAndRecreateDatabase(): void {
  closeDatabase();

  const globalDir = getGlobalAgentBlameDir();

  // Remove entire directory
  if (fs.existsSync(globalDir)) {
    fs.rmSync(globalDir, { recursive: true });
  }

  // Recreate fresh (directly create DB, bypassing existence check)
  ensureGlobalAgentBlameDir();
  setDatabasePath(getGlobalDbPath());
  initDatabase();
}

// =============================================================================
// Helpers
// =============================================================================

function rowToSession(row: any): DbSession {
  return {
    id: row.id,
    repo: row.repo,
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
