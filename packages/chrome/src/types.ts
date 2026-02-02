/**
 * Agent Blame Chrome Extension Types
 */

// Minimum supported version
export const MIN_SUPPORTED_VERSION = 3;

// Storage types
export interface AgentBlameStorage {
  githubToken?: string;
  enabled?: boolean;
}

// Git notes attribution v3 format (matches CLI types.ts)
export interface GitNotesAttribution {
  version: number;
  timestamp: string;
  sessions: Record<string, SessionMetadata>;
  files: Record<string, FileAttribution>;
}

/**
 * A single prompt with its associated tool calls
 */
export interface PromptEntry {
  id?: number; // Database ID - used to link lines to specific prompts
  timestamp: string;
  content: string;
  tools?: Record<string, number>; // tool counts triggered by this prompt
  duration?: number; // seconds until next prompt
}

export interface SessionMetadata {
  agent: string; // 'claude' | 'cursor' | 'opencode'
  model: string | null;
  prompts: PromptEntry[] | string | null; // prompts with tool counts (array, or string for backwards compat)
  startedAt: string; // session start timestamp
}

export interface FileAttribution {
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

// Legacy v2 format (for backwards compatibility)
export interface GitNotesAttributionV2 {
  version: number;
  timestamp: string;
  attributions: AttributionEntryV2[];
}

export interface AttributionEntryV2 {
  path: string;
  startLine: number;
  endLine: number;
  contentHash: string;
  matchType: string;
  category: "ai_generated";
  provider: string;
  model: string | null;
  confidence: number;
}

// PR context extracted from GitHub page
export interface PRContext {
  owner: string;
  repo: string;
  prNumber: number;
  commits: string[];
}

// Parsed diff line info
export interface DiffLine {
  filePath: string;
  lineNumber: number;
  element: HTMLElement;
  type: "added" | "deleted" | "context";
}

// Attribution lookup result
export interface LineAttribution {
  category: "ai_generated"; // Only ai_generated
  provider: string;
  model: string | null;
  sessionId?: string; // Session ID for lookup
  promptContent?: string; // Prompt text for tooltip display
}

// Prompt info for PR summary display
export interface PromptInfo {
  index: string; // P1, P2, etc.
  agent: string;
  model: string | null;
  content: string;
  tools?: Record<string, number>;
}

// Message types for communication between content script and background
export type MessageType =
  | { type: "GET_TOKEN" }
  | { type: "FETCH_NOTES"; owner: string; repo: string; commits: string[] }
  | { type: "GET_STATUS" };

export type MessageResponse =
  | { type: "TOKEN"; token: string | null }
  | { type: "NOTES"; notes: Map<string, GitNotesAttribution> }
  | { type: "STATUS"; enabled: boolean; hasToken: boolean }
  | { type: "ERROR"; error: string };
