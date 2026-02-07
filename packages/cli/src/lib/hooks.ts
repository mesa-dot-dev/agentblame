/**
 * Hook Installation
 *
 * Install and manage hooks for Cursor and Claude Code.
 * Hooks are installed at repo-level for isolation.
 */

import * as fs from "node:fs";
import * as path from "node:path";

/**
 * Get the Cursor hooks.json path for a repo.
 */
export function getCursorHooksPath(repoRoot: string): string {
  return path.join(repoRoot, ".cursor", "hooks.json");
}

/**
 * Get the Claude Code settings.json path for a repo.
 */
export function getClaudeSettingsPath(repoRoot: string): string {
  return path.join(repoRoot, ".claude", "settings.json");
}

/**
 * Get the OpenCode plugin directory path for a repo.
 */
export function getOpenCodePluginDir(repoRoot: string): string {
  return path.join(repoRoot, ".opencode", "plugin");
}

/**
 * Get the OpenCode agentblame plugin file path for a repo.
 */
export function getOpenCodePluginPath(repoRoot: string): string {
  return path.join(getOpenCodePluginDir(repoRoot), "agentblame.ts");
}


/**
 * Generate the hook command for a given provider.
 * Uses bunx to run agentblame - no global install required.
 * Fails silently if bunx/bun is not available.
 */
function getHookCommand(
  provider: "cursor" | "claude",
  event?: string
): string {
  const eventArg = event ? ` --event ${event}` : "";

  // Cursor's shell has a bug where "command -v bunx && ..." breaks stdin piping.
  // So for Cursor, we skip the check and just run bunx directly.
  // For Claude, we keep the check since it works correctly there.
  if (provider === "cursor") {
    return `bunx @mesadev/agentblame capture --provider ${provider}${eventArg} 2>/dev/null || true`;
  }

  return `command -v bunx >/dev/null 2>&1 && bunx @mesadev/agentblame capture --provider ${provider}${eventArg} 2>/dev/null || true`;
}

/**
 * OpenCode plugin template that captures edits and prompts, and sends to agentblame.
 * BULLETPROOF: Uses both tool.execute.before and tool.execute.after for accurate capture.
 * The plugin hooks into:
 * - message.updated: to capture user prompts
 * - tool.execute.before: to capture file state BEFORE edit (checkpoint)
 * - tool.execute.after: to capture file state AFTER edit
 */
