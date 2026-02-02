/**
 * Attribution Module v3
 *
 * Computes line attributions by replaying edit deltas.
 * At commit time, replays all deltas to determine which lines
 * were written by AI vs human, and links to specific prompts.
 *
 * Algorithm:
 * 1. Start with empty attributions (or git blame for existing lines)
 * 2. For each delta in chronological order:
 *    - Shift existing attributions based on insertions/deletions
 *    - Remove attributions for deleted lines
 *    - Add attributions for inserted lines
 * 3. Merge adjacent same-author ranges
 */

import type {
  EditDelta,
  DeltaHunk,
  LineAttribution,
  ComputedFileAttribution,
} from "./types";
import { readDeltasForFile } from "./delta";
import { getFileAtCommit } from "./storage";

// =============================================================================
// Delta Replay
// =============================================================================

/**
 * Apply a single delta to existing attributions
 * Returns updated attributions and new line count
 */
export function applyDelta(
  attributions: LineAttribution[],
  delta: EditDelta,
  lineCount: number
): { attributions: LineAttribution[]; lineCount: number } {
  // Sort hunks by oldStart in reverse order to process from bottom to top
  // This prevents line number shifts from affecting earlier hunks
  const sortedHunks = [...delta.hunks].sort((a, b) => b.oldStart - a.oldStart);

  let result = [...attributions];
  let newLineCount = lineCount;

  for (const hunk of sortedHunks) {
    const { oldStart, oldCount, newStart, newCount } = hunk;
    const shift = newCount - oldCount;

    // Update line count
    newLineCount += shift;

    // Process existing attributions
    const updated: LineAttribution[] = [];

    for (const attr of result) {
      // Case 1: Attribution is entirely before the hunk - unchanged
      if (attr.endLine < oldStart) {
        updated.push(attr);
        continue;
      }

      // Case 2: Attribution is entirely after the hunk - shift
      if (attr.startLine >= oldStart + oldCount) {
        updated.push({
          ...attr,
          startLine: attr.startLine + shift,
          endLine: attr.endLine + shift,
        });
        continue;
      }

      // Case 3: Attribution overlaps with deleted region
      // Split into before and after parts, removing the deleted portion

      // Part before deletion
      if (attr.startLine < oldStart) {
        updated.push({
          ...attr,
          endLine: oldStart - 1,
        });
      }

      // Part after deletion (shifted)
      if (attr.endLine >= oldStart + oldCount) {
        const newStartLine = newStart + newCount;
        const originalEndOffset = attr.endLine - (oldStart + oldCount - 1);
        updated.push({
          ...attr,
          startLine: newStartLine,
          endLine: newStartLine + originalEndOffset - 1,
        });
      }

      // The part that overlaps with deletion is removed (overwritten)
      // If this was an AI attribution being overwritten by human, track it
      if (delta.sessionId === null && attr.sessionId) {
        // Human overwrote AI - we could track this as 'overrode'
        // For now, we just remove the attribution
      }
    }

    // Add attribution for new lines (if any)
    if (newCount > 0 && delta.sessionId !== null) {
      updated.push({
        startLine: newStart,
        endLine: newStart + newCount - 1,
        sessionId: delta.sessionId,
        promptId: delta.promptId,
      });
    }

    result = updated;
  }

  return {
    attributions: mergeAttributions(result),
    lineCount: newLineCount,
  };
}

/**
 * Merge adjacent attributions with the same author
 */
export function mergeAttributions(attrs: LineAttribution[]): LineAttribution[] {
  if (attrs.length === 0) {
    return [];
  }

  // Sort by start line
  const sorted = [...attrs].sort((a, b) => a.startLine - b.startLine);

  const merged: LineAttribution[] = [];
  let current = { ...sorted[0] };

  for (let i = 1; i < sorted.length; i++) {
    const next = sorted[i];

    // Check if can merge: same session, same prompt, adjacent or overlapping
    if (
      current.sessionId === next.sessionId &&
      current.promptId === next.promptId &&
      next.startLine <= current.endLine + 1
    ) {
      // Merge: extend current to include next
      current.endLine = Math.max(current.endLine, next.endLine);
    } else {
      // Can't merge: push current and start new
      merged.push(current);
      current = { ...next };
    }
  }

  // Push last one
  merged.push(current);

  // Filter out invalid ranges
  return merged.filter((attr) => attr.startLine <= attr.endLine);
}

// =============================================================================
// Full Attribution Computation
// =============================================================================

/**
 * Compute final attributions for a file by replaying all deltas
 */
