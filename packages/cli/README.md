# Agent Blame

Track AI-generated vs human-written code. Know what the AI wrote and focus your code reviews where it matters.

## Prerequisites

- [Bun](https://bun.sh/) runtime (required for hooks)
- Git 2.25+
- Cursor or Claude Code

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
- Editor hooks for Cursor and Claude Code
- Git post-commit hook for attribution capture
- GitHub Actions workflow for squash/merge support

**Note:** Restart Cursor/Claude Code after running this.

## Usage

1. Make AI edits in Cursor or Claude Code
2. Commit your changes (attribution attached automatically)
3. View attribution:

```bash
agentblame blame <file>
```

### Example Output

```
  src/auth.ts
  ──────────────────────────────────────────────────────────────────────

a1b2c3d alice  2024-01-15 ✨ Cursor - claude-3.5-sonnet    │  1 │ export function login() {
a1b2c3d alice  2024-01-15 ✨ Cursor - claude-3.5-sonnet    │  2 │   const user = await db.find();
def456b bob    2024-01-20                                   │  3 │   // Rate limiting
a1b2c3d alice  2024-01-15 ✨ Claude Code                    │  5 │   return validate(user);

  ██████████████████████████████░░░░░░░░░░░░░░░░░░░░
  ✨ AI: 3 (75%)  │  👤 Human: 1 (25%)
```

## CLI Commands

```bash
agentblame init              # Set up hooks for current repo
agentblame init --force      # Set up hooks and clean up old global install
agentblame clean             # Remove hooks from current repo
agentblame clean --force     # Also clean up old global install
agentblame blame <file>      # Show AI attribution
agentblame blame --summary   # Summary only
agentblame blame --json      # JSON output
agentblame status            # Show pending edits
agentblame sync              # Transfer notes after squash/rebase
agentblame prune             # Remove old database entries
```

## Chrome Extension

See AI markers on GitHub PRs with our Chrome extension.

Get it from the [Chrome Web Store](https://chromewebstore.google.com/detail/agent-blame/ofldnnppeiicgpmpgkbmipbcnhnbgccp) or the [GitHub repository](https://github.com/mesa-dot-dev/agentblame#chrome-extension).

## Troubleshooting

| Problem | Solution |
|---------|----------|
| Hooks not capturing | Restart Cursor/Claude Code |
| Notes not on GitHub | Run `git push origin refs/notes/agentblame` |
| After squash/rebase | Run `agentblame sync` |
| Bun not found | Install Bun: `curl -fsSL https://bun.sh/install \| bash` |

## More Information

For full documentation, Chrome extension installation, and contributing guidelines, visit the [GitHub repository](https://github.com/mesa-dot-dev/agentblame).

## License

Apache 2.0
