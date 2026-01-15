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
import { execSync } from "node:child_process";
import { blame } from "./blame";
import { sync } from "./sync";
import { runProcess } from "./process";
import {
  installCursorHooks,
  installClaudeHooks,
  installGitHook,
  installGlobalGitHook,
  installGitHubAction,
  uninstallCursorHooks,
  uninstallClaudeHooks,
  uninstallGitHook,
  uninstallGlobalGitHook,
  uninstallGitHubAction,
  getRepoRoot,
  configureNotesSync,
  removeNotesSync,
  initDatabase,
  getPendingEditCount,
  getRecentPendingEdits,
  getDistDir,
  cleanupOldEntries,
} from "./lib";

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
    case "install":
      await runInstall(args.slice(1));
      break;
    case "uninstall":
      await runUninstall(args.slice(1));
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
    case "cleanup":
      await runCleanup();
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
  agentblame install           Set up hooks for current repo
  agentblame install --global  Set up hooks for all repos
  agentblame uninstall         Remove hooks from current repo
  agentblame uninstall --global Remove global hooks
  agentblame blame <file>      Show AI attribution for a file
  agentblame blame --summary   Show summary only
  agentblame blame --json      Output as JSON
  agentblame status            Show pending AI edits
  agentblame cleanup           Remove old entries from database

Examples:
  agentblame install           # Current repo only (recommended)
  agentblame install --global  # All repos (overrides repo-specific hooks)
  agentblame blame src/index.ts
