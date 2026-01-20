#!/usr/bin/env bun

/**
 * Agent Blame CLI
 *
 * Commands:
 *   agentblame init              - Set up hooks and configuration
 *   agentblame blame <file>      - Show attribution for a file
 *   agentblame status            - Show current attribution status
 */

import * as path from "node:path";
import * as fs from "node:fs";
import * as os from "node:os";
import { execSync } from "node:child_process";
import { blame } from "./blame";
import { sync } from "./sync";
import { runProcess } from "./process";
import { runCapture } from "./capture";
import {
  installCursorHooks,
  installClaudeHooks,
  installGitHook,
  installGitHubAction,
  uninstallCursorHooks,
  uninstallClaudeHooks,
  uninstallGitHook,
  uninstallGitHubAction,
  getRepoRoot,
  runGit,
  configureNotesSync,
  removeNotesSync,
  initDatabase,
  setAgentBlameDir,
  getAgentBlameDirForRepo,
  getPendingEditCount,
  getRecentPendingEdits,
  cleanupOldEntries,
} from "./lib";

const ANALYTICS_TAG = "agentblame-analytics-anchor";

/**
 * Check if Bun is installed and available in PATH.
 */
function isBunInstalled(): boolean {
  try {
    execSync("bun --version", { stdio: "pipe" });
    return true;
  } catch {
    return false;
  }
}

const args = process.argv.slice(2);
const command = args[0];

async function main(): Promise<void> {
  switch (command) {
    case "init":
      await runInit(args.slice(1));
      break;
    case "clean":
      await runClean(args.slice(1));
      break;
    case "capture":
      await runCapture();
      break;
    case "blame":
      await runBlame(args.slice(1));
      break;
    case "process":
      await runProcess(args[1]);
      break;
    case "sync":
      await runSync(args.slice(1));
      break;
    case "status":
      await runStatus();
      break;
    case "prune":
      await runPrune();
      break;
    case "--version":
    case "-v":
      printVersion();
      break;
    case "--help":
    case "-h":
    case undefined:
      printHelp();
      break;
    default:
      console.error(`Unknown command: ${command}`);
      printHelp();
      process.exit(1);
  }
}

function printHelp(): void {
  console.log(`
Agent Blame - Track AI-generated code in your commits

Usage:
  agentblame init              Set up hooks for current repo
  agentblame init --force      Set up hooks and clean up old global install
  agentblame clean             Remove hooks from current repo
  agentblame clean --force     Also clean up old global install
  agentblame blame <file>      Show AI attribution for a file
  agentblame blame --summary   Show summary only
  agentblame blame --json      Output as JSON
  agentblame status            Show pending AI edits
  agentblame sync              Transfer notes after squash/rebase
  agentblame prune             Remove old entries from database

Examples:
  agentblame init
  agentblame blame src/index.ts
`);
}

function printVersion(): void {
  const packageJsonPath = path.join(__dirname, "..", "package.json");
  try {
    const packageJson = JSON.parse(fs.readFileSync(packageJsonPath, "utf8"));
    console.log(`agentblame v${packageJson.version}`);
  } catch {
    console.log("agentblame (version unknown)");
  }
}

/**
 * Create the analytics anchor tag on the root commit.
 * This tag is used to store repository-wide analytics.
 */
async function createAnalyticsTag(repoRoot: string): Promise<boolean> {
  try {
    // Check if tag already exists
    const existingTag = await runGit(repoRoot, ["tag", "-l", ANALYTICS_TAG], 5000);
    if (existingTag.stdout.trim()) {
      // Tag already exists
      return true;
    }

    // Get the root commit(s)
    const rootResult = await runGit(repoRoot, ["rev-list", "--max-parents=0", "HEAD"], 10000);
    if (rootResult.exitCode !== 0 || !rootResult.stdout.trim()) {
      return false;
    }

    const rootLines = rootResult.stdout.trim().split("\n").filter(Boolean);
    if (rootLines.length === 0) {
      return false;
    }

    // Use the first root commit
    const rootSha = rootLines[0];

    // Create the tag
    const tagResult = await runGit(repoRoot, ["tag", ANALYTICS_TAG, rootSha], 5000);
    if (tagResult.exitCode !== 0) {
      return false;
    }

    return true;
  } catch {
    return false;
  }
}

/**
 * Clean up global hooks and database from previous versions.
 */
