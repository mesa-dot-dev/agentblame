/**
 * Process Command v3
 *
 * Process a commit using delta-based attribution.
 * Replays deltas to compute AI vs human attributions and writes git notes.
 */

import {
  getRepoRoot,
  runGit,
} from "./lib/git/gitCli";
import { getCommitDiff, parseDiff } from "./lib/git/gitDiff";
import { attachNote, fetchNotesQuiet } from "./lib/git/gitNotes";
import {
  setDatabasePath,
  getSession,
  getConcatenatedPromptsForSession,
  getPromptsWithToolCounts,
  updateSessionFirstCommit,
} from "./lib/database";
import {
  getParentCommit,
  getDatabasePath,
  cleanupWorkingDir,
} from "./lib/storage";
import {
  aggregateToRanges,
  separateRanges,
  buildSessionMap,
  buildHumanMap,
} from "./lib/trace";
import { updateAnalytics, computeCommitStats } from "./lib/analytics";
import {
  getFilesWithDeltas,
  clearDeltas,
  getLastDeltaForFile,
  computeDiff,
  appendDelta,
  createHumanDelta,
} from "./lib/delta";
import {
  loadSnapshot,
  storeSnapshot,
  getFileAtCommit,
} from "./lib/storage";
import {
  computeFileAttributions,
} from "./lib/attribution";
import type {
  Attribution,
  SessionMetadata,
  ProcessResult,
} from "./lib/types";

// Terminal colors
const c = {
  reset: "\x1b[0m",
  bold: "\x1b[1m",
  dim: "\x1b[2m",
  cyan: "\x1b[36m",
  yellow: "\x1b[33m",
  green: "\x1b[32m",
  orange: "\x1b[38;2;184;101;64m",
  blue: "\x1b[34m",
};

/**
 * Detect and record human edits made after the last AI edit but before commit.
 * This ensures human edits that happen between AI edits and commit are captured.
 */
async function detectHumanEditsAtCommitTime(
  repoRoot: string,
  parentSha: string,
  commitSha: string,
  filePath: string
): Promise<void> {
  // Get the last delta for this file (AI or human)
  const lastDelta = getLastDeltaForFile(repoRoot, parentSha, filePath);

  if (!lastDelta?.afterBlob) {
    // No delta exists for this file, nothing to compare against
    if (process.env.AGENTBLAME_DEBUG) {
      console.error(`[agentblame] detectHumanEditsAtCommitTime: no delta for ${filePath}`);
    }
    return;
  }

  // Get the content from the last delta's afterBlob (baseline)
  let baselineContent: string;
  try {
    baselineContent = await loadSnapshot(repoRoot, lastDelta.afterBlob);
  } catch (err) {
    if (process.env.AGENTBLAME_DEBUG) {
      console.error(`[agentblame] detectHumanEditsAtCommitTime: failed to load afterBlob for ${filePath}: ${err}`);
    }
    return;
  }

  // Get the committed file content
  const committedContent = await getFileAtCommit(repoRoot, commitSha, filePath);
  if (committedContent === null) {
    if (process.env.AGENTBLAME_DEBUG) {
      console.error(`[agentblame] detectHumanEditsAtCommitTime: file not in commit ${filePath}`);
    }
    return;
  }

  // Compute diff between baseline and committed content
  const hunks = computeDiff(baselineContent, committedContent);

  if (hunks.length === 0) {
    // No changes between last delta and commit - nothing to record
    if (process.env.AGENTBLAME_DEBUG) {
      console.error(`[agentblame] detectHumanEditsAtCommitTime: no diff for ${filePath}`);
    }
    return;
  }

  // Human edits detected! Record them as a human delta
  const afterBlob = await storeSnapshot(repoRoot, committedContent);
  const humanDelta = createHumanDelta(filePath, hunks, afterBlob);
  appendDelta(repoRoot, parentSha, humanDelta);

  if (process.env.AGENTBLAME_DEBUG) {
    console.error(
      `[agentblame] detectHumanEditsAtCommitTime: recorded human delta for ${filePath} (${hunks.length} hunks)`
    );
  }
}

