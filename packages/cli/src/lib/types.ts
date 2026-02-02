/**
 * Core Types for Agent Blame v3
 *
 * Line-level attribution tracking for AI-generated code.
 * Uses git blobs for snapshots, SQLite for sessions/prompts/tool_calls.
 */

// =============================================================================
// Agent Types
// =============================================================================

/**
 * AI agent that generated the code
 */
export type AiAgent = "cursor" | "claude" | "opencode";

// =============================================================================
// Session Types (SQLite)
// =============================================================================

/**
 * A session represents one AI conversation
 * ID is SHA256(agent:conversation_id)[0:16]
 */
export interface Session {
  id: string; // 16-char hex
  agent: AiAgent;
  model: string | null;
  conversationId: string | null;
  createdAt: string; // ISO timestamp
  firstCommitSha: string | null;
  firstCommitAt: string | null;
}

/**
 * A user prompt that triggered AI actions
 */
export interface Prompt {
  id: number;
  sessionId: string;
  content: string;
  timestamp: string;
}

/**
 * A tool call made by the AI
 */
export interface ToolCall {
  id: number;
  sessionId: string;
  toolName: string; // 'Edit', 'Write', 'MultiEdit', etc.
  toolInput: string | null; // JSON of tool arguments
  filePath: string | null;
  timestamp: string;
  beforeBlob: string | null; // Git blob SHA of file before
  afterBlob: string | null; // Git blob SHA of file after
}

// =============================================================================
// Snapshot & Working Log Types
// =============================================================================

/**
 * Entry in the working log (snapshots.jsonl)
 */
export interface SnapshotEntry {
  ts: string;
  file: string;
  blob: string;
  session: string | null;
  type: "ai_edit" | "human_edit";
}

/**
 * A snapshot in the chain for line tracing
 */
export interface Snapshot {
  timestamp: string;
  filePath: string;
  blobSha: string;
  sessionId: string | null;
  type: "ai_edit" | "human_edit";
}

/**
 * File attribution in INITIAL file
 */
export interface FileAttribution {
  blobSha: string;
  attributions: Array<{
    lines: [number, number];
    sessionId: string;
  }>;
}

/**
 * INITIAL file format - tracks uncommitted attributions
 */
export interface InitialFile {
  baseSha: string;
  files: Record<string, FileAttribution>;
}

// =============================================================================
// Line Tracing Types
// =============================================================================

/**
 * Result of tracing a line's origin
 */
export interface LineOrigin {
  sessionId: string | null;
  confidence: number;
}

/**
 * Context for line matching (prev/next lines)
 */
export interface LineContext {
  prev?: string;
  next?: string;
}

// =============================================================================
// Git Notes v3 Format
// =============================================================================

/**
 * A single prompt with its associated tool calls
 * Tool calls that happen after this prompt (until next prompt) belong to this prompt
 */
export interface PromptEntry {
  id?: number; // Database ID - used to link lines to specific prompts
  timestamp: string; // ISO format
  content: string | null; // null when storePromptContent config is false
  tools?: Record<string, number>; // tool counts triggered by this prompt (e.g., {"edit": 2, "read": 3})
  duration?: number; // seconds until next prompt (or end of session)
}

/**
 * Session metadata in git notes
 */
export interface SessionMetadata {
  agent: AiAgent;
  model: string | null;
  prompts: PromptEntry[] | null;
  startedAt: string; // session start timestamp
}

/**
 * Git notes v3 JSON metadata section
 */
export interface GitNotesMetadata {
  version: 3;
  timestamp: string;
  sessions: Record<string, SessionMetadata>;
}

/**
 * Full parsed v3 attribution
 */
export interface Attribution {
  version: 3;
  timestamp: string;
  sessions: Record<string, SessionMetadata>;
  files: Record<
    string,
    {
      aiRanges: Array<{
        sessionId: string;
        promptId?: number | null; // Links to specific prompt that generated these lines
        startLine: number;
        endLine: number;
      }>;
      humanRanges: Array<{
        startLine: number;
        endLine: number;
      }>;
    }
  >;
}

// =============================================================================
// Commit Attribution Types
// =============================================================================

/**
 * Attribution for a commit (used during processing)
 */
export interface CommitAttribution {
  sessions: Map<string, Map<string, number[]>>; // sessionId -> filePath -> lines
  humanRanges: Map<string, number[]>; // filePath -> lines
}

/**
 * Result of processing a commit
 */
export interface ProcessResult {
  sha: string;
  filesProcessed: number;
  aiLines: number;
  humanLines: number;
  sessions: string[];
}

// =============================================================================
// Analytics Types
// =============================================================================

/**
 * Agent breakdown for analytics
 */
export interface AgentBreakdown {
  cursor?: number;
  claude?: number;
  opencode?: number;
  [key: string]: number | undefined;
}

/**
 * Model breakdown for analytics (model name -> line count)
 */
export type ModelBreakdown = Record<string, number>;

/**
 * Per-contributor analytics
 */
export interface ContributorStats {
  commits: number;
  prs: number;
  prompts: number;
  aiLines: number;
  humanLines: number;
  unknownLines: number;
  topModels: string[];
}

/**
 * PR entry in analytics
 */
export interface PREntry {
  number: number;
  title: string;
  author: string;
  aiLines: number;
  humanLines: number;
  unknownLines: number;
  prompts: number;
  mergedAt: string;
}

