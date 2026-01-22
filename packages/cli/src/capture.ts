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
  lineNumber?: number;
  contextBefore?: string;
  contextAfter?: string;
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
  sessionId?: string;
  toolUseId?: string;
}

interface CursorPayload {
  file_path: string;
  edits?: Array<{ old_string: string; new_string: string }>;
  model?: string;
  conversation_id?: string;
  generation_id?: string;
}

interface StructuredPatchHunk {
  oldStart: number;
  oldLines: number;
  newStart: number;
  newLines: number;
  lines: string[];
}

interface ClaudePayload {
  tool_name?: string;
  tool_input?: {
    file_path?: string;
    old_string?: string;
    new_string?: string;
    content?: string;
  };
  tool_response?: {
    filePath?: string;
    originalFile?: string;
    structuredPatch?: StructuredPatchHunk[];
    userModified?: boolean;
  };
  session_id?: string;
  tool_use_id?: string;
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

/**
 * Hash lines with line numbers and context (for Claude structuredPatch)
 */
function hashLinesWithNumbers(
  lines: Array<{ content: string; lineNumber: number }>,
  allFileLines: string[]
): CapturedLine[] {
  const result: CapturedLine[] = [];

  for (const { content, lineNumber } of lines) {
    // Skip empty lines
    if (!content.trim()) continue;

    // Get context (3 lines before and after)
    const contextBefore = allFileLines
      .slice(Math.max(0, lineNumber - 4), lineNumber - 1)
      .join("\n");
    const contextAfter = allFileLines
      .slice(lineNumber, Math.min(allFileLines.length, lineNumber + 3))
      .join("\n");

    result.push({
      content,
      hash: computeHash(content),
      hashNormalized: computeNormalizedHash(content),
      lineNumber,
      contextBefore: contextBefore || undefined,
      contextAfter: contextAfter || undefined,
    });
  }

  return result;
}

/**
 * Parse Claude Code's structuredPatch to extract added lines with line numbers
 */
function parseStructuredPatch(
  hunks: StructuredPatchHunk[],
  originalFileLines: string[]
): Array<{ content: string; lineNumber: number }> {
  const addedLines: Array<{ content: string; lineNumber: number }> = [];

  for (const hunk of hunks) {
    let newLineNumber = hunk.newStart;

    for (const line of hunk.lines) {
      if (line.startsWith("+")) {
        // Added line - strip the + prefix
        addedLines.push({
          content: line.slice(1),
          lineNumber: newLineNumber,
        });
        newLineNumber++;
      } else if (line.startsWith("-")) {
        // Deleted line - don't increment new line number
        continue;
      } else {
        // Context line (starts with space) - increment line number
        newLineNumber++;
      }
    }
  }

  return addedLines;
}

/**
 * Read a file and return its lines (for Cursor line number derivation)
 */
async function readFileLines(filePath: string): Promise<string[] | null> {
  try {
    const fs = await import("node:fs/promises");
    const content = await fs.readFile(filePath, "utf8");
    return content.split("\n");
  } catch {
    return null;
  }
}

/**
 * Find where old_string exists in file and return line numbers for new_string
 * Returns null if old_string not found (new file or complex edit)
 */
function findEditLocation(
  fileLines: string[],
  oldString: string,
  newString: string
): Array<{ content: string; lineNumber: number }> | null {
  if (!oldString) {
    // New content with no old string - can't determine line numbers without more context
    return null;
  }

  const fileContent = fileLines.join("\n");
  const oldIndex = fileContent.indexOf(oldString);

  if (oldIndex === -1) {
    return null;
  }

  // Count lines before the match to get line number
  const linesBefore = fileContent.slice(0, oldIndex).split("\n").length;
  const startLine = linesBefore;

  // Calculate what the new file will look like after the edit
  const newFileContent = fileContent.replace(oldString, newString);
  const newFileLines = newFileContent.split("\n");

  // Find the added lines by comparing old and new
  const addedContent = extractAddedContent(oldString, newString);
  if (!addedContent.trim()) {
    return null;
  }

  const addedLines = addedContent.split("\n").filter(l => l.trim());
  const result: Array<{ content: string; lineNumber: number }> = [];

  // Find each added line in the new content
  let searchStart = startLine - 1;
  for (const addedLine of addedLines) {
    if (!addedLine.trim()) continue;

    for (let i = searchStart; i < newFileLines.length; i++) {
      if (newFileLines[i] === addedLine || newFileLines[i].trim() === addedLine.trim()) {
        result.push({
          content: addedLine,
          lineNumber: i + 1, // 1-indexed
        });
        searchStart = i + 1;
        break;
      }
    }
  }

  return result.length > 0 ? result : null;
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
    sessionId: edit.sessionId,
    toolUseId: edit.toolUseId,
  });
}

