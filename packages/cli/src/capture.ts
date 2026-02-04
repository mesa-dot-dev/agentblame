#!/usr/bin/env bun
/**
 * Agent Blame Hook Capture v3
 *
 * Captures AI-generated code from Cursor, Claude Code, and OpenCode hooks.
 * Uses delta-based tracking for accurate line attribution.
 *
 * Usage:
 *   echo '{"payload": ...}' | bun run capture.ts --provider cursor --event afterFileEdit
 *   echo '{"payload": ...}' | bun run capture.ts --provider claude
 *   echo '{"payload": ...}' | bun run capture.ts --provider opencode
 */

import * as fs from "node:fs";
import * as path from "node:path";
import {
  setDatabasePath,
  generateSessionId,
  upsertSession,
  insertPrompt,
  insertToolCall,
  promptExists,
  getLatestPromptForSession,
  hashPromptContent,
} from "./lib/database";
import { getConfig } from "./lib/config";
import {
  storeSnapshot,
  getGitHead,
  readFileContent,
  getDatabasePath,
  ensureAgentBlameDirs,
  loadSnapshot,
  cleanupProcessedWorkingDirs,
} from "./lib/storage";
import {
  captureBeforePromptCheckpoint,
  captureFileCheckpoint,
  getBeforeBlob,
  hasFileChanged,
  getCheckpointContent,
  loadCheckpoint,
} from "./lib/checkpoint";
import { normalizeModelName } from "./lib/util";
import {
  computeDiff,
  appendDelta,
  createAIDelta,
  createHumanDelta,
  getLastAIDeltaForFile,
  getLastDeltaForFile,
} from "./lib/delta";
import type { AiAgent } from "./lib/types";
import { writeHookTrace } from "./lib/hooks";

// =============================================================================
// Types
// =============================================================================

interface CursorPayload {
  file_path?: string;
  edits?: Array<{ old_string: string; new_string: string }>;
  model?: string;
  conversation_id?: string;
  generation_id?: string;
  prompt?: string;
  attachments?: Array<{ type: string; file_path: string }>;
  hook_event_name?: string;
  workspace_roots?: string[];
}

interface ClaudePayload {
  tool_name?: string;
  tool_input?: {
    file_path?: string;
    old_string?: string;
    new_string?: string;
    content?: string;
    pattern?: string;
    path?: string;
    command?: string;
    query?: string;
    url?: string;
    description?: string;
    subagent_type?: string;
  };
  tool_response?: {
    filePath?: string;
    originalFile?: string;
    userModified?: boolean;
  };
  session_id?: string;
  tool_use_id?: string;
  transcript_path?: string;
  file_path?: string;
  hook_event_name?: string;
}

interface OpenCodePayload {
  tool: "edit" | "write";
  sessionID?: string;
  callID?: string;
  filePath?: string;
  oldString?: string;
  newString?: string;
  before?: string;
  after?: string;
  diff?: string;
  content?: string;
  model?: string;
  prompt?: string;
  hook_event?: "before" | "after";
}

// =============================================================================
// Utilities
// =============================================================================

async function findRepoRoot(filePath: string): Promise<string | null> {
  const absolutePath = path.isAbsolute(filePath)
    ? filePath
    : path.resolve(process.cwd(), filePath);

  let dir: string;
  try {
    const stat = fs.statSync(absolutePath);
    dir = stat.isDirectory() ? absolutePath : path.dirname(absolutePath);
  } catch {
    dir = path.dirname(absolutePath);
  }

  while (dir !== "/" && dir !== ".") {
    const gitDir = path.join(dir, ".git");
    if (fs.existsSync(gitDir)) {
      return dir;
    }
    dir = path.dirname(dir);
  }

  return null;
}

function makeRelative(repoRoot: string, filePath: string): string {
  if (filePath.startsWith(repoRoot)) {
    return filePath.slice(repoRoot.length + 1);
  }
  return filePath;
}

async function extractModelFromTranscript(
  transcriptPath: string
): Promise<string | null> {
  try {
    const content = fs.readFileSync(transcriptPath, "utf8");
    const lines = content.split("\n");

    for (let i = lines.length - 1; i >= 0; i--) {
      const line = lines[i].trim();
      if (!line) continue;

      try {
        const entry = JSON.parse(line);
        if (entry.message?.model) {
          return entry.message.model;
        }
      } catch {
        continue;
      }
    }

    return null;
  } catch {
    return null;
  }
}

