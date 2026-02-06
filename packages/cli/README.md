# Agent Blame CLI

**Know what the AI wrote. Focus your code reviews where it matters.**

[![npm version](https://img.shields.io/npm/v/@mesadev/agentblame)](https://www.npmjs.com/package/@mesadev/agentblame)
[![License](https://img.shields.io/badge/license-Apache%202.0-blue.svg)](https://github.com/mesa-dot-dev/agentblame/blob/main/LICENSE)

Track AI-generated vs human-written code in your Git history. Works with Cursor, Claude Code, and OpenCode.

## Prerequisites

- [Bun](https://bun.sh/) runtime (required for hooks)
- Git 2.25+
- Cursor, Claude Code, or OpenCode

```bash
# Install Bun if you haven't already
curl -fsSL https://bun.sh/install | bash
```

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

This sets up everything automatically:
- Editor hooks for Cursor, Claude Code, and OpenCode
- Git post-commit hook for attribution capture
- GitHub Actions workflow for squash/merge support

> **Important:** Restart your editor after running init.

### 3. View Attribution

Make AI edits, commit, then view attribution:

```bash
bunx @mesadev/agentblame@latest blame src/auth.ts
```

Example output:
```
  src/auth.ts
  ──────────────────────────────────────────────────────────────────────
  Prompts:
  [P1] Cursor (gpt-5.2-codex)
       "Add a new file hello_world.py in python and add two print st..."
       Tools: edit: 1
  ──────────────────────────────────────────────────────────────────────
  7bdf773 Murali Varad 2026-02-03 │ P1 │ 1 │ print("Hello, World1")
  7bdf773 Murali Varad 2026-02-03 │ P1 │ 2 │ print("Hello, World2")
  ──────────────────────────────────────────────────────────────────────
  ████████████████████████████████████████
  AI: 2 lines (100%)  │  Human: 0 lines (0%)
```

## CLI Reference

| Command | Description |
|---------|-------------|
| `bunx @mesadev/agentblame@latest setup` | One-time machine setup (creates ~/.agentblame database) |
| `bunx @mesadev/agentblame@latest init` | Set up hooks and GitHub Actions workflow for a repo |
| `bunx @mesadev/agentblame@latest clean` | Remove hooks from current repo |
| `bunx @mesadev/agentblame@latest blame <file>` | Show AI attribution for a file |
| `bunx @mesadev/agentblame@latest sync` | Transfer notes after squash/rebase |
| `bunx @mesadev/agentblame@latest config` | Show/set configuration |
| `bunx @mesadev/agentblame@latest debug` | Show detailed debug info |

### Configuration

```bash
# Show current config
bunx @mesadev/agentblame@latest config

# Disable prompt content storage (enabled by default)
bunx @mesadev/agentblame@latest config storePromptContent false
```

## How It Works

```
┌─────────────────┐     ┌─────────────────┐     ┌─────────────────┐
│  Cursor/Claude  │────▶│   Git Hooks     │────▶│    Database     │
│   Code edits    │     │  capture edits  │     │  stores pending │
└─────────────────┘     └─────────────────┘     └─────────────────┘
                                                        │
                                                        ▼
┌─────────────────┐     ┌─────────────────┐     ┌─────────────────┐
│  CLI/Extension  │◀────│   Git Notes     │◀────│  Git Commit     │
│  show markers   │     │  store metadata │     │  triggers match │
└─────────────────┘     └─────────────────┘     └─────────────────┘
```

1. **Hooks** intercept edits from AI coding tools
2. **Database** stores pending attributions with content hashes
3. **Commit** triggers matching of committed lines to pending edits
4. **Git Notes** attach attribution metadata to commits
5. **CLI/Extension** read notes to display markers

## Troubleshooting

| Problem | Solution |
|---------|----------|
| Database not found | Run `bunx @mesadev/agentblame@latest setup` once on your machine |
| Hooks not capturing | Restart your editor; run `bunx @mesadev/agentblame@latest debug` to check status |
| Notes not on GitHub | Run `git push origin refs/notes/agentblame` |
| Squash merge lost attribution | Ensure workflow is committed; run `bunx @mesadev/agentblame@latest sync` locally |
| Bun not found | Install Bun: `curl -fsSL https://bun.sh/install \| bash` |

## Browser Extensions

See AI attribution directly on GitHub PRs:
- [Chrome Web Store](https://chromewebstore.google.com/detail/agent-blame/ofldnnppeiicgpmpgkbmipbcnhnbgccp)
- [Firefox Add-ons](https://addons.mozilla.org/en-US/firefox/addon/agentblame/)

## More Information

For full documentation, contributing guidelines, and source code, visit the [GitHub repository](https://github.com/mesa-dot-dev/agentblame).

## License

Apache 2.0
