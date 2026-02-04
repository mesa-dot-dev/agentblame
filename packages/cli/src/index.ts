#!/usr/bin/env bun

/**
 * Agent Blame CLI v3
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
  installOpenCodeHooks,
  installGitHook,
  installGitHubAction,
  uninstallCursorHooks,
  uninstallClaudeHooks,
  uninstallOpenCodeHooks,
  uninstallGitHook,
  uninstallGitHubAction,
} from "./lib/hooks";
import { getRepoRoot, runGit } from "./lib/git/gitCli";
import { configureNotesSync, removeNotesSync } from "./lib/git/gitConfig";
import {
  initDatabase,
  setDatabasePath,
  getStats,
  getRecentSessions,
  getToolCallsForSession,
} from "./lib/database";
import {
  getDatabasePath,
  ensureAgentBlameDirs,
  getAgentBlameGitDir,
  getActiveBaseShas,
  readWorkingLog,
  getGitHead,
} from "./lib/storage";
import { initAnalytics } from "./lib/analytics";
import {
  getConfig,
  setConfig,
  listConfig,
  VALID_CONFIG_KEYS,
  parseConfigValue,
  type AgentBlameConfig,
} from "./lib/config";

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
    case "debug":
      await runDebug();
      break;
    case "config":
      await runConfig(args.slice(1));
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
Agent Blame v3 - Track AI-generated code in your commits

Usage:
  agentblame init              Set up hooks for current repo
  agentblame clean             Remove hooks from current repo
  agentblame blame <file>      Show AI attribution
  agentblame sync              Transfer notes after squash/rebase
  agentblame config            Show/set configuration
  agentblame debug             Show detailed debug info

Examples:
  agentblame init
  agentblame blame src/index.ts
  agentblame config set storePromptContent true
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
 */
async function createAnalyticsTag(repoRoot: string): Promise<boolean> {
  try {
    const existingTag = await runGit(repoRoot, ["tag", "-l", ANALYTICS_TAG], 5000);
    if (existingTag.stdout.trim()) {
      return true;
    }

    const rootResult = await runGit(
      repoRoot,
      ["rev-list", "--max-parents=0", "HEAD"],
      10000
    );
    if (rootResult.exitCode !== 0 || !rootResult.stdout.trim()) {
      return false;
    }

    const rootLines = rootResult.stdout.trim().split("\n").filter(Boolean);
    if (rootLines.length === 0) {
      return false;
    }

    const rootSha = rootLines[0];
    const tagResult = await runGit(repoRoot, ["tag", ANALYTICS_TAG, rootSha], 5000);
    return tagResult.exitCode === 0;
  } catch {
    return false;
  }
}

/**
 * Clean up global hooks and database from previous versions.
 */