`);
}

async function runInstall(args: string[]): Promise<void> {
  const isGlobal = args.includes("--global");

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

  // For per-repo, validate we're in a git repo first
  let repoRoot: string | null = null;
  if (!isGlobal) {
    repoRoot = await getRepoRoot(process.cwd());
    if (!repoRoot) {
      console.log("");
      console.log("  \x1b[31m✗\x1b[0m Not in a git repository");
      console.log("");
      console.log("  Run this command from inside a git repository, or use:");
      console.log("    \x1b[36magentblame install --global\x1b[0m");
      console.log("");
      process.exit(1);
    }
  }

  // Header
  console.log("");
  console.log("  \x1b[1m\x1b[35m◆\x1b[0m \x1b[1mAgent Blame\x1b[0m");
  console.log("  \x1b[2mTrack AI-generated code in your commits\x1b[0m");
  console.log("");

  if (isGlobal) {
    console.log("  \x1b[2mMode:\x1b[0m Global (all repositories)");
  } else {
    const repoName = path.basename(repoRoot!);
    console.log(`  \x1b[2mRepository:\x1b[0m ${repoName}`);
  }
  console.log("");

  // Track results
  const results: { name: string; success: boolean }[] = [];

  // Initialize SQLite database
  try {
    initDatabase();
    results.push({ name: "Database", success: true });
  } catch (err) {
    results.push({ name: "Database", success: false });
  }

  // Find capture script in the dist/ directory (always run compiled .js)
  const distDir = getDistDir(__dirname);
  const captureScript = path.resolve(distDir, "capture.js");

  // Install editor hooks
  const cursorSuccess = await installCursorHooks(captureScript);
  results.push({ name: "Cursor hooks", success: cursorSuccess });

  const claudeSuccess = await installClaudeHooks(captureScript);
  results.push({ name: "Claude Code hooks", success: claudeSuccess });

  if (isGlobal) {
    // Install global git hook (works for all repos)
    const gitHookSuccess = await installGlobalGitHook();
    results.push({ name: "Git hook (global)", success: gitHookSuccess });
  } else {
    // Per-repo installation
    const gitHookSuccess = await installGitHook(repoRoot!);
    results.push({ name: "Git post-commit hook", success: gitHookSuccess });

    const notesPushSuccess = await configureNotesSync(repoRoot!);
    results.push({ name: "Notes auto-push", success: notesPushSuccess });

    const githubActionSuccess = await installGitHubAction(repoRoot!);
    results.push({ name: "GitHub Actions workflow", success: githubActionSuccess });
  }

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
  console.log("  \x1b[33m2.\x1b[0m Make AI edits and commit your changes");
  console.log("  \x1b[33m3.\x1b[0m Run \x1b[36magentblame blame <file>\x1b[0m to see attribution");

  if (!isGlobal) {
    console.log("");
    console.log("  \x1b[2mWorkflow created at:\x1b[0m .github/workflows/agentblame.yml");
    console.log("  \x1b[2mCommit this file to enable squash/rebase merge support.\x1b[0m");
  }

  console.log("");
}

async function runUninstall(args: string[]): Promise<void> {
  const isGlobal = args.includes("--global");

  // For per-repo, validate we're in a git repo first
  let repoRoot: string | null = null;
  if (!isGlobal) {
    repoRoot = await getRepoRoot(process.cwd());
    if (!repoRoot) {
      console.log("");
      console.log("  \x1b[31m✗\x1b[0m Not in a git repository");
      console.log("");
      console.log("  Run this command from inside a git repository, or use:");
      console.log("    \x1b[36magentblame uninstall --global\x1b[0m");
      console.log("");
      process.exit(1);
    }
  }

  // Header
  console.log("");
  console.log("  \x1b[1m\x1b[35m◆\x1b[0m \x1b[1mAgent Blame\x1b[0m");
  console.log("  \x1b[2mRemoving hooks and configuration\x1b[0m");
  console.log("");

  if (isGlobal) {
    console.log("  \x1b[2mMode:\x1b[0m Global uninstall");
  } else {
    const repoName = path.basename(repoRoot!);
    console.log(`  \x1b[2mRepository:\x1b[0m ${repoName}`);
  }
  console.log("");

  // Track results
  const results: { name: string; success: boolean }[] = [];

  // Always remove editor hooks
  const cursorSuccess = await uninstallCursorHooks();
  results.push({ name: "Cursor hooks", success: cursorSuccess });

  const claudeSuccess = await uninstallClaudeHooks();
  results.push({ name: "Claude Code hooks", success: claudeSuccess });

  if (isGlobal) {
    // Remove global git hook
    const gitHookSuccess = await uninstallGlobalGitHook();
    results.push({ name: "Git hook (global)", success: gitHookSuccess });

    // Remove ~/.agentblame directory
    const fs = await import("node:fs");
    const os = await import("node:os");
    const agentblameDir = path.join(os.homedir(), ".agentblame");
    try {
      if (fs.existsSync(agentblameDir)) {
        await fs.promises.rm(agentblameDir, { recursive: true, force: true });
        results.push({ name: "Data directory", success: true });
      } else {
        results.push({ name: "Data directory", success: true });
      }
    } catch {
      results.push({ name: "Data directory", success: false });
    }
  } else {
    // Per-repo uninstallation
    const gitHookSuccess = await uninstallGitHook(repoRoot!);
    results.push({ name: "Git post-commit hook", success: gitHookSuccess });

    const notesPushSuccess = await removeNotesSync(repoRoot!);
    results.push({ name: "Notes auto-push", success: notesPushSuccess });

    const githubActionSuccess = await uninstallGitHubAction(repoRoot!);
    results.push({ name: "GitHub Actions workflow", success: githubActionSuccess });
  }

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
  console.log("\nAgent Blame Status\n");

  const pendingCount = getPendingEditCount();

  console.log(`Pending AI edits: ${pendingCount}`);

  if (pendingCount > 0) {
    console.log("\nRecent pending edits:");
    const recent = getRecentPendingEdits(5);
    for (const edit of recent) {
      const time = new Date(edit.timestamp).toLocaleTimeString();
      const file = edit.file_path.split("/").pop();
      console.log(`  [${edit.provider}] ${file} at ${time}`);
    }

    if (pendingCount > 5) {
      console.log(`  ... and ${pendingCount - 5} more`);
    }
  }

  console.log("");
}

async function runCleanup(): Promise<void> {
  console.log("\nAgent Blame Cleanup\n");

  const result = cleanupOldEntries();

  console.log(`  Removed: ${result.removed} old entries`);
  console.log(`  Kept: ${result.kept} entries`);
  console.log("\nCleanup complete!");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
