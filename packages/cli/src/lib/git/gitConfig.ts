/**
 * Git configuration for Agent Blame notes
 *
 * Notes are pushed explicitly by the post-commit hook after processing,
 * rather than via push refspec (which fails if notes don't exist).
 *
 * Fetch refspec is configured so notes are automatically fetched on git fetch/pull.
 */

import { runGit } from "./gitCli";

const NOTES_FETCH_REFSPEC = "+refs/notes/agentblame:refs/notes/agentblame";
const ANALYTICS_FETCH_REFSPEC = "+refs/notes/agentblame-analytics:refs/notes/agentblame-analytics";

/**
 * Configure notes sync for a repository.
 * Sets up fetch refspec so notes are automatically fetched on git fetch/pull.
 * Push is handled explicitly by the post-commit hook.
 */
export async function configureNotesSync(repoRoot: string): Promise<boolean> {
  try {
    // Check if fetch refspec already exists
    const existingConfig = await runGit(repoRoot, [
      "config",
      "--local",
      "--get-all",
      "remote.origin.fetch",
    ]);

    const existingRefspecs = existingConfig.stdout.trim().split("\n");

    // Add notes fetch refspec if not already configured
    if (!existingRefspecs.includes(NOTES_FETCH_REFSPEC)) {
      await runGit(repoRoot, [
        "config",
        "--local",
        "--add",
        "remote.origin.fetch",
        NOTES_FETCH_REFSPEC,
      ]);
    }

    // Add analytics fetch refspec if not already configured
    if (!existingRefspecs.includes(ANALYTICS_FETCH_REFSPEC)) {
      await runGit(repoRoot, [
        "config",
        "--local",
        "--add",
        "remote.origin.fetch",
        ANALYTICS_FETCH_REFSPEC,
      ]);
    }

    return true;
  } catch {
    return false;
  }
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