async function cleanupGlobalInstall(): Promise<{
  cursor: boolean;
  claude: boolean;
  db: boolean;
}> {
  const results = { cursor: false, claude: false, db: false };
  const home = os.homedir();

  // Clean up global Cursor hooks
  const globalCursorHooks = path.join(home, ".cursor", "hooks.json");
  try {
    if (fs.existsSync(globalCursorHooks)) {
      const config = JSON.parse(await fs.promises.readFile(globalCursorHooks, "utf8"));
      if (config.hooks?.afterFileEdit) {
        config.hooks.afterFileEdit = config.hooks.afterFileEdit.filter(
          (h: any) =>
            !h?.command?.includes("agentblame") && !h?.command?.includes("capture")
        );
      }
      await fs.promises.writeFile(
        globalCursorHooks,
        JSON.stringify(config, null, 2),
        "utf8"
      );
      results.cursor = true;
    }
  } catch {
    // Ignore errors
  }

  // Clean up global Claude hooks
  const globalClaudeSettings = path.join(home, ".claude", "settings.json");
  try {
    if (fs.existsSync(globalClaudeSettings)) {
      const config = JSON.parse(
        await fs.promises.readFile(globalClaudeSettings, "utf8")
      );
      if (config.hooks?.PostToolUse) {
        config.hooks.PostToolUse = config.hooks.PostToolUse.filter(
          (h: any) =>
            !h?.hooks?.some(
              (hh: any) =>
                hh?.command?.includes("agentblame") ||
                hh?.command?.includes("capture")
            )
        );
      }
      await fs.promises.writeFile(
        globalClaudeSettings,
        JSON.stringify(config, null, 2),
        "utf8"
      );
      results.claude = true;
    }
  } catch {
    // Ignore errors
  }

  // Clean up global database (old location)
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
  const traceHooks = initArgs.includes("--trace-hooks");

  // Check if Bun is installed (required for hooks)
  if (!isBunInstalled()) {
    const installCmd =
      process.platform === "win32"
        ? 'powershell -c "irm bun.sh/install.ps1 | iex"'
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
  console.log("  \x1b[1m\x1b[35m◆\x1b[0m \x1b[1mAgent Blame v3\x1b[0m");
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

  // Create .git/agentblame directory and initialize SQLite database
  try {
    ensureAgentBlameDirs(repoRoot);
    const dbPath = getDatabasePath(repoRoot);
    setDatabasePath(dbPath);
    initDatabase();
    results.push({ name: "Database (.git/agentblame/)", success: true });
  } catch (err) {
    results.push({ name: "Database", success: false });
  }

  // Initialize analytics
  try {
    await initAnalytics(repoRoot);
    results.push({ name: "Analytics", success: true });
  } catch {
    results.push({ name: "Analytics", success: false });
  }

  // Add old .agentblame/ to .gitignore (for backwards compatibility)
  try {
    const gitignorePath = path.join(repoRoot, ".gitignore");
    let gitignoreContent = "";
    if (fs.existsSync(gitignorePath)) {
      gitignoreContent = await fs.promises.readFile(gitignorePath, "utf8");
    }
    let entriesToAdd = "";
    if (!gitignoreContent.includes(".agentblame")) {
      entriesToAdd += "\n# Agent Blame local database (legacy)\n.agentblame/\n";
    }
    if (!gitignoreContent.includes(".opencode")) {
      entriesToAdd +=
        "\n# OpenCode local plugin (installed by agentblame init)\n.opencode/\n";
    }
    if (entriesToAdd) {
      await fs.promises.appendFile(gitignorePath, entriesToAdd);
    }
    results.push({ name: "Updated .gitignore", success: true });
  } catch {
    results.push({ name: "Updated .gitignore", success: false });
  }

  // Install editor hooks (repo-level)
  const cursorSuccess = await installCursorHooks(repoRoot);
  results.push({ name: "Cursor hooks", success: cursorSuccess });

  const claudeSuccess = await installClaudeHooks(repoRoot);
  results.push({ name: "Claude Code hooks", success: claudeSuccess });

  const opencodeSuccess = await installOpenCodeHooks(repoRoot);
  results.push({ name: "OpenCode hooks", success: opencodeSuccess });

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
  console.log(
    "  \x1b[33m1.\x1b[0m Commit \x1b[36m.github/workflows/agentblame.yml\x1b[0m to enable PR analytics"
  );
  console.log("  \x1b[33m2.\x1b[0m Restart Cursor or Claude Code to pick up hooks");
  console.log("  \x1b[33m3.\x1b[0m Make AI edits and commit your changes");
  console.log(
    "  \x1b[33m4.\x1b[0m Run \x1b[36magentblame blame <file>\x1b[0m to see attribution"
  );
  console.log("");
}

async function runClean(uninstallArgs: string[] = []): Promise<void> {
  const forceCleanup =
    uninstallArgs.includes("--force") || uninstallArgs.includes("-f");

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

  const opencodeSuccess = await uninstallOpenCodeHooks(repoRoot);
  results.push({ name: "OpenCode hooks", success: opencodeSuccess });

  // Remove repo hooks and workflow
  const gitHookSuccess = await uninstallGitHook(repoRoot);
  results.push({ name: "Git post-commit hook", success: gitHookSuccess });

  const notesPushSuccess = await removeNotesSync(repoRoot);
  results.push({ name: "Notes auto-push", success: notesPushSuccess });

  const githubActionSuccess = await uninstallGitHubAction(repoRoot);
  results.push({ name: "GitHub Actions workflow", success: githubActionSuccess });

  // Remove .git/agentblame directory (v3 location)
  const agentBlameGitDir = getAgentBlameGitDir(repoRoot);
  let dbSuccess = true;
  try {
    if (fs.existsSync(agentBlameGitDir)) {
      await fs.promises.rm(agentBlameGitDir, { recursive: true });
    }
  } catch {
    dbSuccess = false;
  }
  results.push({ name: "Database (.git/agentblame/)", success: dbSuccess });

  // Also remove legacy .agentblame directory
  const legacyDir = path.join(repoRoot, ".agentblame");
  try {
    if (fs.existsSync(legacyDir)) {
      await fs.promises.rm(legacyDir, { recursive: true });
      results.push({ name: "Legacy database (.agentblame/)", success: true });
    }
  } catch {
    // Ignore
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
  const options: { json?: boolean; summary?: boolean; showPrompts?: boolean; verbose?: boolean } = {};
  let filePath: string | undefined;

  for (const arg of args) {
    if (arg === "--json") {
      options.json = true;
    } else if (arg === "--summary") {
      options.summary = true;
    } else if (arg === "--prompts" || arg === "-p") {
      options.showPrompts = true;
    } else if (arg === "--verbose" || arg === "-v") {
      options.verbose = true;
    } else if (!arg.startsWith("-")) {
      filePath = arg;
    }
  }

  if (!filePath) {
    console.error("Usage: agentblame blame [--json|--summary|--prompts|--verbose] <file>");
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


async function runConfig(args: string[]): Promise<void> {
  const repoRoot = await getRepoRoot(process.cwd());
  if (!repoRoot) {
    console.error("Not in a git repository");
    process.exit(1);
  }

  const subcommand = args[0];
  const key = args[1] as keyof AgentBlameConfig | undefined;
  const value = args[2];

  // No subcommand - list all config
  if (!subcommand) {
    console.log("\nAgent Blame Configuration\n");
    const configs = await listConfig(repoRoot);
    for (const cfg of configs) {
      const status = cfg.isDefault ? "(default)" : "(custom)";
      console.log(`  ${cfg.key}: ${cfg.value} ${status}`);
    }
    console.log("\nUse 'agentblame config set <key> <value>' to change settings.");
    console.log("");
    return;
  }

  // Get a config value
  if (subcommand === "get") {
    if (!key) {
      console.error("Usage: agentblame config get <key>");
      console.error(`Valid keys: ${VALID_CONFIG_KEYS.join(", ")}`);
      process.exit(1);
    }

    if (!VALID_CONFIG_KEYS.includes(key)) {
      console.error(`Unknown config key: ${key}`);
      console.error(`Valid keys: ${VALID_CONFIG_KEYS.join(", ")}`);
      process.exit(1);
    }

    const currentValue = await getConfig(repoRoot, key);
    console.log(String(currentValue));
    return;
  }

  // Set a config value
  if (subcommand === "set") {
    if (!key || value === undefined) {
      console.error("Usage: agentblame config set <key> <value>");
      console.error(`Valid keys: ${VALID_CONFIG_KEYS.join(", ")}`);
      process.exit(1);
    }

    if (!VALID_CONFIG_KEYS.includes(key)) {
      console.error(`Unknown config key: ${key}`);
      console.error(`Valid keys: ${VALID_CONFIG_KEYS.join(", ")}`);
      process.exit(1);
    }

    const parsedValue = parseConfigValue(key, value);
    if (parsedValue === null) {
      console.error(`Invalid value for ${key}: ${value}`);
      console.error("For boolean settings, use: true/false, yes/no, or 1/0");
      process.exit(1);
    }

    await setConfig(repoRoot, key, parsedValue);
    console.log(`Set ${key} = ${parsedValue}`);
    return;
  }

  console.error(`Unknown config subcommand: ${subcommand}`);
  console.error("Usage: agentblame config [get|set] <key> [value]");
  process.exit(1);
}

async function runDebug(): Promise<void> {
  const repoRoot = await getRepoRoot(process.cwd());
  if (!repoRoot) {
    console.error("Not in a git repository");
    process.exit(1);
  }

  const dbPath = getDatabasePath(repoRoot);
  setDatabasePath(dbPath);

  console.log("\n\x1b[1mAgent Blame Debug Info\x1b[0m\n");

  // Show repo info
  console.log(`\x1b[36mRepository:\x1b[0m ${repoRoot}`);

  // Show current HEAD
  const head = await getGitHead(repoRoot);
  console.log(`\x1b[36mCurrent HEAD:\x1b[0m ${head || "none"}`);

  // Show database stats
  console.log("\n\x1b[1mDatabase:\x1b[0m");
  try {
    const stats = getStats();
    console.log(`  Sessions: ${stats.sessions}`);
    console.log(`  Prompts: ${stats.prompts}`);
    console.log(`  Tool Calls: ${stats.toolCalls}`);

    // Show recent sessions with their tool calls
    if (stats.sessions > 0) {
      console.log("\n\x1b[1mRecent Sessions:\x1b[0m");
      const sessions = getRecentSessions(5);
      for (const session of sessions) {
        console.log(`\n  \x1b[33m${session.id}\x1b[0m`);
        console.log(`    Agent: ${session.agent}`);
        console.log(`    Model: ${session.model || "unknown"}`);
        console.log(`    Created: ${session.createdAt}`);
        console.log(`    First Commit: ${session.firstCommitSha || "pending"}`);

        // Show tool calls for this session
        const toolCalls = getToolCallsForSession(session.id);
        if (toolCalls.length > 0) {
          // Count tool types (all names are lowercase)
          const fileModifyingNames = ["edit", "write", "multiedit"];
          const fileModifying = toolCalls.filter(tc =>
            fileModifyingNames.includes(tc.toolName)
          );
          const readOnly = toolCalls.filter(tc =>
            !fileModifyingNames.includes(tc.toolName)
          );

          console.log(`    Tool Calls: ${toolCalls.length} total (${fileModifying.length} edits, ${readOnly.length} other)`);
          console.log(`    Sequence:`);

          for (const tc of toolCalls.slice(0, 10)) {
            const isEdit = fileModifyingNames.includes(tc.toolName);
            const icon = isEdit ? "✏️" : "🔍";
            const filePart = tc.filePath ? ` → ${tc.filePath}` : "";
            console.log(`      ${icon} ${tc.toolName}${filePart}`);
          }
          if (toolCalls.length > 10) {
            console.log(`      ... and ${toolCalls.length - 10} more`);
          }
        }
      }
    }
  } catch (err) {
    console.log(`  \x1b[31mError:\x1b[0m ${err}`);
  }

  // Show working directories
  console.log("\n\x1b[1mWorking Directories:\x1b[0m");
  const baseShas = getActiveBaseShas(repoRoot);
  if (baseShas.length === 0) {
    console.log("  \x1b[33mNo working directories found\x1b[0m");
    console.log("  This means no AI edits have been captured since the last commit.");
  } else {
    for (const baseSha of baseShas) {
      console.log(`\n  \x1b[33m${baseSha}\x1b[0m`);
      const entries = readWorkingLog(repoRoot, baseSha);
      if (entries.length === 0) {
        console.log("    \x1b[31mEmpty (no snapshots.jsonl entries)\x1b[0m");
      } else {
        console.log(`    Entries: ${entries.length}`);
        for (const entry of entries.slice(0, 5)) {
          const sessionStr = entry.session ? entry.session.slice(0, 8) : "human";
          console.log(`      - ${entry.file} (${entry.type}, session: ${sessionStr})`);
        }
        if (entries.length > 5) {
          console.log(`      ... and ${entries.length - 5} more`);
        }
      }
    }
  }

  // Check agentblame directory structure
  console.log("\n\x1b[1mDirectory Structure:\x1b[0m");
  const agentBlameDir = getAgentBlameGitDir(repoRoot);
  if (fs.existsSync(agentBlameDir)) {
    console.log(`  ${agentBlameDir}/`);
    try {
      const entries = fs.readdirSync(agentBlameDir);
      for (const entry of entries) {
        const entryPath = path.join(agentBlameDir, entry);
        const stat = fs.statSync(entryPath);
        if (stat.isDirectory()) {
          const subEntries = fs.readdirSync(entryPath);
          console.log(`    ${entry}/ (${subEntries.length} items)`);
        } else {
          console.log(`    ${entry} (${stat.size} bytes)`);
        }
      }
    } catch (err) {
      console.log(`    \x1b[31mError reading directory:\x1b[0m ${err}`);
    }
  } else {
    console.log(`  \x1b[31mNot found:\x1b[0m ${agentBlameDir}`);
    console.log("  Run 'agentblame init' to set up the database.");
  }

  console.log("");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
