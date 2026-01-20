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
export type AiProvider = "cursor" | "claude_code";

/**
 * Attribution category - we only track AI-generated code
 * Human is the default for unattributed code
 */
export type AttributionCategory = "ai_generated";

/**
 * How the match was determined
 */
export type MatchType =
  | "exact_hash" // Line hash matches exactly (confidence: 1.0)
  | "normalized_hash" // Normalized hash matches (confidence: 0.95)
  | "line_in_ai_content" // Line found within AI edit (confidence: 0.9)
  | "ai_content_in_line" // AI content found in line (confidence: 0.85)
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
  hash_normalized: string;
}

// =============================================================================
// Git Diff Types
// =============================================================================

/**
 * A hunk of code from a git diff
 */
export interface DiffHunk {
  path: string;
  start_line: number;
  end_line: number;
  content: string;
  content_hash: string;
  content_hash_normalized: string;
  lines: Array<{
    line_number: number;
    content: string;
    hash: string;
    hash_normalized: string;
  }>;
}

/**
 * Deleted lines from a commit (for move detection)
 */
export interface DeletedBlock {
  path: string;
  start_line: number;
  lines: string[];
  normalized_content: string;
}

/**
 * A detected move operation
 */
export interface MoveMapping {
  from_path: string;
  from_start_line: number;
  to_path: string;
  to_start_line: number;
  line_count: number;
  normalized_content: string;
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
  match_type: MatchType;
  content_hash: string;
}

/**
 * Attribution for a range of lines (merged consecutive lines)
 */
export interface RangeAttribution {
  path: string;
  start_line: number;
  end_line: number;
  provider: AiProvider;
  model: string | null;
  confidence: number;
  match_type: MatchType;
  content_hash: string;
}

/**
 * Result of matching a commit
 */
export interface MatchResult {
  sha: string;
  attributions: RangeAttribution[];
  unmatched_lines: number;
  total_lines: number;
}

// =============================================================================
// Git Notes Types (Stored in git notes)
// =============================================================================

/**
 * Git notes format for storing attribution
 */
export interface GitNotesAttribution {
  version: 1;
  timestamp: string;
  attributions: Array<{
    path: string;
    start_line: number;
    end_line: number;
    category: AttributionCategory;
    provider: AiProvider;
    model: string | null;
    confidence: number;
    match_type: MatchType;
    content_hash: string;
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
  claude_code?: number;
}

/**
 * Model breakdown for analytics (model name -> line count)
 */
export type ModelBreakdown = Record<string, number>;

/**
 * Per-contributor analytics
 */
export interface ContributorStats {
  total_lines: number;
  ai_lines: number;
  by_provider: ProviderBreakdown;
  by_model: ModelBreakdown;
  pr_count: number;
}

/**
 * PR history entry (compact format for storage efficiency)
 * d=date, pr=PR number, t=title, author=author
 * a=additions, r=removals, ai=AI lines
 * p=by_provider, m=by_model
 */
export interface PRHistoryEntry {
  d: string; // ISO date (YYYY-MM-DD)
  pr: number;
  t?: string; // title (optional to save space)
  author: string;
  a: number; // additions
  r: number; // removals
  ai: number; // AI-attributed lines
  p?: ProviderBreakdown; // by_provider
  m?: ModelBreakdown; // by_model
}

/**
 * Repository-wide analytics summary
 */
export interface AnalyticsSummary {
  total_lines: number;
  ai_lines: number;
  human_lines: number;
  by_provider: ProviderBreakdown;
  by_model: ModelBreakdown;
  last_updated: string;
}

/**
 * Analytics note format (stored as git note on analytics tag)
 * Version 2 to distinguish from attribution notes (version 1)
 */
export interface AnalyticsNote {
  version: 2;
  summary: AnalyticsSummary;
  contributors: Record<string, ContributorStats>;
  history: PRHistoryEntry[];
}
