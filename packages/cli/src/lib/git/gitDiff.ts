/**
 * Git Diff Parser
 *
 * Parse git diffs to extract added/deleted content for attribution matching.
 * Includes line-level hashing and move detection.
 */

import { runGit } from "./gitCli";
import { computeContentHash, computeNormalizedHash } from "../util";
import type { DiffHunk, DeletedBlock, MoveMapping } from "../types";

// =============================================================================
// Commit Diff
// =============================================================================

/**
 * Get the diff for a specific commit (compared to its parent)
 */
export async function getCommitDiff(
  repoRoot: string,
  sha: string
): Promise<string> {
  const result = await runGit(repoRoot, [
    "diff",
    `${sha}^`,
    sha,
    "--unified=0",
  ]);

  if (result.exitCode !== 0) {
    // First commit has no parent, try diffing against empty tree
    const emptyTree = await runGit(repoRoot, [
      "diff",
      "4b825dc642cb6eb9a060e54bf8d69288fbee4904", // empty tree hash
      sha,
      "--unified=0",
    ]);
    return emptyTree.stdout;
  }

  return result.stdout;
}

/**
 * Get full diff including both additions and deletions (for move detection)
 */
export async function getFullCommitDiff(
  repoRoot: string,
  sha: string
): Promise<string> {
  const result = await runGit(repoRoot, [
    "diff",
    `${sha}^`,
    sha,
    "--unified=3", // Include context for better move detection
  ]);

  if (result.exitCode !== 0) {
    const emptyTree = await runGit(repoRoot, [
      "diff",
      "4b825dc642cb6eb9a060e54bf8d69288fbee4904",
      sha,
      "--unified=3",
    ]);
    return emptyTree.stdout;
  }

  return result.stdout;
}

// =============================================================================
// Diff Parsing
// =============================================================================

/**
 * Parse a unified diff to extract added hunks with line-level data
 */
export function parseDiff(diffOutput: string): DiffHunk[] {
  const hunks: DiffHunk[] = [];
  const diffLines = diffOutput.split("\n");

  let currentPath: string | null = null;
  let hunkStartLine = 0;
  let currentLineNum = 0;
  let hunkLines: Array<{
    line_number: number;
    content: string;
    hash: string;
    hash_normalized: string;
  }> = [];

  for (const line of diffLines) {
    // New file header: +++ b/path/to/file
    if (line.startsWith("+++ b/")) {
      // Save previous hunk if exists
      if (currentPath && hunkLines.length > 0) {
        const content = hunkLines.map((l) => l.content).join("\n");
        hunks.push({
          path: currentPath,
          start_line: hunkStartLine,
          end_line: hunkStartLine + hunkLines.length - 1,
          content,
          content_hash: computeContentHash(content),
          content_hash_normalized: computeNormalizedHash(content),
          lines: hunkLines,
        });
        hunkLines = [];
      }
      currentPath = line.slice(6); // Remove "+++ b/"
      continue;
    }

    // Hunk header: @@ -old,count +new,count @@
    if (line.startsWith("@@")) {
      // Save previous hunk if exists
      if (currentPath && hunkLines.length > 0) {
        const content = hunkLines.map((l) => l.content).join("\n");
        hunks.push({
          path: currentPath,
          start_line: hunkStartLine,
          end_line: hunkStartLine + hunkLines.length - 1,
          content,
          content_hash: computeContentHash(content),
          content_hash_normalized: computeNormalizedHash(content),
          lines: hunkLines,
        });
        hunkLines = [];
      }

      // Parse new file line number: @@ -X,Y +Z,W @@
      const match = line.match(/@@ [^+]+ \+(\d+)/);
      if (match) {
        hunkStartLine = parseInt(match[1], 10);
        currentLineNum = hunkStartLine;
      }
      continue;
    }

    // Added line (starts with +, but not +++ header)
    if (line.startsWith("+") && !line.startsWith("+++")) {
      const content = line.slice(1); // Remove leading +
      hunkLines.push({
        line_number: currentLineNum,
        content,
        hash: computeContentHash(content),
        hash_normalized: computeNormalizedHash(content),
      });
      currentLineNum++;
    } else if (!line.startsWith("-") && !line.startsWith("\\")) {
      // Context line - just increment line number
      currentLineNum++;
    }
  }

  // Save final hunk
  if (currentPath && hunkLines.length > 0) {
    const content = hunkLines.map((l) => l.content).join("\n");
    hunks.push({
      path: currentPath,
      start_line: hunkStartLine,
      end_line: hunkStartLine + hunkLines.length - 1,
      content,
      content_hash: computeContentHash(content),
      content_hash_normalized: computeNormalizedHash(content),
      lines: hunkLines,
    });
  }

  return hunks;
}

/**
 * Parse deleted blocks from a diff (for move detection)
 */
