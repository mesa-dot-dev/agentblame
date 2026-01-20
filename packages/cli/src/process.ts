/**
 * Process Command
 *
 * Match a commit against pending AI edits and attach git notes.
 */

import {
  getRepoRoot,
  runGit,
  getCommitHunks,
  getCommitMoves,
  buildMoveIndex,
  attachNote,
  fetchNotesQuiet,
  getAgentBlameDirForRepo,
  type RangeAttribution,
  type LineAttribution,
  type MatchResult,
} from "./lib";
import {
  findLineMatch,
  markEditsAsMatched,
  findEditsByFile,
  getEditLines,
  setAgentBlameDir,
} from "./lib/database";

// Terminal colors
const c = {
  reset: "\x1b[0m",
  bold: "\x1b[1m",
  dim: "\x1b[2m",
  cyan: "\x1b[36m",
  yellow: "\x1b[33m",
  green: "\x1b[32m",
  orange: "\x1b[38;5;166m", // Mesa Orange - matches gutter color
  blue: "\x1b[34m",
};

/**
 * Find a match for an original location (before move)
 * Used for move detection - checks if the original location had AI-attributed code
 */
function findMatchForOriginalLocation(
  originalPath: string
): { editId: number; provider: string; model: string | null } | null {
  // Find edits that match the original file
  const edits = findEditsByFile(originalPath);

  for (const edit of edits) {
    const lines = getEditLines(edit.id);
    if (lines.length > 0) {
      return {
        editId: edit.id,
        provider: edit.provider,
        model: edit.model,
      };
    }
  }

  return null;
}

/**
 * Merge consecutive lines with the same attribution into ranges
 */
function mergeConsecutiveLines(lines: LineAttribution[]): RangeAttribution[] {
  if (lines.length === 0) return [];

  const sorted = [...lines].sort((a, b) => {
    if (a.path !== b.path) return a.path.localeCompare(b.path);
    return a.line - b.line;
  });

  const ranges: RangeAttribution[] = [];
  let currentRange: RangeAttribution | null = null;

  for (const line of sorted) {
    if (
      currentRange &&
      currentRange.path === line.path &&
      currentRange.endLine === line.line - 1 &&
      currentRange.provider === line.provider &&
      currentRange.matchType === line.matchType
    ) {
      currentRange.endLine = line.line;
      currentRange.confidence = Math.min(currentRange.confidence, line.confidence);
    } else {
      if (currentRange) {
        ranges.push(currentRange);
      }
      currentRange = {
        path: line.path,
        startLine: line.line,
        endLine: line.line,
        provider: line.provider,
        model: line.model,
        confidence: line.confidence,
        matchType: line.matchType,
        contentHash: line.contentHash,
      };
    }
  }

  if (currentRange) {
    ranges.push(currentRange);
  }

  return ranges;
}

/**
 * Match a commit's lines against pending AI edits
 */
async function matchCommit(
  repoRoot: string,
  sha: string
): Promise<MatchResult> {
  const hunks = await getCommitHunks(repoRoot, sha);
  const moves = await getCommitMoves(repoRoot, sha);
  const moveIndex = buildMoveIndex(moves);

  const lineAttributions: LineAttribution[] = [];
  const matchedEditIds = new Set<number>();
  let totalLines = 0;
  let unmatchedLines = 0;

  for (const hunk of hunks) {
    for (const line of hunk.lines) {
      // Skip empty lines (whitespace-only) from counting
      if (line.content.trim() === "") {
        continue;
      }

      totalLines++;

      // Use SQLite-based matching (O(log n) per lookup via index)
      let match = findLineMatch(
        line.content,
        line.hash,
        line.hashNormalized,
        hunk.path
      );

      // If no direct match, check for moved code
      if (!match) {
        const moveKey = `${hunk.path}:${line.lineNumber}`;
        const moveInfo = moveIndex.get(moveKey);

        if (moveInfo) {
          const originalMatch = findMatchForOriginalLocation(moveInfo.fromPath);

          if (originalMatch) {
            lineAttributions.push({
              path: hunk.path,
              line: line.lineNumber,
              provider: originalMatch.provider as "cursor" | "claudeCode",
              model: originalMatch.model,
              confidence: 0.85,
              matchType: "move_detected",
              contentHash: line.hash,
            });

            // Track for marking as matched
            if (originalMatch.editId) {
              matchedEditIds.add(originalMatch.editId);
            }
            continue;
          }
        }
      }

      if (match) {
        lineAttributions.push({
          path: hunk.path,
          line: line.lineNumber,
          provider: match.edit.provider,
          model: match.edit.model,
          confidence: match.confidence,
          matchType: match.matchType,
          contentHash: line.hash,
        });

        // Track edit ID for marking as matched
        if (match.edit.status !== "matched") {
          matchedEditIds.add(match.edit.id);
        }
      } else {
        unmatchedLines++;
      }
    }
  }

  // Mark all matched edits in a single transaction
  if (matchedEditIds.size > 0) {
    markEditsAsMatched(Array.from(matchedEditIds), sha);
  }

  const rangeAttributions = mergeConsecutiveLines(lineAttributions);

  return {
    sha,
    attributions: rangeAttributions,
    unmatchedLines,
    totalLines,
  };
}

