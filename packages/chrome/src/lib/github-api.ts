/**
 * GitHub API client for fetching git notes
 */

import type { GitNotesAttribution } from "../types";

const API_BASE = "https://api.github.com";

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
   */
  private parseNote(content: string): GitNotesAttribution | null {
    try {
      return JSON.parse(content);
    } catch {
      logError("Failed to parse note:", content.slice(0, 100));
      return null;
    }
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
  ): Promise<Map<string, GitNotesAttribution>> {
    const result = new Map<string, GitNotesAttribution>();

    log(`Fetching notes for ${commits.length} commits in ${owner}/${repo}`);

    // Check cache first
    const uncached = commits.filter((c) => {
      const cached = this.cache.get(c);
      if (cached) {
        result.set(c, cached);
        return false;
      }
      return true;
    });

    if (uncached.length === 0) {
      log("All commits found in cache");
      return result;
    }

    log(`${uncached.length} commits not in cache, fetching from API`);

    // Get the notes tree
    const treeSha = await this.getNotesTreeSha(owner, repo);
    if (!treeSha) {
      return result;
    }

    const tree = await this.getNotesTree(owner, repo, treeSha);
    if (!tree) {
      log("Could not fetch notes tree");
      return result;
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

      const note = this.parseNote(content);
      if (note) {
        result.set(commitSha, note);
        this.cache.set(commitSha, note);
        foundCount++;
      }
    }

    log(`Found notes for ${foundCount}/${uncached.length} uncached commits`);

    return result;
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
