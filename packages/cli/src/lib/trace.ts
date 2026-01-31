/**
 * Line Tracing Module v3
 *
 * Context-aware line tracing algorithm for attributing lines in committed code
 * to their original AI session. Walks backwards through snapshot chain to find
 * where each line was introduced.
 *
 * Key features:
 * - Context-aware matching (uses prev/next lines to disambiguate)
 * - Handles common collisions like `}`, `{`, empty lines
 * - Similarity-based fallback for fuzzy context matching
 */

import type { Snapshot, LineOrigin, LineContext } from "./types";
import { loadSnapshot, loadSnapshotsBatch } from "./storage";

// =============================================================================
// String Utilities (needed early for indexing)
// =============================================================================

/**
 * Normalize whitespace in a string
 */
function normalizeWhitespace(s: string): string {
  return s.replace(/\s+/g, " ").trim();
}

/**
 * Normalize line endings (CRLF -> LF) and split into lines
 */
export function splitLines(content: string): string[] {
  return content.replace(/\r\n/g, "\n").replace(/\r/g, "\n").split("\n");
}

// =============================================================================
// Line Index for O(1) Lookups
// =============================================================================

/**
 * Pre-built index for fast line lookups
 * Maps line content -> array of indices where that content appears
 */
type LineIndex = Map<string, number[]>;

/**
 * Build a line index for a snapshot's content
 */
function buildLineIndex(lines: string[]): LineIndex {
  const index: LineIndex = new Map();
  for (let i = 0; i < lines.length; i++) {
    const content = lines[i];
    if (!index.has(content)) {
      index.set(content, []);
    }
    index.get(content)!.push(i);
  }
  return index;
}

/**
 * Build a normalized line index (whitespace-normalized)
 */
function buildNormalizedLineIndex(lines: string[]): LineIndex {
  const index: LineIndex = new Map();
  for (let i = 0; i < lines.length; i++) {
    const normalized = normalizeWhitespace(lines[i]);
    if (!index.has(normalized)) {
      index.set(normalized, []);
    }
    index.get(normalized)!.push(i);
  }
  return index;
}

// =============================================================================
// Main Line Tracing
// =============================================================================

/**
 * Trace a line's origin through the snapshot chain
 * Returns the session that introduced the line, or null if it existed before AI edits
 *
 * @param repoRoot - Repository root path
 * @param lineContent - The line content to trace
 * @param context - Surrounding lines for disambiguation
 * @param chain - Snapshot chain (oldest first)
 */
export async function traceLineOrigin(
  repoRoot: string,
  lineContent: string,
  context: LineContext,
  chain: Snapshot[]
): Promise<LineOrigin> {
  if (chain.length === 0) {
    // No AI edits tracked for this file
    return { sessionId: null, confidence: 1.0 };
  }

  // Walk backwards through snapshots (newest first)
  for (let i = chain.length - 1; i >= 0; i--) {
    const snapshot = chain[i];
    const snapshotContent = await loadSnapshot(repoRoot, snapshot.blobSha);
    const snapshotLines = splitLines(snapshotContent);

    const match = findLineWithContext(lineContent, context, snapshotLines);

    if (match === null) {
      // Line doesn't exist in this snapshot
      // It was introduced in the NEXT snapshot (newer)
      const introducer = chain[i + 1];
      return {
        sessionId: introducer?.sessionId || null,
        confidence: 1.0,
      };
    }

    // Update context for next iteration (earlier snapshot)
    context = {
      prev: snapshotLines[match.index - 1],
      next: snapshotLines[match.index + 1],
    };
  }

  // Line existed before any AI edits (original git state)
  return { sessionId: null, confidence: 1.0 };
}

/**
 * Snapshot data with pre-built indexes for fast lookups
 */
interface IndexedSnapshot {
  lines: string[];
  exactIndex: LineIndex;
  normalizedIndex: LineIndex;
  sessionId: string | null;
}

/**
 * Batch trace multiple lines from the same file
 * Uses pre-built indexes for O(1) line lookups instead of O(n) scans
 */
