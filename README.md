<div align="center">

# Agent Blame

**Know what the AI wrote. Focus your code reviews where it matters.**

[![npm version](https://img.shields.io/npm/v/@mesadev/agentblame)](https://www.npmjs.com/package/@mesadev/agentblame)
[![License](https://img.shields.io/badge/license-Apache%202.0-blue.svg)](LICENSE)
[![Discord](https://img.shields.io/badge/Discord-Join%20us-5865F2?logo=discord&logoColor=white)](https://discord.gg/2vvEJFrCHV)

[Quick Start](#quick-start) | [Chrome Extension](#chrome-extension-features) | [CLI Reference](#cli-reference) | [Squash & Merge Support](#squash--merge-support)
<br>

<img src="docs/github-view.png" alt="Agent Blame showing AI attribution on a GitHub PR" width="700">

<sub>Orange markers highlight AI-generated lines in GitHub PRs</sub>

<br>

</div>

---

## What It Does

Agent Blame tracks AI-generated code in your Git history:

- **CLI** - See which lines were written by AI in any file
- **Chrome Extension** - View AI markers directly on GitHub PRs
- **Automatic** - Works silently with Cursor, Claude Code, and OpenCode
- **Squash-Safe** - Attribution survives squash and rebase merges

---

## Prerequisites

- [Bun](https://bun.sh/) runtime (required for hooks)
- Git 2.25+
- Cursor, Claude Code, or OpenCode

```bash
# Install Bun if you haven't already
curl -fsSL https://bun.sh/install | bash
```

---

## Quick Start

### 1. One-Time Machine Setup

Run this once on your machine to create the local database:
```bash
bunx @mesadev/agentblame@latest setup
```

### 2. Repository Setup

In each git repository you want to track:
```bash
bunx @mesadev/agentblame@latest init
```

This sets up everything automatically for your repository:
- Editor hooks for Cursor, Claude Code, and OpenCode
- Git post-commit hook for attribution capture
- GitHub Actions workflow for squash/merge support

> **Important:** Restart your editor after running init.

<br>

![Agent Blame Install](docs/agentblame-install.gif)

<br>

---

### 2. Commit the Workflow

In order preserve attribution across when squash merging you need a custom [GitHub Actions workflow](.github/workflows/agentblame.yml).
You can either copy + paste that into your own repo or rely on the init command to do it for you.

```bash
git add .github/workflows/agentblame.yml
git commit -m "Add Agent Blame workflow for squash/merge support"
git push
```

When you merge a PR with squash/rebase, the original commits are replaced with new ones. The GitHub Actions workflow automatically:

1. Detects the merge type (squash, rebase, or regular merge)
2. Retrieves attribution data from the original PR commits
3. Transfers attribution to the new merge commit(s)
4. Pushes the updated notes to the repository

If you do not want to use a workflow you can manually sync attribution after pulling a squash merge locally:

```bash
git pull origin main
agentblame sync
```

---

### 3. Install Chrome Extension

See AI attribution directly on GitHub Pull Requests.

**Option A: Chrome Web Store (Recommended)**

1. Install from the [Chrome Web Store](https://chromewebstore.google.com/detail/agent-blame/ofldnnppeiicgpmpgkbmipbcnhnbgccp)
2. Click the extension icon and add your [GitHub token](https://github.com/settings/tokens) (needs `repo` scope)

**Option B: Manual Install**

1. Download `agentblame-chrome.zip` from [Releases](https://github.com/mesa-dot-dev/agentblame/releases)
2. Go to `chrome://extensions` and enable **Developer mode**
3. Click **Load unpacked** and select the extracted folder
4. Click the extension icon and add your [GitHub token](https://github.com/settings/tokens) (needs `repo` scope)

**GitHub Token**
You can use either GitHub's Fine Grained Tokens (recommended) or the classic tokens.
1. For Fine Grained Tokens it needs to have access to your repo with the `contents` scope
![Fine Grained Token Scope](docs/token-permissions.png)
2. For classic tokens you need to check the `repo` scopes

<br>

![Chrome Extension Install](docs/chrome-install.gif)

<br>

---

### 4. View Attribution

Make AI edits, commit, then view attribution in CLI or GitHub PRs:

```bash
agentblame blame src/auth.ts
```

<br>

![Agent Blame Attribution](docs/agentblame-attribution.gif)

<br>

---

## Chrome Extension Features

### PR Attribution

<!-- TODO: Add screenshot -->
![Agent Blame PR Attribution](docs/pr-attribution.png)

<br>

- **PR summary** at the top of every PR showing AI-generated vs human-written line counts and overall AI percentage
- **File-level badges** in the diff header for each file
- **Line-level gutter markers** that highlight AI-generated lines in orange
- **Hover details** on any gutter marker showing the tool, model, and prompt used to generate that code

### Analytics Dashboard

Full repository-wide analytics, accessible from the **Insights** sidebar on any GitHub repository.

<!-- TODO: Add screenshot -->
![Agent Blame Analytics Dashboard](docs/analytics-dashboard.png)

<br>

- **Summary stats** showing AI vs human percentages, total lines tracked, and commit-to-prompt ratio
- **Tool breakdown** showing which AI tools (Cursor, Claude Code, OpenCode, etc.) generated the most code
- **Model breakdown** with the top models used across the repository
- **Trend charts** for AI code percentage, prompt efficiency, tool usage, and model usage over time
- **Time period filtering** to slice all metrics by past 24 hours, 3 days, week, month, or all time
- **Per-contributor stats** with AI usage percentage, commit-to-prompt ratio, and line counts
- **Recent PR activity** listing the latest PRs with AI attribution badges and diff stats

---

## CLI Reference

Run with `bunx @mesadev/agentblame@latest <command>` or install globally with `npm install -g @mesadev/agentblame`.

| Command | Description |
|---------|-------------|
| `agentblame setup` | One-time machine setup (creates ~/.agentblame database) |
| `agentblame init` | Set up hooks and GitHub Actions workflow for a repo |
| `agentblame clean` | Remove hooks from current repo |
| `agentblame blame <file>` | Show AI attribution for a file |
| `agentblame sync` | Transfer notes after squash/rebase |
| `agentblame config` | Show/set configuration |
| `agentblame debug` | Show detailed debug info |

---

## How It Works

```
┌─────────────────┐     ┌─────────────────┐     ┌─────────────────┐
│  Cursor/Claude  │────▶│   Git Hooks     │────▶│    Database     │
│   Code edits    │     │  capture edits  │     │  stores pending │
└─────────────────┘     └─────────────────┘     └─────────────────┘
                                                        │
                                                        ▼
┌─────────────────┐     ┌─────────────────┐     ┌─────────────────┐
│   CLI/Chrome    │◀────│   Git Notes     │◀────│  Git Commit     │
│  show markers   │     │  store metadata │     │  triggers match │
└─────────────────┘     └─────────────────┘     └─────────────────┘
```

1. **Hooks** intercept edits from AI coding tools
2. **Database** stores pending attributions with content hashes
3. **Commit** triggers matching of committed lines to pending edits
4. **Git Notes** attach attribution metadata to commits
5. **CLI/Extension** read notes to display markers
6. **GitHub Actions** preserve attribution through squash/rebase merges

---

## Troubleshooting

| Problem | Solution |
|---------|----------|
| Database not found | Run `bunx @mesadev/agentblame@latest setup` once on your machine |
| Hooks not capturing | Restart your editor; run `agentblame debug` to check status |
| Notes not on GitHub | Run `git push origin refs/notes/agentblame` |
| Squash merge lost attribution | Ensure workflow is committed; run `agentblame sync` locally |
| Bun not found | Install Bun: `curl -fsSL https://bun.sh/install \| bash` |

---

## Contributing
### Prerequisites

- [Bun](https://bun.sh/) v1.0+
- Git

### Setup

```bash
git clone https://github.com/mesa-dot-dev/agentblame.git
cd agentblame
bun install
bun run build
```

### Commands

```bash
bun run build            # Build all
bun run build:cli        # Build CLI only
bun run build:chrome     # Build Chrome extension only
bun run dev <command>    # Run CLI in dev mode (from packages/cli)
bun run fmt              # Format code
bun run lint             # Lint code
```

### Project Structure

```
agentblame/
├── packages/
│   ├── cli/              # CLI tool
│   │   └── src/
│   │       ├── lib/      # Core utilities
│   │       ├── capture.ts
│   │       ├── blame.ts
│   │       ├── sync.ts
│   │       ├── post-merge.ts
│   │       └── index.ts
│   └── chrome/           # Chrome extension
└── docs/                 # Documentation
```

### Publishing

**npm:**
```bash
cd packages/cli && npm publish --otp=YOUR_CODE
```

**Chrome:** Automatically built on GitHub releases.

### Roadmap
Contributions welcome! Here's what we'd love help with:
- Support for other coding agents
  - VSCode / Copilot
  - Windsurf
  - Antigravity
  - and more!
- Multi-browser extension support
- Support for JJ VCS
---

## License

Apache 2.0

---

<div align="center">

Made by [Mesa.dev](https://mesa.dev)

</div>
