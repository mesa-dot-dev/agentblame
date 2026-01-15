/**
 * Diff utilities for extracting changes between old and new content
 */

import { diffLines } from "diff";

/**
 * Extract only the added lines from a diff between old and new text.
 * This gives us exactly what the AI wrote, not the entire file.
 */
export function extractAddedContent(oldText: string, newText: string): string {
  const parts = diffLines(oldText ?? "", newText ?? "");
  const addedParts: string[] = [];

  for (const part of parts) {
    if (part.added) {
      addedParts.push(part.value ?? "");
    }
  }

  return addedParts.join("");
}

/**
 * Check if two pieces of content are substantially the same
 * (ignoring whitespace differences)
 */
export function contentMatches(a: string, b: string): boolean {
  const normalizeA = a.replace(/\s+/g, " ").trim();
  const normalizeB = b.replace(/\s+/g, " ").trim();
  return normalizeA === normalizeB;
}