export async function computeFileAttributions(
  repoRoot: string,
  baseSha: string,
  filePath: string
): Promise<ComputedFileAttribution> {
  // Load deltas for this file
  const deltas = readDeltasForFile(repoRoot, baseSha, filePath);

  if (deltas.length === 0) {
    return { aiRanges: [], humanRanges: [] };
  }

  if (process.env.AGENTBLAME_DEBUG) {
    console.error(`[agentblame] computeFileAttributions: ${filePath}`);
    console.error(`[agentblame]   deltas: ${deltas.length}`);
    for (const d of deltas) {
      const sid = d.sessionId?.slice(0,8) || 'HUMAN';
      console.error(`[agentblame]     ${sid}: L${d.hunks[0]?.newStart}+${d.hunks[0]?.newCount}`);
    }
  }

  // Get initial line count from the file at baseSha
  const initialContent = await getFileAtCommit(repoRoot, baseSha, filePath);
  let lineCount = initialContent ? initialContent.split("\n").length : 0;

  // Replay deltas in chronological order
  let attributions: LineAttribution[] = [];

  for (const delta of deltas) {
    const result = applyDelta(attributions, delta, lineCount);
    attributions = result.attributions;
    lineCount = result.lineCount;

    if (process.env.AGENTBLAME_DEBUG) {
      const sid = delta.sessionId?.slice(0,8) || 'HUMAN';
      console.error(`[agentblame]   after ${sid}: attrs=${attributions.map(a => `${a.sessionId?.slice(0,8)}:L${a.startLine}-${a.endLine}`).join(', ')}`);
    }
  }

  // Separate AI vs human ranges
  const aiRanges = attributions.filter((attr) => attr.sessionId !== null);

  if (process.env.AGENTBLAME_DEBUG) {
    console.error(`[agentblame]   final aiRanges: ${aiRanges.map(a => `${a.sessionId?.slice(0,8)}:L${a.startLine}-${a.endLine}`).join(', ')}`);
  }

  // Compute human ranges as gaps in AI ranges
  const humanRanges = computeHumanRanges(aiRanges, lineCount);

  return { aiRanges, humanRanges };
}

/**
 * Compute human ranges as gaps between AI ranges
 */
function computeHumanRanges(
  aiRanges: LineAttribution[],
  totalLines: number
): Array<{ startLine: number; endLine: number }> {
  if (totalLines === 0) {
    return [];
  }

  // Sort AI ranges
  const sorted = [...aiRanges].sort((a, b) => a.startLine - b.startLine);

  const humanRanges: Array<{ startLine: number; endLine: number }> = [];
  let currentLine = 1;

  for (const range of sorted) {
    // Gap before this AI range
    if (range.startLine > currentLine) {
      humanRanges.push({
        startLine: currentLine,
        endLine: range.startLine - 1,
      });
    }
    currentLine = Math.max(currentLine, range.endLine + 1);
  }

  // Gap after last AI range
  if (currentLine <= totalLines) {
    humanRanges.push({
      startLine: currentLine,
      endLine: totalLines,
    });
  }

  return humanRanges;
}

/**
 * Compute attributions for multiple files
 */
export async function computeAttributionsForFiles(
  repoRoot: string,
  baseSha: string,
  files: string[]
): Promise<Record<string, ComputedFileAttribution>> {
  const result: Record<string, ComputedFileAttribution> = {};

  // Process files in parallel for performance
  const promises = files.map(async (file) => {
    const attribution = await computeFileAttributions(repoRoot, baseSha, file);
    return { file, attribution };
  });

  const results = await Promise.all(promises);

  for (const { file, attribution } of results) {
    result[file] = attribution;
  }

  return result;
}

// =============================================================================
// Statistics
// =============================================================================

/**
 * Count total AI lines from attributions
 */
export function countAILines(attribution: ComputedFileAttribution): number {
  let count = 0;
  for (const range of attribution.aiRanges) {
    count += range.endLine - range.startLine + 1;
  }
  return count;
}

/**
 * Count total human lines from attributions
 */
export function countHumanLines(attribution: ComputedFileAttribution): number {
  let count = 0;
  for (const range of attribution.humanRanges) {
    count += range.endLine - range.startLine + 1;
  }
  return count;
}

/**
 * Get attribution summary for a file
 */
export function getAttributionSummary(attribution: ComputedFileAttribution): {
  totalLines: number;
  aiLines: number;
  humanLines: number;
  aiPercent: number;
  sessionCount: number;
} {
  const aiLines = countAILines(attribution);
  const humanLines = countHumanLines(attribution);
  const totalLines = aiLines + humanLines;

  const sessions = new Set<string>();
  for (const range of attribution.aiRanges) {
    sessions.add(range.sessionId);
  }

  return {
    totalLines,
    aiLines,
    humanLines,
    aiPercent: totalLines > 0 ? Math.round((aiLines / totalLines) * 100) : 0,
    sessionCount: sessions.size,
  };
}
