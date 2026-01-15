import * as crypto from "node:crypto";
import * as fs from "node:fs";
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
 * Find the .agentblame directory by walking up from a file path.
 * Returns null if not found (file is not in an initialized repo).
 */
export function findAgentBlameDir(filePath: string): string | null {
  let dir = path.dirname(filePath);

  while (dir !== path.dirname(dir)) {
    const agentblameDir = path.join(dir, ".agentblame");
    if (fs.existsSync(agentblameDir)) {
      return agentblameDir;
    }
    dir = path.dirname(dir);
  }

  return null;
}

/**
 * Get the agentblame directory for a specific repo root.
 * Used during init when we know the repo root.
 */
export function getAgentBlameDirForRepo(repoRoot: string): string {
  return path.join(repoRoot, ".agentblame");
}