async function cleanupGlobalInstall(): Promise<{ cursor: boolean; claude: boolean; db: boolean }> {
  const results = { cursor: false, claude: false, db: false };
  const home = os.homedir();

  // Clean up global Cursor hooks
  const globalCursorHooks = path.join(home, ".cursor", "hooks.json");
  try {
    if (fs.existsSync(globalCursorHooks)) {
      const config = JSON.parse(await fs.promises.readFile(globalCursorHooks, "utf8"));
      if (config.hooks?.afterFileEdit) {
        config.hooks.afterFileEdit = config.hooks.afterFileEdit.filter(
          (h: any) => !h?.command?.includes("agentblame") && !h?.command?.includes("capture")
        );
      }
      await fs.promises.writeFile(globalCursorHooks, JSON.stringify(config, null, 2), "utf8");
      results.cursor = true;
    }
  } catch {
    // Ignore errors
  }

  // Clean up global Claude hooks
  const globalClaudeSettings = path.join(home, ".claude", "settings.json");
  try {
    if (fs.existsSync(globalClaudeSettings)) {
      const config = JSON.parse(await fs.promises.readFile(globalClaudeSettings, "utf8"));
      if (config.hooks?.PostToolUse) {
        config.hooks.PostToolUse = config.hooks.PostToolUse.filter(
          (h: any) => !h?.hooks?.some(
            (hh: any) => hh?.command?.includes("agentblame") || hh?.command?.includes("capture")
          )
        );
      }
      await fs.promises.writeFile(globalClaudeSettings, JSON.stringify(config, null, 2), "utf8");
      results.claude = true;
    }
  } catch {
    // Ignore errors
  }

  // Clean up global database
  const globalDb = path.join(home, ".agentblame");
  try {
    if (fs.existsSync(globalDb)) {
      await fs.promises.rm(globalDb, { recursive: true });
      results.db = true;
    }
  } catch {
    // Ignore errors
  }

  return results;
}

