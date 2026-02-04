#!/usr/bin/env bun

/**
 * Agent Blame CLI v3
 *
 * Commands:
 *   agentblame init              - Set up repo for AI tracking (first developer, commits to git)
 *   agentblame setup             - Set up local machine (DB + git hook)
 *   agentblame blame <file>      - Show attribution for a file
 *
 * Flow:
 *   First developer: init → commit → push
 *   Other developers: clone → setup
 */

import * as path from "node:path";
import * as fs from "node:fs";
import { blame } from "./blame";
import { sync } from "./sync";
import { runProcess } from "./process";
import { runCapture } from "./capture";
import { runPostMerge } from "./post-merge";
import {
  installCursorHooks,
  installClaudeHooks,
  installOpenCodeHooks,
  installCopilotHooks,
  installGitHubAction,
  installGitHookSmart,
  detectHooksSetup,
  isGitHookInstalled,
} from "./lib/hooks";
import { colors as c } from "./lib/colors";
import { getRepoRoot, runGit } from "./lib/git/gitCli";
import {
  initGlobalDatabase,
  getStats,
  getRecentSessions,
  getToolCallsForSession,
  getRepoIdentifier,
  wipeAndRecreateDatabase,
  getGlobalAgentBlameDir,
} from "./lib/database";
import {
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
import {
  logCommandStart,
  logCommandSuccess,
  logCommandError,
  getRecentLogs,
} from "./lib/logger";

const ANALYTICS_TAG = "agentblame-analytics-anchor";

const args = process.argv.slice(2);
const command = args[0];

async function main(): Promise<void> {
  switch (command) {
    case "init":
      await runInit(args.slice(1));
      break;
    case "setup":
      await runSetup();
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
    case "post-merge":
      await runPostMerge();
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
    case "status":
      await runStatus();
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
  ab setup             Set up local machine (run once, wipes and recreates DB)
  ab init              Set up repo for AI tracking (first developer only)
  ab status            Show tracking stats
  ab blame <file>      Show AI attribution
  ab sync              Transfer notes after squash/rebase
  ab config            Show/set configuration
  ab debug             Show detailed debug info

  'ab' is a shell alias added by 'bunx @mesadev/agentblame@latest setup'.

Getting started:
  1. Run once per machine:  bunx @mesadev/agentblame@latest setup
  2. Restart your terminal to activate the 'ab' alias
  3. First developer (once per repo):
       ab init
       git add .cursor/ .claude/ .opencode/ .github/
       git commit && git push
  4. All other developers (once per machine):
       bunx @mesadev/agentblame@latest setup

Examples:
  ab init
  ab blame src/index.ts
  ab status
  ab sync
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

async function runInit(initArgs: string[] = []): Promise<void> {
  logCommandStart("init");

  // Validate we're in a git repo
  const repoRoot = await getRepoRoot(process.cwd());
  if (!repoRoot) {
    console.log("");
    console.log(`  ${c.red}✗${c.reset} Not in a git repository`);
    console.log("");
    console.log("  Run this command from inside a git repository.");
    console.log("");
    process.exit(1);
  }

  // Header
  console.log("");
  console.log(`  ${c.bold}${c.magenta}◆${c.reset} ${c.bold}Agent Blame - Repository Setup${c.reset}`);
  console.log(`  ${c.dim}One user runs this, commits to git, everyone benefits${c.reset}`);
  console.log("");

  const repoName = path.basename(repoRoot);
  console.log(`  ${c.dim}Repository:${c.reset} ${repoName}`);
  console.log("");

  // Track results
  const results: { name: string; success: boolean }[] = [];

  // Initialize analytics
  try {
    await initAnalytics(repoRoot);
    results.push({ name: "Analytics", success: true });
  } catch {
    results.push({ name: "Analytics", success: false });
  }

  // Update .gitignore only if editor hooks are being ignored (add negation patterns)
  try {
    const gitignorePath = path.join(repoRoot, ".gitignore");
    if (fs.existsSync(gitignorePath)) {
      const gitignoreContent = await fs.promises.readFile(gitignorePath, "utf8");
      let entriesToAdd = "";

      // Ensure .cursor/ is NOT ignored (add negation if it's ignored)
      if (gitignoreContent.match(/^\.cursor\/?$/m) && !gitignoreContent.includes("!.cursor")) {
        entriesToAdd += "\n# Agent Blame: ensure editor hooks are committed\n!.cursor/\n";
      }

      // Ensure .claude/ is NOT ignored (add negation if it's ignored)
      if (gitignoreContent.match(/^\.claude\/?$/m) && !gitignoreContent.includes("!.claude")) {
        entriesToAdd += "!.claude/\n";
      }

      // Ensure .opencode/ is NOT ignored (add negation if it's ignored)
      if (gitignoreContent.match(/^\.opencode\/?$/m) && !gitignoreContent.includes("!.opencode")) {
        entriesToAdd += "!.opencode/\n";
      }

      if (entriesToAdd) {
        await fs.promises.appendFile(gitignorePath, entriesToAdd);
        results.push({ name: "Updated .gitignore (added negations)", success: true });
      }
    }
  } catch {
    results.push({ name: "Updated .gitignore", success: false });
  }

  // Install editor hooks (repo-level, to be committed)
  const cursorSuccess = await installCursorHooks(repoRoot);
  results.push({ name: "Cursor hooks (.cursor/)", success: cursorSuccess });

  const claudeSuccess = await installClaudeHooks(repoRoot);
  results.push({ name: "Claude Code hooks (.claude/)", success: claudeSuccess });

  const opencodeSuccess = await installOpenCodeHooks(repoRoot);
  results.push({ name: "OpenCode hooks (.opencode/)", success: opencodeSuccess });

  const copilotSuccess = await installCopilotHooks(repoRoot);
  results.push({ name: "Copilot hooks", success: copilotSuccess });

  // Install GitHub Actions workflow
  const githubActionSuccess = await installGitHubAction(repoRoot);
  results.push({ name: "GitHub Actions workflow", success: githubActionSuccess });

  // Install git post-commit hook (detects custom hooks path like .husky/)
  const gitHookResult = await installGitHookSmart(repoRoot);
  results.push({ name: `Git post-commit hook (${gitHookResult.method})`, success: gitHookResult.success });

  // Create analytics anchor tag
  const analyticsTagSuccess = await createAnalyticsTag(repoRoot);
  results.push({ name: "Analytics anchor tag", success: analyticsTagSuccess });

  // Print results
  console.log(`  ${c.dim}─────────────────────────────────────────${c.reset}`);
  console.log("");

  for (const result of results) {
    const icon = result.success ? `${c.green}✓${c.reset}` : `${c.red}✗${c.reset}`;
    console.log(`  ${icon} ${result.name}`);
  }

  const allSuccess = results.every((r) => r.success);
  const anySuccess = results.some((r) => r.success);

  console.log("");
  console.log(`  ${c.dim}─────────────────────────────────────────${c.reset}`);
  console.log("");

  if (allSuccess) {
    console.log(`  ${c.green}✓${c.reset} ${c.bold}Repository setup complete${c.reset}`);
  } else if (anySuccess) {
    console.log(`  ${c.yellow}!${c.reset} ${c.bold}Setup completed with warnings${c.reset}`);
  } else {
    console.log(`  ${c.red}✗${c.reset} ${c.bold}Setup failed${c.reset}`);
  }

  console.log("");
  console.log(`  ${c.bold}Next steps:${c.reset}`);
  console.log(
    `  ${c.yellow}1.${c.reset} Commit: ${c.cyan}.cursor/${c.reset}, ${c.cyan}.claude/${c.reset}, ${c.cyan}.opencode/${c.reset}, ${c.cyan}.github/workflows/${c.reset}`
  );
  console.log(`  ${c.yellow}2.${c.reset} Push to share with your team`);
  console.log("");
  console.log(`  ${c.dim}Teammates run:${c.reset} ${c.cyan}bunx @mesadev/agentblame@latest setup${c.reset}`);
  console.log("");

  logCommandSuccess("init", { repo: repoName });
}

/**
 * Show status of agentblame - stats and info.
 */
async function runStatus(): Promise<void> {
  logCommandStart("status");

  // Header
  console.log("");
  console.log(`  ${c.bold}${c.magenta}◆${c.reset} ${c.bold}Agent Blame Status${c.reset}`);
  console.log("");

  // Initialize global database
  initGlobalDatabase();

  // Show global database location
  console.log(`  ${c.dim}Database:${c.reset} ${getGlobalAgentBlameDir()}/agentblame.db`);
  console.log("");

  // Show global stats
  console.log(`  ${c.bold}Global Stats:${c.reset}`);
  const globalStats = getStats();
  console.log(`    Sessions: ${globalStats.sessions}`);
  console.log(`    Prompts: ${globalStats.prompts}`);
  console.log(`    Tool Calls: ${globalStats.toolCalls}`);

  // Check if we're in a git repo
  const repoRoot = await getRepoRoot(process.cwd());
  if (repoRoot) {
    const repoName = path.basename(repoRoot);
    console.log("");
    console.log(`  ${c.bold}Current Repository:${c.reset} ${repoName}`);

    // Check for hooks
    const cursorHooksPath = path.join(repoRoot, ".cursor", "hooks.json");
    const claudeHooksPath = path.join(repoRoot, ".claude", "settings.json");

    const hasCursorHooks = fs.existsSync(cursorHooksPath);
    const hasClaudeHooks = fs.existsSync(claudeHooksPath);

    // Detect git hooks setup
    const hooksSetup = await detectHooksSetup(repoRoot);
    const hasGitHook = await isGitHookInstalled(repoRoot);

    console.log(`    Cursor hooks: ${hasCursorHooks ? `${c.green}✓${c.reset}` : `${c.yellow}✗${c.reset}`}`);
    console.log(`    Claude hooks: ${hasClaudeHooks ? `${c.green}✓${c.reset}` : `${c.yellow}✗${c.reset}`}`);

    if (hasGitHook) {
      console.log(`    Git hook: ${c.green}✓${c.reset} (${hooksSetup.type})`);
    } else {
      console.log(`    Git hook: ${c.yellow}✗${c.reset} (auto-installs on first AI edit)`);
    }
  }

  console.log("");

  logCommandSuccess("status");
}

/**
 * Set up local machine for agentblame.
 * Wipes and recreates global database and logs.
 * Run once per machine (or to reset/update).
 */
async function runSetup(): Promise<void> {
  logCommandStart("setup");

  // Header
  console.log("");
  console.log(`  ${c.bold}${c.magenta}◆${c.reset} ${c.bold}Agent Blame - Machine Setup${c.reset}`);
  console.log(`  ${c.dim}Setting up local machine (wipes existing data)${c.reset}`);
  console.log("");

  const globalDir = getGlobalAgentBlameDir();
  console.log(`  ${c.dim}Global directory:${c.reset} ${globalDir}`);
  console.log("");

  // Track results
  const results: { name: string; success: boolean }[] = [];

  // Wipe entire ~/.agentblame/ directory and recreate
  try {
    if (fs.existsSync(globalDir)) {
      await fs.promises.rm(globalDir, { recursive: true });
    }
    results.push({ name: "Cleared existing data", success: true });
  } catch (err) {
    results.push({ name: "Clear existing data", success: false });
  }

  // Recreate database
  try {
    wipeAndRecreateDatabase();
    results.push({ name: "Database (~/.agentblame/agentblame.db)", success: true });
  } catch (err) {
    results.push({ name: "Database", success: false });
  }

  // Create logs directory
  try {
    const logsDir = path.join(globalDir, "logs");
    await fs.promises.mkdir(logsDir, { recursive: true });
    results.push({ name: "Logs directory (~/.agentblame/logs/)", success: true });
  } catch (err) {
    results.push({ name: "Logs directory", success: false });
  }

  // Install shell alias 'ab'
  let shellProfilePath: string | null = null;
  try {
    const shell = process.env.SHELL || "";
    const home = process.env.HOME || "";
    const aliasLine = "alias ab='bunx @mesadev/agentblame@latest'";
    const aliasComment = "# Added by agentblame setup";
    let isFish = false;

    if (shell.endsWith("/fish")) {
      isFish = true;
      shellProfilePath = path.join(home, ".config", "fish", "config.fish");
    } else if (shell.endsWith("/zsh")) {
      shellProfilePath = path.join(home, ".zshrc");
    } else if (shell.endsWith("/bash")) {
      const bashrc = path.join(home, ".bashrc");
      const bashProfile = path.join(home, ".bash_profile");
      shellProfilePath = fs.existsSync(bashrc) ? bashrc : bashProfile;
    }

    if (shellProfilePath && home) {
      const fishAliasLine = "alias ab 'bunx @mesadev/agentblame@latest'";
      const lineToWrite = isFish ? fishAliasLine : aliasLine;

      if (fs.existsSync(shellProfilePath)) {
        const content = await fs.promises.readFile(shellProfilePath, "utf8");
        const alreadyExists = isFish
          ? content.includes("alias ab ")
          : content.includes("alias ab=");

        if (alreadyExists) {
          const profileName = path.basename(shellProfilePath);
          results.push({ name: `Shell alias 'ab' (~/${profileName} - already configured)`, success: true });
        } else {
          await fs.promises.appendFile(shellProfilePath, `\n${aliasComment}\n${lineToWrite}\n`);
          const profileName = path.basename(shellProfilePath);
          results.push({ name: `Shell alias 'ab' (~/${profileName})`, success: true });
        }
      } else {
        // Profile file doesn't exist yet, create it with the alias
        await fs.promises.mkdir(path.dirname(shellProfilePath), { recursive: true });
        await fs.promises.writeFile(shellProfilePath, `${aliasComment}\n${lineToWrite}\n`);
        const profileName = path.basename(shellProfilePath);
        results.push({ name: `Shell alias 'ab' (~/${profileName})`, success: true });
      }
    } else {
      results.push({ name: "Shell alias 'ab'", success: false });
    }
  } catch (err) {
    results.push({ name: "Shell alias 'ab'", success: false });
  }

  // Print results
  console.log(`  ${c.dim}─────────────────────────────────────────${c.reset}`);
  console.log("");

  for (const result of results) {
    const icon = result.success ? `${c.green}✓${c.reset}` : `${c.red}✗${c.reset}`;
    console.log(`  ${icon} ${result.name}`);
  }

  const allSuccess = results.every((r) => r.success);

  console.log("");
  console.log(`  ${c.dim}─────────────────────────────────────────${c.reset}`);
  console.log("");

  if (allSuccess) {
    console.log(`  ${c.green}✓${c.reset} ${c.bold}Setup complete${c.reset}`);
    console.log("");
    console.log("  You're ready to track AI-generated code!");
    if (shellProfilePath) {
      const profileName = path.basename(shellProfilePath);
      console.log(`  Tip: Restart your terminal (or run ${c.cyan}source ~/${profileName}${c.reset}) to use the ${c.cyan}ab${c.reset} shorthand.`);
    }
  } else {
    console.log(`  ${c.yellow}!${c.reset} ${c.bold}Setup completed with warnings${c.reset}`);
    if (!shellProfilePath) {
      console.log(`  To set up the ${c.cyan}ab${c.reset} alias manually, add this to your shell profile:`);
      console.log(`    ${c.cyan}alias ab='bunx @mesadev/agentblame@latest'${c.reset}`);
    }
  }

  console.log("");

  logCommandSuccess("setup");
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

  // Initialize global database
  initGlobalDatabase();

  const repoId = getRepoIdentifier(repoRoot);

  console.log(`\n${c.bold}Agent Blame Debug Info${c.reset}\n`);

  // Show repo info
  console.log(`${c.cyan}Repository:${c.reset} ${repoRoot}`);
  console.log(`${c.cyan}Repo ID:${c.reset} ${repoId}`);
  console.log(`${c.cyan}Global DB:${c.reset} ${getGlobalAgentBlameDir()}/agentblame.db`);

  // Show current HEAD
  const head = await getGitHead(repoRoot);
  console.log(`${c.cyan}Current HEAD:${c.reset} ${head || "none"}`);

  // Show database stats
  console.log(`\n${c.bold}Database:${c.reset}`);
  try {
    const stats = getStats();
    console.log(`  Sessions: ${stats.sessions}`);
    console.log(`  Prompts: ${stats.prompts}`);
    console.log(`  Tool Calls: ${stats.toolCalls}`);

    // Show recent sessions with their tool calls
    if (stats.sessions > 0) {
      console.log(`\n${c.bold}Recent Sessions:${c.reset}`);
      const sessions = getRecentSessions(5);
      for (const session of sessions) {
        console.log(`\n  ${c.yellow}${session.id}${c.reset}`);
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
    console.log(`  ${c.red}Error:${c.reset} ${err}`);
  }

  // Show working directories
  console.log(`\n${c.bold}Working Directories:${c.reset}`);
  const baseShas = getActiveBaseShas(repoRoot);
  if (baseShas.length === 0) {
    console.log(`  ${c.yellow}No working directories found${c.reset}`);
    console.log("  This means no AI edits have been captured since the last commit.");
  } else {
    for (const baseSha of baseShas) {
      console.log(`\n  ${c.yellow}${baseSha}${c.reset}`);
      const entries = readWorkingLog(repoRoot, baseSha);
      if (entries.length === 0) {
        console.log(`    ${c.red}Empty (no snapshots.jsonl entries)${c.reset}`);
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
  console.log(`\n${c.bold}Directory Structure:${c.reset}`);
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
      console.log(`    ${c.red}Error reading directory:${c.reset} ${err}`);
    }
  } else {
    console.log(`  ${c.red}Not found:${c.reset} ${agentBlameDir}`);
    console.log("  This directory will be created on first AI edit.");
  }

  console.log("");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