async function extractPromptFromTranscript(
  transcriptPath: string
): Promise<string | null> {
  try {
    const content = fs.readFileSync(transcriptPath, "utf8");
    const lines = content.split("\n").reverse();

    for (const line of lines) {
      if (!line.trim()) continue;

      try {
        const entry = JSON.parse(line);

        if (entry.type === "human" || entry.message?.role === "user") {
          const msg = entry.message?.content;

          if (Array.isArray(msg)) {
            const textPart = msg.find(
              (m: any) => m.type === "text" || typeof m === "string"
            );
            if (textPart) {
              return typeof textPart === "string" ? textPart : textPart.text;
            }
          } else if (typeof msg === "string") {
            return msg;
          } else if (entry.content) {
            return entry.content;
          }
        }
      } catch {
        continue;
      }
    }

    return null;
  } catch {
    return null;
  }
}

// =============================================================================
// Capture Context
// =============================================================================

interface CaptureContext {
  repoRoot: string;
  baseSha: string;
  agent: AiAgent;
  sessionId: string;
  model: string | null;
  storePromptContent: boolean;
}

async function setupCaptureContext(
  filePath: string,
  agent: AiAgent,
  conversationId: string,
  model: string | null
): Promise<CaptureContext | null> {
  // this will override the config used before we had a payload from the agent. Once we have a payload,
  // prefer the paths indicated in the payload.
  const repoRoot = await findRepoRoot(filePath);
  if (!repoRoot) {
    if (process.env.AGENTBLAME_DEBUG) {
      console.error(`[agentblame] No git repo found for ${filePath}`);
    }
    return null;
  }

  ensureAgentBlameDirs(repoRoot);

  const dbPath = getDatabasePath(repoRoot);
  setDatabasePath(dbPath);

  const baseSha = await getGitHead(repoRoot);
  if (!baseSha) {
    if (process.env.AGENTBLAME_DEBUG) {
      console.error(`[agentblame] No HEAD commit found in ${repoRoot}`);
    }
    return null;
  }

  // Smart cleanup: only clean up working directories for commits that:
  // 1. Are ancestors of current HEAD (we've moved past them)
  // 2. Have git notes (deltas were processed)
  // This preserves deltas for reset/recommit and stash scenarios
  await cleanupProcessedWorkingDirs(repoRoot, baseSha);

  const sessionId = generateSessionId(agent, conversationId);
  const normalizedModel = normalizeModelName(model);

  // Load config setting for prompt content storage
  const storePromptContent = await getConfig(repoRoot, 'storePromptContent');

  return {
    repoRoot,
    baseSha,
    agent,
    sessionId,
    model: normalizedModel,
    storePromptContent,
  };
}

// =============================================================================
// Delta Capture (v3 - The Only Way)
// =============================================================================

/**
 * Detect and record human edits since last checkpoint.
 *
 * IMPORTANT: We need to be careful not to mark another AI tool's edits as human.
 * The most reliable baseline is the most recent delta's afterBlob (from any session).
 * This handles:
 * 1. Cross-session detection (another AI edited the file)
 * 2. Same-session async race (PostToolUse is async, so checkpoint might be stale)
 *
 * Priority:
 * 1. Last delta's afterBlob (most reliable - represents actual file state)
 * 2. Checkpoint content (fallback if no delta exists)
 */
