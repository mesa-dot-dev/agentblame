# Contributing to Agent Blame

Thank you for your interest in contributing to Agent Blame!

## Development Setup

### Prerequisites

- [Bun](https://bun.sh/) runtime (v1.0+)
- [Cursor](https://cursor.sh/) or VS Code
- Git

### Getting Started

```bash
# Clone the repository
git clone https://github.com/anthropics/agentblame.git
cd agentblame

# Install dependencies
bun install

# Build all packages
bun run build
```

### Project Structure

```
agentblame/
├── packages/
│   ├── cli/              # CLI tool - all core functionality
│   │   └── src/
│   │       ├── lib/      # Core types, utilities, git operations
│   │       ├── capture.ts        # Hook handler for Cursor/Claude Code
│   │       ├── transfer-notes.ts # GitHub Action entry point
│   │       ├── blame.ts          # blame command
│   │       ├── sync.ts           # sync command
│   │       └── index.ts          # CLI entry point
│   └── chrome/           # Chrome extension for GitHub PR visualization
└── docs/                 # Documentation
```

### Development Commands

```bash
# Build all packages
bun run build

# Build specific package
bun run build:cli
bun run build:chrome

# Run CLI in development
bun run ab --help
bun run ab blame <file>

# Build Chrome extension
bun run build:chrome
# Load packages/chrome/dist/ as unpacked extension in Chrome
```

### Testing Changes

1. **CLI**: Run `bun run ab <command>` from root
2. **Chrome Extension**: Load `packages/chrome/dist` as unpacked extension in Chrome
3. **Hooks**: Test by making AI edits in Cursor or Claude Code and checking `~/.agentblame/logs/`

### Submitting Changes

1. Fork the repository
2. Create a feature branch (`git checkout -b feature/my-feature`)
3. Make your changes
4. Run `bun run build` to ensure everything compiles
5. Commit your changes with a clear message
6. Push to your fork and submit a Pull Request

### Code Style

- We use [Biome](https://biomejs.dev/) for linting and formatting
- Run `bun run fmt` to format code
- Run `bun run lint` to check for issues

### Release Process

For maintainers:

1. Update version in relevant `packages/*/package.json`
2. Commit and push to `main`
3. Create a GitHub release with appropriate tags

## Questions?

Open an issue on GitHub if you have questions or run into problems.
