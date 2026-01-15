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
 * Get the agentblame directory path (~/.agentblame)
 */
export function getAgentBlameDir(): string {
  const home = process.env.HOME || process.env.USERPROFILE || "";
  return `${home}/.agentblame`;
}