async function detectAndRecordHumanEdits(
  ctx: CaptureContext,
  conversationId: string,
  filePath: string
): Promise<void> {
  const absolutePath = path.isAbsolute(filePath)
    ? filePath
    : path.join(ctx.repoRoot, filePath);
  const relativePath = makeRelative(ctx.repoRoot, absolutePath);

  // Read current file content first
  const currentContent = readFileContent(absolutePath);
  if (currentContent === null) {
    return;
  }

  if (process.env.AGENTBLAME_DEBUG) {
    console.error(`[agentblame] detectHumanEdits: ${relativePath}`);
  }

  // Priority 1: Use the last delta's afterBlob as baseline (most reliable)
  // This handles both cross-session AND same-session scenarios
  // (e.g., when async PostToolUse writes delta but checkpoint is stale)
  let beforeContent: string | null = null;
  const lastDelta = getLastDeltaForFile(ctx.repoRoot, ctx.baseSha, relativePath);

  if (process.env.AGENTBLAME_DEBUG) {
    console.error(`[agentblame]   lastDelta: ${lastDelta ? `session=${lastDelta.sessionId?.slice(0,8) || 'human'}, afterBlob=${lastDelta.afterBlob?.slice(0,8)}` : 'null'}`);
  }

  if (lastDelta?.afterBlob) {
    try {
      beforeContent = await loadSnapshot(ctx.repoRoot, lastDelta.afterBlob);
      if (process.env.AGENTBLAME_DEBUG) {
        console.error(`[agentblame]   Loaded afterBlob: ${beforeContent?.length} chars`);
      }
    } catch (err) {
      if (process.env.AGENTBLAME_DEBUG) {
        console.error(`[agentblame]   Failed to load afterBlob: ${err}`);
      }
      // Fall through to checkpoint
    }
  }

  // Priority 2: Fall back to checkpoint if no delta afterBlob available
  if (beforeContent === null) {
    beforeContent = await getCheckpointContent(ctx.repoRoot, conversationId, relativePath);
    if (process.env.AGENTBLAME_DEBUG) {
      console.error(`[agentblame]   checkpoint content: ${beforeContent ? beforeContent.length + ' chars' : 'null'}`);
    }
  }

  // No baseline available - can't detect changes
  if (beforeContent === null) {
    if (process.env.AGENTBLAME_DEBUG) {
      console.error(`[agentblame]   No baseline - skipping`);
    }
    return;
  }

  const hunks = computeDiff(beforeContent, currentContent);
  if (process.env.AGENTBLAME_DEBUG) {
    console.error(`[agentblame]   beforeContent: ${beforeContent.length} chars, currentContent: ${currentContent.length} chars`);
    console.error(`[agentblame]   diff hunks: ${hunks.length} (${hunks.map(h => `L${h.newStart}+${h.newCount}`).join(',')})`);
  }

  if (hunks.length === 0) {
    // Update checkpoint even if no changes (keeps it current)
    await captureFileCheckpoint(ctx.repoRoot, conversationId, relativePath);
    return;
  }

  // Store afterBlob for cross-session detection
  const afterBlob = await storeSnapshot(ctx.repoRoot, currentContent);

  if (process.env.AGENTBLAME_DEBUG) {
    console.error(`[agentblame]   RECORDING HUMAN DELTA: ${relativePath} with ${hunks.length} hunks`);
  }

  const humanDelta = createHumanDelta(relativePath, hunks, afterBlob);
  appendDelta(ctx.repoRoot, ctx.baseSha, humanDelta);

  // Update checkpoint to current state
  await captureFileCheckpoint(ctx.repoRoot, conversationId, relativePath);

  if (process.env.AGENTBLAME_DEBUG) {
    console.error(
      `[agentblame] Detected human edit: ${relativePath} (${hunks.length} hunks)`
    );
  }
}

/**
 * Record an AI edit delta.
 */
async function recordAIDelta(
  ctx: CaptureContext,
  filePath: string,
  beforeContent: string | null,
  afterContent: string
): Promise<void> {
  const absolutePath = path.isAbsolute(filePath)
    ? filePath
    : path.join(ctx.repoRoot, filePath);
  const relativePath = makeRelative(ctx.repoRoot, absolutePath);

  const before = beforeContent ?? "";

  const hunks = computeDiff(before, afterContent);
  if (hunks.length === 0) {
    if (process.env.AGENTBLAME_DEBUG) {
      console.error(`[agentblame] recordAIDelta: no diff for ${relativePath} (before=${before.length} chars, after=${afterContent.length} chars)`);
    }
    return;
  }

  // Store afterBlob for cross-session human edit detection
  const afterBlob = await storeSnapshot(ctx.repoRoot, afterContent);

  const latestPrompt = getLatestPromptForSession(ctx.sessionId);
  const promptId = latestPrompt?.id ?? null;

  const aiDelta = createAIDelta(relativePath, ctx.sessionId, promptId, hunks, afterBlob);
  appendDelta(ctx.repoRoot, ctx.baseSha, aiDelta);

  if (process.env.AGENTBLAME_DEBUG) {
    console.error(
      `[agentblame] Recorded AI delta: ${relativePath} (${hunks.length} hunks, prompt: ${promptId}, lines: ${hunks.map(h => `${h.newStart}+${h.newCount}`).join(',')})`
    );
    console.error(`[agentblame]   stored path: "${relativePath}"`);
  }
}