/**
 * Process a commit using delta-based attribution
 */
export async function processCommit(
  repoRoot: string,
  commitSha: string
): Promise<ProcessResult> {
  // Get parent commit
  const parentSha = await getParentCommit(repoRoot, commitSha);

  // If no parent, this is the initial commit - no attribution possible
  if (!parentSha) {
    return {
      sha: commitSha,
      filesProcessed: 0,
      aiLines: 0,
      humanLines: 0,
      sessions: [],
    };
  }

  // Get diff to find modified files and added lines
  const diff = await getCommitDiff(repoRoot, commitSha);
  const addedHunks = parseDiff(diff.raw);

  // Build a map of file -> added line numbers for quick lookup
  const addedLinesMap = new Map<string, Set<number>>();
  for (const hunk of addedHunks) {
    if (!addedLinesMap.has(hunk.path)) {
      addedLinesMap.set(hunk.path, new Set());
    }
    for (const line of hunk.lines) {
      addedLinesMap.get(hunk.path)!.add(line.lineNumber);
    }
  }

  // Check if we have any deltas to process
  const filesWithDeltas = getFilesWithDeltas(repoRoot, parentSha);

  // Detect human edits made after the last AI edit but before commit.
  // This ensures that if a user makes manual edits after AI edits and then commits,
  // those human edits are captured as deltas before we compute attributions.
  for (const filePath of filesWithDeltas) {
    await detectHumanEditsAtCommitTime(repoRoot, parentSha, commitSha, filePath);
  }

  // Track attributions per file (only for added lines)
  const fileAttributions = new Map<
    string,
    Array<{ line: number; sessionId: string | null }>
  >();

  let totalAiLines = 0;
  let totalHumanLines = 0;
  const allSessionIds = new Set<string>();

  for (const file of diff.files || []) {
    // Skip deleted files
    if (file.status === "deleted") continue;

    // Get the set of added lines for this file
    const addedLines = addedLinesMap.get(file.path);
    if (!addedLines || addedLines.size === 0) {
      continue;
    }

    // Compute attributions by replaying deltas
    const computed = await computeFileAttributions(repoRoot, parentSha, file.path);

    if (process.env.AGENTBLAME_DEBUG) {
      console.error(`[agentblame] process ${file.path}:`);
      console.error(`[agentblame]   addedLines from diff: ${Array.from(addedLines).join(', ')}`);
      console.error(`[agentblame]   aiRanges: ${computed.aiRanges.map(r => `${r.sessionId?.slice(0,8)}:L${r.startLine}-${r.endLine}`).join(', ')}`);
    }

    // Build attributions - only for ADDED lines
    const attrs: Array<{ line: number; sessionId: string | null; promptId?: number | null }> = [];

    for (const lineNum of addedLines) {
      // Check if this line is in an AI range
      let sessionId: string | null = null;
      let promptId: number | null = null;
      for (const range of computed.aiRanges) {
        if (lineNum >= range.startLine && lineNum <= range.endLine) {
          sessionId = range.sessionId;
          promptId = range.promptId ?? null;
          allSessionIds.add(sessionId);
          break;
        }
      }

      if (process.env.AGENTBLAME_DEBUG) {
        console.error(`[agentblame]   L${lineNum} -> ${sessionId?.slice(0,8) || 'HUMAN'} (prompt: ${promptId})`);
      }

      attrs.push({ line: lineNum, sessionId, promptId });

      if (sessionId) {
        totalAiLines++;
      } else {
        totalHumanLines++;
      }
    }

    fileAttributions.set(file.path, attrs);
  }

  // Build session map for the note
  const sessionMap = buildSessionMap(fileAttributions);
  const humanMap = buildHumanMap(fileAttributions);

  // Build attribution structure
  const attribution: Attribution = {
    version: 3,
    timestamp: new Date().toISOString(),
    sessions: {},
    files: {},
  };

  // Add session metadata
  const sessions: Record<string, SessionMetadata> = {};
  for (const sessionId of allSessionIds) {
    const session = getSession(sessionId);
    const prompts = getPromptsWithToolCounts(sessionId);

    sessions[sessionId] = {
      agent: session?.agent || "cursor",
      model: session?.model || null,
      prompts: prompts || null,
      startedAt: session?.createdAt || new Date().toISOString(),
    };

    // Update session with first commit info
    updateSessionFirstCommit(sessionId, commitSha);
  }
  attribution.sessions = sessions;

  // Build file attributions
  for (const [filePath, attrs] of fileAttributions) {
    const ranges = aggregateToRanges(attrs);
    const { aiRanges, humanRanges } = separateRanges(ranges);

    attribution.files[filePath] = {
      aiRanges: aiRanges.map((r) => ({
        sessionId: r.sessionId,
        promptId: r.promptId,
        startLine: r.startLine,
        endLine: r.endLine,
      })),
      humanRanges,
    };
  }

  // Write git note only if there are AI attributions
  // Don't overwrite existing notes if we have no AI data
  if (allSessionIds.size > 0) {
    await attachNote(repoRoot, commitSha, attribution, sessions);
  } else if (process.env.AGENTBLAME_DEBUG) {
    console.error(`[agentblame] No AI sessions found, skipping note write`);
  }

  // Update analytics
  const commitStats = computeCommitStats(sessions, attribution.files);

  // Get commit author for analytics
  const authorResult = await runGit(repoRoot, [
    "log",
    "-1",
    "--format=%ae",
    commitSha,
  ]);
  const commitAuthor =
    authorResult.exitCode === 0 ? authorResult.stdout.trim() : undefined;

  await updateAnalytics(repoRoot, commitStats, commitAuthor);

  // NOTE: We intentionally do NOT clean up deltas here.
  // Deltas are cleaned up in capture.ts when a new base SHA is detected.
  // This allows users to reset and recommit without losing attribution.

  return {
    sha: commitSha,
    filesProcessed: fileAttributions.size,
    aiLines: totalAiLines,
    humanLines: totalHumanLines,
    sessions: Array.from(allSessionIds),
  };
}

