/**
 * GitHub API client for fetching git notes
 */

import type {
  GitNotesAttribution,
  GitNotesAttributionV2,
  SessionMetadata,
  FileAttribution,
} from "../types";
import { MIN_SUPPORTED_VERSION } from "../types";

const API_BASE = "https://api.github.com";

// Result type that includes version warning
export interface NotesResult {
  notes: Map<string, GitNotesAttribution>;
  hasUnsupportedVersions: boolean;
  unsupportedVersionsFound: number[];
}

// Debug logging - disabled in production
// eslint-disable-next-line @typescript-eslint/no-unused-vars
function log(..._args: unknown[]): void {
  // Logging disabled for production
}

// eslint-disable-next-line @typescript-eslint/no-unused-vars
function logError(..._args: unknown[]): void {
  // Logging disabled for production
}

interface GitRef {
  ref: string;
  object: {
    sha: string;
    type: string;
  };
}

interface GitTree {
  sha: string;
  tree: Array<{
    path: string;
    mode: string;
    type: string;
    sha: string;
  }>;
}

interface GitBlob {
  sha: string;
  content: string;
  encoding: string;
}

/**
 * GitHub API client
 */
export class GitHubAPI {
  private token: string;
  private cache: Map<string, GitNotesAttribution> = new Map();

  constructor(token: string) {
    this.token = token;
  }

