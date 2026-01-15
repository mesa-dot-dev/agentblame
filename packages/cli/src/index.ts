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
  uninstallCursorHooks,
  uninstallClaudeHooks,
  uninstallGitHook,
  uninstallGlobalGitHook,
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

    console.error("\n┌─────────────────────────────────────────────────────────────┐");
    console.error("│  Error: Bun is required but not installed                   │");
    console.error("├─────────────────────────────────────────────────────────────┤");
    console.error("│                                                             │");
    console.error("│  Agent Blame uses Bun to run hooks for Cursor and Claude   │");
    console.error("│  Code. Please install Bun first:                            │");
    console.error("│                                                             │");
    console.error(`│    ${installCmd.padEnd(55)}│`);
    console.error("│                                                             │");
    console.error("│  Then restart your terminal and run this command again.    │");
    console.error("│                                                             │");
    console.error("│  Learn more: https://bun.sh                                 │");
    console.error("└─────────────────────────────────────────────────────────────┘\n");
    process.exit(1);
  }

  console.log(`Agent Blame Setup${isGlobal ? " (Global)" : ""}\n`);

  // Initialize SQLite database
  try {
    initDatabase();
    console.log("  Database: initialized");
  } catch (err) {
    console.log("  Database: failed to initialize");
    console.error(err);
    process.exit(1);
  }

  // Find capture script in the dist/ directory (always run compiled .js)
  const distDir = getDistDir(__dirname);
  const captureScript = path.resolve(distDir, "capture.js");

  // Always install/reinstall editor hooks
  const cursorSuccess = await installCursorHooks(captureScript);
  console.log(cursorSuccess ? "  Cursor hooks: installed" : "  Cursor hooks: failed");

  const claudeSuccess = await installClaudeHooks(captureScript);
  console.log(claudeSuccess ? "  Claude Code hooks: installed" : "  Claude Code hooks: failed");

  if (isGlobal) {
    // Install global git hook (works for all repos)
    const gitHookSuccess = await installGlobalGitHook();
    if (gitHookSuccess) {
      console.log("  Git post-commit hook: installed (global)");
      console.log("  Notes auto-push: auto-configures per repo on first commit");
    } else {
      console.log("  Git post-commit hook: failed");
    }
  } else {
    // Per-repo installation
    const repoRoot = await getRepoRoot(process.cwd());
    if (!repoRoot) {
      console.error("\nError: Not in a git repository. Use --global for system-wide setup.");
      process.exit(1);
    }

    const gitHookSuccess = await installGitHook(repoRoot);
    console.log(gitHookSuccess ? "  Git post-commit hook: installed" : "  Git post-commit hook: failed");

    const notesPushSuccess = await configureNotesSync(repoRoot);
    console.log(notesPushSuccess ? "  Notes auto-push: configured" : "  Notes auto-push: failed");
  }

  console.log("\nSetup complete!");
  console.log("\nIMPORTANT: Restart Cursor/Claude Code for hooks to take effect.");
  console.log("\nHow it works:");
  console.log("  1. Make AI edits in Cursor or Claude Code");
  console.log("  2. Commit your changes (attribution attached automatically)");
  console.log("  3. Run 'agentblame blame <file>' to see attribution");
}

async function runUninstall(args: string[]): Promise<void> {
  const isGlobal = args.includes("--global");

  console.log(`Removing Agent Blame${isGlobal ? " (Global)" : ""}...\n`);

  // Always remove editor hooks
  const cursorSuccess = await uninstallCursorHooks();
  console.log(cursorSuccess ? "  Cursor hooks: removed" : "  Cursor hooks: failed");

  const claudeSuccess = await uninstallClaudeHooks();
  console.log(claudeSuccess ? "  Claude Code hooks: removed" : "  Claude Code hooks: failed");

  if (isGlobal) {
    // Remove global git hook
    const gitHookSuccess = await uninstallGlobalGitHook();
    console.log(gitHookSuccess ? "  Git post-commit hook: removed (global)" : "  Git post-commit hook: failed");

    // Remove ~/.agentblame directory
    const fs = await import("node:fs");
    const os = await import("node:os");
    const agentblameDir = path.join(os.homedir(), ".agentblame");
    try {
      if (fs.existsSync(agentblameDir)) {
        await fs.promises.rm(agentblameDir, { recursive: true, force: true });
        console.log("  Data directory: removed");
      } else {
        console.log("  Data directory: not found");
      }
    } catch {
      console.log("  Data directory: failed to remove");
    }
  } else {
    // Per-repo uninstallation
    const repoRoot = await getRepoRoot(process.cwd());
    if (!repoRoot) {
      console.error("\nError: Not in a git repository. Use --global to remove global hooks.");
      process.exit(1);
    }

    const gitHookSuccess = await uninstallGitHook(repoRoot);
    console.log(gitHookSuccess ? "  Git post-commit hook: removed" : "  Git post-commit hook: failed");

    const notesPushSuccess = await removeNotesSync(repoRoot);
    console.log(notesPushSuccess ? "  Notes auto-push: removed" : "  Notes auto-push: failed");
  }

  console.log("\nUninstall complete!");
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