/**
 * Analytics summary
 */
export interface AnalyticsSummary {
  totalLines: number;
  aiLines: number;
  humanLines: number;
  unknownLines: number;
  prompts: number;
  byAgent: AgentBreakdown;
  byModel: ModelBreakdown;
}

/**
 * Hourly data point for time-series analytics
 * Used for "Past 24 hours" and "3 days" views
 */
export interface HourlyDataPoint {
  hour: string; // YYYY-MM-DDTHH format (e.g., "2026-01-29T14")
  aiLines: number;
  humanLines: number;
  unknownLines: number;
  prompts: number;
  byAgent: AgentBreakdown;
  byModel: ModelBreakdown;
  commits: number;
}

/**
 * Daily data point for time-series analytics
 * Used for "1 week" and "1 month" views
 */
export interface DailyDataPoint {
  date: string; // YYYY-MM-DD format
  aiLines: number;
  humanLines: number;
  unknownLines: number;
  prompts: number;
  byAgent: AgentBreakdown;
  byModel: ModelBreakdown;
  commits: number;
}

/**
 * Time-series data for trending
 * Supports: Past 24 hours, 3 days, 1 week, 1 month, All time
 */
export interface TimeSeries {
  hourly: HourlyDataPoint[]; // Last 72 hours (for 24h and 3d views)
  daily: DailyDataPoint[]; // Last 30 days (for 1w and 1m views)
}

/**
 * Analytics note format (stored on root commit)
 */
export interface AnalyticsNote {
  v: 3;
  updated: string;
  summary: AnalyticsSummary;
  contributors: Record<string, ContributorStats>;
  recentPRs: PREntry[];
  timeSeries?: TimeSeries; // Time-series data for trending
}

// =============================================================================
// Git Types
// =============================================================================

/**
 * Git repository state
 */
export interface GitState {
  branch: string | null;
  head: string | null;
  mergeHead: string | null;
  rebaseHead: string | null;
  cherryPickHead: string | null;
  bisectLog: boolean;
}

// =============================================================================
// Delta-Based Attribution Types (v3)
// =============================================================================

/**
 * A hunk from a unified diff
 * Represents a contiguous block of changes
 */
export interface DeltaHunk {
  oldStart: number;   // Line number in old file (1-indexed)
  oldCount: number;   // Number of lines removed
  newStart: number;   // Line number in new file (1-indexed)
  newCount: number;   // Number of lines added
}

/**
 * An edit delta - represents what changed in one edit operation
 * Stored in deltas.jsonl, append-only
 */
export interface EditDelta {
  ts: string;                    // ISO timestamp
  file: string;                  // Relative file path
  sessionId: string | null;      // null = human edit
  promptId: number | null;       // Links to prompts table (null for human)
  hunks: DeltaHunk[];            // What changed
  afterBlob?: string;            // Git blob SHA of file after edit (for cross-session detection)
}

/**
 * Line attribution computed from replaying deltas
 * Used at commit time to build git notes
 */
export interface LineAttribution {
  startLine: number;             // 1-indexed, inclusive
  endLine: number;               // 1-indexed, inclusive
  sessionId: string;             // Session that wrote these lines
  promptId: number | null;       // Prompt that triggered this edit
  overrode?: string;             // Previous author if overwritten
}

/**
 * Computed attribution for a file
 * Result of replaying all deltas
 */
export interface ComputedFileAttribution {
  aiRanges: LineAttribution[];
  humanRanges: Array<{ startLine: number; endLine: number }>;
}

// =============================================================================
// Diff Types
// =============================================================================

/**
 * Git diff hunk
 */
export interface DiffHunk {
  path: string;
  startLine: number;
  endLine: number;
  content: string;
  contentHash: string;
  contentHashNormalized: string;
  lines: Array<{
    lineNumber: number;
    content: string;
    hash: string;
    hashNormalized: string;
  }>;
}

/**
 * Deleted lines from a commit (for move detection)
 */
export interface DeletedBlock {
  path: string;
  startLine: number;
  lines: string[];
  normalizedContent: string;
}

/**
 * A detected move operation
 */
export interface MoveMapping {
  fromPath: string;
  fromStartLine: number;
  toPath: string;
  toStartLine: number;
  lineCount: number;
  normalizedContent: string;
}

// =============================================================================
// Hook Payload Types
// =============================================================================

/**
 * Claude hook payload
 */
export interface ClaudeHookPayload {
  tool_name: string;
  tool_input: {
    file_path?: string;
    command?: string;
    old_string?: string;
    new_string?: string;
    content?: string;
    edits?: Array<{
      old_string: string;
      new_string: string;
    }>;
  };
  tool_response?: string;
  session_id?: string;
  transcript_path?: string;
}

/**
 * Cursor hook payload
 */
export interface CursorHookPayload {
  event: string;
  model?: string;
  session_id?: string;
  edits?: Array<{
    file_path: string;
    old_content?: string;
    new_content: string;
  }>;
}

/**
 * OpenCode hook payload
 */
export interface OpenCodeHookPayload {
  tool_name: string;
  tool_input: Record<string, unknown>;
  file_path?: string;
  before_content?: string;
  after_content?: string;
  model?: string;
  session_id?: string;
  prompt?: string;
}