/**
 * CLI handler for process command
 */
export async function runProcess(sha?: string): Promise<void> {
  const repoRoot = await getRepoRoot(process.cwd());

  if (!repoRoot) {
    console.error("Error: Not in a git repository");
    process.exit(1);
  }

  // Set up database directory for this repo
  const dbPath = getDatabasePath(repoRoot);
  setDatabasePath(dbPath);

  // Fetch remote notes first to avoid push conflicts
  await fetchNotesQuiet(repoRoot);

  // Resolve commit SHA
  let commitSha = sha || "HEAD";
  const resolveResult = await runGit(repoRoot, ["rev-parse", commitSha]);
  if (resolveResult.exitCode !== 0) {
    console.error("Error: Could not resolve commit");
    process.exit(1);
  }
  commitSha = resolveResult.stdout.trim();

  const result = await processCommit(repoRoot, commitSha);

  // Calculate stats
  const totalLines = result.aiLines + result.humanLines;
  const aiPercent =
    totalLines > 0 ? Math.round((result.aiLines / totalLines) * 100) : 0;
  const humanPercent = 100 - aiPercent;

  const WIDTH = 72;
  const INNER = WIDTH - 2;
  const border = `${c.dim}│${c.reset}`;

  const padRight = (content: string, visibleLen: number) =>
    content + " ".repeat(Math.max(0, INNER - visibleLen));

  // Print formatted output
  console.log("");
  console.log(`${c.dim}┌${"─".repeat(WIDTH - 2)}┐${c.reset}`);

  // Title
  const title = "Agent Blame v3";
  const titlePadLeft = Math.floor((INNER - title.length) / 2);
  const titlePadRight = INNER - title.length - titlePadLeft;
  console.log(
    `${border}${" ".repeat(titlePadLeft)}${c.bold}${c.cyan}${title}${c.reset}${" ".repeat(titlePadRight)}${border}`
  );

  console.log(`${c.dim}├${"─".repeat(WIDTH - 2)}┤${c.reset}`);

  // Commit line
  const commitVisible = `  Commit: ${commitSha.slice(0, 8)}`;
  const commitColored = `  ${c.yellow}Commit: ${commitSha.slice(0, 8)}${c.reset}`;
  console.log(`${border}${padRight(commitColored, commitVisible.length)}${border}`);

  // Files processed
  const filesVisible = `  Files: ${result.filesProcessed}`;
  console.log(`${border}${padRight(filesVisible, filesVisible.length)}${border}`);

  console.log(`${c.dim}├${"─".repeat(WIDTH - 2)}┤${c.reset}`);

  // Sessions
  if (result.sessions.length > 0) {
    const sessHeader = "  Sessions:";
    console.log(`${border}${padRight(sessHeader, sessHeader.length)}${border}`);

    for (const sessionId of result.sessions) {
      const session = getSession(sessionId);
      const agent = session?.agent || "unknown";
      const model = session?.model || "";
      const modelStr = model ? ` - ${model}` : "";

      const visibleText = `    ${sessionId.slice(0, 8)} [${agent}${modelStr}]`;
      const coloredText = `    ${c.blue}${sessionId.slice(0, 8)}${c.reset} ${c.orange}[${agent}${modelStr}]${c.reset}`;
      console.log(`${border}${padRight(coloredText, visibleText.length)}${border}`);

      // Show prompt(s) if available
      const prompts = getPromptsWithToolCounts(sessionId);
      if (prompts && prompts.length > 0) {
        for (const prompt of prompts) {
          const content = prompt.content ?? "[content not stored]";
          const truncatedPrompt =
            content.length > 45
              ? content.substring(0, 45) + "..."
              : content;
          const promptVisible = `      [P${prompt.id}] "${truncatedPrompt}"`;
          const promptColored = `      ${c.dim}[P${prompt.id}] "${truncatedPrompt}"${c.reset}`;
          console.log(`${border}${padRight(promptColored, promptVisible.length)}${border}`);
        }
      }
    }

    console.log(`${c.dim}├${"─".repeat(WIDTH - 2)}┤${c.reset}`);
  }

  // Summary bar
  const barWidth = 50;
  const aiBarWidth = Math.round((aiPercent / 100) * barWidth);
  const humanBarWidth = barWidth - aiBarWidth;

  const summaryHeader = "  Summary:";
  console.log(`${border}${padRight(summaryHeader, summaryHeader.length)}${border}`);

  const barVisible = `  ${"█".repeat(aiBarWidth)}${"░".repeat(humanBarWidth)}`;
  const barColored = `  ${c.orange}${"█".repeat(aiBarWidth)}${c.reset}${c.dim}${"░".repeat(humanBarWidth)}${c.reset}`;
  console.log(`${border}${padRight(barColored, barVisible.length)}${border}`);

  const statsVisible = `  AI: ${String(result.aiLines).padStart(3)} lines (${String(aiPercent).padStart(3)}%)    Human: ${String(result.humanLines).padStart(3)} lines (${String(humanPercent).padStart(3)}%)`;
  const statsColored = `  ${c.orange}AI: ${String(result.aiLines).padStart(3)} lines (${String(aiPercent).padStart(3)}%)${c.reset}    ${c.green}Human: ${String(result.humanLines).padStart(3)} lines (${String(humanPercent).padStart(3)}%)${c.reset}`;
  console.log(`${border}${padRight(statsColored, statsVisible.length)}${border}`);

  console.log(`${c.dim}└${"─".repeat(WIDTH - 2)}┘${c.reset}`);
  console.log("");
}