async function runInit(initArgs: string[] = []): Promise<void> {
  const forceCleanup = initArgs.includes("--force") || initArgs.includes("-f");

  // Check if Bun is installed (required for hooks)
  if (!isBunInstalled()) {
    const installCmd = process.platform === "win32"
      ? "powershell -c \"irm bun.sh/install.ps1 | iex\""
      : "curl -fsSL https://bun.sh/install | bash";

    console.log("");
    console.log("  \x1b[31m✗\x1b[0m Bun is required but not installed");
    console.log("");
    console.log("  Agent Blame uses Bun to run hooks. Install it first:");
    console.log("");
    console.log(`    \x1b[36m${installCmd}\x1b[0m`);
    console.log("");
    console.log("  Then restart your terminal and run this command again.");
    console.log("  Learn more: \x1b[36mhttps://bun.sh\x1b[0m");
    console.log("");
    process.exit(1);
  }

  // Validate we're in a git repo
  const repoRoot = await getRepoRoot(process.cwd());
  if (!repoRoot) {
    console.log("");
    console.log("  \x1b[31m✗\x1b[0m Not in a git repository");
    console.log("");
    console.log("  Run this command from inside a git repository.");
    console.log("");
    process.exit(1);
  }

  // Header
  console.log("");
  console.log("  \x1b[1m\x1b[35m◆\x1b[0m \x1b[1mAgent Blame\x1b[0m");
  console.log("  \x1b[2mTrack AI-generated code in your commits\x1b[0m");
  console.log("");

  const repoName = path.basename(repoRoot);
  console.log(`  \x1b[2mRepository:\x1b[0m ${repoName}`);
  console.log("");

  // Clean up global install if --force flag is passed
  if (forceCleanup) {
    console.log("  \x1b[2mCleaning up global install...\x1b[0m");
    const cleanup = await cleanupGlobalInstall();
    if (cleanup.cursor) console.log("  \x1b[32m✓\x1b[0m Removed global Cursor hooks");
    if (cleanup.claude) console.log("  \x1b[32m✓\x1b[0m Removed global Claude hooks");
    if (cleanup.db) console.log("  \x1b[32m✓\x1b[0m Removed global database");
    if (!cleanup.cursor && !cleanup.claude && !cleanup.db) {
      console.log("  \x1b[2m  No global install found\x1b[0m");
    }
    console.log("");
  }

  // Track results
  const results: { name: string; success: boolean }[] = [];

  // Create .agentblame directory and initialize SQLite database
  try {
    const agentblameDir = getAgentBlameDirForRepo(repoRoot);
    setAgentBlameDir(agentblameDir);
    initDatabase();
    results.push({ name: "Database", success: true });
  } catch (err) {
    results.push({ name: "Database", success: false });
  }

  // Add .agentblame/ to .gitignore
  try {
    const gitignorePath = path.join(repoRoot, ".gitignore");
    let gitignoreContent = "";
    if (fs.existsSync(gitignorePath)) {
      gitignoreContent = await fs.promises.readFile(gitignorePath, "utf8");
    }
    if (!gitignoreContent.includes(".agentblame")) {
      const entry = "\n# Agent Blame local database\n.agentblame/\n";
      await fs.promises.appendFile(gitignorePath, entry);
    }
    results.push({ name: "Updated .gitignore", success: true });
  } catch (err) {
    results.push({ name: "Updated .gitignore", success: false });
  }

  // Install editor hooks (repo-level)
  const cursorSuccess = await installCursorHooks(repoRoot);
  results.push({ name: "Cursor hooks", success: cursorSuccess });

  const claudeSuccess = await installClaudeHooks(repoRoot);
  results.push({ name: "Claude Code hooks", success: claudeSuccess });

  // Install repo hooks and workflow
  const gitHookSuccess = await installGitHook(repoRoot);
  results.push({ name: "Git post-commit hook", success: gitHookSuccess });

  const notesPushSuccess = await configureNotesSync(repoRoot);
  results.push({ name: "Notes auto-push", success: notesPushSuccess });

  const githubActionSuccess = await installGitHubAction(repoRoot);
  results.push({ name: "GitHub Actions workflow", success: githubActionSuccess });

  // Create analytics anchor tag
  const analyticsTagSuccess = await createAnalyticsTag(repoRoot);
  results.push({ name: "Analytics anchor tag", success: analyticsTagSuccess });

  // Print results
  console.log("  \x1b[2m─────────────────────────────────────────\x1b[0m");
  console.log("");

  for (const result of results) {
    const icon = result.success ? "\x1b[32m✓\x1b[0m" : "\x1b[31m✗\x1b[0m";
    console.log(`  ${icon} ${result.name}`);
  }

  const allSuccess = results.every((r) => r.success);
  const anySuccess = results.some((r) => r.success);

  console.log("");
  console.log("  \x1b[2m─────────────────────────────────────────\x1b[0m");
  console.log("");

  if (allSuccess) {
    console.log("  \x1b[32m✓\x1b[0m \x1b[1mSetup complete\x1b[0m");
  } else if (anySuccess) {
    console.log("  \x1b[33m!\x1b[0m \x1b[1mSetup completed with warnings\x1b[0m");
  } else {
    console.log("  \x1b[31m✗\x1b[0m \x1b[1mSetup failed\x1b[0m");
  }

  console.log("");
  console.log("  \x1b[1mNext steps:\x1b[0m");
  console.log("  \x1b[33m1.\x1b[0m Restart Cursor or Claude Code");
  console.log("  \x1b[33m2.\x1b[0m Push the analytics tag: \x1b[36mgit push origin agentblame-analytics-anchor\x1b[0m");
  console.log("  \x1b[33m3.\x1b[0m Make AI edits and commit your changes");
  console.log("  \x1b[33m4.\x1b[0m Run \x1b[36magentblame blame <file>\x1b[0m to see attribution");
  console.log("");
  console.log("  \x1b[2mWorkflow created at:\x1b[0m .github/workflows/agentblame.yml");
  console.log("  \x1b[2mCommit this file to enable squash/rebase merge support and analytics.\x1b[0m");
  console.log("");
}

