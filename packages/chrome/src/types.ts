/**
 * Agent Blame Chrome Extension Types
 */

// Storage types
export interface AgentBlameStorage {
  githubToken?: string;
  enabled?: boolean;
}

// Git notes attribution (matches main types.ts)
export interface GitNotesAttribution {
  version: number;
  timestamp: string;
  attributions: AttributionEntry[];
}

export interface AttributionEntry {
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