export async function traceFileLines(
  repoRoot: string,
  lines: string[],
  chain: Snapshot[]
): Promise<LineOrigin[]> {
  if (chain.length === 0) {
    // No AI edits tracked - all lines are human/original
    return lines.map(() => ({ sessionId: null, confidence: 1.0 }));
  }

  // Batch load all snapshots at once
  const blobShas = chain.map((s) => s.blobSha);
  const contents = await loadSnapshotsBatch(repoRoot, blobShas);

  // Build indexed snapshots with pre-computed lookup tables
  const indexedSnapshots: IndexedSnapshot[] = chain.map((snapshot) => {
    const content = contents.get(snapshot.blobSha) || "";
    const snapshotLines = splitLines(content);
    return {
      lines: snapshotLines,
      exactIndex: buildLineIndex(snapshotLines),
      normalizedIndex: buildNormalizedLineIndex(snapshotLines),
      sessionId: snapshot.sessionId,
    };
  });

  const results: LineOrigin[] = [];

  for (let lineIdx = 0; lineIdx < lines.length; lineIdx++) {
    const lineContent = lines[lineIdx];
    let context: LineContext = {
      prev: lines[lineIdx - 1],
      next: lines[lineIdx + 1],
    };

    let origin: LineOrigin = { sessionId: null, confidence: 1.0 };

    // Walk backwards through snapshots
    let foundIntroducer = false;
    for (let i = chain.length - 1; i >= 0; i--) {
      const snapshot = indexedSnapshots[i];
      const match = findLineWithContextIndexed(
        lineContent,
        context,
        snapshot.lines,
        snapshot.exactIndex,
        snapshot.normalizedIndex
      );

      if (match === null) {
        // Line was introduced in the NEXT snapshot
        const introducer = chain[i + 1];
        origin = {
          sessionId: introducer?.sessionId || null,
          confidence: 1.0,
        };
        foundIntroducer = true;
        break;
      }

      // Update context for next iteration
      context = {
        prev: snapshot.lines[match.index - 1],
        next: snapshot.lines[match.index + 1],
      };
    }

    // If line existed in all snapshots and chain[0] is not the original (new file),
    // attribute to the first AI snapshot that created the file
    if (!foundIntroducer && chain[0].sessionId !== null) {
      origin = {
        sessionId: chain[0].sessionId,
        confidence: 1.0,
      };
    }

    results.push(origin);
  }

  return results;
}

// =============================================================================
// Line Matching with Context
// =============================================================================

interface LineMatch {
  index: number;
  confidence: number;
}

/**
 * Find a line in the snapshot using context for disambiguation
 * Uses pre-built indexes for O(1) lookups
 */
export function findLineWithContextIndexed(
  target: string,
  context: LineContext,
  lines: string[],
  exactIndex: LineIndex,
  normalizedIndex: LineIndex
): LineMatch | null {
  // O(1) lookup using index
  const matches = exactIndex.get(target) || [];

  if (matches.length === 0) {
    // Try normalized match using normalized index
    const normalizedTarget = normalizeWhitespace(target);
    const normMatches = normalizedIndex.get(normalizedTarget) || [];

    if (normMatches.length === 1) {
      return { index: normMatches[0], confidence: 0.95 };
    }

    if (normMatches.length > 1) {
      // Multiple normalized matches - use context
      const contextMatch = findBestContextMatch(normMatches, context, lines);
      if (contextMatch !== null) {
        return { index: contextMatch, confidence: 0.9 };
      }
    }

    return null;
  }

  if (matches.length === 1) {
    return { index: matches[0], confidence: 1.0 };
  }

  // Multiple matches (e.g., `}`, empty lines) - use context
  const contextMatch = findBestContextMatch(matches, context, lines);
  if (contextMatch !== null) {
    return { index: contextMatch, confidence: 1.0 };
  }

  // Fuzzy context matching as fallback
  const fuzzyMatch = findFuzzyContextMatch(matches, context, lines);
  if (fuzzyMatch !== null) {
    return { index: fuzzyMatch.index, confidence: fuzzyMatch.confidence };
  }

  // Can't disambiguate - assume first match
  return { index: matches[0], confidence: 0.5 };
}

/**
 * Find a line in the snapshot using context for disambiguation
 * Legacy version without index (for single-use cases)
 */
