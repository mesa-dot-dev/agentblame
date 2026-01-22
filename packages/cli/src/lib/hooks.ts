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
 * Uses the globally installed agentblame command.
 */
function getHookCommand(
  provider: "cursor" | "claude",
  event?: string
): string {
  const eventArg = event ? ` --event ${event}` : "";
  return `agentblame capture --provider ${provider}${eventArg}`;
}

/**
 * OpenCode plugin template that captures edits and sends to agentblame.
 * The plugin hooks into tool.execute.after for edit/write operations.
 */
const OPENCODE_PLUGIN_TEMPLATE = `import type { Plugin } from "@opencode-ai/plugin"
import { execSync } from "child_process"

export default (async (ctx: any) => {
  return {
    "tool.execute.after": async (input: any, output: any) => {
      // Only capture edit and write tools
      if (input?.tool !== "edit" && input?.tool !== "write") {
        return
      }

      try {
        // Get model info from config
        let model: string | null = null
        if (ctx?.client?.config?.providers) {
          try {
            const configResult = await ctx.client.config.providers()
            const config = configResult?.data || configResult
            const activeProvider = config?.connected?.[0]
            if (activeProvider && config?.default?.[activeProvider]) {
              const modelId = config.default[activeProvider]
              // Try to get display name from provider models
              const provider = config?.providers?.find((p: any) => p.id === activeProvider)
              const modelInfo = provider?.models?.[modelId]
              model = modelInfo?.name || modelId
            }
          } catch {
            // Ignore config errors
          }
        }

        // Build payload based on tool type
        const payload: any = {
          tool: input.tool,
          sessionID: input.sessionID,
          callID: input.callID,
        }

        if (input.tool === "edit") {
          // Edit tool: has before/after content in metadata
          payload.filePath = output?.metadata?.filediff?.file || output?.args?.filePath
          payload.oldString = output?.args?.oldString
          payload.newString = output?.args?.newString
          payload.before = output?.metadata?.filediff?.before
          payload.after = output?.metadata?.filediff?.after
          payload.diff = output?.metadata?.diff
        } else if (input.tool === "write") {
          // Write tool: has content in args
          payload.filePath = output?.args?.filePath || output?.metadata?.filepath
          payload.content = output?.args?.content
        }

        if (model) {
          payload.model = model
        }

        // Call agentblame capture with the payload
        execSync("agentblame capture --provider opencode", {
          input: JSON.stringify(payload),
          cwd: ctx?.directory || process.cwd(),
          stdio: ["pipe", "inherit", "inherit"],
          timeout: 5000,
        })
      } catch {
        // Silent failure - don't interrupt OpenCode
      }
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
    return hasFileEdit === true;
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
 * Install git post-commit hook to auto-process commits (per-repo)
 * Always installs/updates the hook - removes old agentblame section if present and adds latest
 */
export async function installGitHook(repoRoot: string): Promise<boolean> {
  const hooksDir = path.join(repoRoot, ".git", "hooks");
  const hookPath = path.join(hooksDir, "post-commit");

  // Use the globally installed agentblame command
  const hookContent = `#!/bin/sh
# Agent Blame - Auto-process commits for AI attribution
agentblame process HEAD 2>/dev/null || true

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

    // Remove old agentblame section if present (to update to latest)
    if (existingContent.includes("agentblame") || existingContent.includes("Agent Blame")) {
      existingContent = removeAgentBlameSection(existingContent);
    }

    // Append to existing hook or create new
    if (existingContent.trim()) {
      // Append to existing hook (preserves user's other hooks)
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
  post-merge:
    # Only run if the PR was merged (not just closed)
    if: github.event.pull_request.merged == true
    runs-on: ubuntu-latest

    permissions:
      contents: write  # Needed to push notes

    steps:
      - name: Checkout repository
        uses: actions/checkout@v4
        with:
          fetch-depth: 0  # Full history needed for notes and blame
          ref: \${{ github.event.pull_request.base.ref }}  # Checkout target branch (e.g., main)

      - name: Setup Bun
        uses: oven-sh/setup-bun@v1

      - name: Configure git identity
        run: |
          git config user.name "github-actions[bot]"
          git config user.email "github-actions[bot]@users.noreply.github.com"

      - name: Install agentblame
        run: npm install -g @mesadev/agentblame

      - name: Fetch notes, tags, and PR head
        run: |
          git fetch origin refs/notes/agentblame:refs/notes/agentblame 2>/dev/null || echo "No existing attribution notes"
          git fetch origin refs/notes/agentblame-analytics:refs/notes/agentblame-analytics 2>/dev/null || echo "No existing analytics notes"
          git fetch origin --tags 2>/dev/null || echo "No tags to fetch"
          git fetch origin refs/pull/\${{ github.event.pull_request.number }}/head:refs/pull/\${{ github.event.pull_request.number }}/head 2>/dev/null || echo "Could not fetch PR head"

      - name: Process merge (transfer notes + update analytics)
        run: bun \$(npm root -g)/@mesadev/agentblame/dist/post-merge.js
        env:
          PR_NUMBER: \${{ github.event.pull_request.number }}
          PR_TITLE: \${{ github.event.pull_request.title }}
          PR_AUTHOR: \${{ github.event.pull_request.user.login }}
          BASE_REF: \${{ github.event.pull_request.base.ref }}
          BASE_SHA: \${{ github.event.pull_request.base.sha }}
          HEAD_SHA: \${{ github.event.pull_request.head.sha }}
          MERGE_SHA: \${{ github.event.pull_request.merge_commit_sha }}

      - name: Push notes and tags
        run: |
          # Push attribution notes
          git push origin refs/notes/agentblame 2>/dev/null || echo "No attribution notes to push"
          # Push analytics notes
          git push origin refs/notes/agentblame-analytics 2>/dev/null || echo "No analytics notes to push"
          # Push analytics anchor tag
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
