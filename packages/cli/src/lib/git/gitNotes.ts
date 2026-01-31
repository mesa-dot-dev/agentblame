/**
 * Git Notes Operations
 *
 * Attach and read attribution data from git notes (refs/notes/agentblame)
 *
 * Format:
 * - Two-section format: attestation section (fast grep-able) + JSON metadata
 */

import type {
  GitNotesMetadata,
  Attribution,
  SessionMetadata,
} from "../types";
import { formatRanges, parseRanges } from "../trace";
import { runGit } from "./gitCli";

const NOTES_REF = "refs/notes/agentblame";

// =============================================================================
// Note Format
// =============================================================================

/**
 * Build note content as JSON
 */
export function buildNote(
  attribution: Attribution,
  sessions: Record<string, SessionMetadata>
): string {
  // Build files object with AI ranges
  const files: Record<string, Array<{ session: string; prompt?: number | null; lines: string }>> = {};

  for (const [filePath, fileAttr] of Object.entries(attribution.files)) {
    if (fileAttr.aiRanges.length === 0) continue;

    // Group ranges by session+prompt combination
    const groupKey = (sessionId: string, promptId?: number | null) =>
      `${sessionId}:${promptId ?? "null"}`;

    const groupedRanges = new Map<string, { sessionId: string; promptId?: number | null; ranges: Array<[number, number]> }>();

    for (const range of fileAttr.aiRanges) {
      const key = groupKey(range.sessionId, range.promptId);
      if (!groupedRanges.has(key)) {
        groupedRanges.set(key, { sessionId: range.sessionId, promptId: range.promptId, ranges: [] });
      }
      groupedRanges.get(key)!.ranges.push([range.startLine, range.endLine]);
    }

    files[filePath] = [];
    for (const { sessionId, promptId, ranges } of groupedRanges.values()) {
      const rangeStr = formatRanges(
        ranges.map(([start, end]) => ({ startLine: start, endLine: end }))
      );
      const entry: { session: string; prompt?: number | null; lines: string } = {
        session: sessionId,
        lines: rangeStr,
      };
      // Only include prompt if it's not null
      if (promptId != null) {
        entry.prompt = promptId;
      }
      files[filePath].push(entry);
    }
  }

  const note = {
    version: 3,
    timestamp: attribution.timestamp,
    sessions,
    files,
  };

  return JSON.stringify(note);
}

/**
 * Parse a note (JSON format)
 */
export function parseNote(content: string): Attribution | null {
  if (!content.trim()) return null;

  try {
    const note = JSON.parse(content) as {
      version: number;
      timestamp: string;
      sessions: Record<string, SessionMetadata>;
      files: Record<string, Array<{ session: string; prompt?: number | null; lines: string }>>;
    };

    const attribution: Attribution = {
      version: 3,
      timestamp: note.timestamp,
      sessions: note.sessions,
      files: {},
    };

    // Parse files
    for (const [filePath, ranges] of Object.entries(note.files || {})) {
      attribution.files[filePath] = {
        aiRanges: [],
        humanRanges: [],
      };

      for (const { session, prompt, lines } of ranges) {
        const parsed = parseRanges(lines);
        for (const range of parsed) {
          attribution.files[filePath].aiRanges.push({
            sessionId: session,
            promptId: prompt,
            startLine: range.startLine,
            endLine: range.endLine,
          });
        }
      }
    }

    return attribution;
  } catch {
    return null;
  }
}

// =============================================================================
// Note Read/Write Operations
// =============================================================================

/**
 * Attach attribution data as a git note to a commit
 */
export async function attachNote(
  repoRoot: string,
  sha: string,
  attribution: Attribution,
  sessions: Record<string, SessionMetadata>
): Promise<boolean> {
  const noteContent = buildNote(attribution, sessions);

  const result = await runGit(
    repoRoot,
    ["notes", `--ref=${NOTES_REF}`, "add", "-f", "-m", noteContent, sha],
    10000
  );

  return result.exitCode === 0;
}

/**
 * Read attribution note from a commit
 */
export async function readNote(
  repoRoot: string,
  sha: string
): Promise<Attribution | null> {
  const result = await runGit(
    repoRoot,
    ["notes", `--ref=${NOTES_REF}`, "show", sha],
    5000
  );

  if (result.exitCode !== 0) return null;

  return parseNote(result.stdout.trim());
}

// =============================================================================
// Note Sync Operations
// =============================================================================

/**
 * Push notes to remote
 */
export async function pushNotes(
  repoRoot: string,
  remote = "origin"
): Promise<boolean> {
  const result = await runGit(repoRoot, ["push", remote, NOTES_REF], 30000);
  return result.exitCode === 0;
}

/**
 * Fetch notes from remote
 */
export async function fetchNotes(
  repoRoot: string,
  remote = "origin"
): Promise<boolean> {
  const result = await runGit(
    repoRoot,
    ["fetch", remote, `${NOTES_REF}:${NOTES_REF}`],
    30000
  );
  return result.exitCode === 0;
}

/**
 * Fetch notes from remote, silently ignoring errors
 */
export async function fetchNotesQuiet(
  repoRoot: string,
  remote = "origin",
  verbose = false
): Promise<boolean> {
  if (verbose) {
    console.log("Fetching attribution notes from remote...");
  }

  const result = await runGit(
    repoRoot,
    ["fetch", remote, `${NOTES_REF}:${NOTES_REF}`],
    30000
  );

  if (result.exitCode === 0) {
    if (verbose) {
      console.log("Notes fetched successfully.\n");
    }
    return true;
  }

  if (verbose) {
    console.log("No remote notes found (this is normal for new repos).\n");
  }
  return false;
}

/**
 * Copy note from one commit to another (for squash/rebase)
 */
export async function copyNote(
  repoRoot: string,
  fromSha: string,
  toSha: string
): Promise<boolean> {
  const result = await runGit(
    repoRoot,
    ["notes", `--ref=${NOTES_REF}`, "copy", fromSha, toSha],
    5000
  );
  return result.exitCode === 0;
}

/**
 * Remove note from a commit
 */
export async function removeNote(
  repoRoot: string,
  sha: string
): Promise<boolean> {
  const result = await runGit(
    repoRoot,
    ["notes", `--ref=${NOTES_REF}`, "remove", sha],
    5000
  );
  return result.exitCode === 0;
}

/**
 * Get the notes ref name
 */
export function getNotesRef(): string {
  return NOTES_REF;
}

/**
 * Check if a commit has an attribution note
 */
export async function hasNote(repoRoot: string, sha: string): Promise<boolean> {
  const result = await runGit(
    repoRoot,
    ["notes", `--ref=${NOTES_REF}`, "show", sha],
    5000
  );
  return result.exitCode === 0;
}

/**
 * List all commits that have attribution notes
 */
export async function listNotedCommits(repoRoot: string): Promise<string[]> {
  const result = await runGit(
    repoRoot,
    ["notes", `--ref=${NOTES_REF}`, "list"],
    10000
  );

  if (result.exitCode !== 0) return [];

  // Format: <note-sha> <commit-sha>
  return result.stdout
    .trim()
    .split("\n")
    .filter(Boolean)
    .map((line) => {
      const parts = line.split(" ");
      return parts[1] || "";
    })
    .filter(Boolean);
}