export function findLineWithContext(
  target: string,
  context: LineContext,
  lines: string[]
): LineMatch | null {
  // Find all exact matches
  const matches = findExactMatches(target, lines);

  if (matches.length === 0) {
    // Try normalized match (whitespace-only differences)
    const normMatches = findNormalizedMatches(target, lines);

    if (normMatches.length === 1) {
      return { index: normMatches[0], confidence: 0.95 };
    }

    if (normMatches.length > 1) {
      // Multiple normalized matches - use context
      const contextMatch = findBestContextMatch(normMatches, context, lines);
      if (contextMatch !== null) {
        return { index: contextMatch, confidence: 0.9 };
      }
    }

    return null;
  }

  if (matches.length === 1) {
    return { index: matches[0], confidence: 1.0 };
  }

  // Multiple matches (e.g., `}`, empty lines) - use context
  const contextMatch = findBestContextMatch(matches, context, lines);
  if (contextMatch !== null) {
    return { index: contextMatch, confidence: 1.0 };
  }

  // Fuzzy context matching as fallback
  const fuzzyMatch = findFuzzyContextMatch(matches, context, lines);
  if (fuzzyMatch !== null) {
    return { index: fuzzyMatch.index, confidence: fuzzyMatch.confidence };
  }

  // Can't disambiguate - assume first match
  return { index: matches[0], confidence: 0.5 };
}

/**
 * Find all indices where line exactly matches
 */
function findExactMatches(target: string, lines: string[]): number[] {
  const matches: number[] = [];
  for (let i = 0; i < lines.length; i++) {
    if (lines[i] === target) {
      matches.push(i);
    }
  }
  return matches;
}

/**
 * Find all indices where normalized line matches
 */
function findNormalizedMatches(target: string, lines: string[]): number[] {
  const normalizedTarget = normalizeWhitespace(target);
  const matches: number[] = [];

  for (let i = 0; i < lines.length; i++) {
    if (normalizeWhitespace(lines[i]) === normalizedTarget) {
      matches.push(i);
    }
  }

  return matches;
}

/**
 * Find best match using exact context comparison
 */
function findBestContextMatch(
  candidates: number[],
  context: LineContext,
  lines: string[]
): number | null {
  for (const idx of candidates) {
    const prevMatch = !context.prev || lines[idx - 1] === context.prev;
    const nextMatch = !context.next || lines[idx + 1] === context.next;

    if (prevMatch && nextMatch) {
      return idx;
    }
  }

  // Try with just one context line matching
  for (const idx of candidates) {
    const prevMatch = !context.prev || lines[idx - 1] === context.prev;
    const nextMatch = !context.next || lines[idx + 1] === context.next;

    if (prevMatch || nextMatch) {
      return idx;
    }
  }

  return null;
}

/**
 * Find best match using fuzzy context similarity
 */
function findFuzzyContextMatch(
  candidates: number[],
  context: LineContext,
  lines: string[]
): { index: number; confidence: number } | null {
  let best: { index: number; score: number } | null = null;

  for (const idx of candidates) {
    let score = 0;
    let maxScore = 0;

    if (context.prev !== undefined) {
      score += similarity(lines[idx - 1] || "", context.prev);
      maxScore += 1;
    }

    if (context.next !== undefined) {
      score += similarity(lines[idx + 1] || "", context.next);
      maxScore += 1;
    }

    const normalizedScore = maxScore > 0 ? score / maxScore : 0;

    if (!best || normalizedScore > best.score) {
      best = { index: idx, score: normalizedScore };
    }
  }

  if (best && best.score > 0.5) {
    // Map score to confidence (0.5-1.0 score -> 0.7-0.9 confidence)
    const confidence = 0.7 + best.score * 0.2;
    return { index: best.index, confidence };
  }

  return null;
}

// =============================================================================
// String Similarity
// =============================================================================

/**
 * Compute similarity between two strings (0-1)
 * Uses a combination of normalized edit distance and token overlap
 */
export function similarity(a: string, b: string): number {
  if (a === b) return 1.0;
  if (!a || !b) return 0.0;

  // Normalize whitespace for comparison
  const normA = normalizeWhitespace(a);
  const normB = normalizeWhitespace(b);

  if (normA === normB) return 0.95;

  // Token-based similarity
  const tokensA = tokenize(normA);
  const tokensB = tokenize(normB);

  if (tokensA.length === 0 && tokensB.length === 0) return 1.0;
  if (tokensA.length === 0 || tokensB.length === 0) return 0.0;

  // Jaccard similarity on tokens
  const setA = new Set(tokensA);
  const setB = new Set(tokensB);

  let intersection = 0;
  for (const token of setA) {
    if (setB.has(token)) intersection++;
  }

  const union = setA.size + setB.size - intersection;
  return union > 0 ? intersection / union : 0;
}

/**
 * Tokenize a string into words/identifiers
 */
function tokenize(s: string): string[] {
  // Split on non-alphanumeric characters
  return s
    .split(/[^a-zA-Z0-9_]+/)
    .filter((t) => t.length > 0)
    .map((t) => t.toLowerCase());
}

