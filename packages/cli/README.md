# Agent Blame

Track AI-generated vs human-written code. Know what the AI wrote and focus your code reviews where it matters.

## Prerequisites

- [Bun](https://bun.sh/) runtime (required for hooks)
- Git 2.25+
- Cursor, Claude Code, or OpenCode

```bash
# Install Bun if you haven't already
curl -fsSL https://bun.sh/install | bash
```

## Installation

```bash
npm install -g @mesadev/agentblame
```

## Setup

In your git repository:
```bash
agentblame init
```

This sets up:
- Editor hooks for Cursor, Claude Code, and OpenCode
- Git post-commit hook for attribution capture
- GitHub Actions workflow for squash/merge support

**Note:** Restart your editor after running this.

## Usage

1. Make AI edits in Cursor, Claude Code, or OpenCode
2. Commit your changes (attribution attached automatically)
```bash
git commit -m "new python file"
```
```
┌──────────────────────────────────────────────────────────────────────┐
│                            Agent Blame v3                            │
├──────────────────────────────────────────────────────────────────────┤
│  Commit: 7bdf773b                                                    │
│  Files: 1                                                            │
├──────────────────────────────────────────────────────────────────────┤
│  Sessions:                                                           │
│    b4deb96e [cursor - gpt-5.2-codex]                                 │
│      [P13] "Add a new file hello_world.py in python and a..."        │
├──────────────────────────────────────────────────────────────────────┤
│  Summary:                                                            │
│  ██████████████████████████████████████████████████                  │
│  AI:   2 lines (100%)    Human:   0 lines (  0%)                     │
└──────────────────────────────────────────────────────────────────────┘ 
```

3. View attribution:

```bash
agentblame blame <file>
```

### Example Output

```
  python/hello_world.py
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

## CLI Commands

```bash
agentblame init              # Set up hooks for current repo
agentblame clean             # Remove hooks from current repo
agentblame blame <file>      # Show AI attribution
agentblame sync              # Transfer notes after squash/rebase
agentblame config            # Show/set configuration
agentblame debug             # Show detailed debug info
```

## Chrome Extension

See AI markers on GitHub PRs with our Chrome extension.

Get it from the [Chrome Web Store](https://chromewebstore.google.com/detail/agent-blame/ofldnnppeiicgpmpgkbmipbcnhnbgccp) or the [GitHub repository](https://github.com/mesa-dot-dev/agentblame#chrome-extension).

## Troubleshooting

| Problem | Solution |
|---------|----------|
| Hooks not capturing | Restart your editor; run `agentblame debug` to check status |
| Notes not on GitHub | Run `git push origin refs/notes/agentblame` |
| Squash merge lost attribution | Ensure workflow is committed; run `agentblame sync` locally |
| Bun not found | Install Bun: `curl -fsSL https://bun.sh/install \| bash` |

## More Information

For full documentation, Chrome extension installation, and contributing guidelines, visit the [GitHub repository](https://github.com/mesa-dot-dev/agentblame).

## License

Apache 2.0