async function processCursorPayload(
  payload: CursorPayload,
  event: string
): Promise<CapturedEdit[]> {
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

  // Read the file to derive line numbers (Cursor doesn't provide them)
  const fileLines = await readFileLines(payload.file_path);

  for (const edit of payload.edits) {
    const oldString = edit.old_string || "";
    const newString = edit.new_string || "";

    if (!newString) continue;

    // Extract only the added content
    const addedContent = extractAddedContent(oldString, newString);
    if (!addedContent.trim()) continue;

    let lines: CapturedLine[];

    // Try to derive line numbers if we have the file
    if (fileLines && oldString) {
      const linesWithNumbers = findEditLocation(fileLines, oldString, newString);
      if (linesWithNumbers && linesWithNumbers.length > 0) {
        lines = hashLinesWithNumbers(linesWithNumbers, fileLines);
      } else {
        // Fallback to basic hashing without line numbers
        lines = hashLines(addedContent);
      }
    } else {
      // No file or no old_string - hash without line numbers
      lines = hashLines(addedContent);
    }

    if (lines.length === 0) continue;

    edits.push({
      timestamp,
      provider: "cursor",
      filePath: payload.file_path,
      model: payload.model || null,
      lines,
      content: addedContent,
      contentHash: computeHash(addedContent),
      contentHashNormalized: computeNormalizedHash(addedContent),
      editType: determineEditType(oldString, newString),
      oldContent: oldString || undefined,
      sessionId: payload.conversation_id,
      toolUseId: payload.generation_id,
    });
  }

  return edits;
}

function processClaudePayload(payload: ClaudePayload): CapturedEdit[] {
  const edits: CapturedEdit[] = [];
  const timestamp = new Date().toISOString();

  // Claude Code has tool_input with the actual content
  const toolInput = payload.tool_input;
  const toolResponse = payload.tool_response;
  const filePath = toolResponse?.filePath || toolInput?.file_path || payload.file_path;

  if (!filePath) return edits;

  // Extract session info for correlation
  const sessionId = payload.session_id;
  const toolUseId = payload.tool_use_id;

  // If we have structuredPatch, use it for precise line numbers
  if (toolResponse?.structuredPatch && toolResponse.structuredPatch.length > 0) {
    // Get original file lines for context
    const originalFileLines = (toolResponse.originalFile || "").split("\n");

    // Parse the structured patch to get added lines with line numbers
    const addedLinesWithNumbers = parseStructuredPatch(
      toolResponse.structuredPatch,
      originalFileLines
    );

    if (addedLinesWithNumbers.length === 0) return edits;

    // Hash lines with their line numbers and context
    const lines = hashLinesWithNumbers(addedLinesWithNumbers, originalFileLines);
    if (lines.length === 0) return edits;

    // Aggregate content
    const addedContent = addedLinesWithNumbers.map(l => l.content).join("\n");

    edits.push({
      timestamp,
      provider: "claudeCode",
      filePath,
      model: "claude",
      lines,
      content: addedContent,
      contentHash: computeHash(addedContent),
      contentHashNormalized: computeNormalizedHash(addedContent),
      editType: "modification",
      sessionId,
      toolUseId,
    });

    return edits;
  }

  // Fallback: Get content from tool_input or top-level payload
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
      filePath,
      model: "claude",
      lines,
      content,
      contentHash: computeHash(content),
      contentHashNormalized: computeNormalizedHash(content),
      editType: "addition",
      sessionId,
      toolUseId,
    });
    return edits;
  }

  // Handle Edit tool (old_string -> new_string) without structuredPatch
  if (!newString) return edits;

  const addedContent = extractAddedContent(oldString, newString);
  if (!addedContent.trim()) return edits;

  const lines = hashLines(addedContent);
  if (lines.length === 0) return edits;

  edits.push({
    timestamp,
    provider: "claudeCode",
    filePath,
    model: "claude",
    lines,
    content: addedContent,
    contentHash: computeHash(addedContent),
    contentHashNormalized: computeNormalizedHash(addedContent),
    editType: determineEditType(oldString, newString),
    oldContent: oldString || undefined,
    sessionId,
    toolUseId,
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
      edits = await processCursorPayload(payload as CursorPayload, eventName);
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

