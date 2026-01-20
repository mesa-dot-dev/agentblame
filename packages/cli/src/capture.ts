#!/usr/bin/env bun
/**
 * Agent Blame Hook Capture
 *
 * Captures AI-generated code from Cursor and Claude Code hooks.
 * Performs line-level hashing for precise attribution matching.
 *
 * Usage:
 *   echo '{"payload": ...}' | bun run capture.ts --provider cursor --event afterFileEdit
 *   echo '{"payload": ...}' | bun run capture.ts --provider claude
 *
 * Note: We only track afterFileEdit (Composer/Agent mode).
 * Tab completions (afterTabFileEdit) are NOT tracked because they fire
 * as fragments that cannot be reliably matched to commits.
 */

import * as crypto from "node:crypto";
import { diffLines } from "diff";
import { insertEdit, setAgentBlameDir } from "./lib/database";
import { findAgentBlameDir } from "./lib/util";

// =============================================================================
// Types
// =============================================================================

interface CapturedLine {
  content: string;
  hash: string;
  hashNormalized: string;
}

interface CapturedEdit {
  timestamp: string;
  provider: "cursor" | "claudeCode";
  filePath: string;
  model: string | null;
  lines: CapturedLine[];
  content: string;
  contentHash: string;
  contentHashNormalized: string;
  editType: "addition" | "modification" | "replacement";
  oldContent?: string;
}

interface CursorPayload {
  file_path: string;
  edits?: Array<{ old_string: string; new_string: string }>;
  model?: string;
}

interface ClaudePayload {
  tool_name?: string;
  tool_input?: {
    file_path?: string;
    old_string?: string;
    new_string?: string;
    content?: string;
  };
  file_path?: string;
  old_string?: string;
  new_string?: string;
  content?: string;
}

// =============================================================================
// Utilities
// =============================================================================

function computeHash(content: string): string {
  return `sha256:${crypto.createHash("sha256").update(content).digest("hex")}`;
}

function computeNormalizedHash(content: string): string {
  const normalized = content.replace(/\s+/g, "");
  return `sha256:${crypto.createHash("sha256").update(normalized).digest("hex")}`;
}

/**
 * Extract only the added lines from a diff between old and new text.
 */
function extractAddedContent(oldText: string, newText: string): string {
  // Normalize trailing newlines to avoid false positives.
  // diffLines treats "line" and "line\n" as different, so when a line
  // goes from being last (no \n) to having content after it (has \n),
  // it gets marked as "added" even though the content is identical.
  const normalize = (text: string): string => {
    if (!text) return "";
    return text.endsWith("\n") ? text : text + "\n";
  };

  const parts = diffLines(normalize(oldText), normalize(newText));
  const addedParts: string[] = [];

  for (const part of parts) {
    if (part.added) {
      addedParts.push(part.value ?? "");
    }
  }

  return addedParts.join("");
}

/**
 * Determine the edit type based on old and new content
 */
function determineEditType(
  oldContent: string | undefined,
  newContent: string
): "addition" | "modification" | "replacement" {
  if (!oldContent || oldContent.trim() === "") {
    return "addition";
  }
  if (newContent.includes(oldContent)) {
    return "modification"; // New content contains old content (added to it)
  }
  return "replacement"; // Old content was replaced
}

/**
 * Hash each line individually for precise matching
 */
function hashLines(content: string): CapturedLine[] {
  const lines = content.split("\n");
  const result: CapturedLine[] = [];

  for (const line of lines) {
    // Skip empty lines for hashing purposes but keep them for content
    if (!line.trim()) continue;

    result.push({
      content: line,
      hash: computeHash(line),
      hashNormalized: computeNormalizedHash(line),
    });
  }

  return result;
}

// =============================================================================
// Payload Processing
// =============================================================================

function parseArgs(): { provider: "cursor" | "claude"; event?: string } {
  const args = process.argv.slice(2);
  let provider: "cursor" | "claude" = "cursor";
  let event: string | undefined;

  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--provider" && args[i + 1]) {
      provider = args[i + 1] as "cursor" | "claude";
      i++;
    } else if (args[i] === "--event" && args[i + 1]) {
      event = args[i + 1];
      i++;
    }
  }

  return { provider, event };
}

/**
 * Save an edit to the SQLite database
 */
function saveEdit(edit: CapturedEdit): void {
  insertEdit({
    timestamp: edit.timestamp,
    provider: edit.provider,
    filePath: edit.filePath,
    model: edit.model,
    content: edit.content,
    contentHash: edit.contentHash,
    contentHashNormalized: edit.contentHashNormalized,
    editType: edit.editType,
    oldContent: edit.oldContent,
    lines: edit.lines,
  });
}

