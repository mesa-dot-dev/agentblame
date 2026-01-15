/**
 * Hook Installation
 *
 * Install and manage hooks for Cursor and Claude Code.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { getDistDir } from "./util";

export const AGENTBLAME_ROOT = path.join(os.homedir(), ".agentblame");

// Cursor hooks.json location
export const CURSOR_HOOKS_CONFIG = path.join(
  os.homedir(),
  ".cursor",
  "hooks.json"
);

// Claude Code settings.json location
export const CLAUDE_SETTINGS_DIR = path.join(os.homedir(), ".claude");
export const CLAUDE_SETTINGS_FILE = path.join(
  CLAUDE_SETTINGS_DIR,
  "settings.json"
);


/**
 * Find the capture script path.
 * Looks in common locations for the compiled capture.js script.
 */
function findCaptureScript(): string | null {
  // Use getDistDir to find the dist/ directory, then look for capture.js
  const distDir = getDistDir(__dirname);
  const captureJs = path.join(distDir, "capture.js");

  if (fs.existsSync(captureJs)) {
    return captureJs;
  }

  // Fallback: check npm global install locations
  const globalPaths = [
    path.join(os.homedir(), ".npm-global", "lib", "node_modules", "@mesadev", "agentblame", "dist", "capture.js"),
    path.join("/usr", "local", "lib", "node_modules", "@mesadev", "agentblame", "dist", "capture.js"),
  ];

  for (const p of globalPaths) {
    if (fs.existsSync(p)) {
      return p;
    }
  }

  return null;
}

/**
 * Generate the hook command for a given provider.
 */
function getHookCommand(
  provider: "cursor" | "claude",
  captureScript: string,
  event?: string
): string {
  const eventArg = event ? ` --event ${event}` : "";
  return `bun run "${captureScript}" --provider ${provider}${eventArg}`;
}

/**
 * Install the Cursor hooks and configure ~/.cursor/hooks.json
 */
export async function installCursorHooks(
  captureScript?: string
): Promise<boolean> {
  if (process.platform === "win32") {
    console.error("Windows is not supported yet");
    return false;
  }

  const script = captureScript || findCaptureScript();
  if (!script) {
    console.error("Could not find capture script. Make sure agentblame is installed correctly.");
    return false;
  }

  try {
    // Update ~/.cursor/hooks.json
    await fs.promises.mkdir(path.dirname(CURSOR_HOOKS_CONFIG), {
      recursive: true,
    });

    let config: any = {};
    try {
      const existing = await fs.promises.readFile(CURSOR_HOOKS_CONFIG, "utf8");
      config = JSON.parse(existing || "{}");
    } catch {
      // File doesn't exist or invalid JSON
    }

    config.version = config.version ?? 1;
    config.hooks = config.hooks ?? {};

    const fileEditCommand = getHookCommand("cursor", script, "afterFileEdit");

    // Configure afterFileEdit
    config.hooks.afterFileEdit = config.hooks.afterFileEdit ?? [];
    if (!Array.isArray(config.hooks.afterFileEdit)) {
      config.hooks.afterFileEdit = [];
    }

    // Remove any existing agentblame hooks first
    config.hooks.afterFileEdit = config.hooks.afterFileEdit.filter(
      (h: any) => !h?.command?.includes("agentblame") && !h?.command?.includes("capture.ts")
    );
    config.hooks.afterFileEdit.push({ command: fileEditCommand });

    // Clean up old afterTabFileEdit hooks
    if (config.hooks.afterTabFileEdit) {
      config.hooks.afterTabFileEdit = config.hooks.afterTabFileEdit.filter(
        (h: any) => !h?.command?.includes("agentblame") && !h?.command?.includes("capture.ts")
      );
      if (config.hooks.afterTabFileEdit.length === 0) {
        delete config.hooks.afterTabFileEdit;
      }
    }

    await fs.promises.writeFile(
      CURSOR_HOOKS_CONFIG,
      JSON.stringify(config, null, 2),
      "utf8"
    );

    return true;
  } catch (err) {
    console.error("Failed to install Cursor hooks:", err);
    return false;
  }
}

/**
 * Install the Claude Code hooks and configure ~/.claude/settings.json
 */