/**
 * Get before content from checkpoint or git HEAD.
 */
async function getBeforeContent(
  ctx: CaptureContext,
  conversationId: string,
  filePath: string
): Promise<string | null> {
  const absolutePath = path.isAbsolute(filePath)
    ? filePath
    : path.join(ctx.repoRoot, filePath);
  const relativePath = makeRelative(ctx.repoRoot, absolutePath);

  const beforeBlob = await getBeforeBlob(ctx.repoRoot, conversationId, relativePath);
  if (!beforeBlob) {
    return null;
  }

  try {
    return await loadSnapshot(ctx.repoRoot, beforeBlob);
  } catch {
    return null;
  }
}

// =============================================================================
// Payload Processing
// =============================================================================

function parseArgs(): {
  provider: "cursor" | "claude" | "opencode";
  event?: string;
} {
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

async function processCursorBeforeSubmitPrompt(
  payload: CursorPayload
): Promise<void> {
  const workspaceRoot = payload.workspace_roots?.[0];
  if (!workspaceRoot) return;

  const conversationId = payload.conversation_id || `cursor-${Date.now()}`;
  const ctx = await setupCaptureContext(
    workspaceRoot,
    "cursor",
    conversationId,
    payload.model || null
  );
  if (!ctx) return;

  upsertSession({
    id: ctx.sessionId,
    agent: "cursor",
    model: ctx.model,
    conversationId,
  });

  // Detect human edits on existing checkpoints, then capture new checkpoint
  try {
    const existingCheckpoint = loadCheckpoint(ctx.repoRoot, conversationId);
    if (existingCheckpoint) {
      for (const filePath of Object.keys(existingCheckpoint.files)) {
        await detectAndRecordHumanEdits(ctx, conversationId, filePath);
      }
    }

    await captureBeforePromptCheckpoint(ctx.repoRoot, conversationId);
  } catch (err) {
    if (process.env.AGENTBLAME_DEBUG) {
      console.error(`[agentblame] Failed to capture checkpoint:`, err);
    }
  }

  // Store prompt if provided
  const prompt = payload.prompt;
  if (prompt) {
    const contentHash = hashPromptContent(prompt);
    if (!promptExists(ctx.sessionId, contentHash)) {
      insertPrompt({
        sessionId: ctx.sessionId,
        content: ctx.storePromptContent ? prompt : null,
        contentHash,
      });

      if (process.env.AGENTBLAME_DEBUG) {
        console.error(`[agentblame] Captured prompt: ${prompt.substring(0, 100)}...`);
      }
    }
  }
}

async function processCursorPayload(
  payload: CursorPayload,
  event: string
): Promise<void> {
  if (event === "beforeSubmitPrompt") {
    await processCursorBeforeSubmitPrompt(payload);
    return;
  }

  if (event === "afterTabFileEdit") {
    return;
  }

  if (!payload.edits || payload.edits.length === 0) {
    return;
  }

  const filePath = payload.file_path;
  if (!filePath) return;

  const conversationId = payload.conversation_id || `cursor-${Date.now()}`;
  const ctx = await setupCaptureContext(
    filePath,
    "cursor",
    conversationId,
    payload.model || null
  );
  if (!ctx) return;

  upsertSession({
    id: ctx.sessionId,
    agent: "cursor",
    model: ctx.model,
    conversationId,
  });

  const absolutePath = path.isAbsolute(filePath)
    ? filePath
    : path.join(ctx.repoRoot, filePath);
  const relativePath = makeRelative(ctx.repoRoot, absolutePath);


  // Get before/after content and record delta
  const beforeContent = await getBeforeContent(ctx, conversationId, filePath);
  const afterContent = readFileContent(absolutePath);

  if (afterContent) {
    await recordAIDelta(ctx, filePath, beforeContent, afterContent);
    // Update checkpoint to current state so next beforeSubmitPrompt doesn't
    // incorrectly detect this AI edit as a "human edit"
    await captureFileCheckpoint(ctx.repoRoot, conversationId, filePath);
  }

  insertToolCall({
    sessionId: ctx.sessionId,
    toolName: "edit",
    filePath: relativePath,
  });

  if (process.env.AGENTBLAME_DEBUG) {
    console.error(`[agentblame] Captured Cursor edit: ${filePath}`);
  }
}

async function processClaudePayload(payload: ClaudePayload): Promise<void> {
  if ((payload as any).cursor_version) {
    return;
  }

  const toolName = payload.tool_name || "";
  if (!toolName) return;

  const hookEvent = payload.hook_event_name || "PostToolUse";
  const toolInput = payload.tool_input;
  const toolResponse = payload.tool_response;
  const filePath =
    toolResponse?.filePath || toolInput?.file_path || payload.file_path;

  const toolNameLower = toolName.toLowerCase();
  const isFileModifying =
    toolNameLower === "edit" ||
    toolNameLower === "write" ||
    toolNameLower === "multiedit";

  const pathForRepo = filePath || payload.transcript_path;
  if (!pathForRepo) return;

  if (process.env.AGENTBLAME_DEBUG) {
    console.error(`[agentblame] Claude ${hookEvent} ${toolName}:`);
    console.error(`[agentblame]   toolResponse.filePath: ${toolResponse?.filePath}`);
    console.error(`[agentblame]   toolInput.file_path: ${toolInput?.file_path}`);
    console.error(`[agentblame]   payload.file_path: ${payload.file_path}`);
    console.error(`[agentblame]   resolved filePath: ${filePath}`);
  }

  let model: string | null = null;
  if (payload.transcript_path) {
    model = await extractModelFromTranscript(payload.transcript_path);
  }
  if (!model) {
    model = "claude";
  }

  const conversationId = payload.session_id || `claude-${Date.now()}`;
  const ctx = await setupCaptureContext(pathForRepo, "claude", conversationId, model);
  if (!ctx) return;

  upsertSession({
    id: ctx.sessionId,
    agent: "claude",
    model: ctx.model,
    conversationId,
  });

  // Extract and store prompt
  if (payload.transcript_path) {
    const prompt = await extractPromptFromTranscript(payload.transcript_path);
    if (prompt) {
      const contentHash = hashPromptContent(prompt);
      if (!promptExists(ctx.sessionId, contentHash)) {
        insertPrompt({
          sessionId: ctx.sessionId,
          content: ctx.storePromptContent ? prompt : null,
          contentHash,
        });
      }
    }
  }

  // PreToolUse: detect human edits and capture checkpoint
  if (hookEvent === "PreToolUse" && isFileModifying && filePath) {
    if (process.env.AGENTBLAME_DEBUG) {
      console.error(`[agentblame] PreToolUse: ${filePath}`);
    }
    await detectAndRecordHumanEdits(ctx, conversationId, filePath);
    await captureFileCheckpoint(ctx.repoRoot, conversationId, filePath);

    if (process.env.AGENTBLAME_DEBUG) {
      console.error(`[agentblame] PreToolUse complete: ${filePath}`);
    }
    return;
  }

  // PostToolUse: record AI delta
  if (hookEvent === "PostToolUse" && isFileModifying && filePath) {
    const absolutePath = path.isAbsolute(filePath)
      ? filePath
      : path.join(ctx.repoRoot, filePath);
    const relativePath = makeRelative(ctx.repoRoot, absolutePath);

    const beforeContent = await getBeforeContent(ctx, conversationId, filePath);
    const afterContent = readFileContent(absolutePath);

    if (process.env.AGENTBLAME_DEBUG) {
      console.error(`[agentblame] PostToolUse ${toolName}: ${relativePath}`);
      console.error(`[agentblame]   beforeContent: ${beforeContent ? beforeContent.length + ' chars' : 'null'}`);
      console.error(`[agentblame]   afterContent: ${afterContent ? afterContent.length + ' chars' : 'null'}`);
    }

    if (afterContent) {
      await recordAIDelta(ctx, filePath, beforeContent, afterContent);
      // Update checkpoint to current state so next PreToolUse doesn't
      // incorrectly detect this AI edit as a "human edit"
      await captureFileCheckpoint(ctx.repoRoot, conversationId, filePath);
    } else if (process.env.AGENTBLAME_DEBUG) {
      console.error(`[agentblame]   SKIPPED: no afterContent for ${relativePath}`);
    }

    insertToolCall({
      sessionId: ctx.sessionId,
      toolName: toolName.toLowerCase(),
      filePath: relativePath,
    });

    if (process.env.AGENTBLAME_DEBUG) {
      console.error(`[agentblame] Captured Claude ${toolName}: ${filePath}`);
    }
  } else if (!isFileModifying) {
    // Read-only tools
    insertToolCall({
      sessionId: ctx.sessionId,
      toolName: toolName.toLowerCase(),
      filePath: filePath ? makeRelative(ctx.repoRoot, filePath) : null,
    });
  }
}

async function processOpenCodePayload(payload: OpenCodePayload): Promise<void> {
  const filePath = payload.filePath;
  if (!filePath) return;

  const conversationId = payload.sessionID || `opencode-${Date.now()}`;
  const ctx = await setupCaptureContext(
    filePath,
    "opencode",
    conversationId,
    payload.model || null
  );
  if (!ctx) return;

  upsertSession({
    id: ctx.sessionId,
    agent: "opencode",
    model: ctx.model,
    conversationId,
  });

  if (payload.prompt) {
    const contentHash = hashPromptContent(payload.prompt);
    if (!promptExists(ctx.sessionId, contentHash)) {
      insertPrompt({
        sessionId: ctx.sessionId,
        content: ctx.storePromptContent ? payload.prompt : null,
        contentHash,
      });
    }
  }

  // Before hook: detect human edits and capture checkpoint
  if (payload.hook_event === "before") {
    await detectAndRecordHumanEdits(ctx, conversationId, filePath);
    await captureFileCheckpoint(ctx.repoRoot, conversationId, filePath);

    if (process.env.AGENTBLAME_DEBUG) {
      console.error(`[agentblame] OpenCode before checkpoint: ${filePath}`);
    }
    return;
  }

  // After hook: record AI delta
  const absolutePath = path.isAbsolute(filePath)
    ? filePath
    : path.join(ctx.repoRoot, filePath);
  const relativePath = makeRelative(ctx.repoRoot, absolutePath);

  // Get before content (OpenCode may provide it directly)
  let beforeContent: string | null = null;
  if (payload.before) {
    beforeContent = payload.before;
  } else {
    beforeContent = await getBeforeContent(ctx, conversationId, filePath);
  }

  // Get after content
  const afterContent = payload.after ?? readFileContent(absolutePath);

  if (afterContent) {
    await recordAIDelta(ctx, filePath, beforeContent, afterContent);
    // Update checkpoint to current state so next before hook doesn't
    // incorrectly detect this AI edit as a "human edit"
    await captureFileCheckpoint(ctx.repoRoot, conversationId, filePath);
  }

  insertToolCall({
    sessionId: ctx.sessionId,
    toolName: payload.tool,
    filePath: relativePath,
  });

  if (process.env.AGENTBLAME_DEBUG) {
    console.error(`[agentblame] Captured OpenCode ${payload.tool}: ${filePath}`);
  }
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

    if (process.env.AGENTBLAME_DEBUG) {
      console.error(`[agentblame] Capture: provider=${provider}, event=${event}`);
    }

    if (!input.trim()) {
      console.warn(`[agentblame] Capture: input empty, returning 0`)
      process.exit(0);
    }

    // make best-effort to load an existing config using cwd- payload may override this config dir later in the process
    const repoRoot = await findRepoRoot(process.cwd());
    if (!repoRoot) {
      console.warn(`[agentblame] Capture: could not detect repo root via cwd, configs may not work until we get a payload`)
    }

    const traceHooks = repoRoot ? await getConfig(repoRoot, 'traceHooks') : false;

    if (traceHooks && repoRoot) {
      const traceFile = writeHookTrace(repoRoot, input);
      if (traceFile && process.env.AGENTBLAME_DEBUG) {
        console.error(`[agentblame] Trace written: ${traceFile}`);
      }
    }

    const data = JSON.parse(input);
    const payload = data.payload || data;

    if (provider === "cursor") {
      const eventName = event || data.hook_event_name || "afterFileEdit";
      await processCursorPayload(payload as CursorPayload, eventName);
    } else if (provider === "claude") {
      await processClaudePayload(payload as ClaudePayload);
    } else if (provider === "opencode") {
      await processOpenCodePayload(payload as OpenCodePayload);
    }

    process.exit(0);
  } catch (err) {
    if (process.env.AGENTBLAME_DEBUG) {
      console.error("Agent Blame capture error:", err);
    }
    process.exit(0);
  }
}
