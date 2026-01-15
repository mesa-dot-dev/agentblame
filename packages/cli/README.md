# Agent Blame

Track AI-generated vs human-written code. Know what the AI wrote and focus your code reviews where it matters.

## Installation

```bash
npm install -g @mesadev/agentblame
```

## Setup

For a specific repo:
```bash
cd your-repo
agentblame install
```

Or for all repos (run from anywhere):
```bash
agentblame install --global
```

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
agentblame install             # Set up hooks (current repo)
agentblame install --global    # Set up hooks (all repos)
agentblame uninstall           # Remove hooks
agentblame blame <file>        # Show AI attribution
agentblame blame --summary     # Summary only
agentblame blame --json        # JSON output
agentblame status              # Show pending edits
agentblame sync                # Transfer notes after squash/rebase
```

## Chrome Extension

See AI markers on GitHub PRs with our Chrome extension.

Get it from the [GitHub repository](https://github.com/mesa-dot-dev/agentblame#chrome-extension-optional).

## Troubleshooting

| Problem | Solution |
|---------|----------|
| Hooks not capturing | Restart Cursor/Claude Code |
| Notes not on GitHub | Run `git push origin refs/notes/agentblame` |
| After squash/rebase | Run `agentblame sync` |

## More Information

For developer documentation and Chrome extension installation, visit the [GitHub repository](https://github.com/mesa-dot-dev/agentblame).

## License

Apache 2.0