// =============================================================================
// Attribution Aggregation
// =============================================================================

/**
 * Aggregate line-level attributions into ranges
 */
export function aggregateToRanges(
  attributions: Array<{ line: number; sessionId: string | null; promptId?: number | null }>
): Array<{ startLine: number; endLine: number; sessionId: string | null; promptId?: number | null }> {
  if (attributions.length === 0) return [];

  // Sort by line number
  const sorted = [...attributions].sort((a, b) => a.line - b.line);

  const ranges: Array<{
    startLine: number;
    endLine: number;
    sessionId: string | null;
    promptId?: number | null;
  }> = [];
  let current = {
    startLine: sorted[0].line,
    endLine: sorted[0].line,
    sessionId: sorted[0].sessionId,
    promptId: sorted[0].promptId,
  };

  for (let i = 1; i < sorted.length; i++) {
    const attr = sorted[i];

    // Merge if consecutive and same session AND same prompt
    if (
      attr.line === current.endLine + 1 &&
      attr.sessionId === current.sessionId &&
      attr.promptId === current.promptId
    ) {
      current.endLine = attr.line;
    } else {
      ranges.push(current);
      current = {
        startLine: attr.line,
        endLine: attr.line,
        sessionId: attr.sessionId,
        promptId: attr.promptId,
      };
    }
  }

  ranges.push(current);
  return ranges;
}

/**
 * Separate AI and human ranges
 */
export function separateRanges(
  ranges: Array<{ startLine: number; endLine: number; sessionId: string | null; promptId?: number | null }>
): {
  aiRanges: Array<{
    startLine: number;
    endLine: number;
    sessionId: string;
    promptId?: number | null;
  }>;
  humanRanges: Array<{ startLine: number; endLine: number }>;
} {
  const aiRanges: Array<{
    startLine: number;
    endLine: number;
    sessionId: string;
    promptId?: number | null;
  }> = [];
  const humanRanges: Array<{ startLine: number; endLine: number }> = [];

  for (const range of ranges) {
    if (range.sessionId) {
      aiRanges.push({
        startLine: range.startLine,
        endLine: range.endLine,
        sessionId: range.sessionId,
        promptId: range.promptId,
      });
    } else {
      humanRanges.push({
        startLine: range.startLine,
        endLine: range.endLine,
      });
    }
  }

  return { aiRanges, humanRanges };
}

/**
 * Format ranges as compact string (e.g., "10-45,60-75")
 */
export function formatRanges(
  ranges: Array<{ startLine: number; endLine: number }>
): string {
  return ranges
    .map((r) =>
      r.startLine === r.endLine ? `${r.startLine}` : `${r.startLine}-${r.endLine}`
    )
    .join(",");
}

/**
 * Parse ranges from compact string
 */
export function parseRanges(
  str: string
): Array<{ startLine: number; endLine: number }> {
  if (!str) return [];

  return str.split(",").map((part) => {
    const [start, end] = part.split("-").map((n) => parseInt(n, 10));
    return {
      startLine: start,
      endLine: end ?? start,
    };
  });
}

// =============================================================================
// Session Attribution Map
// =============================================================================

/**
 * Build a map of sessionId -> files -> lines from traced results
 */
export function buildSessionMap(
  fileAttributions: Map<string, Array<{ line: number; sessionId: string | null }>>
): Map<string, Map<string, number[]>> {
  const sessionMap = new Map<string, Map<string, number[]>>();

  for (const [filePath, attributions] of fileAttributions) {
    for (const { line, sessionId } of attributions) {
      if (!sessionId) continue;

      if (!sessionMap.has(sessionId)) {
        sessionMap.set(sessionId, new Map());
      }

      const fileMap = sessionMap.get(sessionId)!;
      if (!fileMap.has(filePath)) {
        fileMap.set(filePath, []);
      }

      fileMap.get(filePath)!.push(line);
    }
  }

  return sessionMap;
}

/**
 * Build human ranges map from traced results
 */
export function buildHumanMap(
  fileAttributions: Map<string, Array<{ line: number; sessionId: string | null }>>
): Map<string, number[]> {
  const humanMap = new Map<string, number[]>();

  for (const [filePath, attributions] of fileAttributions) {
    const humanLines: number[] = [];

    for (const { line, sessionId } of attributions) {
      if (!sessionId) {
        humanLines.push(line);
      }
    }

    if (humanLines.length > 0) {
      humanMap.set(filePath, humanLines);
    }
  }

  return humanMap;
}
