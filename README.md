<div align="center">

# Agent Blame

**Know what the AI wrote. Focus your code reviews where it matters.**

[![npm version](https://img.shields.io/npm/v/@mesadev/agentblame)](https://www.npmjs.com/package/@mesadev/agentblame)
[![License](https://img.shields.io/badge/license-Apache%202.0-blue.svg)](LICENSE)

[Quick Start](#quick-start) | [CLI Reference](#cli-reference)

</div>

---

## What It Does

Agent Blame tracks AI-generated code in your Git history:

- **CLI** - See which lines were written by AI in any file
- **Chrome Extension** - View AI markers directly on GitHub PRs
- **Automatic** - Works silently with Cursor and Claude Code

---

## Quick Start

### 1. Install CLI & Set Up Hooks

```bash
npm install -g @mesadev/agentblame
agentblame install
```

> Restart Cursor/Claude Code after installation.

<br>

![Agent Blame Install](docs/agentblame-install.gif)

<br>

---

### 2. Install Chrome Extension

See AI attribution directly on GitHub Pull Requests.

1. Download `agentblame-chrome.zip` from [Releases](https://github.com/mesa-dot-dev/agentblame/releases)
2. Go to `chrome://extensions` and enable **Developer mode**
3. Click **Load unpacked** and select the extracted folder
4. Click the extension icon and add your [GitHub token](https://github.com/settings/tokens) (needs `repo` scope)

<br>

![Chrome Extension Install](docs/chrome-install.gif)

<br>

---

### 3. View Attribution

Make AI edits, commit, then view attribution in CLI or GitHub PRs:

```bash
agentblame blame src/auth.ts
```

<br>

![Agent Blame Attribution](docs/agentblame-attribution.gif)

<br>

---

## Chrome Extension Features

- AI percentage badge per file
- Sparkle markers on AI-generated lines
- PR summary showing total AI vs human code

---

## CLI Reference

| Command | Description |
|---------|-------------|
| `agentblame install` | Set up hooks (current repo) |
| `agentblame install --global` | Set up hooks (all repos) |
| `agentblame uninstall` | Remove hooks |
| `agentblame blame <file>` | Show AI attribution |
| `agentblame blame --summary` | Summary only |
| `agentblame blame --json` | JSON output |
| `agentblame status` | Show pending edits |
| `agentblame cleanup` | Clean old database entries |
| `agentblame sync` | Transfer notes after squash/rebase |

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

---

## Troubleshooting

| Problem | Solution |
|---------|----------|
| Hooks not capturing | Restart Cursor/Claude Code |
| Notes not on GitHub | Run `git push origin refs/notes/agentblame` |
| After squash/rebase | Run `agentblame sync` |

---

<details>
<summary><strong>For Developers</strong></summary>

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

</details>

---

## License

Apache 2.0

---

<div align="center">

Made by [Mesa.dev](https://mesa.dev)

</div>