  /**
   * Make an authenticated API request with timeout
   */
  private async fetch<T>(
    endpoint: string,
    timeoutMs = 15000,
  ): Promise<T | null> {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), timeoutMs);

    log(`Fetching: ${endpoint}`);

    try {
      const response = await fetch(`${API_BASE}${endpoint}`, {
        headers: {
          Authorization: `token ${this.token}`,
          Accept: "application/vnd.github.v3+json",
        },
        signal: controller.signal,
      });

      clearTimeout(timeoutId);

      if (!response.ok) {
        if (response.status === 404) {
          log(`Not found (404): ${endpoint}`);
          return null;
        }
        if (response.status === 429) {
          const retryAfter = response.headers.get("Retry-After");
          logError(`Rate limited. Retry after ${retryAfter || "unknown"}s`);
          return null;
        }
        if (response.status === 401) {
          logError("Unauthorized (401) - token may be invalid or expired");
          return null;
        }
        throw new Error(`GitHub API error: ${response.status}`);
      }

      log(`Success: ${endpoint}`);
      return response.json();
    } catch (error) {
      clearTimeout(timeoutId);
      if (error instanceof Error && error.name === "AbortError") {
        logError(`Timeout for ${endpoint}`);
      } else {
        logError(`Error for ${endpoint}:`, error);
      }
      return null;
    }
  }

  /**
   * Get the notes tree SHA for a repo
   */
  private async getNotesTreeSha(
    owner: string,
    repo: string,
  ): Promise<string | null> {
    const ref = await this.fetch<GitRef>(
      `/repos/${owner}/${repo}/git/refs/notes/agentblame`,
    );

    if (!ref) {
      log(`No agentblame notes ref found for ${owner}/${repo}`);
      return null;
    }

    log(`Found notes ref: ${ref.ref} -> ${ref.object.sha}`);

    // The ref points to a commit, we need the tree
    if (ref.object.type === "commit") {
      const commit = await this.fetch<{ tree: { sha: string } }>(
        `/repos/${owner}/${repo}/git/commits/${ref.object.sha}`,
      );
      return commit?.tree.sha || null;
    }

    return ref.object.sha;
  }

  /**
   * Get the notes tree (list of all notes)
   */
  private async getNotesTree(
    owner: string,
    repo: string,
    treeSha: string,
  ): Promise<GitTree | null> {
    return this.fetch<GitTree>(
      `/repos/${owner}/${repo}/git/trees/${treeSha}?recursive=1`,
    );
  }

  /**
   * Get a blob (note content)
   */
  private async getBlob(
    owner: string,
    repo: string,
    blobSha: string,
  ): Promise<string | null> {
    const blob = await this.fetch<GitBlob>(
      `/repos/${owner}/${repo}/git/blobs/${blobSha}`,
    );

    if (!blob) return null;

    // Decode base64 content
    if (blob.encoding === "base64") {
      return atob(blob.content.replace(/\n/g, ""));
    }

    return blob.content;
  }

  /**
   * Parse note content to GitNotesAttribution
   * Handles both v3 (two-section) and legacy v2 (pure JSON) formats
   * Returns { note, version } to track what versions were found
   */
  private parseNote(content: string): { note: GitNotesAttribution | null; version: number } {
    try {
      // Check for v3 format (has divider)
      const dividerIndex = content.indexOf("\n---\n");

      if (dividerIndex !== -1) {
        // V3 format: attestation + JSON metadata
        const note = this.parseV3Note(content, dividerIndex);
        return { note, version: 3 };
      }

      // Try parsing as JSON (v2 or raw v3 metadata)
      const parsed = JSON.parse(content);

      // Check if it's v3 JSON format (new or legacy)
      if (parsed.version === 3 || parsed.v === 3 || parsed.sessions) {
        const note = this.convertV3MetadataToAttribution(parsed);
        return { note, version: parsed.version || parsed.v || 3 };
      }

      // Legacy v2 format - return version info but don't convert
      if (parsed.attributions || parsed.version === 2) {
        return { note: null, version: parsed.version || 2 };
      }

      // Legacy v1 format
      if (parsed.version === 1) {
        return { note: null, version: 1 };
      }

      return { note: null, version: 0 };
    } catch {
      logError("Failed to parse note:", content.slice(0, 100));
      return { note: null, version: 0 };
    }
  }

  /**
   * Parse v3 two-section format
   */
  private parseV3Note(
    content: string,
    dividerIndex: number,
  ): GitNotesAttribution | null {
    const attestation = content.substring(0, dividerIndex);
    const metadataStr = content.substring(dividerIndex + 5).trim();

    try {
      const metadata = JSON.parse(metadataStr);
      return this.parseV3Content(attestation, metadata);
    } catch {
      return null;
    }
  }

  /**
   * Parse v3 attestation and metadata into Attribution
   */
  private parseV3Content(
    attestation: string,
    metadata: {
      v: number;
      ts: string;
      sessions: Record<string, SessionMetadata>;
      h: Record<string, string>;
    },
  ): GitNotesAttribution {
    const files: Record<string, FileAttribution> = {};

    // Parse attestation section
    let currentFile: string | null = null;
    for (const line of attestation.split("\n")) {
      if (!line.trim()) continue;

      if (!line.startsWith("  ")) {
        // File path line
        currentFile = line.trim();
        files[currentFile] = {
          aiRanges: [],
          humanRanges: [],
        };
      } else if (currentFile) {
        // Session + ranges line: "  sessionId 10-45,60-75"
        const trimmed = line.trim();
        const spaceIdx = trimmed.indexOf(" ");
        if (spaceIdx > 0) {
          const sessionId = trimmed.substring(0, spaceIdx);
          const rangeStr = trimmed.substring(spaceIdx + 1);
          const ranges = this.parseRanges(rangeStr);

          for (const range of ranges) {
            files[currentFile].aiRanges.push({
              sessionId,
              startLine: range.startLine,
              endLine: range.endLine,
            });
          }
        }
      }
    }

    // Add human ranges from metadata
    for (const [filePath, rangeStr] of Object.entries(metadata.h || {})) {
      if (!files[filePath]) {
        files[filePath] = {
          aiRanges: [],
          humanRanges: [],
        };
      }
      files[filePath].humanRanges = this.parseRanges(rangeStr);
    }

    return {
      version: 3,
      timestamp: metadata.ts,
      sessions: metadata.sessions,
      files,
    };
  }

  /**
   * Convert v3 metadata-only format to full Attribution
   */
  private convertV3MetadataToAttribution(metadata: {
    // New format fields
    version?: number;
    timestamp?: string;
    files?: Record<string, Array<{ session: string; prompt?: number | null; lines: string }>>;
    // Legacy format fields
    v?: number;
    ts?: string;
    h?: Record<string, string>;
    // Common
    sessions: Record<string, SessionMetadata>;
  }): GitNotesAttribution {
    const files: Record<string, FileAttribution> = {};

    // Handle new format with files object
    if (metadata.files) {
      for (const [filePath, ranges] of Object.entries(metadata.files)) {
        files[filePath] = { aiRanges: [], humanRanges: [] };
        for (const { session, prompt, lines } of ranges) {
          const parsed = this.parseRanges(lines);
          for (const range of parsed) {
            files[filePath].aiRanges.push({
              sessionId: session,
              promptId: prompt,
              startLine: range.startLine,
              endLine: range.endLine,
            });
          }
        }
      }
    }

    return {
      version: metadata.version || metadata.v || 3,
      timestamp: metadata.timestamp || metadata.ts || new Date().toISOString(),
      sessions: metadata.sessions,
      files,
    };
  }

  /**
   * Convert legacy v2 format to v3 structure
   */
  private convertV2ToV3(v2: GitNotesAttributionV2): GitNotesAttribution {
    const files: Record<string, FileAttribution> = {};
    const sessions: Record<string, SessionMetadata> = {};

    for (const attr of v2.attributions) {
      // Create a pseudo-session for v2 data
      const sessionId = `v2-${attr.provider}-${attr.model || "unknown"}`;

      if (!sessions[sessionId]) {
        sessions[sessionId] = {
          agent: attr.provider,
          model: attr.model,
          prompts: null, // v2 didn't have prompts
          startedAt: v2.timestamp,
        };
      }

      if (!files[attr.path]) {
        files[attr.path] = {
          aiRanges: [],
          humanRanges: [],
        };
      }

      files[attr.path].aiRanges.push({
        sessionId,
        startLine: attr.startLine,
        endLine: attr.endLine,
      });
    }

    return {
      version: 3,
      timestamp: v2.timestamp,
      sessions,
      files,
    };
  }

  /**
   * Parse range string like "10-45,60-75" into array of ranges
   */
  private parseRanges(
    rangeStr: string,
  ): Array<{ startLine: number; endLine: number }> {
    if (!rangeStr.trim()) return [];

    return rangeStr.split(",").map((part) => {
      const [start, end] = part.split("-").map((n) => parseInt(n.trim(), 10));
      return {
        startLine: start,
        endLine: end ?? start, // Single line if no end
      };
    });
  }

  /**
   * Find note blob SHA for a commit
   * Git notes are stored with paths like "ab/cdef123..." or just "abcdef123..."
   */
  private findNoteBlobSha(tree: GitTree, commitSha: string): string | null {
    // Try full SHA as path
    let entry = tree.tree.find((e) => e.path === commitSha);
    if (entry) return entry.sha;

    // Try split format (first 2 chars / rest)
    const splitPath = `${commitSha.slice(0, 2)}/${commitSha.slice(2)}`;
    entry = tree.tree.find((e) => e.path === splitPath);
    if (entry) return entry.sha;

    // Try finding by prefix (notes might use abbreviated SHAs)
    entry = tree.tree.find(
      (e) =>
        e.path.replace("/", "") === commitSha ||
        commitSha.startsWith(e.path.replace("/", "")),
    );
    if (entry) return entry.sha;

    return null;
  }

  /**
   * Fetch notes for multiple commits
   */
  async fetchNotesForCommits(
    owner: string,
    repo: string,
    commits: string[],
  ): Promise<NotesResult> {
    const notes = new Map<string, GitNotesAttribution>();
    const unsupportedVersionsFound = new Set<number>();

    log(`Fetching notes for ${commits.length} commits in ${owner}/${repo}`);

    // Check cache first
    const uncached = commits.filter((c) => {
      const cached = this.cache.get(c);
      if (cached) {
        notes.set(c, cached);
        return false;
      }
      return true;
    });

    if (uncached.length === 0) {
      log("All commits found in cache");
      return {
        notes,
        hasUnsupportedVersions: false,
        unsupportedVersionsFound: [],
      };
    }

    log(`${uncached.length} commits not in cache, fetching from API`);

    // Get the notes tree
    const treeSha = await this.getNotesTreeSha(owner, repo);
    if (!treeSha) {
      return {
        notes,
        hasUnsupportedVersions: false,
        unsupportedVersionsFound: [],
      };
    }

    const tree = await this.getNotesTree(owner, repo, treeSha);
    if (!tree) {
      log("Could not fetch notes tree");
      return {
        notes,
        hasUnsupportedVersions: false,
        unsupportedVersionsFound: [],
      };
    }

    log(`Notes tree has ${tree.tree.length} entries`);

    // Fetch notes for each commit
    let foundCount = 0;
    for (const commitSha of uncached) {
      const blobSha = this.findNoteBlobSha(tree, commitSha);
      if (!blobSha) {
        continue;
      }

      const content = await this.getBlob(owner, repo, blobSha);
      if (!content) {
        continue;
      }

      const { note, version } = this.parseNote(content);

      if (version > 0 && version < MIN_SUPPORTED_VERSION) {
        unsupportedVersionsFound.add(version);
        log(`Found unsupported version ${version} for commit ${commitSha}`);
      }

      if (note) {
        notes.set(commitSha, note);
        this.cache.set(commitSha, note);
        foundCount++;
      }
    }

    log(`Found notes for ${foundCount}/${uncached.length} uncached commits`);

    return {
      notes,
      hasUnsupportedVersions: unsupportedVersionsFound.size > 0,
      unsupportedVersionsFound: Array.from(unsupportedVersionsFound),
    };
  }

  /**
   * Get commits for a PR
   */
  async getPRCommits(
    owner: string,
    repo: string,
    prNumber: number,
  ): Promise<string[]> {
    log(`Getting commits for PR #${prNumber} in ${owner}/${repo}`);

    const commits = await this.fetch<Array<{ sha: string }>>(
      `/repos/${owner}/${repo}/pulls/${prNumber}/commits?per_page=100`,
    );

    if (!commits) {
      log("No commits returned from API");
      return [];
    }

    log(`PR has ${commits.length} commit(s)`);
    return commits.map((c) => c.sha);
  }

  /**
   * Clear the cache
   */
  clearCache(): void {
    this.cache.clear();
  }
}