const OPENCODE_PLUGIN_TEMPLATE = `import type { Plugin } from "@opencode-ai/plugin"
import { execSync } from "child_process"

// Cache file paths from before hook (keyed by callID) so after hook can use them
const callFiles = new Map<string, string>()

// Store latest prompt and model per session from chat.message hook
const sessionPrompts = new Map<string, string>()
const sessionModels = new Map<string, string>()

export default (async (ctx) => {
  // Check if bunx is available (for running agentblame)
  let hasBunx = false
  try {
    execSync("command -v bunx", { stdio: "pipe" })
    hasBunx = true
  } catch {
    // bunx not installed - all captures will be no-ops
  }

  function capture(payload: any): void {
    if (!hasBunx) return  // Skip if bunx not installed
    try {
      execSync("bunx @mesadev/agentblame capture --provider opencode", {
        input: JSON.stringify(payload),
        cwd: ctx.directory || process.cwd(),
        stdio: ["pipe", "inherit", "inherit"],
        timeout: 5000,
      })
    } catch {
      // Silent failure - don't interrupt OpenCode
    }
  }

  return {
    // Capture user prompts and model info when a new message is created
    // Fires BEFORE tool execution starts (verified from OpenCode source: prompt.ts line 1193)
    //
    // Signature from @opencode-ai/plugin Hooks interface:
    //   (input: { sessionID, agent?, model?: { providerID, modelID }, messageID?, variant? },
    //    output: { message: UserMessage, parts: Part[] }) => void
    //
    // UserMessage has { role, model, sessionID } but NO content field
    // Content is in output.parts as Part objects: { type: "text", text: string, synthetic?: boolean }
    "chat.message": async (input, output) => {
      try {
        const sessionID = input.sessionID

        // Capture model from message (always has the resolved model)
        const message = output?.message
        if (message?.model) {
          sessionModels.set(sessionID, message.model.modelID || message.model.providerID)
        }
        // Fallback: model from input (may be undefined if user didn't specify)
        if (!sessionModels.has(sessionID) && input.model) {
          sessionModels.set(sessionID, input.model.modelID || input.model.providerID)
        }

        // Capture prompt text from parts (only for user messages)
        if (message?.role === "user" && output?.parts) {
          const textParts = output.parts
            .filter((p: any) => p.type === "text" && p.text && !p.synthetic)
            .map((p: any) => p.text)
          if (textParts.length > 0) {
            sessionPrompts.set(sessionID, textParts.join("\\n"))
          }
        }
      } catch {
        // Silent failure
      }
    },

    // Capture file state BEFORE edit (same as Claude PreToolUse)
    // Signature: (input: { tool, sessionID, callID }, output: { args }) => void
    "tool.execute.before": async (input, output) => {
      if (input.tool !== "edit" && input.tool !== "write") {
        return
      }

      const filePath = output?.args?.filePath
      if (!filePath) return

      // Cache filePath so after hook can retrieve it (after hook has no args)
      callFiles.set(input.callID, filePath)

      capture({
        tool: input.tool,
        sessionID: input.sessionID,
        filePath,
        hook_event: "before",
      })
    },

    // Capture file state AFTER edit (same as Claude PostToolUse)
    // Signature: (input: { tool, sessionID, callID }, output: { title, output, metadata }) => void
    "tool.execute.after": async (input, output) => {
      if (input.tool !== "edit" && input.tool !== "write") {
        return
      }

      // Retrieve filePath cached from before hook
      const filePath = callFiles.get(input.callID)
      callFiles.delete(input.callID)
      if (!filePath) return

      const model = sessionModels.get(input.sessionID)
      const prompt = sessionPrompts.get(input.sessionID)

      capture({
        tool: input.tool,
        sessionID: input.sessionID,
        filePath,
        hook_event: "after",
        ...(model && { model }),
        ...(prompt && { prompt }),
      })
    },
  }
}) satisfies Plugin
`;

/**
 * Install the Cursor hooks at repo-level (.cursor/hooks.json)
 */