async function runClean(uninstallArgs: string[] = []): Promise<void> {
  const forceCleanup = uninstallArgs.includes("--force") || uninstallArgs.includes("-f");

  // Validate we're in a git repo
  const repoRoot = await getRepoRoot(process.cwd());
  if (!repoRoot) {
    console.log("");
    console.log("  \x1b[31m✗\x1b[0m Not in a git repository");
    console.log("");
    console.log("  Run this command from inside a git repository.");
    console.log("");
    process.exit(1);
  }

  // Header
  console.log("");
  console.log("  \x1b[1m\x1b[35m◆\x1b[0m \x1b[1mAgent Blame\x1b[0m");
  console.log("  \x1b[2mRemoving hooks and configuration\x1b[0m");
  console.log("");

  const repoName = path.basename(repoRoot);
  console.log(`  \x1b[2mRepository:\x1b[0m ${repoName}`);
  console.log("");

  // Clean up global install if --force flag is passed
  if (forceCleanup) {
    console.log("  \x1b[2mCleaning up global install...\x1b[0m");
    const cleanup = await cleanupGlobalInstall();
    if (cleanup.cursor) console.log("  \x1b[32m✓\x1b[0m Removed global Cursor hooks");
    if (cleanup.claude) console.log("  \x1b[32m✓\x1b[0m Removed global Claude hooks");
    if (cleanup.db) console.log("  \x1b[32m✓\x1b[0m Removed global database");
    if (!cleanup.cursor && !cleanup.claude && !cleanup.db) {
      console.log("  \x1b[2m  No global install found\x1b[0m");
    }
    console.log("");
  }

  // Track results
  const results: { name: string; success: boolean }[] = [];

  // Remove editor hooks (repo-level)
  const cursorSuccess = await uninstallCursorHooks(repoRoot);
  results.push({ name: "Cursor hooks", success: cursorSuccess });

  const claudeSuccess = await uninstallClaudeHooks(repoRoot);
  results.push({ name: "Claude Code hooks", success: claudeSuccess });

  // Remove repo hooks and workflow
  const gitHookSuccess = await uninstallGitHook(repoRoot);
  results.push({ name: "Git post-commit hook", success: gitHookSuccess });

  const notesPushSuccess = await removeNotesSync(repoRoot);
  results.push({ name: "Notes auto-push", success: notesPushSuccess });

  const githubActionSuccess = await uninstallGitHubAction(repoRoot);
  results.push({ name: "GitHub Actions workflow", success: githubActionSuccess });

  // Remove .agentblame directory (database)
  const agentblameDir = getAgentBlameDirForRepo(repoRoot);
  let dbSuccess = true;
  try {
    if (fs.existsSync(agentblameDir)) {
      await fs.promises.rm(agentblameDir, { recursive: true });
    }
  } catch {
    dbSuccess = false;
  }
  results.push({ name: "Database", success: dbSuccess });

  // Print results
  console.log("  \x1b[2m─────────────────────────────────────────\x1b[0m");
  console.log("");

  for (const result of results) {
    const icon = result.success ? "\x1b[32m✓\x1b[0m" : "\x1b[31m✗\x1b[0m";
    console.log(`  ${icon} ${result.name}`);
  }

  const allSuccess = results.every((r) => r.success);

  console.log("");
  console.log("  \x1b[2m─────────────────────────────────────────\x1b[0m");
  console.log("");

  if (allSuccess) {
    console.log("  \x1b[32m✓\x1b[0m \x1b[1mUninstall complete\x1b[0m");
  } else {
    console.log("  \x1b[33m!\x1b[0m \x1b[1mUninstall completed with warnings\x1b[0m");
  }

  console.log("");
}

async function runBlame(args: string[]): Promise<void> {
  // Parse options
  const options: { json?: boolean; summary?: boolean } = {};
  let filePath: string | undefined;

  for (const arg of args) {
    if (arg === "--json") {
      options.json = true;
    } else if (arg === "--summary") {
      options.summary = true;
    } else if (!arg.startsWith("-")) {
      filePath = arg;
    }
  }

  if (!filePath) {
    console.error("Usage: agentblame blame [--json|--summary] <file>");
    process.exit(1);
  }

  await blame(filePath, options);
}

async function runSync(args: string[]): Promise<void> {
  const options: { dryRun?: boolean; verbose?: boolean } = {};

  for (const arg of args) {
    if (arg === "--dry-run") {
      options.dryRun = true;
    } else if (arg === "--verbose" || arg === "-v") {
      options.verbose = true;
    }
  }

  await sync(options);
}

async function runStatus(): Promise<void> {
  // Find repo root and set database directory
  const repoRoot = await getRepoRoot(process.cwd());
  if (!repoRoot) {
    console.error("Not in a git repository");
    process.exit(1);
  }

  const agentblameDir = getAgentBlameDirForRepo(repoRoot);
  setAgentBlameDir(agentblameDir);

  console.log("\nAgent Blame Status\n");

  const pendingCount = getPendingEditCount();

  console.log(`Pending AI edits: ${pendingCount}`);

  if (pendingCount > 0) {
    console.log("\nRecent pending edits:");
    const recent = getRecentPendingEdits(5);
    for (const edit of recent) {
      const time = new Date(edit.timestamp).toLocaleTimeString();
      const file = edit.filePath.split("/").pop();
      console.log(`  [${edit.provider}] ${file} at ${time}`);
    }

    if (pendingCount > 5) {
      console.log(`  ... and ${pendingCount - 5} more`);
    }
  }

  console.log("");
}

async function runPrune(): Promise<void> {
  // Find repo root and set database directory
  const repoRoot = await getRepoRoot(process.cwd());
  if (!repoRoot) {
    console.error("Not in a git repository");
    process.exit(1);
  }

  const agentblameDir = getAgentBlameDirForRepo(repoRoot);
  setAgentBlameDir(agentblameDir);

  console.log("\nAgent Blame Prune\n");

  const result = cleanupOldEntries();

  console.log(`  Removed: ${result.removed} old entries`);
  console.log(`  Kept: ${result.kept} entries`);
  console.log("\nPrune complete!");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