export async function installClaudeHooks(
  captureScript?: string
): Promise<boolean> {
  if (process.platform === "win32") {
    console.error("Windows is not supported yet");
    return false;
  }

  const script = captureScript || findCaptureScript();
  if (!script) {
    console.error("Could not find capture script. Make sure agentblame is installed correctly.");
    return false;
  }

  try {
    // Update ~/.claude/settings.json
    await fs.promises.mkdir(CLAUDE_SETTINGS_DIR, { recursive: true });

    let config: any = {};
    try {
      const existing = await fs.promises.readFile(CLAUDE_SETTINGS_FILE, "utf8");
      config = JSON.parse(existing || "{}");
    } catch {
      // File doesn't exist or invalid JSON
    }

    config.hooks = config.hooks ?? {};

    const hookCommand = getHookCommand("claude", script);

    // Configure PostToolUse hook for Edit/Write/MultiEdit
    config.hooks.PostToolUse = config.hooks.PostToolUse ?? [];
    if (!Array.isArray(config.hooks.PostToolUse)) {
      config.hooks.PostToolUse = [];
    }

    // Remove any existing agentblame hooks first
    config.hooks.PostToolUse = config.hooks.PostToolUse.filter(
      (h: any) =>
        !h?.hooks?.some(
          (hh: any) =>
            hh?.command?.includes("agentblame") ||
            hh?.command?.includes("capture.ts")
        )
    );

    // Add the new hook
    config.hooks.PostToolUse.push({
      matcher: "Edit|Write|MultiEdit",
      hooks: [{ type: "command", command: hookCommand }],
    });

    await fs.promises.writeFile(
      CLAUDE_SETTINGS_FILE,
      JSON.stringify(config, null, 2),
      "utf8"
    );

    return true;
  } catch (err) {
    console.error("Failed to install Claude hooks:", err);
    return false;
  }
}

/**
 * Check if Cursor hooks are installed.
 */
export async function areCursorHooksInstalled(): Promise<boolean> {
  try {
    const config = JSON.parse(
      await fs.promises.readFile(CURSOR_HOOKS_CONFIG, "utf8")
    );

    const hasFileEdit = config.hooks?.afterFileEdit?.some(
      (h: any) =>
        h?.command?.includes("agentblame") || h?.command?.includes("capture.ts")
    );
    return hasFileEdit === true;
  } catch {
    return false;
  }
}

/**
 * Check if Claude Code hooks are installed.
 */
export async function areClaudeHooksInstalled(): Promise<boolean> {
  try {
    const config = JSON.parse(
      await fs.promises.readFile(CLAUDE_SETTINGS_FILE, "utf8")
    );

    const hasHook = config.hooks?.PostToolUse?.some((h: any) =>
      h?.hooks?.some(
        (hh: any) =>
          hh?.command?.includes("agentblame") ||
          hh?.command?.includes("capture.ts")
      )
    );
    return hasHook === true;
  } catch {
    return false;
  }
}

/**
 * Install all hooks (Cursor and Claude Code)
 */
export async function installAllHooks(
  captureScript?: string
): Promise<{ cursor: boolean; claude: boolean }> {
  const cursor = await installCursorHooks(captureScript);
  const claude = await installClaudeHooks(captureScript);
  return { cursor, claude };
}

/**
 * Install global git hook via core.hooksPath
 * This makes agentblame work for ALL repos without per-repo setup
 */
export async function installGlobalGitHook(): Promise<boolean> {
  const globalHooksDir = path.join(AGENTBLAME_ROOT, "git-hooks");
  const hookPath = path.join(globalHooksDir, "post-commit");

  // Find the CLI script in the dist/ directory (always run compiled .js)
  const distDir = getDistDir(__dirname);
  const cliScript = path.resolve(distDir, "index.js");

  const hookContent = `#!/bin/sh
# Agent Blame - Auto-process commits for AI attribution
# Process the commit and attach attribution notes
bun run "${cliScript}" process HEAD 2>/dev/null || true

# Push notes to remote (silently fails if no notes or no remote)
git push origin refs/notes/agentblame:refs/notes/agentblame 2>/dev/null || true
`;

  try {
    await fs.promises.mkdir(globalHooksDir, { recursive: true });
    await fs.promises.writeFile(hookPath, hookContent, { mode: 0o755 });

    // Set global core.hooksPath
    const { execSync } = await import("node:child_process");
    execSync(`git config --global core.hooksPath "${globalHooksDir}"`, {
      stdio: "pipe",
    });

    return true;
  } catch (err) {
    console.error("Failed to install global git hook:", err);
    return false;
  }
}

/**
 * Uninstall global git hook
 */
export async function uninstallGlobalGitHook(): Promise<boolean> {
  try {
    const { execSync } = await import("node:child_process");

    // Remove core.hooksPath config
    execSync("git config --global --unset core.hooksPath", {
      stdio: "pipe",
    });

    // Remove hooks directory
    const globalHooksDir = path.join(AGENTBLAME_ROOT, "git-hooks");
    if (fs.existsSync(globalHooksDir)) {
      await fs.promises.rm(globalHooksDir, { recursive: true });
    }

    return true;
  } catch {
    return true; // Ignore errors (config might not exist)
  }
}

