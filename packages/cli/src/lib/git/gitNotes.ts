/**
 * Git Notes Operations
 *
 * Attach and read attribution data from git notes (refs/notes/agentblame)
 */

import type { GitNotesAttribution, RangeAttribution } from "../types";
import { runGit } from "./gitCli";

const NOTES_REF = "refs/notes/agentblame";

/**
 * Attach attribution data as a git note to a commit
 */
export async function attachNote(
  repoRoot: string,
  sha: string,
  attributions: RangeAttribution[]
): Promise<boolean> {
  const note: GitNotesAttribution = {
    version: 2,
    timestamp: new Date().toISOString(),
    attributions: attributions.map((a) => ({
      path: a.path,
      startLine: a.startLine,
      endLine: a.endLine,
      category: "ai_generated",
      provider: a.provider,
      model: a.model,
      confidence: a.confidence,
      matchType: a.matchType,
      contentHash: a.contentHash,
    })),
  };

  const noteJson = JSON.stringify(note);

  const result = await runGit(
    repoRoot,
    ["notes", `--ref=${NOTES_REF}`, "add", "-f", "-m", noteJson, sha],
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
): Promise<GitNotesAttribution | null> {
  const result = await runGit(
    repoRoot,
    ["notes", `--ref=${NOTES_REF}`, "show", sha],
    5000
  );

  if (result.exitCode !== 0) return null;

  try {
    return JSON.parse(result.stdout.trim()) as GitNotesAttribution;
  } catch {
    return null;
  }
}

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
 * Use this in CLI commands where notes may not exist on remote yet
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
 * Get the notes ref name
 */
export function getNotesRef(): string {
  return NOTES_REF;
}
