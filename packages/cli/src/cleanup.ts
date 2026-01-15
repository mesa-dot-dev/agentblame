#!/usr/bin/env bun
/**
 * Agent Blame Cleanup Script
 *
 * Removes all Agent Blame data and hook configurations:
 * - ~/.agentblame directory (logs, hooks)
 * - Agent Blame entries from ~/.cursor/hooks.json
 * - Agent Blame entries from ~/.claude/settings.json
 */

import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";

const AGENTBLAME_ROOT = path.join(os.homedir(), ".agentblame");
const CURSOR_HOOKS_CONFIG = path.join(os.homedir(), ".cursor", "hooks.json");
const CLAUDE_SETTINGS_FILE = path.join(
  os.homedir(),
  ".claude",
  "settings.json",
);

function removeAgentBlameDirectory(): boolean {
  if (fs.existsSync(AGENTBLAME_ROOT)) {
    fs.rmSync(AGENTBLAME_ROOT, { recursive: true, force: true });
    console.log("✓ Removed ~/.agentblame directory");
    return true;
  }
  console.log("  ~/.agentblame directory not found (already clean)");
  return false;
}

function cleanCursorHooks(): boolean {
  if (!fs.existsSync(CURSOR_HOOKS_CONFIG)) {
    console.log("  ~/.cursor/hooks.json not found (already clean)");
    return false;
  }

  try {
    const content = fs.readFileSync(CURSOR_HOOKS_CONFIG, "utf8");
    const config = JSON.parse(content);

    let modified = false;

    if (config.hooks?.afterFileEdit) {
      const before = config.hooks.afterFileEdit.length;
      config.hooks.afterFileEdit = config.hooks.afterFileEdit.filter(
        (h: any) => !h?.command?.includes("agentblame"),
      );
      if (config.hooks.afterFileEdit.length < before) modified = true;
    }

    if (config.hooks?.afterTabFileEdit) {
      const before = config.hooks.afterTabFileEdit.length;
      config.hooks.afterTabFileEdit = config.hooks.afterTabFileEdit.filter(
        (h: any) => !h?.command?.includes("agentblame"),
      );
      if (config.hooks.afterTabFileEdit.length < before) modified = true;
    }

    if (modified) {
      fs.writeFileSync(
        CURSOR_HOOKS_CONFIG,
        JSON.stringify(config, null, 2),
        "utf8",
      );
      console.log("✓ Removed Agent Blame hooks from ~/.cursor/hooks.json");
      return true;
    }

    console.log("  No Agent Blame hooks found in ~/.cursor/hooks.json");
    return false;
  } catch (err) {
    console.log("  Error reading ~/.cursor/hooks.json:", err);
    return false;
  }
}

function cleanClaudeSettings(): boolean {
  if (!fs.existsSync(CLAUDE_SETTINGS_FILE)) {
    console.log("  ~/.claude/settings.json not found (already clean)");
    return false;
  }

  try {
    const content = fs.readFileSync(CLAUDE_SETTINGS_FILE, "utf8");
    const config = JSON.parse(content);

    let modified = false;

    if (config.hooks?.PostToolUse) {
      const before = config.hooks.PostToolUse.length;
      config.hooks.PostToolUse = config.hooks.PostToolUse.filter(
        (h: any) => !h?.hooks?.some((hh: any) => hh?.command?.includes("agentblame")),
      );
      if (config.hooks.PostToolUse.length < before) modified = true;
    }

    if (modified) {
      fs.writeFileSync(
        CLAUDE_SETTINGS_FILE,
        JSON.stringify(config, null, 2),
        "utf8",
      );
      console.log("✓ Removed Agent Blame hooks from ~/.claude/settings.json");
      return true;
    }

    console.log("  No Agent Blame hooks found in ~/.claude/settings.json");
    return false;
  } catch (err) {
    console.log("  Error reading ~/.claude/settings.json:", err);
    return false;
  }
}

function main(): void {
  console.log(`\nAgent Blame Cleanup\n${"=".repeat(40)}`);

  removeAgentBlameDirectory();
  cleanCursorHooks();
  cleanClaudeSettings();

  console.log(`\n${"=".repeat(40)}`);
  console.log("Cleanup complete!");
  console.log("\nNext steps:");
  console.log("  1. Restart Cursor for hook changes to take effect");
  console.log("  2. Run 'bun run compile' to rebuild");
  console.log("  3. Press F5 to launch extension (will reinstall hooks)");
  console.log("");
}

main();