function processCursorPayload(
  payload: CursorPayload,
  event: string
): CapturedEdit[] {
  const edits: CapturedEdit[] = [];
  const timestamp = new Date().toISOString();

  // Only process afterFileEdit (Composer/Agent mode)
  // Skip afterTabFileEdit - tab completions fire as fragments that can't be matched
  if (event === "afterTabFileEdit") {
    return edits;
  }

  if (!payload.edits || payload.edits.length === 0) {
    return edits;
  }

  for (const edit of payload.edits) {
    const oldString = edit.old_string || "";
    const newString = edit.new_string || "";

    if (!newString) continue;

    // Extract only the added content
    const addedContent = extractAddedContent(oldString, newString);
    if (!addedContent.trim()) continue;

    // Hash each line individually
    const lines = hashLines(addedContent);
    if (lines.length === 0) continue;

    edits.push({
      timestamp,
      provider: "cursor",
      filePath: payload.file_path,
      model: payload.model || null,

      // Line-level data
      lines,

      // Aggregate data
      content: addedContent,
      contentHash: computeHash(addedContent),
      contentHashNormalized: computeNormalizedHash(addedContent),

      // Edit context
      editType: determineEditType(oldString, newString),
      oldContent: oldString || undefined,
    });
  }

  return edits;
}

function processClaudePayload(payload: ClaudePayload): CapturedEdit[] {
  const edits: CapturedEdit[] = [];
  const timestamp = new Date().toISOString();

  // Claude Code has tool_input with the actual content, or it may be at top level
  const toolInput = payload.tool_input;
  const filePath = toolInput?.file_path || payload.file_path;

  if (!filePath) return edits;

  // Get content from tool_input or top-level payload
  const content = toolInput?.content || payload.content;
  const oldString = toolInput?.old_string || payload.old_string || "";
  const newString = toolInput?.new_string || payload.new_string || "";

  // Handle Write tool (new file, content only)
  if (content && !oldString && !newString) {
    if (!content.trim()) return edits;

    const lines = hashLines(content);
    if (lines.length === 0) return edits;

    edits.push({
      timestamp,
      provider: "claudeCode",
      filePath: filePath,
      model: "claude",

      // Line-level data
      lines,

      // Aggregate data
      content: content,
      contentHash: computeHash(content),
      contentHashNormalized: computeNormalizedHash(content),

      // Edit context
      editType: "addition",
    });
    return edits;
  }

  // Handle Edit tool (old_string -> new_string)
  if (!newString) return edits;

  const addedContent = extractAddedContent(oldString, newString);
  if (!addedContent.trim()) return edits;

  const lines = hashLines(addedContent);
  if (lines.length === 0) return edits;

  edits.push({
    timestamp,
    provider: "claudeCode",
    filePath: filePath,
    model: "claude",

    // Line-level data
    lines,

    // Aggregate data
    content: addedContent,
    contentHash: computeHash(addedContent),
    contentHashNormalized: computeNormalizedHash(addedContent),

    // Edit context
    editType: determineEditType(oldString, newString),
    oldContent: oldString || undefined,
  });

  return edits;
}

// =============================================================================
// Main
// =============================================================================

async function readStdin(): Promise<string> {
  const chunks: Buffer[] = [];

  for await (const chunk of process.stdin) {
    chunks.push(chunk);
  }

  return Buffer.concat(chunks).toString("utf8");
}

export async function runCapture(): Promise<void> {
  try {
    const { provider, event } = parseArgs();
    const input = await readStdin();

    if (!input.trim()) {
      process.exit(0);
    }

    const data = JSON.parse(input);

    // The hook receives the payload directly or wrapped
    const payload = data.payload || data;

    let edits: CapturedEdit[] = [];

    if (provider === "cursor") {
      const eventName = event || data.hook_event_name || "afterFileEdit";
      edits = processCursorPayload(payload as CursorPayload, eventName);
    } else if (provider === "claude") {
      edits = processClaudePayload(payload as ClaudePayload);
    }

    // Save all edits to SQLite database
    for (const edit of edits) {
      // Find the agentblame directory for this file
      const agentblameDir = findAgentBlameDir(edit.filePath);
      if (!agentblameDir) {
        // File is not in an initialized repo, skip silently
        continue;
      }

      // Set the database directory and save
      setAgentBlameDir(agentblameDir);
      saveEdit(edit);
    }

    process.exit(0);
  } catch (err) {
    // Silent failure - don't interrupt the editor
    console.error("Agent Blame capture error:", err);
    process.exit(0);
  }
}