/**
 * Install git post-commit hook to auto-process commits (per-repo)
 */
export async function installGitHook(repoRoot: string): Promise<boolean> {
  const hooksDir = path.join(repoRoot, ".git", "hooks");
  const hookPath = path.join(hooksDir, "post-commit");

  // Find the CLI script in the dist/ directory (always run compiled .js)
  const distDir = getDistDir(__dirname);
  const cliScript = path.resolve(distDir, "index.js");

  const hookContent = `#!/bin/sh
# Agent Blame - Auto-process commits for AI attribution
# Process the commit and attach attribution notes
bun run "${cliScript}" process HEAD 2>/dev/null || true

# Push notes to remote (silently fails if no notes or no remote)
git push origin refs/notes/agentblame:refs/notes/agentblame 2>/dev/null || true
`;

  try {
    await fs.promises.mkdir(hooksDir, { recursive: true });

    // Check if hook already exists
    let existingContent = "";
    try {
      existingContent = await fs.promises.readFile(hookPath, "utf8");
    } catch {
      // File doesn't exist
    }

    // Don't overwrite if already has agentblame
    if (existingContent.includes("agentblame")) {
      return true;
    }

    // Append to existing hook or create new
    if (existingContent && !existingContent.includes("agentblame")) {
      // Append to existing hook
      const newContent = existingContent.trimEnd() + "\n\n" + hookContent.split("\n").slice(1).join("\n");
      await fs.promises.writeFile(hookPath, newContent, { mode: 0o755 });
    } else {
      // Create new hook
      await fs.promises.writeFile(hookPath, hookContent, { mode: 0o755 });
    }

    return true;
  } catch (err) {
    console.error("Failed to install git hook:", err);
    return false;
  }
}

/**
 * Uninstall git post-commit hook
 */
export async function uninstallGitHook(repoRoot: string): Promise<boolean> {
  const hookPath = path.join(repoRoot, ".git", "hooks", "post-commit");

  try {
    if (!fs.existsSync(hookPath)) {
      return true;
    }

    const content = await fs.promises.readFile(hookPath, "utf8");

    if (!content.includes("agentblame")) {
      return true; // Not our hook
    }

    // Remove agentblame lines
    const lines = content.split("\n");
    const newLines = lines.filter(
      (line) => !line.includes("agentblame") && !line.includes("Agent Blame")
    );

    if (newLines.filter((l) => l.trim() && !l.startsWith("#!")).length === 0) {
      // Only shebang left, delete the file
      await fs.promises.unlink(hookPath);
    } else {
      await fs.promises.writeFile(hookPath, newLines.join("\n"), { mode: 0o755 });
    }

    return true;
  } catch (err) {
    console.error("Failed to uninstall git hook:", err);
    return false;
  }
}

/**
 * Uninstall Cursor hooks
 */
export async function uninstallCursorHooks(): Promise<boolean> {
  try {
    if (fs.existsSync(CURSOR_HOOKS_CONFIG)) {
      const config = JSON.parse(
        await fs.promises.readFile(CURSOR_HOOKS_CONFIG, "utf8")
      );

      if (config.hooks?.afterFileEdit) {
        config.hooks.afterFileEdit = config.hooks.afterFileEdit.filter(
          (h: any) =>
            !h?.command?.includes("agentblame") &&
            !h?.command?.includes("capture.ts")
        );
      }

      await fs.promises.writeFile(
        CURSOR_HOOKS_CONFIG,
        JSON.stringify(config, null, 2),
        "utf8"
      );
    }
    return true;
  } catch (err) {
    console.error("Failed to uninstall Cursor hooks:", err);
    return false;
  }
}

/**
 * Uninstall Claude Code hooks
 */
export async function uninstallClaudeHooks(): Promise<boolean> {
  try {
    if (fs.existsSync(CLAUDE_SETTINGS_FILE)) {
      const config = JSON.parse(
        await fs.promises.readFile(CLAUDE_SETTINGS_FILE, "utf8")
      );

      if (config.hooks?.PostToolUse) {
        config.hooks.PostToolUse = config.hooks.PostToolUse.filter(
          (h: any) =>
            !h?.hooks?.some(
              (hh: any) =>
                hh?.command?.includes("agentblame") ||
                hh?.command?.includes("capture.ts")
            )
        );
      }

      await fs.promises.writeFile(
        CLAUDE_SETTINGS_FILE,
        JSON.stringify(config, null, 2),
        "utf8"
      );
    }
    return true;
  } catch (err) {
    console.error("Failed to uninstall Claude hooks:", err);
    return false;
  }
}