/**
 * Process a commit - match and attach git note
 */
export async function processCommit(
  repoRoot: string,
  sha: string
): Promise<MatchResult> {
  const result = await matchCommit(repoRoot, sha);

  if (result.attributions.length > 0) {
    await attachNote(repoRoot, sha, result.attributions);
  }

  return result;
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
  const agentblameDir = getAgentBlameDirForRepo(repoRoot);
  setAgentBlameDir(agentblameDir);

  // Fetch remote notes first to avoid push conflicts
  await fetchNotesQuiet(repoRoot);

  // Always resolve to actual SHA (not HEAD)
  let commitSha = sha || "HEAD";
  const resolveResult = await runGit(repoRoot, ["rev-parse", commitSha]);
  if (resolveResult.exitCode !== 0) {
    console.error("Error: Could not resolve commit");
    process.exit(1);
  }
  commitSha = resolveResult.stdout.trim();

  const result = await processCommit(repoRoot, commitSha);

  // Calculate stats
  const aiLines = result.totalLines - result.unmatchedLines;
  const humanLines = result.unmatchedLines;
  const aiPercent = result.totalLines > 0 ? Math.round((aiLines / result.totalLines) * 100) : 0;
  const humanPercent = 100 - aiPercent;

  const WIDTH = 72;
  const INNER = WIDTH - 2; // Content width between │ borders (70 chars)
  const border = `${c.dim}│${c.reset}`;

  // Helper to create padded line
  const padRight = (content: string, visibleLen: number) =>
    content + " ".repeat(Math.max(0, INNER - visibleLen));

  // Print formatted output
  console.log("");
  console.log(`${c.dim}┌${"─".repeat(WIDTH - 2)}┐${c.reset}`);

  // Title - centered
  const title = "Agent Blame";
  const titlePadLeft = Math.floor((INNER - title.length) / 2);
  const titlePadRight = INNER - title.length - titlePadLeft;
  console.log(`${border}${" ".repeat(titlePadLeft)}${c.bold}${c.cyan}${title}${c.reset}${" ".repeat(titlePadRight)}${border}`);

  console.log(`${c.dim}├${"─".repeat(WIDTH - 2)}┤${c.reset}`);

  // Commit line
  const commitVisible = `  Commit: ${commitSha.slice(0, 8)}`;
  const commitColored = `  ${c.yellow}Commit: ${commitSha.slice(0, 8)}${c.reset}`;
  console.log(`${border}${padRight(commitColored, commitVisible.length)}${border}`);

  console.log(`${c.dim}├${"─".repeat(WIDTH - 2)}┤${c.reset}`);

  if (result.attributions.length > 0) {
    const aiHeader = "  AI-Generated Code:";
    console.log(`${border}${padRight(aiHeader, aiHeader.length)}${border}`);

    for (const attr of result.attributions) {
      const provider = attr.provider === "cursor" ? "Cursor" : "Claude";
      const model = attr.model && attr.model !== "claude" ? attr.model : "";
      const modelStr = model ? ` - ${model}` : "";
      const visibleText = `    ${attr.path}:${attr.startLine}-${attr.endLine} [${provider}${modelStr}]`;
      const coloredText = `    ${c.blue}${attr.path}:${attr.startLine}-${attr.endLine}${c.reset} ${c.orange}[${provider}${modelStr}]${c.reset}`;
      console.log(`${border}${padRight(coloredText, visibleText.length)}${border}`);
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

  const statsVisible = `  AI: ${String(aiLines).padStart(3)} lines (${String(aiPercent).padStart(3)}%)    Human: ${String(humanLines).padStart(3)} lines (${String(humanPercent).padStart(3)}%)`;
  const statsColored = `  ${c.orange}AI: ${String(aiLines).padStart(3)} lines (${String(aiPercent).padStart(3)}%)${c.reset}    ${c.green}Human: ${String(humanLines).padStart(3)} lines (${String(humanPercent).padStart(3)}%)${c.reset}`;
  console.log(`${border}${padRight(statsColored, statsVisible.length)}${border}`);

  console.log(`${c.dim}└${"─".repeat(WIDTH - 2)}┘${c.reset}`);
  console.log("");
}