export async function installCursorHooks(repoRoot: string): Promise<boolean> {
  if (process.platform === "win32") {
    console.error("Windows is not supported yet");
    return false;
  }

  const hooksPath = getCursorHooksPath(repoRoot);

  try {
    // Create .cursor directory if it doesn't exist
    await fs.promises.mkdir(path.dirname(hooksPath), {
      recursive: true,
    });

    let config: any = {};
    try {
      const existing = await fs.promises.readFile(hooksPath, "utf8");
      config = JSON.parse(existing || "{}");
    } catch {
      // File doesn't exist or invalid JSON
    }

    config.version = config.version ?? 1;
    config.hooks = config.hooks ?? {};

    const fileEditCommand = getHookCommand("cursor", "afterFileEdit");
    const promptCommand = getHookCommand("cursor", "beforeSubmitPrompt");

    // Configure beforeSubmitPrompt to capture user prompts
    config.hooks.beforeSubmitPrompt = config.hooks.beforeSubmitPrompt ?? [];
    if (!Array.isArray(config.hooks.beforeSubmitPrompt)) {
      config.hooks.beforeSubmitPrompt = [];
    }

    // Remove any existing agentblame hooks first
    config.hooks.beforeSubmitPrompt = config.hooks.beforeSubmitPrompt.filter(
      (h: any) => !h?.command?.includes("agentblame") && !h?.command?.includes("capture.ts")
    );
    config.hooks.beforeSubmitPrompt.push({ command: promptCommand });

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
      hooksPath,
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
 * Install the Claude Code hooks at repo-level (.claude/settings.json)
 * BULLETPROOF: Uses both PreToolUse and PostToolUse for accurate before/after capture
 */
export async function installClaudeHooks(repoRoot: string): Promise<boolean> {
  if (process.platform === "win32") {
    console.error("Windows is not supported yet");
    return false;
  }

  const settingsPath = getClaudeSettingsPath(repoRoot);

  try {
    // Create .claude directory if it doesn't exist
    await fs.promises.mkdir(path.dirname(settingsPath), { recursive: true });

    let config: any = {};
    try {
      const existing = await fs.promises.readFile(settingsPath, "utf8");
      config = JSON.parse(existing || "{}");
    } catch {
      // File doesn't exist or invalid JSON
    }

    config.hooks = config.hooks ?? {};

    const hookCommand = getHookCommand("claude");

    // Helper to remove existing agentblame hooks
    const removeAgentblameHooks = (hooks: any[]) =>
      hooks.filter(
        (h: any) =>
          !h?.hooks?.some(
            (hh: any) =>
              hh?.command?.includes("agentblame") ||
              hh?.command?.includes("capture.ts")
          )
      );

    // BULLETPROOF: Configure PreToolUse to capture file state BEFORE edit
    // Only for file-modifying tools (Edit, Write, MultiEdit)
    // Note: Using separate matchers because regex patterns like (?i) don't work
    config.hooks.PreToolUse = config.hooks.PreToolUse ?? [];
    if (!Array.isArray(config.hooks.PreToolUse)) {
      config.hooks.PreToolUse = [];
    }
    config.hooks.PreToolUse = removeAgentblameHooks(config.hooks.PreToolUse);
    // Add separate matcher for each file-modifying tool
    for (const toolName of ["Edit", "Write", "MultiEdit"]) {
      config.hooks.PreToolUse.push({
        matcher: toolName,
        hooks: [{ type: "command", command: hookCommand }],
      });
    }

    // Configure PostToolUse for ALL tools
    // This captures file state after edit and read-only tools for analytics
    config.hooks.PostToolUse = config.hooks.PostToolUse ?? [];
    if (!Array.isArray(config.hooks.PostToolUse)) {
      config.hooks.PostToolUse = [];
    }
    config.hooks.PostToolUse = removeAgentblameHooks(config.hooks.PostToolUse);
    config.hooks.PostToolUse.push({
      matcher: ".*",
      hooks: [{ type: "command", command: hookCommand, async: true }],
    });

    await fs.promises.writeFile(
      settingsPath,
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
 * Install the OpenCode hooks at repo-level (.opencode/plugin/agentblame.ts)
 */
export async function installOpenCodeHooks(repoRoot: string): Promise<boolean> {
  if (process.platform === "win32") {
    console.error("Windows is not supported yet");
    return false;
  }

  const pluginDir = getOpenCodePluginDir(repoRoot);
  const pluginPath = getOpenCodePluginPath(repoRoot);

  try {
    // Create .opencode/plugin directory if it doesn't exist
    await fs.promises.mkdir(pluginDir, { recursive: true });

    // Write the plugin file (always overwrite to ensure latest version)
    await fs.promises.writeFile(pluginPath, OPENCODE_PLUGIN_TEMPLATE, "utf8");

    return true;
  } catch (err) {
    console.error("Failed to install OpenCode hooks:", err);
    return false;
  }
}

/**
 * Check if OpenCode hooks are installed for a repo.
 */
export async function areOpenCodeHooksInstalled(repoRoot: string): Promise<boolean> {
  try {
    const pluginPath = getOpenCodePluginPath(repoRoot);
    const content = await fs.promises.readFile(pluginPath, "utf8");
    return content.includes("agentblame");
  } catch {
    return false;
  }
}

/**
 * Uninstall OpenCode hooks from a repo
 */
export async function uninstallOpenCodeHooks(repoRoot: string): Promise<boolean> {
  try {
    const pluginPath = getOpenCodePluginPath(repoRoot);
    if (fs.existsSync(pluginPath)) {
      await fs.promises.unlink(pluginPath);
    }
    return true;
  } catch (err) {
    console.error("Failed to uninstall OpenCode hooks:", err);
    return false;
  }
}

/**
 * Check if Cursor hooks are installed for a repo.
 */
export async function areCursorHooksInstalled(repoRoot: string): Promise<boolean> {
  try {
    const hooksPath = getCursorHooksPath(repoRoot);
    const config = JSON.parse(
      await fs.promises.readFile(hooksPath, "utf8")
    );

    const hasFileEdit = config.hooks?.afterFileEdit?.some(
      (h: any) =>
        h?.command?.includes("agentblame") || h?.command?.includes("capture.ts")
    );
    const hasPrompt = config.hooks?.beforeSubmitPrompt?.some(
      (h: any) =>
        h?.command?.includes("agentblame") || h?.command?.includes("capture.ts")
    );
    return hasFileEdit === true && hasPrompt === true;
  } catch {
    return false;
  }
}

/**
 * Check if Claude Code hooks are installed for a repo.
 */
export async function areClaudeHooksInstalled(repoRoot: string): Promise<boolean> {
  try {
    const settingsPath = getClaudeSettingsPath(repoRoot);
    const config = JSON.parse(
      await fs.promises.readFile(settingsPath, "utf8")
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
 * Install all hooks (Cursor, Claude Code, and OpenCode) for a repo
 */
export async function installAllHooks(
  repoRoot: string
): Promise<{ cursor: boolean; claude: boolean; opencode: boolean }> {
  const cursor = await installCursorHooks(repoRoot);
  const claude = await installClaudeHooks(repoRoot);
  const opencode = await installOpenCodeHooks(repoRoot);
  return { cursor, claude, opencode };
}

/**
 * Detected git hooks setup type
 */
export type HooksSetupType =
  | { type: "custom"; path: string }
  | { type: "standard"; path: string };

/**
 * Detect where git hooks should be installed.
 * Simple approach:
 *   1. Check core.hooksPath (explicit git config - works for husky, lefthook, custom setups)
 *   2. Fall back to .git/hooks/ (standard location)
 */
export async function detectHooksSetup(repoRoot: string): Promise<HooksSetupType> {
  // Check for custom hooks path via git config (core.hooksPath)
  // This catches husky, lefthook, and any custom setup
  try {
    const { execSync } = await import("node:child_process");
    const customPath = execSync("git config core.hooksPath", {
      cwd: repoRoot,
      encoding: "utf8",
      stdio: ["pipe", "pipe", "pipe"],
    }).trim();
    if (customPath) {
      const absolutePath = path.isAbsolute(customPath)
        ? customPath
        : path.join(repoRoot, customPath);
      return { type: "custom", path: absolutePath };
    }
  } catch {
    // No custom hooks path configured
  }

  // Fall back to standard .git/hooks/
  return { type: "standard", path: path.join(repoRoot, ".git", "hooks") };
}

/**
 * Check if git hook is already installed
 */
export async function isGitHookInstalled(repoRoot: string): Promise<boolean> {
  const setup = await detectHooksSetup(repoRoot);
  const hookPath = path.join(setup.path, "post-commit");

  try {
    const content = await fs.promises.readFile(hookPath, "utf8");
    return content.includes("agentblame");
  } catch {
    return false;
  }
}

/**
 * Lazily install git hook on first capture.
 * Called from capture command to auto-setup without user running enable.
 */
export async function ensureGitHook(repoRoot: string): Promise<void> {
  const installed = await isGitHookInstalled(repoRoot);
  if (!installed) {
    await installGitHookSmart(repoRoot);
  }
}

/**
 * Install git hook by detecting existing setup and integrating appropriately.
 * Simple approach:
 *   1. Detect hooks directory (core.hooksPath or .git/hooks/)
 *   2. Create/append to post-commit hook there
 */
export async function installGitHookSmart(
  repoRoot: string
): Promise<{ success: boolean; method: string }> {
  const setup = await detectHooksSetup(repoRoot);
  const hooksDir = setup.path;
  const hookPath = path.join(hooksDir, "post-commit");
  const methodName = setup.type === "custom"
    ? `custom (${path.basename(hooksDir)}/)`
    : ".git/hooks/";

  try {
    // Ensure hooks directory exists
    await fs.promises.mkdir(hooksDir, { recursive: true });

    let existingContent = "";
    try {
      existingContent = await fs.promises.readFile(hookPath, "utf8");
    } catch {
      // File doesn't exist
    }

    // Check if already installed
    if (existingContent.includes("agentblame")) {
      return { success: true, method: `${methodName} (already installed)` };
    }

    // Remove old agentblame section if present (for updates)
    if (existingContent.includes("Agent Blame")) {
      existingContent = removeAgentBlameSection(existingContent);
    }

    // Our hook script
    const agentblameScript = `# Agent Blame - Auto-process commits for AI attribution
# Silently skips if bunx is not installed
command -v bunx >/dev/null 2>&1 && bunx @mesadev/agentblame process HEAD 2>/dev/null || true

# Push notes to remote - if successful, configure fetch refspec for auto-pull
if git push origin refs/notes/agentblame:refs/notes/agentblame 2>/dev/null; then
  # Add fetch refspec if not already configured (so notes auto-fetch on git pull)
  git config --local --get-all remote.origin.fetch 2>/dev/null | grep -q 'refs/notes/agentblame' || \
    git config --local --add remote.origin.fetch '+refs/notes/agentblame:refs/notes/agentblame' 2>/dev/null
fi

# Background update - fetch latest version for future captures (fire & forget)
(nohup bunx @mesadev/agentblame@latest --version >/dev/null 2>&1 &) 2>/dev/null`;

    if (existingContent.trim()) {
      // Append to existing hook
      const newContent = existingContent.trimEnd() + "\n\n" + agentblameScript + "\n";
      await fs.promises.writeFile(hookPath, newContent, { mode: 0o755 });
    } else {
      // Create new hook
      const newContent = `#!/bin/sh\n${agentblameScript}\n`;
      await fs.promises.writeFile(hookPath, newContent, { mode: 0o755 });
    }

    return { success: true, method: methodName };
  } catch (err) {
    console.error("Failed to install git hook:", err);
    return { success: false, method: methodName };
  }
}

/**
 * Remove Agent Blame section from hook content (for updates)
 * Removes all agentblame-related lines including the notes push comment
 */
function removeAgentBlameSection(content: string): string {
  const lines = content.split("\n");
  const result: string[] = [];

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const nextLine = lines[i + 1] || "";

    // Skip lines containing agentblame or Agent Blame
    if (line.includes("agentblame") || line.includes("Agent Blame")) {
      continue;
    }

    // Skip "Push notes to remote" comment if followed by agentblame notes push
    if (line.includes("Push notes to remote") && nextLine.includes("refs/notes/agentblame")) {
      continue;
    }

    // Skip consecutive empty lines
    if (line.trim() === "" && result.length > 0 && result[result.length - 1].trim() === "") {
      continue;
    }

    result.push(line);
  }

  return result.join("\n");
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

    if (!content.includes("agentblame") && !content.includes("Agent Blame")) {
      return true; // Not our hook
    }

    // Remove agentblame section
    const newContent = removeAgentBlameSection(content);

    // Check if only shebang/empty lines left
    const meaningfulLines = newContent.split("\n").filter(
      (l) => l.trim() && !l.startsWith("#!")
    );

    if (meaningfulLines.length === 0) {
      // Only shebang left, delete the file
      await fs.promises.unlink(hookPath);
    } else {
      await fs.promises.writeFile(hookPath, newContent, { mode: 0o755 });
    }

    return true;
  } catch (err) {
    console.error("Failed to uninstall git hook:", err);
    return false;
  }
}

/**
 * Uninstall Cursor hooks from a repo
 */
export async function uninstallCursorHooks(repoRoot: string): Promise<boolean> {
  try {
    const hooksPath = getCursorHooksPath(repoRoot);
    if (fs.existsSync(hooksPath)) {
      const config = JSON.parse(
        await fs.promises.readFile(hooksPath, "utf8")
      );

      if (config.hooks?.beforeSubmitPrompt) {
        config.hooks.beforeSubmitPrompt = config.hooks.beforeSubmitPrompt.filter(
          (h: any) =>
            !h?.command?.includes("agentblame") &&
            !h?.command?.includes("capture.ts")
        );
      }

      if (config.hooks?.afterFileEdit) {
        config.hooks.afterFileEdit = config.hooks.afterFileEdit.filter(
          (h: any) =>
            !h?.command?.includes("agentblame") &&
            !h?.command?.includes("capture.ts")
        );
      }

      await fs.promises.writeFile(
        hooksPath,
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
 * Uninstall Claude Code hooks from a repo
 */
export async function uninstallClaudeHooks(repoRoot: string): Promise<boolean> {
  try {
    const settingsPath = getClaudeSettingsPath(repoRoot);
    if (fs.existsSync(settingsPath)) {
      const config = JSON.parse(
        await fs.promises.readFile(settingsPath, "utf8")
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
        settingsPath,
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

/**
 * GitHub Actions workflow content for handling squash/rebase merges and analytics
 */
const GITHUB_WORKFLOW_CONTENT = `name: Agent Blame

on:
  pull_request:
    types: [closed]

jobs:
  agent-blame-post-merge:
    name: Agent Blame - Post Merge Attribution
    if: github.event.pull_request.merged == true
    runs-on: ubuntu-latest

    permissions:
      contents: write

    steps:
      - name: Checkout repository
        uses: actions/checkout@v4
        with:
          fetch-depth: 0
          ref: \${{ github.event.pull_request.base.ref }}

      - name: Setup Bun
        uses: oven-sh/setup-bun@v1

      - name: Configure git identity
        run: |
          git config user.name "github-actions[bot]"
          git config user.email "github-actions[bot]@users.noreply.github.com"

      - name: Agent Blame - Fetch attribution data
        run: |
          git fetch origin refs/notes/agentblame:refs/notes/agentblame 2>/dev/null || echo "No existing attribution notes"
          git fetch origin refs/notes/agentblame-analytics:refs/notes/agentblame-analytics 2>/dev/null || echo "No existing analytics notes"
          git fetch origin --tags 2>/dev/null || echo "No tags to fetch"
          git fetch origin refs/pull/\${{ github.event.pull_request.number }}/head:refs/pull/\${{ github.event.pull_request.number }}/head 2>/dev/null || echo "Could not fetch PR head"

      - name: Agent Blame - Transfer attribution to merge commit
        run: bunx @mesadev/agentblame@latest post-merge
        env:
          PR_NUMBER: \${{ github.event.pull_request.number }}
          PR_TITLE: \${{ github.event.pull_request.title }}
          PR_AUTHOR: \${{ github.event.pull_request.user.login }}
          BASE_REF: \${{ github.event.pull_request.base.ref }}
          BASE_SHA: \${{ github.event.pull_request.base.sha }}
          HEAD_SHA: \${{ github.event.pull_request.head.sha }}
          MERGE_SHA: \${{ github.event.pull_request.merge_commit_sha }}
          MERGED_AT: \${{ github.event.pull_request.merged_at }}

      - name: Agent Blame - Push attribution notes
        run: |
          git push origin refs/notes/agentblame 2>/dev/null || echo "No attribution notes to push"
          git push origin refs/notes/agentblame-analytics 2>/dev/null || echo "No analytics notes to push"
          git push origin agentblame-analytics-anchor 2>/dev/null || echo "No analytics tag to push"
`;

/**
 * Install GitHub Actions workflow for handling squash/rebase merges
 * Always overwrites to ensure the latest version is installed
 */
export async function installGitHubAction(repoRoot: string): Promise<boolean> {
  const workflowDir = path.join(repoRoot, ".github", "workflows");
  const workflowPath = path.join(workflowDir, "agentblame.yml");

  try {
    // Create workflows directory if it doesn't exist
    await fs.promises.mkdir(workflowDir, { recursive: true });

    // Always write the latest workflow file
    await fs.promises.writeFile(workflowPath, GITHUB_WORKFLOW_CONTENT, "utf8");

    return true;
  } catch (err) {
    console.error("Failed to install GitHub Action:", err);
    return false;
  }
}

/**
 * Uninstall GitHub Actions workflow
 */
export async function uninstallGitHubAction(repoRoot: string): Promise<boolean> {
  const workflowPath = path.join(repoRoot, ".github", "workflows", "agentblame.yml");

  try {
    if (fs.existsSync(workflowPath)) {
      await fs.promises.unlink(workflowPath);
    }
    return true;
  } catch (err) {
    console.error("Failed to uninstall GitHub Action:", err);
    return false;
  }
}