export function parseDeletedBlocks(diffOutput: string): DeletedBlock[] {
  const blocks: DeletedBlock[] = [];
  const diffLines = diffOutput.split("\n");

  let currentPath: string | null = null;
  let deletedLines: string[] = [];
  let deleteStartLine = 0;
  let currentOldLine = 0;

  for (const line of diffLines) {
    // File header: --- a/path/to/file
    if (line.startsWith("--- a/")) {
      // Save previous block if exists
      if (currentPath && deletedLines.length >= 3) {
        blocks.push({
          path: currentPath,
          start_line: deleteStartLine,
          lines: deletedLines,
          normalized_content: deletedLines.map((l) => l.trim()).join("\n"),
        });
      }
      currentPath = line.slice(6);
      deletedLines = [];
      continue;
    }

    // Hunk header
    if (line.startsWith("@@")) {
      // Save previous block if exists
      if (currentPath && deletedLines.length >= 3) {
        blocks.push({
          path: currentPath,
          start_line: deleteStartLine,
          lines: deletedLines,
          normalized_content: deletedLines.map((l) => l.trim()).join("\n"),
        });
      }
      deletedLines = [];

      // Parse old file line number: @@ -X,Y +Z,W @@
      const match = line.match(/@@ -(\d+)/);
      if (match) {
        currentOldLine = parseInt(match[1], 10);
        deleteStartLine = currentOldLine;
      }
      continue;
    }

    // Deleted line
    if (line.startsWith("-") && !line.startsWith("---")) {
      if (deletedLines.length === 0) {
        deleteStartLine = currentOldLine;
      }
      deletedLines.push(line.slice(1));
      currentOldLine++;
    } else if (line.startsWith("+") && !line.startsWith("+++")) {
      // Addition breaks the deletion block
      if (currentPath && deletedLines.length >= 3) {
        blocks.push({
          path: currentPath,
          start_line: deleteStartLine,
          lines: deletedLines,
          normalized_content: deletedLines.map((l) => l.trim()).join("\n"),
        });
      }
      deletedLines = [];
    } else if (!line.startsWith("\\")) {
      // Context line breaks deletion block
      if (currentPath && deletedLines.length >= 3) {
        blocks.push({
          path: currentPath,
          start_line: deleteStartLine,
          lines: deletedLines,
          normalized_content: deletedLines.map((l) => l.trim()).join("\n"),
        });
      }
      deletedLines = [];
      currentOldLine++;
    }
  }

  // Save final block
  if (currentPath && deletedLines.length >= 3) {
    blocks.push({
      path: currentPath,
      start_line: deleteStartLine,
      lines: deletedLines,
      normalized_content: deletedLines.map((l) => l.trim()).join("\n"),
    });
  }

  return blocks;
}

// =============================================================================
// Move Detection
// =============================================================================

const MOVE_THRESHOLD = 3; // Minimum lines for move detection

/**
 * Detect moved code blocks between deletions and additions
 */
export function detectMoves(
  deletedBlocks: DeletedBlock[],
  addedHunks: DiffHunk[]
): MoveMapping[] {
  const moves: MoveMapping[] = [];

  for (const deleted of deletedBlocks) {
    if (deleted.lines.length < MOVE_THRESHOLD) continue;

    for (const added of addedHunks) {
      if (added.lines.length < MOVE_THRESHOLD) continue;

      // Check for matching normalized content
      const addedNormalized = added.lines.map((l) => l.content.trim()).join("\n");

      if (deleted.normalized_content === addedNormalized) {
        moves.push({
          from_path: deleted.path,
          from_start_line: deleted.start_line,
          to_path: added.path,
          to_start_line: added.start_line,
          line_count: deleted.lines.length,
          normalized_content: deleted.normalized_content,
        });
        break; // Only match once
      }

      // Check for partial moves (deleted content is subset of added)
      if (
        addedNormalized.includes(deleted.normalized_content) &&
        deleted.lines.length >= MOVE_THRESHOLD
      ) {
        // Find where in the added hunk the deleted content starts
        const normalizedLines = deleted.lines.map((l) => l.trim());
        let matchStartIdx = -1;

        for (let i = 0; i <= added.lines.length - deleted.lines.length; i++) {
          let matches = true;
          for (let j = 0; j < deleted.lines.length; j++) {
            if (added.lines[i + j].content.trim() !== normalizedLines[j]) {
              matches = false;
              break;
            }
          }
          if (matches) {
            matchStartIdx = i;
            break;
          }
        }

        if (matchStartIdx >= 0) {
          moves.push({
            from_path: deleted.path,
            from_start_line: deleted.start_line,
            to_path: added.path,
            to_start_line: added.start_line + matchStartIdx,
            line_count: deleted.lines.length,
            normalized_content: deleted.normalized_content,
          });
          break;
        }
      }
    }
  }

  return moves;
}

/**
 * Build a line-level move index for quick lookup
 */
export function buildMoveIndex(
  moves: MoveMapping[]
): Map<string, { fromPath: string; fromLine: number }> {
  const index = new Map<string, { fromPath: string; fromLine: number }>();

  for (const move of moves) {
    for (let i = 0; i < move.line_count; i++) {
      // Key: normalized content of each line
      const lineContent = move.normalized_content.split("\n")[i];
      if (lineContent) {
        const key = `${move.to_path}:${move.to_start_line + i}`;
        index.set(key, {
          fromPath: move.from_path,
          fromLine: move.from_start_line + i,
        });
      }
    }
  }

  return index;
}

// =============================================================================
// Main Entry Points
// =============================================================================

/**
 * Get parsed diff hunks for a commit with line-level data
 */
export async function getCommitHunks(
  repoRoot: string,
  sha: string
): Promise<DiffHunk[]> {
  const diffOutput = await getCommitDiff(repoRoot, sha);
  return parseDiff(diffOutput);
}

/**
 * Get move mappings for a commit
 */
export async function getCommitMoves(
  repoRoot: string,
  sha: string
): Promise<MoveMapping[]> {
  const diffOutput = await getFullCommitDiff(repoRoot, sha);
  const deletedBlocks = parseDeletedBlocks(diffOutput);
  const addedHunks = parseDiff(diffOutput);
  return detectMoves(deletedBlocks, addedHunks);
}
