import * as crypto from "node:crypto";
import * as path from "node:path";

/**
 * Get the dist directory (where compiled .js files are)
 * Always resolves to the dist/ directory relative to the current file.
 * @param dirname - Pass __dirname from the calling module
 */
export function getDistDir(dirname: string): string {
  // Find the dist/ directory in the path
  const parts = dirname.split(path.sep);
  const distIndex = parts.lastIndexOf("dist");
  if (distIndex !== -1) {
    // Already in dist/, return the dist root
    return parts.slice(0, distIndex + 1).join(path.sep);
  }
  // Fallback: assume we're in src/ during development, point to sibling dist/
  return path.resolve(dirname, "..", "dist");
}

/**
 * Compute SHA256 hash of content
 */
export function computeContentHash(content: string): string {
  return `sha256:${crypto.createHash("sha256").update(content).digest("hex")}`;
}

/**
 * Compute normalized hash (whitespace-stripped) for formatter tolerance
 */
export function computeNormalizedHash(content: string): string {
  const normalized = content.replace(/\s+/g, "");
  return `sha256:${crypto.createHash("sha256").update(normalized).digest("hex")}`;
}

/**
 * Normalize model name by stripping date/version suffixes.
 * Uses generic patterns - no model-specific logic, so new models work automatically.
 *
 * Strips:
 * - Trailing 3+ digit version numbers: -001, -0613, -20241022
 * - Trailing YYYY-MM-DD dates: -2024-04-09
 * - Mid-string date codes before suffixes: -1106-preview → -preview
 */
export function normalizeModelName(model: string | null): string | null {
  if (!model) return null;

  return model
    // -YYYY-MM-DD at end (e.g., -2024-04-09)
    .replace(/-\d{4}-\d{2}-\d{2}$/, "")
    // -NNNN-suffix where NNNN is 4 digits (e.g., -1106-preview → -preview)
    .replace(/-\d{4}(-[a-z]+)$/i, "$1")
    // -NNN or -NNNN or -NNNNNNNN at end (3-8 digits)
    .replace(/-\d{3,8}$/, "");
}
