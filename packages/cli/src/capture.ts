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
  provider: "cursor" | "claudeCode" | "opencode";
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
  transcript_path?: string;
  file_path?: string;
  old_string?: string;
  new_string?: string;
  content?: string;
}

interface OpenCodePayload {
  tool: "edit" | "write";
  sessionID?: string;
  callID?: string;
  filePath?: string;
  // Edit tool fields
  oldString?: string;
  newString?: string;
  before?: string;  // Full file content before edit
  after?: string;   // Full file content after edit
  diff?: string;    // Unified diff
  // Write tool fields
  content?: string;
  // Model info (extracted by plugin from config)
  model?: string;
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
 * Extract model name from Claude Code transcript file.
 * The transcript is a JSONL file where assistant messages contain the model field.
 * We read from the end to find the most recent model used.
 */
async function extractModelFromTranscript(transcriptPath: string): Promise<string | null> {
  try {
    const fs = await import("node:fs/promises");
    const content = await fs.readFile(transcriptPath, "utf8");
    const lines = content.split("\n");

    // Read from the end to find the most recent assistant message with model info
    for (let i = lines.length - 1; i >= 0; i--) {
      const line = lines[i].trim();
      if (!line) continue;

      try {
        const entry = JSON.parse(line);
        // Assistant messages have message.model field
        if (entry.message?.model) {
          return entry.message.model;
        }
      } catch {
        // Skip malformed lines
        continue;
      }
    }

    return null;
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

function parseArgs(): { provider: "cursor" | "claude" | "opencode"; event?: string } {
  const args = process.argv.slice(2);
  let provider: "cursor" | "claude" | "opencode" = "cursor";
  let event: string | undefined;

  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--provider" && args[i + 1]) {
      provider = args[i + 1] as "cursor" | "claude" | "opencode";
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

async function processClaudePayload(payload: ClaudePayload): Promise<CapturedEdit[]> {
  const edits: CapturedEdit[] = [];

  // CRITICAL: Skip payloads that are actually from Cursor.
  // Both Cursor and Claude Code can trigger hooks from .claude/settings.json,
  // so we need to detect Cursor payloads and skip them here.
  // Cursor payloads have cursor_version field, Claude payloads don't.
  if ((payload as any).cursor_version) {
    return edits;
  }

  // CRITICAL: Only process if this is an actual Edit or Write tool usage from Claude.
  // Claude Code's hooks fire for various reasons, but we only want to capture
  // when Claude actually performed an edit/write operation.
  // Without a valid tool_name, this is likely a spurious trigger (e.g., from file
  // watcher detecting external changes).
  const toolName = payload.tool_name?.toLowerCase() || "";
  if (toolName !== "edit" && toolName !== "write" && toolName !== "multiedit") {
    return edits;
  }

  const timestamp = new Date().toISOString();

  // Claude Code has tool_input with the actual content
  const toolInput = payload.tool_input;
  const toolResponse = payload.tool_response;
  const filePath = toolResponse?.filePath || toolInput?.file_path || payload.file_path;

  if (!filePath) return edits;

  // Extract session info for correlation
  const sessionId = payload.session_id;
  const toolUseId = payload.tool_use_id;

  // Extract model from transcript file (Claude Code provides transcript_path in hook payload)
  let model: string | null = null;
  if (payload.transcript_path) {
    model = await extractModelFromTranscript(payload.transcript_path);
  }
  // Fallback to generic "claude" if transcript parsing fails
  if (!model) {
    model = "claude";
  }

  // For Edit/MultiEdit tools, REQUIRE structuredPatch.
  // Without structuredPatch, we cannot accurately determine what Claude added.
  // Spurious triggers (e.g., file watcher detecting external changes) won't have
  // structuredPatch and would incorrectly capture the entire file.
  if (toolName === "edit" || toolName === "multiedit") {
    if (!toolResponse?.structuredPatch || toolResponse.structuredPatch.length === 0) {
      // No structuredPatch - skip this capture to avoid incorrect attribution
      // Log for debugging missing captures
      if (process.env.AGENTBLAME_DEBUG) {
        console.error(`[agentblame] Skipping ${toolName} for ${filePath}: no structuredPatch in tool_response`);
        console.error(`[agentblame] tool_response keys: ${toolResponse ? Object.keys(toolResponse).join(", ") : "null"}`);
      }
      return edits;
    }

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
      model,
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

  // Handle Write tool (new file creation)
  // For Write, we need content
  if (toolName === "write") {
    const content = toolInput?.content || payload.content;

    if (!content || !content.trim()) {
      return edits;
    }

    const lines = hashLines(content);
    if (lines.length === 0) return edits;

    edits.push({
      timestamp,
      provider: "claudeCode",
      filePath,
      model,
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

  // Unknown tool type that passed the initial check - skip
  return edits;
}

/**
 * Process OpenCode payload.
 * OpenCode provides before/after file content which allows precise line number extraction.
 */
function processOpenCodePayload(payload: OpenCodePayload): CapturedEdit[] {
  const edits: CapturedEdit[] = [];
  const timestamp = new Date().toISOString();

  const filePath = payload.filePath;
  if (!filePath) return edits;

  const sessionId = payload.sessionID;
  const toolUseId = payload.callID;
  const model = payload.model || null;

  // Handle write tool (new file creation)
  if (payload.tool === "write" && payload.content) {
    const content = payload.content;
    if (!content.trim()) return edits;

    // For new files, all lines are added
    const fileLines = content.split("\n");
    const linesWithNumbers = fileLines
      .map((line, i) => ({ content: line, lineNumber: i + 1 }))
      .filter(l => l.content.trim());

    const lines = hashLinesWithNumbers(linesWithNumbers, fileLines);
    if (lines.length === 0) return edits;

    edits.push({
      timestamp,
      provider: "opencode",
      filePath,
      model,
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

  // Handle edit tool
  if (payload.tool === "edit") {
    // OpenCode provides full before/after content - use it for precise line detection
    if (payload.before !== undefined && payload.after !== undefined) {
      const beforeLines = payload.before.split("\n");
      const afterLines = payload.after.split("\n");

      // Use diffLines to find added lines with their positions
      const parts = diffLines(payload.before, payload.after);
      const addedLinesWithNumbers: Array<{ content: string; lineNumber: number }> = [];

      let afterLineIndex = 0;
      for (const part of parts) {
        const partLines = part.value.split("\n");
        // Remove empty string from split if value ends with \n
        if (partLines[partLines.length - 1] === "") {
          partLines.pop();
        }

        if (part.added) {
          // These lines were added
          for (const line of partLines) {
            addedLinesWithNumbers.push({
              content: line,
              lineNumber: afterLineIndex + 1, // 1-indexed
            });
            afterLineIndex++;
          }
        } else if (part.removed) {
          // Removed lines don't affect after line index
        } else {
          // Context lines - advance the after line index
          afterLineIndex += partLines.length;
        }
      }

      if (addedLinesWithNumbers.length === 0) return edits;

      // Filter empty lines and hash with context
      const nonEmptyLines = addedLinesWithNumbers.filter(l => l.content.trim());
      if (nonEmptyLines.length === 0) return edits;

      const lines = hashLinesWithNumbers(nonEmptyLines, afterLines);
      if (lines.length === 0) return edits;

      const addedContent = nonEmptyLines.map(l => l.content).join("\n");

      edits.push({
        timestamp,
        provider: "opencode",
        filePath,
        model,
        lines,
        content: addedContent,
        contentHash: computeHash(addedContent),
        contentHashNormalized: computeNormalizedHash(addedContent),
        editType: "modification",
        oldContent: payload.oldString,
        sessionId,
        toolUseId,
      });

      return edits;
    }

    // Fallback: use oldString/newString if before/after not available
    const oldString = payload.oldString || "";
    const newString = payload.newString || "";

    if (!newString) return edits;

    const addedContent = extractAddedContent(oldString, newString);
    if (!addedContent.trim()) return edits;

    const lines = hashLines(addedContent);
    if (lines.length === 0) return edits;

    edits.push({
      timestamp,
      provider: "opencode",
      filePath,
      model,
      lines,
      content: addedContent,
      contentHash: computeHash(addedContent),
      contentHashNormalized: computeNormalizedHash(addedContent),
      editType: determineEditType(oldString, newString),
      oldContent: oldString || undefined,
      sessionId,
      toolUseId,
    });
  }

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
      edits = await processClaudePayload(payload as ClaudePayload);
    } else if (provider === "opencode") {
      edits = processOpenCodePayload(payload as OpenCodePayload);
    }

    // Save all edits to SQLite database
    if (process.env.AGENTBLAME_DEBUG && edits.length === 0) {
      console.error(`[agentblame] No edits extracted from ${provider} payload`);
    }

    for (const edit of edits) {
      // Find the agentblame directory for this file
      const agentblameDir = findAgentBlameDir(edit.filePath);
      if (!agentblameDir) {
        // File is not in an initialized repo, skip silently
        if (process.env.AGENTBLAME_DEBUG) {
          console.error(`[agentblame] No agentblame dir found for ${edit.filePath}`);
        }
        continue;
      }

      // Set the database directory and save
      setAgentBlameDir(agentblameDir);
      try {
        saveEdit(edit);
        if (process.env.AGENTBLAME_DEBUG) {
          console.error(`[agentblame] Saved edit for ${edit.filePath}: ${edit.lines.length} lines`);
        }
      } catch (saveErr) {
        // Log database errors even without debug mode since they indicate lost data
        console.error(`[agentblame] Failed to save edit for ${edit.filePath}:`, saveErr);
      }
    }

    process.exit(0);
  } catch (err) {
    // Silent failure - don't interrupt the editor
    console.error("Agent Blame capture error:", err);
    process.exit(0);
  }
}

