# Privacy Policy for Agent Blame Chrome Extension

**Last Updated:** January 2025

## Overview

Agent Blame is a Chrome extension that displays AI-generated code attribution markers on GitHub Pull Request pages. This privacy policy explains what data the extension accesses and how it is used.

## Data Collection

**Agent Blame does not collect, store, or transmit any personal data to external servers.**

### What the Extension Accesses

1. **GitHub Personal Access Token**
   - You provide a GitHub token to authenticate API requests
   - This token is stored locally in Chrome's storage (`chrome.storage.local`)
   - The token is only sent to GitHub's API (`api.github.com`) to fetch repository data
   - The token never leaves your browser except when making GitHub API calls

2. **GitHub Pull Request Data**
   - The extension reads PR commit information via the GitHub API
   - This data is used solely to display AI attribution markers on the page
   - No PR data is stored or transmitted elsewhere

3. **Git Notes Metadata**
   - The extension fetches git notes containing AI attribution metadata
   - This metadata is stored in your repository and accessed via GitHub's API
   - The extension only reads this data to display attribution markers

### What the Extension Does NOT Do

- Does not collect analytics or telemetry
- Does not track browsing history
- Does not store any data on external servers
- Does not share any data with third parties
- Does not access any websites other than github.com and api.github.com

## Data Storage

All data is stored locally on your device:

- **GitHub Token**: Stored in `chrome.storage.local`
- **Extension Settings**: Stored in `chrome.storage.local`

You can clear this data at any time by:
1. Removing your token via the extension popup
2. Uninstalling the extension

## Permissions Explained

| Permission | Why It's Needed |
|------------|-----------------|
| `storage` | To save your GitHub token and settings locally |
| `host_permissions: github.com` | To inject attribution markers on PR pages |
| `host_permissions: api.github.com` | To fetch PR commits and git notes metadata |

## Open Source

Agent Blame is open source. You can review the complete source code at:
https://github.com/mesa-dot-dev/agentblame

## Contact

For questions about this privacy policy or the extension:
- GitHub Issues: https://github.com/mesa-dot-dev/agentblame/issues
- Website: https://mesa.dev

## Changes to This Policy

Any changes to this privacy policy will be posted in the GitHub repository and reflected in the "Last Updated" date above.
