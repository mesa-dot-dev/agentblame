/**
 * Git configuration for Agent Blame notes
 *
 * Notes are pushed explicitly by the post-commit hook after processing,
 * rather than via push refspec (which fails if notes don't exist).
 */

import { runGit } from "./gitCli";

/**
 * Configure notes sync for a repository.
 * This is now a no-op - notes are pushed by the post-commit hook instead.
 * Keeping the function for API compatibility.
 */
export async function configureNotesSync(_repoRoot: string): Promise<boolean> {
  // Notes are pushed explicitly by the post-commit hook after processing.
  // We don't configure push refspec because it fails if notes don't exist yet.
  return true;
}

/**
 * Check if notes sync is already configured (legacy - always returns false)
 */
export async function isNotesSyncConfigured(
  _repoRoot: string,
): Promise<boolean> {
  return false;
}

/**
 * Remove notes sync configuration.
 * Cleans up any push/fetch refspecs from older versions.
 */
export async function removeNotesSync(repoRoot: string): Promise<boolean> {
  try {
    // Remove push refspec if it exists (from older versions)
    await runGit(repoRoot, [
      "config",
      "--local",
      "--unset-all",
      "remote.origin.push",
      "refs/notes/agentblame",
    ]).catch(() => {}); // Ignore if not present

    // Also remove fetch refspec if it exists
    await runGit(repoRoot, [
      "config",
      "--local",
      "--unset-all",
      "remote.origin.fetch",
      "refs/notes/agentblame",
    ]).catch(() => {}); // Ignore if not present

    return true;
  } catch {
    return false;
  }
}
