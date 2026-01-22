/**
 * Core Types for Agent Blame
 *
 * Line-level attribution tracking for AI-generated code.
 */

// =============================================================================
// Provider & Category Types
// =============================================================================

/**
 * AI provider that generated the code
 */
export type AiProvider = "cursor" | "claudeCode" | "opencode";

/**
 * Attribution category - we only track AI-generated code
 * Human is the default for unattributed code
 */
export type AttributionCategory = "ai_generated";

/**
 * How the match was determined
 * Only exact matching - no fuzzy/substring matching
 */
export type MatchType =
  | "exact_hash" // Line hash matches exactly (confidence: 1.0)
  | "normalized_hash" // Normalized hash matches, handles formatter whitespace (confidence: 0.95)
  | "move_detected"; // Line was moved from AI-attributed location (confidence: 0.85)

// =============================================================================
// Captured Line Type (used by capture.ts and database.ts)
// =============================================================================

/**
 * A single line captured from an AI edit
 */
export interface CapturedLine {
  content: string;
  hash: string;
  hashNormalized: string;
  lineNumber?: number; // Line number in the file (1-indexed)
  contextBefore?: string; // 3 lines before for disambiguation
  contextAfter?: string; // 3 lines after for disambiguation
}

// =============================================================================
// Git Diff Types
// =============================================================================

/**
 * A hunk of code from a git diff
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
// Attribution Types (Matching Results)
// =============================================================================

/**
 * Attribution for a single line
 */
export interface LineAttribution {
  path: string;
  line: number;
  provider: AiProvider;
  model: string | null;
  confidence: number;
  matchType: MatchType;
  contentHash: string;
}

/**
 * Attribution for a range of lines (merged consecutive lines)
 */
export interface RangeAttribution {
  path: string;
  startLine: number;
  endLine: number;
  provider: AiProvider;
  model: string | null;
  confidence: number;
  matchType: MatchType;
  contentHash: string;
}

/**
 * Result of matching a commit
 */
export interface MatchResult {
  sha: string;
  attributions: RangeAttribution[];
  unmatchedLines: number;
  totalLines: number;
}

// =============================================================================
// Git Notes Types (Stored in git notes)
// =============================================================================

/**
 * Git notes format for storing attribution (version 2 with camelCase)
 */
export interface GitNotesAttribution {
  version: 2;
  timestamp: string;
  attributions: Array<{
    path: string;
    startLine: number;
    endLine: number;
    category: AttributionCategory;
    provider: AiProvider;
    model: string | null;
    confidence: number;
    matchType: MatchType;
    contentHash: string;
  }>;
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
// Analytics Types (Repository-wide aggregates)
// =============================================================================

/**
 * Provider breakdown for analytics
 */
export interface ProviderBreakdown {
  cursor?: number;
  claudeCode?: number;
  opencode?: number;
}

/**
 * Model breakdown for analytics (model name -> line count)
 */
export type ModelBreakdown = Record<string, number>;

/**
 * Per-contributor analytics
 */
export interface ContributorStats {
  totalLines: number;
  aiLines: number;
  providers: ProviderBreakdown;
  models: ModelBreakdown;
  prCount: number;
}

/**
 * PR history entry
 */
export interface PRHistoryEntry {
  date: string; // ISO date (YYYY-MM-DD)
  pr: number;
  title?: string;
  author: string;
  added: number;
  removed: number;
  aiLines: number;
  providers?: ProviderBreakdown;
  models?: ModelBreakdown;
}

/**
 * Repository-wide analytics summary
 */
export interface AnalyticsSummary {
  totalLines: number;
  aiLines: number;
  humanLines: number;
  providers: ProviderBreakdown;
  models: ModelBreakdown;
  updated: string;
}

/**
 * Analytics note format (stored as git note on analytics tag)
 * Version 2: Analytics with camelCase field names
 * Version 1: Attribution notes (per-commit, different format)
 */
export interface AnalyticsNote {
  version: 2;
  summary: AnalyticsSummary;
  contributors: Record<string, ContributorStats>;
  history: PRHistoryEntry[];
}
