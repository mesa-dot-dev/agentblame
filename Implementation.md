# Implementation Plan: Repository-Wide Analytics

This document captures the design decisions and implementation plan for adding repository-wide analytics to Agent Blame.

## Table of Contents

1. [Overview](#overview)
2. [Feature Breakdown by Phase](#feature-breakdown-by-phase)
3. [Analytics Feature Design](#analytics-feature-design)
4. [Data Flow](#data-flow)
5. [Storage Format](#storage-format)
6. [Chrome Extension Views](#chrome-extension-views)
7. [GitHub Token Strategy](#github-token-strategy)
8. [Current Notes Implementation Analysis](#current-notes-implementation-analysis)
9. [Optimized Notes Writing Strategy](#optimized-notes-writing-strategy)
10. [Implementation Phases](#implementation-phases)
11. [Edge Cases & Error Handling](#edge-cases--error-handling)
12. [Performance Optimization](#performance-optimization)
13. [Professional UI Specifications](#professional-ui-specifications)
14. [Mesa Design System](#mesa-design-system)

---

## Current Implementation Status

### Phase 1: Core Analytics - ✅ COMPLETE

| Task | Status | Files Modified |
|------|--------|----------------|
| Add analytics types | ✅ Done | `packages/cli/src/lib/types.ts` |
| Analytics aggregation on merge | ✅ Done | `packages/cli/src/transfer-notes.ts` |
| GitHub Actions workflow | ✅ Done | `.github/workflows/agentblame.yml` |
| Chrome: Analytics tab injection | ✅ Done | `packages/chrome/src/content/analytics-tab.ts` |
| Chrome: Analytics overlay UI | ✅ Done | `packages/chrome/src/content/analytics-overlay.ts` |
| Chrome: Real API + mock fallback | ✅ Done | `packages/chrome/src/lib/mock-analytics.ts` |

### What's Working Now

1. **CLI (transfer-notes.ts)**:
   - Creates `agentblame-analytics-anchor` tag on root commit
   - Stores analytics in `refs/notes/agentblame-analytics`
   - Aggregates PR stats: total lines, AI lines, by provider, by model
   - Tracks per-contributor stats
   - Maintains PR history (last 100 PRs)

2. **GitHub Actions**:
   - Fetches both attribution and analytics notes
   - Passes `PR_AUTHOR` environment variable
   - Pushes analytics notes and anchor tag

3. **Chrome Extension**:
   - "Agent Blame" item injected in Insights sidebar (after Pulse)
   - Full page component with 3 vertical sections:
     - **Repository Overview**: AI %, provider breakdown, model breakdown
     - **Contributors**: Per-user AI %, lines, PR count
     - **Recent PRs**: PR history with AI % badges
   - Fetches real analytics from `refs/notes/agentblame-analytics`
   - Falls back to mock data if no real analytics exist
   - Caching layer (5-minute TTL)

### What's NOT Implemented Yet (Phase 1.5+)

- [ ] PR Summary card (injected on PR pages)
- [ ] Dedicated Contributors view
- [ ] Mesa component library port
- [ ] Phase 2 features (activity heatmap, file type breakdown)

---

## Testing Instructions

### Prerequisites

1. Build the CLI: `bun run build` or use directly via `bun packages/cli/src/index.ts`
2. Build the Chrome extension: `bun run packages/chrome/build-chrome.ts`
3. Load the extension in Chrome: `chrome://extensions` → Developer mode → Load unpacked → select `packages/chrome/dist`

### Test Flow

**Step 1: Initialize a test repo**
```bash
cd /path/to/test-repo
bun /path/to/agentblame/packages/cli/src/index.ts init
```

Expected output:
- ✓ Database
- ✓ Updated .gitignore
- ✓ Cursor hooks
- ✓ Claude Code hooks
- ✓ Git post-commit hook
- ✓ Notes auto-push
- ✓ GitHub Actions workflow
- ✓ Analytics anchor tag

**Step 2: Push the analytics tag**
```bash
git push origin agentblame-analytics-anchor
```

**Step 3: Create a PR with AI-generated code**
1. Make an AI edit with Cursor or Claude Code
2. Commit the changes (post-commit hook attaches notes)
3. Push to a branch
4. Create and merge a PR

**Step 4: Verify analytics**
1. After PR merge, GitHub Actions runs `transfer-notes.ts`
2. Check Actions log for analytics update message
3. Visit the repo page on GitHub
4. Click the "Agent Blame" tab (next to Insights)
5. Should see analytics overlay with stats

### Manual Testing (No PR Required)

To test the Chrome extension UI without a real PR merge:

1. Load the extension
2. Visit any GitHub repo's **Insights** page (e.g., `https://github.com/owner/repo/pulse`)
3. Look for "Agent Blame" in the left sidebar (after "Pulse")
4. Click it - you'll see the full analytics page with mock data

**Note:** The extension now only loads on Insights pages (`/pulse`, `/graphs/*`, `/community`, `/network`, `/forks`)

### Verifying Analytics Storage

After a PR merge, verify the analytics note was created:

```bash
# Fetch analytics notes
git fetch origin refs/notes/agentblame-analytics:refs/notes/agentblame-analytics

# Show the analytics note
git notes --ref=refs/notes/agentblame-analytics show agentblame-analytics-anchor
```

---

## Overview

### Goal

Provide repository-wide analytics showing:
- Percentage of code written by AI vs humans
- Breakdown by provider (Cursor, Claude Code)
- Breakdown by model (GPT-4, Claude 3.5, etc.)
- Historical trends over time
- Per-PR contribution stats
- Per-contributor AI usage breakdown
- Activity heatmaps and file type analysis

### Reference Design

A detailed UI mockup exists at `/Users/murali/Code/Sandbox/agentblame-expansion` showing three main views:
1. **Repository Pulse** (`/pulse`) - Repo-wide AI trends and charts
2. **PR Summary** (`/pr`) - Per-PR AI attribution with quality signals
3. **Contributors** (`/contributors`) - Per-developer AI fingerprints

This implementation plan aims to deliver ~85% of the mockup's features without requiring a backend server.

### Key Design Decisions

| Decision | Choice | Rationale |
|----------|--------|-----------|
| Storage location | Git notes (existing infrastructure) | Reuses existing code, no external dependencies |
| Analytics anchor | Tag `agentblame-analytics` | Easy API access (1 call), protected from casual deletion |
| Who writes | GitHub Actions | Centralized, runs on every PR merge |
| Who reads | Chrome extension | Team-wide visibility, in-context with GitHub |
| Display | Overlay on repo page | Native feel, no separate dashboard needed |

---

## Feature Breakdown by Phase

### Architecture Decision: No Backend Required

All features in Phase 1 and Phase 2 can be implemented using:
- **Git notes** for storage (existing infrastructure)
- **GitHub Actions** for computation at PR merge time
- **Chrome extension** for display

Features requiring a backend (survivability tracking, PR approval metrics) are deferred.

### Phase 1: Core Analytics

**Effort: ~3-4 days | No commit hook changes | No backend**

#### What Users Get

| View | Features |
|------|----------|
| **Repository Pulse** | AI % over time, provider breakdown, model breakdown, recent PRs list, weekly trend chart |
| **PR Summary** | AI % for PR, provider/model breakdown, security-sensitive file warnings |
| **Contributors** | Per-author AI %, per-author lines, per-author tool/model breakdown |

#### Data Capture Timing

| Data Point | When Captured | Where | Complexity |
|------------|---------------|-------|------------|
| Total lines added/removed | PR merge | GitHub Actions | Low |
| AI lines count | PR merge | GitHub Actions (from commit notes) | Low |
| By provider (Cursor/Claude Code) | PR merge | GitHub Actions | Low |
| By model (gpt-4, claude-3.5-sonnet, etc.) | PR merge | GitHub Actions | Low |
| PR author | PR merge | GitHub Actions | Low |
| PR number/title/date | PR merge | GitHub Actions | Low |

#### Implementation Tasks

| # | Task | File(s) | Effort |
|---|------|---------|--------|
| 1 | Add analytics types | `packages/cli/src/lib/types.ts` | 1 hr |
| 2 | Create analytics tag in `init` | `gitNotes.ts`, `index.ts` | 1 hr |
| 3 | Aggregate PR stats on merge | `transfer-notes.ts` | 3-4 hrs |
| 4 | Track per-author stats | `transfer-notes.ts` | 1 hr |
| 5 | Chrome: Fetch analytics API | `github-api.ts` | 2 hrs |
| 6 | Chrome: Caching layer | `analytics-cache.ts` | 1 hr |
| 7 | Chrome: Repository Pulse view | `analytics-overlay.ts` | 4 hrs |
| 8 | Chrome: Contributors view | `analytics-overlay.ts` | 3 hrs |
| 9 | Chrome: PR Summary card | `pr-summary.ts` (new) | 4 hrs |
| 10 | Port Mesa design system | `mesa/*.ts` (new) | 3 hrs |

---

### Phase 2: Enhanced Analytics

**Effort: ~2-3 days | Still no commit hook changes | No backend**

#### What Users Get (in addition to Phase 1)

| View | New Features |
|------|--------------|
| **Repository Pulse** | Stacked area chart (AI vs human over time) |
| **PR Summary** | Duplicate pattern detection |
| **Contributors** | 90-day activity heatmap, by-file-type breakdown |

#### Data Capture Timing

| Data Point | When Captured | Where | Complexity |
|------------|---------------|-------|------------|
| Daily line counts per author | PR merge | GitHub Actions | Low |
| File type category (tests/utils/core) | PR merge | GitHub Actions | Low |
| AI % per file type | PR merge | GitHub Actions | Low |
| Content hashes for duplicates | PR merge | GitHub Actions | Medium |

#### Implementation Tasks

| # | Task | File(s) | Effort |
|---|------|---------|--------|
| 1 | File type categorization | `transfer-notes.ts` | 2 hrs |
| 2 | Daily activity tracking | `transfer-notes.ts` | 2 hrs |
| 3 | Duplicate detection (hash-based) | `transfer-notes.ts` | 3 hrs |
| 4 | Chrome: Activity heatmap component | `heatmap.ts` (new) | 4 hrs |
| 5 | Chrome: File type breakdown UI | `analytics-overlay.ts` | 2 hrs |
| 6 | Chrome: Duplicate warnings | `pr-summary.ts` | 2 hrs |
| 7 | Chrome: Stacked area chart (SVG) | `analytics-overlay.ts` | 3 hrs |

---

### Phase 3: Quality Analysis (Optional/Future)

**Effort: ~5-7 days | Requires commit hook changes | Higher risk**

These features require AST parsing at commit time, which adds complexity:

| Feature | When Captured | Where | Complexity | Risk |
|---------|---------------|-------|------------|------|
| Complexity hotspots | **Commit** | Post-commit hook | High | Slows hook |
| Convention drift | **Commit** | Post-commit hook | Medium | Language-specific |
| Error handling issues | **Commit** | Post-commit hook | High | Needs AST parser |

**Alternative**: Use simple regex heuristics instead of full AST parsing (less accurate but 10x simpler).

---

### Deferred: Backend Required

These features cannot be implemented without a backend server:

| Feature | Why Backend Needed |
|---------|-------------------|
| Survivability tracking | Requires comparing code across time (historical git analysis) |
| PR approval rate | Requires GitHub API aggregation beyond git notes |
| Avg review comments | Requires GitHub PR review data |
| Regression tracking | Requires issue/commit correlation |
| Real-time team dashboards | Requires persistent state and webhooks |

---

### Summary Comparison

| Aspect | Phase 1 | Phase 2 | Phase 3 |
|--------|---------|---------|---------|
| **Effort** | 3-4 days | 2-3 days | 5-7 days |
| **Commit hook changes** | None | None | Required |
| **Backend needed** | No | No | No |
| **Risk** | Low | Low | Medium-High |
| **Mockup coverage** | ~55% | ~75% | ~85% |

### Feature Checklist

| Feature | Phase 1 | Phase 2 | Phase 3 | Backend |
|---------|:-------:|:-------:|:-------:|:-------:|
| Repository AI % trends | ✅ | | | |
| Provider breakdown | ✅ | | | |
| Model breakdown | ✅ | | | |
| Recent PRs list | ✅ | | | |
| PR AI % summary | ✅ | | | |
| Security file warnings | ✅ | | | |
| Per-author AI % | ✅ | | | |
| Per-author tool/model | ✅ | | | |
| Stacked area chart | | ✅ | | |
| Activity heatmap | | ✅ | | |
| File type breakdown | | ✅ | | |
| Duplicate detection | | ✅ | | |
| Complexity analysis | | | ✅ | |
| Convention drift | | | ✅ | |
| Error handling issues | | | ✅ | |
| Survivability | | | | ❌ |
| PR approval metrics | | | | ❌ |

---

## Analytics Feature Design

### When Analytics Are Captured

**Trigger:** GitHub Actions workflow on PR merge (existing `agentblame.yml`)

**What happens:**
1. PR merges to main/target branch
2. GitHub Actions workflow triggers
3. Existing: Transfer notes for squash/rebase
4. **New:** Compute and store analytics delta

### Analytics Anchor: Tag Approach

We use a git tag `agentblame-analytics` as the anchor point for storing repository-wide analytics in git notes.

**Why a tag?**
- Tags have first-class GitHub API support (single API call to resolve)
- Tag name is known/constant - no discovery needed
- Tags are protected from casual deletion (no GitHub UI option)
- Works even if repo has multiple root commits

**Created during `agentblame init`:**
```bash
# Find root commit
ROOT=$(git rev-list --max-parents=0 HEAD | head -1)

# Create tag pointing to root
git tag agentblame-analytics $ROOT

# Push tag
git push origin agentblame-analytics
```

### Reading Analytics (Chrome Extension)

```typescript
const ANALYTICS_TAG = 'agentblame-analytics';

async function fetchAnalytics(owner: string, repo: string): Promise<Analytics | null> {
  const token = await getStoredToken();

  // Step 1: Resolve tag to SHA (single API call)
  const tagRes = await fetch(
    `https://api.github.com/repos/${owner}/${repo}/git/ref/tags/${ANALYTICS_TAG}`,
    { headers: { Authorization: `Bearer ${token}` } }
  );

  if (!tagRes.ok) return null;  // No analytics yet

  const tag = await tagRes.json();
  const anchorSha = tag.object.sha;

  // Step 2: Fetch note for that SHA (reuse existing notes code)
  const notes = await fetchNotesForCommit(owner, repo, anchorSha);

  return notes?.analytics || null;
}
```

**Total API calls: 2** (tag resolution + note fetch)

---

## Data Flow

### Complete Flow Diagram

```
┌─────────────────────────────────────────────────────────────────────────┐
│                         SETUP (one-time)                                │
├─────────────────────────────────────────────────────────────────────────┤
│                                                                         │
│  $ agentblame init                                                             │
│        ↓                                                                │
│  1. Install editor hooks (existing)                                     │
│  2. Install git hooks (existing)                                        │
│  3. Find root commit: git rev-list --max-parents=0 HEAD                 │
│  4. Create tag: git tag agentblame-analytics <root-sha>                        │
│  5. Push tag: git push origin agentblame-analytics                             │
│                                                                         │
└─────────────────────────────────────────────────────────────────────────┘

┌─────────────────────────────────────────────────────────────────────────┐
│                       CAPTURE (on each commit)                          │
├─────────────────────────────────────────────────────────────────────────┤
│                                                                         │
│  Developer uses Cursor/Claude Code                                      │
│        ↓                                                                │
│  Editor hook captures AI edit → SQLite database                         │
│        ↓                                                                │
│  Developer commits                                                      │
│        ↓                                                                │
│  Post-commit hook matches lines → Git notes                             │
│        ↓                                                                │
│  Developer pushes (includes notes)                                      │
│                                                                         │
└─────────────────────────────────────────────────────────────────────────┘

┌─────────────────────────────────────────────────────────────────────────┐
│                      ANALYTICS (on PR merge)                            │
├─────────────────────────────────────────────────────────────────────────┤
│                                                                         │
│  PR merged to main                                                      │
│        ↓                                                                │
│  GitHub Actions workflow triggers                                       │
│        ↓                                                                │
│  ┌─────────────────────────────────────────┐                           │
│  │  Job: update-analytics                   │                           │
│  │                                          │                           │
│  │  1. Checkout repo                        │                           │
│  │  2. Fetch refs/notes/agentblame                 │                           │
│  │  3. Resolve agentblame-analytics tag → SHA      │                           │
│  │  4. Read existing analytics note         │                           │
│  │  5. Compute PR stats from notes:         │                           │
│  │     - Lines added (total)                │                           │
│  │     - AI lines (from notes)              │                           │
│  │     - By provider, by model              │                           │
│  │  6. Append to history, update summary    │                           │
│  │  7. Write updated note to anchor         │                           │
│  │  8. Push refs/notes/agentblame                  │                           │
│  └─────────────────────────────────────────┘                           │
│                                                                         │
└─────────────────────────────────────────────────────────────────────────┘

┌─────────────────────────────────────────────────────────────────────────┐
│                        VIEW (Chrome extension)                          │
├─────────────────────────────────────────────────────────────────────────┤
│                                                                         │
│  User visits github.com/org/repo                                        │
│        ↓                                                                │
│  Content script detects repo page                                       │
│        ↓                                                                │
│  Injects "Agent Blame" tab next to Insights                             │
│        ↓                                                                │
│  User clicks button                                                     │
│        ↓                                                                │
│  1. GET /repos/:owner/:repo/git/ref/tags/agentblame-analytics                  │
│     → Returns anchor SHA                                                │
│        ↓                                                                │
│  2. Fetch note for anchor SHA (existing code)                           │
│     → Returns { analytics: {...} }                                      │
│        ↓                                                                │
│  3. Render overlay with stats and charts                                │
│                                                                         │
└─────────────────────────────────────────────────────────────────────────┘
```

---

## Storage Format

### Analytics Note Structure (Phase 1 + Phase 2)

```typescript
interface AnalyticsNote {
  version: 2;

  // Repository-wide summary (computed from history)
  summary: {
    total_lines: number;
    ai_lines: number;
    human_lines: number;

    by_provider: {
      cursor?: number;
      claude_code?: number;
    };

    by_model: {
      [model: string]: number;  // e.g., "gpt-4": 1200, "claude-3.5-sonnet": 800
    };

    last_updated: string;  // ISO timestamp
  };

  // Per-contributor aggregates (Phase 1)
  contributors: {
    [username: string]: {
      total_lines: number;
      ai_lines: number;
      by_provider: Record<string, number>;
      by_model: Record<string, number>;
      pr_count: number;
      // Phase 2 additions:
      by_file_type?: Record<string, { total: number; ai: number }>;
      activity?: Record<string, number>;  // { "2026-01-15": 45 } - daily line counts
    };
  };

  // Historical entries (append-only)
  history: Array<{
    d: string;           // date (ISO timestamp) - compact key
    pr: number;          // pr_number
    t?: string;          // pr_title (optional, truncated)
    author: string;      // GitHub username

    // Delta for this PR
    a: number;           // lines_added
    r: number;           // lines_removed
    ai: number;          // ai_lines_added

    p?: Record<string, number>;  // by_provider
    m?: Record<string, number>;  // by_model

    // Phase 2 additions:
    ft?: Record<string, { a: number; ai: number }>;  // by file type
    quality?: {
      security_files?: string[];     // paths of security-sensitive files touched
      duplicates?: number;           // duplicate patterns detected
    };
  }>;

  // Phase 2: Weekly aggregates for charts (cached, computed from history)
  weekly?: Array<{
    week: string;        // "2026-W03"
    cursor: number;
    claude_code: number;
    human: number;
  }>;
}
```

### Example

```json
{
  "version": 2,
  "summary": {
    "total_lines": 15420,
    "ai_lines": 3847,
    "human_lines": 11573,
    "by_provider": {
      "cursor": 2100,
      "claude_code": 1747
    },
    "by_model": {
      "gpt-4": 1800,
      "claude-3.5-sonnet": 1747,
      "gpt-4o": 300
    },
    "last_updated": "2026-01-16T10:30:00Z"
  },
  "contributors": {
    "alice": {
      "total_lines": 2847,
      "ai_lines": 1651,
      "by_provider": { "cursor": 1200, "claude_code": 451 },
      "by_model": { "gpt-4": 900, "claude-3.5-sonnet": 451, "gpt-4o": 300 },
      "pr_count": 12,
      "by_file_type": {
        "tests": { "total": 500, "ai": 400 },
        "utils": { "total": 300, "ai": 180 },
        "core": { "total": 800, "ai": 350 }
      },
      "activity": {
        "2026-01-15": 45,
        "2026-01-16": 120,
        "2026-01-17": 23
      }
    },
    "bob": {
      "total_lines": 1892,
      "ai_lines": 643,
      "by_provider": { "cursor": 400, "claude_code": 243 },
      "by_model": { "claude-3.5-sonnet": 500, "gpt-4": 143 },
      "pr_count": 8
    }
  },
  "history": [
    {
      "d": "2026-01-16T10:30:00Z",
      "pr": 52,
      "t": "Add user authentication",
      "author": "alice",
      "a": 200,
      "r": 50,
      "ai": 120,
      "p": { "cursor": 120 },
      "m": { "gpt-4": 120 },
      "ft": { "core": { "a": 150, "ai": 90 }, "tests": { "a": 50, "ai": 30 } },
      "quality": { "security_files": ["src/auth/oauth.ts"] }
    },
    {
      "d": "2026-01-15T14:20:00Z",
      "pr": 51,
      "t": "Fix login bug",
      "author": "bob",
      "a": 30,
      "r": 10,
      "ai": 15,
      "p": { "claude_code": 15 },
      "m": { "claude-3.5-sonnet": 15 }
    }
  ],
  "weekly": [
    { "week": "2026-W02", "cursor": 150, "claude_code": 80, "human": 400 },
    { "week": "2026-W03", "cursor": 200, "claude_code": 120, "human": 350 }
  ]
}
```

### History Retention

- Keep full history (append-only)
- For very active repos, consider:
  - Aggregating old entries (daily → weekly → monthly)
  - Archiving to separate notes if size becomes an issue
  - Current limit: ~1MB for git notes (plenty for years of history)

---

## Chrome Extension Views

### Three Main Views

The Chrome extension provides three distinct views for different contexts:

#### 1. Repository Pulse (Overlay)

**Trigger**: "Agent Blame" tab in repo navigation
**Location**: Modal overlay on any repo page
**Features**:
- Repository-wide AI % with trend
- Provider breakdown (Cursor vs Claude Code)
- Model breakdown
- Weekly trend chart (Phase 2: stacked area)
- Recent PRs with AI %
- Contributors list with AI %

#### 2. PR Summary (Injected Card)

**Trigger**: Automatically on PR Files tab
**Location**: Above the file tree
**Features**:
- PR AI % with provider breakdown
- Security-sensitive file warnings
- Phase 2: Duplicate pattern detection

#### 3. PR Diff Highlighting (Existing)

**Trigger**: Automatically on PR diff view
**Location**: Inline with diff lines
**Features**:
- Orange left border on AI-generated lines
- Tooltip showing provider/model

### Tab Placement: Next to Insights

The "Agent Blame" tab is injected into the repo navigation, positioned next to "Insights":

```
┌─────────────────────────────────────────────────────────────────────────────┐
│  mesa-dot-dev / agentblame                               ⭐ Star  👁 Watch  │
├─────────────────────────────────────────────────────────────────────────────┤
│  <> Code   ◯ Issues   ↱ Pull requests   ▶ Actions   📊 Insights  🌵 Agent Blame
│                                                                   ^^^^^^^^^^^^^^
│                                                                   Mesa logo + name
└─────────────────────────────────────────────────────────────────────────────┘
```

**Why next to Insights:**
- Agent Blame IS an insight - AI attribution analytics
- Logical grouping with other analytics features
- Users looking for metrics will find it naturally

### Tab Implementation

```typescript
function injectAgentBlameTab(owner: string, repo: string): void {
  // Find the underline nav (repo tabs)
  const nav = document.querySelector('.UnderlineNav-body');
  if (!nav) return;

  // Check if already injected
  if (nav.querySelector('[data-agentblame-tab]')) return;

  // Find Insights tab to insert after
  const insightsTab = nav.querySelector('a[href$="/pulse"]')?.closest('.UnderlineNav-item');

  // Create tab link using Primer classes
  const tab = document.createElement('a');
  tab.href = '#';
  tab.className = 'UnderlineNav-item';
  tab.setAttribute('data-agentblame-tab', 'true');
  tab.innerHTML = `
    <img src="${chrome.runtime.getURL('icons/logo.svg')}"
         width="16" height="16"
         class="UnderlineNav-octicon"
         alt="Agent Blame">
    <span data-content="Agent Blame">Agent Blame</span>
  `;

  tab.addEventListener('click', (e) => {
    e.preventDefault();
    showAnalyticsOverlay(owner, repo);
  });

  // Insert after Insights, or at end if Insights not found
  if (insightsTab && insightsTab.nextSibling) {
    nav.insertBefore(tab, insightsTab.nextSibling);
  } else {
    nav.appendChild(tab);
  }
}
```

### Icon Asset

**Location:** `packages/chrome/src/icons/logo.svg`

The Mesa logo (black & white, circular) is used for:
- Tab icon in repo navigation (16x16)
- Overlay header branding
- Consistent with extension popup branding

### UI Design (Overlay Modal)

```
┌─────────────────────────────────────────────────────────────────┐
│  🌵 Agent Blame Analytics                              [✕ Close]│
├─────────────────────────────────────────────────────────────────┤
│                                                                 │
│  Repository: mesa-dot-dev/agentblame                            │
│                                                                 │
│  ┌─────────────┐  ┌─────────────┐  ┌─────────────┐              │
│  │   24.9%     │  │    2,100    │  │    1,747    │              │
│  │  AI-written │  │   Cursor    │  │ Claude Code │              │
│  └─────────────┘  └─────────────┘  └─────────────┘              │
│                                                                 │
│  Trend (last 30 days)                                           │
│  ┌─────────────────────────────────────────────────┐            │
│  │     ╭─╮                                         │            │
│  │  ╭──╯ ╰──╮    ╭───╮                             │            │
│  │ ─╯       ╰────╯   ╰──────                       │            │
│  │  Jan 1        Jan 8       Jan 15                │            │
│  └─────────────────────────────────────────────────┘            │
│                                                                 │
│  By Model                        Recent PRs                     │
│  ┌──────────────────────┐       ┌──────────────────────┐        │
│  │ GPT-4        ████ 47%│       │ #52 - 60% AI (Cursor)│        │
│  │ Claude 3.5   ███  35%│       │ #51 - 50% AI (Claude)│        │
│  │ GPT-4o       ██   18%│       │ #50 - 0% AI          │        │
│  └──────────────────────┘       └──────────────────────┘        │
│                                                                 │
└─────────────────────────────────────────────────────────────────┘
```

### Implementation Approach

- **Trigger:** Inject button into GitHub repo navigation header
- **Overlay:** Modal overlay rendered via content script
- **Charts:** Pure SVG/CSS (no external chart library to keep extension small)
- **Caching:** Cache analytics in `chrome.storage.local` with TTL

### Files to Create/Modify

```
packages/chrome/src/
├── manifest.json            # Update matches and web_accessible_resources
├── content/
│   ├── content.ts           # Extend to detect repo pages
│   ├── analytics-tab.ts     # NEW: Inject Agent Blame tab
│   └── analytics-overlay.ts # NEW: Overlay component
├── icons/
│   ├── icon16.png           # Existing
│   ├── icon48.png           # Existing
│   ├── icon128.png          # Existing
│   └── logo.svg  # NEW: Tab icon
├── lib/
│   ├── github-api.ts        # Add fetchAnalytics()
│   └── analytics-cache.ts   # NEW: Caching layer
└── styles/
    └── chart.css            # NEW: Only ~10 lines for chart animation
```

### Manifest Changes Required

Current manifest only matches PR pages. Need to expand for repo pages:

```json
{
  "content_scripts": [
    {
      "matches": [
        "https://github.com/*/*/pull/*",
        "https://github.com/*/*"
      ],
      "exclude_matches": [
        "https://github.com/*/*/pull/*",
        "https://github.com/*/*/issues/*",
        "https://github.com/*/*/actions/*",
        "https://github.com/*/*/settings/*"
      ],
      "js": ["content/content.js"],
      "css": ["content/content.css"],
      "run_at": "document_idle"
    }
  ],
  "web_accessible_resources": [
    {
      "resources": ["icons/*.png", "icons/*.svg"],
      "matches": ["https://github.com/*"]
    }
  ]
}
```

**Key changes:**
1. Add `"https://github.com/*/*"` to match repo root pages
2. Use `exclude_matches` to avoid running on non-repo pages
3. Add `"icons/*.svg"` to `web_accessible_resources` for the Mesa logo

---

## GitHub Token Strategy

### Token Contexts

| Context | Token Type | How Obtained | Permissions Needed |
|---------|------------|--------------|-------------------|
| **CLI (local)** | SSH keys or PAT | User's existing git auth | Push to refs/notes, tags |
| **GitHub Actions** | `GITHUB_TOKEN` | Automatic | `contents: write` |
| **Chrome Extension** | User's PAT | User enters manually | `repo` (private) or `public_repo` |

### CLI (Local Git Operations)

**No special token needed** - uses whatever git auth the user has configured:

```bash
# User already has this working (SSH or credential helper)
git push origin refs/notes/agentblame
git push origin agentblame-analytics  # tag
```

### GitHub Actions

**Automatic `GITHUB_TOKEN`** - already configured in `agentblame.yml`:

```yaml
permissions:
  contents: write  # Already present - enables pushing notes and tags
```

The `GITHUB_TOKEN` is:
- Auto-generated by GitHub for each workflow run
- Scoped to the repo where the workflow runs
- Temporary (expires after workflow completes)
- No setup required

### Chrome Extension

User must provide a Personal Access Token (PAT) with appropriate scopes:

| Repo Type | Minimum Scope | What It Grants |
|-----------|---------------|----------------|
| Public | `public_repo` | Read public repo contents |
| Private | `repo` | Full access to private repos |

**Current flow:**
1. User creates PAT at github.com/settings/tokens
2. User enters token in extension popup
3. Token stored in `chrome.storage.local`
4. Used for all GitHub API calls

**Future improvement:** Consider GitHub OAuth flow for better UX.

---

## Current Notes Implementation Analysis

### How Notes Are Written (gitNotes.ts)

```typescript
// Current implementation
export async function attachNote(
  repoRoot: string,
  sha: string,
  attributions: RangeAttribution[]
): Promise<boolean> {
  const note: GitNotesAttribution = {
    version: 1,
    timestamp: new Date().toISOString(),
    attributions: attributions.map((a) => ({
      path: a.path,
      start_line: a.start_line,
      end_line: a.end_line,
      category: "ai_generated",
      provider: a.provider,
      model: a.model,
      confidence: a.confidence,
      match_type: a.match_type,
      content_hash: a.content_hash,
    })),
  };

  const noteJson = JSON.stringify(note);

  const result = await runGit(
    repoRoot,
    ["notes", `--ref=${NOTES_REF}`, "add", "-f", "-m", noteJson, sha],
    10000
  );

  return result.exitCode === 0;
}
```

### Observations

1. **Single note per commit** - Good, atomic
2. **JSON format** - Flexible, extensible
3. **Version field** - Good for future migrations
4. **Force flag (-f)** - Overwrites existing, handles re-runs

### How Notes Are Read (github-api.ts)

The Chrome extension reads notes via GitHub API:

1. Get notes ref → commit SHA
2. Get commit → tree SHA
3. Get tree → find blob for target commit
4. Get blob → decode base64 content

**4 API calls per note fetch** - acceptable with caching.

---

## Optimized Notes Writing Strategy

### For Attribution Notes (per-commit)

Current approach is already good:
- Single atomic write per commit
- Merge consecutive lines into ranges (reduces size)
- Content hashes for deduplication

### For Analytics Note (repo-wide)

**Challenge:** Multiple PRs could merge simultaneously, causing race conditions.

**Solution:** Read-modify-write with optimistic locking

```typescript
async function updateAnalytics(prStats: PRStats): Promise<void> {
  const anchorSha = getAnchorSha();

  // Read current analytics
  const current = await readNote(anchorSha);
  const analytics: AnalyticsNote = current?.analytics || createEmptyAnalytics();

  // Append new entry
  analytics.history.push({
    date: new Date().toISOString(),
    pr_number: prStats.prNumber,
    pr_title: prStats.prTitle,
    lines_added: prStats.linesAdded,
    lines_removed: prStats.linesRemoved,
    ai_lines_added: prStats.aiLinesAdded,
    by_provider: prStats.byProvider,
    by_model: prStats.byModel,
  });

  // Recalculate summary
  analytics.summary = recalculateSummary(analytics.history);

  // Write back
  await writeNote(anchorSha, { analytics });
}
```

**Race condition mitigation:**
- GitHub Actions runs sequentially per branch by default
- For concurrent merges, last write wins (acceptable - data is additive)
- Could add retry logic with re-read if needed

### Size Optimization

For very large histories:

```typescript
function compactHistory(history: HistoryEntry[]): HistoryEntry[] {
  const ONE_MONTH = 30 * 24 * 60 * 60 * 1000;
  const now = Date.now();

  return history.map(entry => {
    const age = now - new Date(entry.date).getTime();

    // Keep full detail for recent entries
    if (age < ONE_MONTH) return entry;

    // Compact older entries (remove pr_title to save space)
    const { pr_title, ...compact } = entry;
    return compact;
  });
}
```

---

## Implementation Phases

### Phase 1: Analytics Tag Setup

**Files:**
- `packages/cli/src/init.ts`
- `packages/cli/src/lib/git/gitNotes.ts`

**Tasks:**
1. Add `createAnalyticsTag()` function
2. Integrate into `agentblame init` command
3. Handle case where tag already exists
4. Handle repos with multiple root commits

### Phase 2: Analytics Capture

**Files:**
- `packages/cli/src/transfer-notes.ts` (or new `analytics.ts`)
- `packages/cli/src/lib/types.ts`
- `.github/workflows/agentblame.yml`

**Tasks:**
1. Define `AnalyticsNote` type
2. Add `computePRStats()` function
3. Add `updateAnalytics()` function
4. Integrate into GitHub Actions workflow
5. Add `agentblame analytics` CLI command for manual runs

### Phase 3: Chrome Extension Overlay

**Files:**
- `packages/chrome/src/content/content.ts`
- `packages/chrome/src/content/analytics-overlay.ts` (new)
- `packages/chrome/src/lib/github-api.ts`
- `packages/chrome/src/manifest.json`

**Tasks:**
1. Extend content script to detect repo pages
2. Add `fetchAnalytics()` to GitHub API client
3. Create overlay UI component
4. Add SVG chart rendering
5. Implement caching layer
6. Update manifest permissions if needed

### Phase 4: Testing & Documentation

**Tasks:**
1. Add unit tests for analytics functions
2. Add integration tests for GitHub Actions workflow
3. Test Chrome extension on various repo sizes
4. Update README with analytics documentation
5. Update CONTRIBUTING.md with new architecture

---

## Edge Cases & Error Handling

### CLI / Init Edge Cases

| Edge Case | Handling |
|-----------|----------|
| Tag already exists | Skip creation, log "Analytics tag already exists" |
| Multiple root commits | Use first one (`head -1`), log warning |
| No push permission | Fail gracefully with clear error message |
| Offline / no remote | Create tag locally, push later |
| Re-running init | Idempotent - detect existing setup, skip |

```typescript
async function createAnalyticsTag(repoRoot: string): Promise<boolean> {
  // Check if tag exists
  const existing = await runGit(repoRoot, ['tag', '-l', 'agentblame-analytics']);
  if (existing.stdout.trim()) {
    console.log('Analytics tag already exists, skipping');
    return true;
  }

  // Get root commit(s)
  const roots = await runGit(repoRoot, ['rev-list', '--max-parents=0', 'HEAD']);
  const rootLines = roots.stdout.trim().split('\n').filter(Boolean);

  if (rootLines.length === 0) {
    console.error('Error: No root commit found');
    return false;
  }

  if (rootLines.length > 1) {
    console.log(`Note: Found ${rootLines.length} root commits, using first`);
  }

  const rootSha = rootLines[0];

  // Create tag
  const tagResult = await runGit(repoRoot, ['tag', 'agentblame-analytics', rootSha]);
  if (tagResult.exitCode !== 0) {
    console.error('Failed to create analytics tag');
    return false;
  }

  // Push tag (optional, may fail if no remote)
  const pushResult = await runGit(repoRoot, ['push', 'origin', 'agentblame-analytics']);
  if (pushResult.exitCode !== 0) {
    console.log('Note: Could not push tag (will push with next git push)');
  }

  return true;
}
```

### GitHub Actions Edge Cases

| Edge Case | Handling |
|-----------|----------|
| Notes ref doesn't exist | Create it (first PR) |
| Analytics note doesn't exist | Initialize empty analytics |
| Corrupted analytics JSON | Log error, reinitialize from scratch |
| Tag doesn't exist | Log error, skip analytics update |
| Concurrent PR merges | Last write wins (data is additive) |
| PR with no AI code | Still record entry (ai_lines_added: 0) |

```typescript
async function safeUpdateAnalytics(prStats: PRStats): Promise<void> {
  try {
    // Get anchor SHA
    const anchorResult = await runGit('.', ['rev-parse', 'agentblame-analytics']);
    if (anchorResult.exitCode !== 0) {
      console.log('[agentblame] Analytics tag not found, skipping analytics update');
      return;
    }
    const anchorSha = anchorResult.stdout.trim();

    // Read existing analytics
    let analytics: AnalyticsNote;
    try {
      const note = await readNote(anchorSha);
      analytics = note?.analytics || createEmptyAnalytics();
    } catch (e) {
      console.log('[agentblame] Could not parse analytics, reinitializing');
      analytics = createEmptyAnalytics();
    }

    // Append and save
    analytics.history.push(prStats);
    analytics.summary = recalculateSummary(analytics.history);

    await writeNote(anchorSha, { analytics });
    console.log(`[agentblame] Analytics updated for PR #${prStats.pr_number}`);

  } catch (error) {
    console.error('[agentblame] Analytics update failed:', error);
    // Don't fail the workflow - analytics is non-critical
  }
}
```

### Chrome Extension Edge Cases

| Edge Case | Handling |
|-----------|----------|
| No token configured | Show "Configure token" prompt in overlay |
| Invalid/expired token | Show error with "Update token" link |
| Tag doesn't exist | Show "No analytics yet" empty state |
| Note doesn't exist | Show "No analytics yet" empty state |
| Network error | Show retry button, use cached data if available |
| Rate limited (403) | Show "Rate limited, try later" message |
| Very large history | Virtualize list, limit chart points |
| Malformed JSON | Show error state, log to console |

---

## Performance Optimization

### JSON Size Optimization

**Compact keys in history entries:**

```typescript
// Instead of verbose keys
interface HistoryEntry {
  date: string;
  pr_number: number;
  pr_title: string;
  lines_added: number;
  ai_lines_added: number;
  by_provider: { cursor?: number; claude_code?: number };
  by_model: { [key: string]: number };
}

// Use compact keys for storage (expand on read)
interface CompactHistoryEntry {
  d: string;      // date
  pr: number;     // pr_number
  t?: string;     // pr_title (optional, can omit for old entries)
  a: number;      // lines_added
  ai: number;     // ai_lines_added
  p?: Record<string, number>;  // by_provider
  m?: Record<string, number>;  // by_model
}
```

**Size comparison:**

| PRs | Verbose Keys | Compact Keys | Savings |
|-----|--------------|--------------|---------|
| 100 | ~25 KB | ~12 KB | 52% |
| 1000 | ~250 KB | ~120 KB | 52% |
| 5000 | ~1.25 MB | ~600 KB | 52% |

### Chrome Extension Performance

**1. Instant perceived load with skeleton UI:**

```typescript
function showOverlay() {
  // Immediately show skeleton
  renderSkeleton();

  // Then fetch data
  const analytics = await fetchAnalytics(owner, repo);

  // Replace skeleton with real content
  renderAnalytics(analytics);
}

function renderSkeleton(): void {
  overlay.innerHTML = `
    <div class="agb-modal">
      <div class="agb-header">
        <div class="agb-skeleton agb-skeleton-title"></div>
        <button class="agb-close">✕</button>
      </div>
      <div class="agb-stats">
        <div class="agb-skeleton agb-skeleton-card"></div>
        <div class="agb-skeleton agb-skeleton-card"></div>
        <div class="agb-skeleton agb-skeleton-card"></div>
      </div>
      <div class="agb-skeleton agb-skeleton-chart"></div>
    </div>
  `;
}
```

**2. Aggressive caching:**

```typescript
interface CachedAnalytics {
  data: AnalyticsNote;
  fetchedAt: number;
  repoKey: string;
}

const CACHE_TTL = 5 * 60 * 1000; // 5 minutes

async function fetchAnalyticsWithCache(owner: string, repo: string): Promise<AnalyticsNote | null> {
  const cacheKey = `analytics_${owner}_${repo}`;

  // Check memory cache first (instant)
  const memCached = memoryCache.get(cacheKey);
  if (memCached && Date.now() - memCached.fetchedAt < CACHE_TTL) {
    return memCached.data;
  }

  // Check storage cache (fast, survives page navigation)
  const stored = await chrome.storage.local.get(cacheKey);
  if (stored[cacheKey] && Date.now() - stored[cacheKey].fetchedAt < CACHE_TTL) {
    memoryCache.set(cacheKey, stored[cacheKey]);
    return stored[cacheKey].data;
  }

  // Fetch fresh data
  const data = await fetchAnalytics(owner, repo);

  if (data) {
    const cached = { data, fetchedAt: Date.now(), repoKey: cacheKey };
    memoryCache.set(cacheKey, cached);
    await chrome.storage.local.set({ [cacheKey]: cached });
  }

  return data;
}
```

**3. Render optimization for charts:**

```typescript
function renderTrendChart(history: HistoryEntry[]): string {
  // Limit data points for performance
  const MAX_POINTS = 90; // 90 days
  const recentHistory = history.slice(-MAX_POINTS);

  // Aggregate by day if too many entries
  const dailyData = aggregateByDay(recentHistory);

  // Generate SVG path (no external library)
  const points = dailyData.map((d, i) => ({
    x: (i / (dailyData.length - 1)) * 100,
    y: 100 - (d.aiPercent * 100)
  }));

  const pathD = points.map((p, i) =>
    `${i === 0 ? 'M' : 'L'} ${p.x} ${p.y}`
  ).join(' ');

  return `
    <svg viewBox="0 0 100 100" preserveAspectRatio="none" class="agb-chart">
      <path d="${pathD}" fill="none" stroke="var(--agb-primary)" stroke-width="2"/>
    </svg>
  `;
}
```

**4. Lazy render sections:**

```typescript
function renderAnalytics(analytics: AnalyticsNote): void {
  // Render critical content first (above the fold)
  renderSummaryCards(analytics.summary);

  // Defer non-critical content
  requestAnimationFrame(() => {
    renderTrendChart(analytics.history);
  });

  requestAnimationFrame(() => {
    renderModelBreakdown(analytics.summary.by_model);
    renderRecentPRs(analytics.history.slice(-5));
  });
}
```

---

## Professional UI Specifications

### Design Principles

1. **Use GitHub's Primer CSS** - Zero additional CSS, automatic theming
2. **Leverage existing classes** - `Box`, `Button`, `Label`, `Progress`, etc.
3. **Dark mode free** - Primer handles it automatically
4. **Accessible by default** - Primer is accessibility-tested
5. **No custom colors** - Use CSS variables GitHub already defines

### Using GitHub's Primer CSS (No Custom CSS Needed)

GitHub's pages already include Primer CSS. We just use their classes:

```typescript
// GitHub's CSS variables are already available
// --color-fg-default, --color-fg-muted, --color-canvas-default, etc.
// --color-accent-fg, --color-success-fg, --color-danger-fg, etc.

// Primer component classes available:
// Box, Box-header, Box-body, Box-row
// Button, btn, btn-primary, btn-sm
// Label, Label--success, Label--accent
// Progress, Progress-item
// flash, flash-warn, flash-error
// Overlay, Overlay-body
// anim-fade-in, anim-scale-in
```

**Key Primer classes we'll use:**

| Component | Primer Classes |
|-----------|---------------|
| Modal container | `Box`, `Box--overlay`, `Overlay` |
| Header | `Box-header`, `d-flex`, `flex-justify-between` |
| Close button | `btn-octicon`, `close-button` |
| Stat cards | `Box`, `p-3`, `text-center` |
| Large numbers | `f1`, `text-bold`, `color-fg-default` |
| Labels | `text-small`, `color-fg-muted` |
| Progress bars | `Progress`, `Progress-item` |
| Buttons | `btn`, `btn-primary`, `btn-sm` |
| Lists | `Box-row`, `d-flex`, `flex-items-center` |
| Badges | `Label`, `Label--accent`, `Label--success` |
| Loading | `anim-pulse` (or custom shimmer) |
| Animations | `anim-fade-in`, `anim-scale-in` |

### UI States (Using Primer Classes)

**1. Loading State (Skeleton):**

```html
<!-- Uses Primer's anim-pulse for loading effect -->
<div class="Overlay Overlay--size-medium anim-fade-in">
  <div class="Box Box--overlay d-flex flex-column" style="width: 600px;">
    <div class="Box-header d-flex flex-justify-between flex-items-center">
      <div class="anim-pulse rounded-2" style="width: 200px; height: 24px; background: var(--color-canvas-subtle);"></div>
      <button class="btn-octicon" aria-label="Close">
        <svg class="octicon octicon-x" viewBox="0 0 16 16" width="16" height="16">
          <path fill-rule="evenodd" d="M3.72 3.72a.75.75 0 011.06 0L8 6.94l3.22-3.22a.75.75 0 111.06 1.06L9.06 8l3.22 3.22a.75.75 0 11-1.06 1.06L8 9.06l-3.22 3.22a.75.75 0 01-1.06-1.06L6.94 8 3.72 4.78a.75.75 0 010-1.06z"></path>
        </svg>
      </button>
    </div>
    <div class="Box-body d-flex gap-3">
      <div class="anim-pulse rounded-2 flex-1" style="height: 80px; background: var(--color-canvas-subtle);"></div>
      <div class="anim-pulse rounded-2 flex-1" style="height: 80px; background: var(--color-canvas-subtle);"></div>
      <div class="anim-pulse rounded-2 flex-1" style="height: 80px; background: var(--color-canvas-subtle);"></div>
    </div>
    <div class="Box-body">
      <div class="anim-pulse rounded-2" style="height: 120px; background: var(--color-canvas-subtle);"></div>
    </div>
  </div>
</div>
```

**2. Empty State (No Analytics Yet):**

```html
<!-- Uses Primer's blankslate component -->
<div class="blankslate">
  <svg class="blankslate-icon color-fg-muted" viewBox="0 0 24 24" width="48" height="48">
    <!-- Sparkle icon -->
  </svg>
  <h3 class="blankslate-heading">No Analytics Yet</h3>
  <p class="color-fg-muted">Analytics will appear after the first PR is merged with AI attribution.</p>
  <div class="blankslate-action">
    <a href="https://github.com/mesa-dot-dev/agentblame#setup" class="btn btn-primary" target="_blank">
      Learn how to set up Agent Blame
    </a>
  </div>
</div>
```

**3. Error State:**

```html
<!-- Uses Primer's flash component -->
<div class="flash flash-error d-flex flex-items-center">
  <svg class="octicon octicon-alert mr-2" viewBox="0 0 16 16" width="16" height="16">
    <path fill-rule="evenodd" d="M8.22 1.754a.25.25 0 00-.44 0L1.698 13.132a.25.25 0 00.22.368h12.164a.25.25 0 00.22-.368L8.22 1.754zm-1.763-.707c.659-1.234 2.427-1.234 3.086 0l6.082 11.378A1.75 1.75 0 0114.082 15H1.918a1.75 1.75 0 01-1.543-2.575L6.457 1.047zM9 11a1 1 0 11-2 0 1 1 0 012 0zm-.25-5.25a.75.75 0 00-1.5 0v2.5a.75.75 0 001.5 0v-2.5z"></path>
  </svg>
  <span class="flex-1">Could not load analytics. Please try again.</span>
  <button class="btn btn-sm" onclick="retry()">Retry</button>
</div>
```

**4. Token Required State:**

```html
<!-- Uses Primer's blankslate -->
<div class="blankslate">
  <svg class="blankslate-icon color-fg-muted" viewBox="0 0 24 24" width="48" height="48">
    <!-- Key icon -->
  </svg>
  <h3 class="blankslate-heading">GitHub Token Required</h3>
  <p class="color-fg-muted">A personal access token is needed to fetch analytics for this repository.</p>
  <div class="blankslate-action">
    <button class="btn btn-primary" onclick="openExtensionPopup()">
      Configure Token
    </button>
  </div>
</div>
```

### Animation & Transitions

**Primer provides built-in animation classes:**

```html
<!-- Fade in -->
<div class="anim-fade-in">Content fades in</div>

<!-- Scale in (for modals) -->
<div class="anim-scale-in">Modal scales in</div>

<!-- Pulse (for loading) -->
<div class="anim-pulse">Loading skeleton</div>

<!-- Grow (for progress bars) -->
<div class="anim-grow-x">Progress bar grows</div>
```

**Minimal custom CSS (only for chart animation):**

```css
/* Only custom CSS needed - chart line draw animation */
.agentblame-chart-line {
  stroke-dasharray: 1000;
  stroke-dashoffset: 1000;
  animation: agentblame-draw 1s ease-out forwards;
}

@keyframes agentblame-draw {
  to { stroke-dashoffset: 0; }
}
```

**Total custom CSS: ~10 lines** (just for the chart animation)

### Count-Up Animation for Numbers

```typescript
function animateValue(element: HTMLElement, start: number, end: number, duration: number): void {
  const startTime = performance.now();

  function update(currentTime: number) {
    const elapsed = currentTime - startTime;
    const progress = Math.min(elapsed / duration, 1);

    // Ease out cubic
    const eased = 1 - Math.pow(1 - progress, 3);
    const current = Math.round(start + (end - start) * eased);

    element.textContent = current.toLocaleString();

    if (progress < 1) {
      requestAnimationFrame(update);
    }
  }

  requestAnimationFrame(update);
}

// Usage
const valueEl = document.querySelector('.agb-stat-value');
animateValue(valueEl, 0, 3847, 600); // Count from 0 to 3847 in 600ms
```

### Accessibility

```html
<!-- Keyboard navigation -->
<div class="agb-overlay" role="dialog" aria-modal="true" aria-labelledby="agb-title">
  <div class="agb-modal">
    <h2 id="agb-title">AI Attribution Analytics</h2>

    <!-- Focus trap -->
    <button class="agb-close" aria-label="Close dialog">✕</button>

    <!-- Screen reader announcements -->
    <div aria-live="polite" class="agb-sr-only" id="agb-status">
      <!-- "Loading analytics..." → "Analytics loaded" -->
    </div>

    <!-- Chart with description -->
    <figure role="img" aria-label="AI code contribution trend over 30 days">
      <svg class="agb-chart">...</svg>
      <figcaption class="agb-sr-only">
        Line chart showing AI-generated code percentage over time
      </figcaption>
    </figure>
  </div>
</div>
```

```typescript
// Focus management
function openOverlay(): void {
  const overlay = document.querySelector('.agb-overlay');
  const closeBtn = overlay.querySelector('.agb-close');

  // Trap focus
  closeBtn.focus();

  // Handle Escape key
  overlay.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') closeOverlay();
  });
}
```

### Complete Modal HTML Structure (100% Primer CSS)

```html
<!-- Overlay backdrop -->
<div class="Overlay Overlay--size-large anim-fade-in" data-modal-dialog-overlay>
  <!-- Modal container -->
  <div class="Overlay-wrapper">
    <div class="Box Box--overlay anim-scale-in" style="width: 640px; max-height: 85vh; overflow: auto;"
         role="dialog" aria-modal="true" aria-labelledby="agentblame-title">

      <!-- Header -->
      <div class="Box-header d-flex flex-justify-between flex-items-center">
        <h2 id="agentblame-title" class="Box-title d-flex flex-items-center gap-2">
          <img src="${chrome.runtime.getURL('icons/logo.svg')}"
               width="20" height="20" alt="">
          Agent Blame Analytics
        </h2>
        <button class="btn-octicon" type="button" aria-label="Close" data-close-dialog>
          <svg class="octicon octicon-x" viewBox="0 0 16 16" width="16" height="16">
            <path fill-rule="evenodd" d="M3.72 3.72a.75.75 0 011.06 0L8 6.94l3.22-3.22a.75.75 0 111.06 1.06L9.06 8l3.22 3.22a.75.75 0 11-1.06 1.06L8 9.06l-3.22 3.22a.75.75 0 01-1.06-1.06L6.94 8 3.72 4.78a.75.75 0 010-1.06z"></path>
          </svg>
        </button>
      </div>

      <!-- Repository name -->
      <div class="Box-body border-bottom color-fg-muted f6">
        <svg class="octicon octicon-repo mr-1" viewBox="0 0 16 16" width="12" height="12">
          <path fill-rule="evenodd" d="M2 2.5A2.5 2.5 0 014.5 0h8.75a.75.75 0 01.75.75v12.5a.75.75 0 01-.75.75h-2.5a.75.75 0 110-1.5h1.75v-2h-8a1 1 0 00-.714 1.7.75.75 0 01-1.072 1.05A2.495 2.495 0 012 11.5v-9zm10.5-1V9h-8c-.356 0-.694.074-1 .208V2.5a1 1 0 011-1h8z"></path>
        </svg>
        mesa-dot-dev/agentblame
      </div>

      <!-- Summary Cards -->
      <div class="Box-body d-flex gap-3">
        <!-- Primary stat -->
        <div class="Box flex-1 text-center p-3 color-bg-accent-emphasis color-fg-on-emphasis rounded-2">
          <div class="f1 text-bold" data-stat="ai-percent">24.9%</div>
          <div class="f6">AI-written code</div>
          <div class="f6 color-fg-on-emphasis" style="opacity: 0.8;">3,847 of 15,420 lines</div>
        </div>
        <!-- Cursor stat -->
        <div class="Box flex-1 text-center p-3 color-bg-subtle rounded-2">
          <div class="f2 text-bold color-fg-default" data-stat="cursor">2,100</div>
          <div class="f6 color-fg-muted">Cursor</div>
        </div>
        <!-- Claude stat -->
        <div class="Box flex-1 text-center p-3 color-bg-subtle rounded-2">
          <div class="f2 text-bold color-fg-default" data-stat="claude">1,747</div>
          <div class="f6 color-fg-muted">Claude Code</div>
        </div>
      </div>

      <!-- Trend Chart -->
      <div class="Box-body">
        <h3 class="f5 text-bold mb-2">Trend (last 30 days)</h3>
        <div class="rounded-2 color-bg-subtle p-3">
          <svg viewBox="0 0 400 100" style="width: 100%; height: 100px;" aria-label="AI contribution trend">
            <!-- Grid lines -->
            <line x1="0" y1="50" x2="400" y2="50" stroke="var(--color-border-default)" stroke-dasharray="4"/>
            <!-- Trend line - rendered dynamically -->
            <path class="agentblame-chart-line" d="M0,80 L50,70 L100,65 L150,60 L200,55 L250,50 L300,45 L350,40 L400,35"
                  fill="none" stroke="var(--color-accent-fg)" stroke-width="2"/>
          </svg>
          <div class="d-flex flex-justify-between f6 color-fg-muted mt-1">
            <span>Jan 1</span>
            <span>Jan 8</span>
            <span>Jan 15</span>
          </div>
        </div>
      </div>

      <!-- Two column layout -->
      <div class="Box-body d-flex gap-3">
        <!-- Model Breakdown -->
        <div class="flex-1">
          <h3 class="f5 text-bold mb-2">By Model</h3>
          <div class="d-flex flex-column gap-2">
            <div class="d-flex flex-items-center gap-2">
              <span class="flex-1 f6">GPT-4</span>
              <span class="Progress flex-1" style="height: 8px;">
                <span class="Progress-item color-bg-accent-emphasis anim-grow-x" style="width: 47%;"></span>
              </span>
              <span class="f6 color-fg-muted" style="width: 36px; text-align: right;">47%</span>
            </div>
            <div class="d-flex flex-items-center gap-2">
              <span class="flex-1 f6">Claude 3.5</span>
              <span class="Progress flex-1" style="height: 8px;">
                <span class="Progress-item color-bg-accent-emphasis anim-grow-x" style="width: 35%;"></span>
              </span>
              <span class="f6 color-fg-muted" style="width: 36px; text-align: right;">35%</span>
            </div>
            <div class="d-flex flex-items-center gap-2">
              <span class="flex-1 f6">GPT-4o</span>
              <span class="Progress flex-1" style="height: 8px;">
                <span class="Progress-item color-bg-accent-emphasis anim-grow-x" style="width: 18%;"></span>
              </span>
              <span class="f6 color-fg-muted" style="width: 36px; text-align: right;">18%</span>
            </div>
          </div>
        </div>

        <!-- Recent PRs -->
        <div class="flex-1">
          <h3 class="f5 text-bold mb-2">Recent PRs</h3>
          <div class="d-flex flex-column gap-1">
            <a href="/mesa-dot-dev/agentblame/pull/52" class="d-flex flex-items-center gap-2 color-fg-default text-decoration-none rounded-2 p-1 color-bg-subtle-hover">
              <span class="color-fg-muted f6">#52</span>
              <span class="flex-1 f6 text-truncate">Add user authentication</span>
              <span class="Label Label--accent">60% AI</span>
            </a>
            <a href="/mesa-dot-dev/agentblame/pull/51" class="d-flex flex-items-center gap-2 color-fg-default text-decoration-none rounded-2 p-1 color-bg-subtle-hover">
              <span class="color-fg-muted f6">#51</span>
              <span class="flex-1 f6 text-truncate">Fix login bug</span>
              <span class="Label Label--accent">50% AI</span>
            </a>
            <a href="/mesa-dot-dev/agentblame/pull/50" class="d-flex flex-items-center gap-2 color-fg-default text-decoration-none rounded-2 p-1 color-bg-subtle-hover">
              <span class="color-fg-muted f6">#50</span>
              <span class="flex-1 f6 text-truncate">Update dependencies</span>
              <span class="Label Label--success">0% AI</span>
            </a>
          </div>
        </div>
      </div>

      <!-- Footer -->
      <div class="Box-footer d-flex flex-justify-between flex-items-center f6 color-fg-muted">
        <span>Updated 2 hours ago</span>
        <a href="https://github.com/mesa-dot-dev/agentblame" class="Link--muted">
          Powered by Agent Blame
        </a>
      </div>

    </div>
  </div>
</div>
```

### Benefits of Using Primer CSS

| Benefit | Impact |
|---------|--------|
| **Zero CSS bundle** | Extension stays small, no CSS to load |
| **Dark mode free** | Automatically works with GitHub themes |
| **Consistent look** | Matches GitHub's native UI perfectly |
| **Accessible** | Primer is tested for WCAG compliance |
| **Future-proof** | GitHub updates Primer, we get updates free |
| **Faster development** | No designing custom components |

### Custom CSS Required

Only **~10 lines** for chart line animation:

```css
.agentblame-chart-line {
  stroke-dasharray: 1000;
  stroke-dashoffset: 1000;
  animation: agentblame-draw 1s ease-out forwards;
}

@keyframes agentblame-draw {
  to { stroke-dashoffset: 0; }
}
```

Everything else uses Primer classes directly.

---

## Open Questions

1. **History retention:** Keep all history forever, or implement rolling window?
2. **Deleted lines:** How to handle code removal? Currently only tracking additions.
3. **Rebased/force-pushed branches:** Analytics might double-count if PR is force-pushed.
4. **Private repos:** Extension needs appropriate token scopes.
5. **Monorepos:** Should analytics be per-package or repo-wide?

---

## Appendix: API Reference

### GitHub API Endpoints Used

```
# Resolve tag to SHA
GET /repos/:owner/:repo/git/ref/tags/agentblame-analytics

# Get notes ref
GET /repos/:owner/:repo/git/refs/notes/agentblame

# Get commit (to get tree)
GET /repos/:owner/:repo/git/commits/:sha

# Get tree (to find note blob)
GET /repos/:owner/:repo/git/trees/:sha?recursive=1

# Get blob (note content)
GET /repos/:owner/:repo/git/blobs/:sha
```

### Git Commands Used

```bash
# Create analytics tag
git tag agentblame-analytics $(git rev-list --max-parents=0 HEAD | head -1)

# Push tag
git push origin agentblame-analytics

# Read note
git notes --ref=refs/notes/agentblame show <sha>

# Write note
git notes --ref=refs/notes/agentblame add -f -m '<json>' <sha>

# Push notes
git push origin refs/notes/agentblame

# Fetch notes
git fetch origin refs/notes/agentblame:refs/notes/agentblame
```

---

## Mesa Design System

The mockup at `/Users/murali/Code/Sandbox/agentblame-expansion` uses a custom design system called "Mesa" built on GitHub's Primer CSS. Key components to port:

### Color System

```typescript
// Map to GitHub Primer CSS variables
const mesaColors = {
  severe: {
    fg: "var(--fgColor-severe)",      // Orange - AI-generated
    bg: "var(--bgColor-severe-muted)",
    border: "var(--borderColor-severe-muted)",
  },
  success: {
    fg: "var(--fgColor-success)",     // Green - Human-written
    bg: "var(--bgColor-success-muted)",
    border: "var(--borderColor-success-muted)",
  },
  attention: {
    fg: "var(--fgColor-attention)",   // Yellow - Warnings
    bg: "var(--bgColor-attention-muted)",
  },
  muted: {
    fg: "var(--fgColor-muted)",       // Gray - Secondary
    bg: "var(--bgColor-muted)",
  },
};

// Semantic aliases
const semantic = {
  ai: mesaColors.severe,      // Orange = AI
  human: mesaColors.success,  // Green = Human
};
```

### Core Components to Port

| Component | Purpose | File |
|-----------|---------|------|
| `AIHumanBar` | Dual-color progress bar (AI orange + Human green) | `ai-human-bar.ts` |
| `MesaCardHeader` | Branded card header with logo + badge | `card-header.ts` |
| `StatDisplay` | Big hero number with label and trend | `stat-display.ts` |
| `BreakdownList` | List of items with progress bars | `breakdown-list.ts` |
| `MesaBadge` | Severity-colored badge | `badge.ts` |
| `HeatmapCalendar` | 90-day activity grid (Phase 2) | `heatmap.ts` |

### AIHumanBar Component

```typescript
// Dual-color progress bar showing AI vs human contribution
function AIHumanBar(ai: number): string {
  const human = 100 - ai;
  return `
    <div class="d-flex rounded-full overflow-hidden" style="height: 8px; background: var(--bgColor-neutral-muted);">
      <div style="width: ${ai}%; background: var(--fgColor-severe);"></div>
      <div style="width: ${human}%; background: var(--fgColor-success);"></div>
    </div>
  `;
}
```

### Card Structure Pattern

```
┌─────────────────────────────────────────────────────────────────┐
│ 🌵 Title                                    Badge   Powered by  │  ← MesaCardHeader
├─────────────────────────────────────────────────────────────────┤
│                                                                 │
│  ┌─────────┐  ┌─────────┐  ┌─────────┐                         │
│  │  58%    │  │  1,651  │  │  1,196  │                         │  ← StatDisplay grid
│  │   AI    │  │ AI lines│  │  Human  │                         │
│  └─────────┘  └─────────┘  └─────────┘                         │
│                                                                 │
│  ████████████████░░░░░░░░  58% AI                              │  ← AIHumanBar
│                                                                 │
│  By Tool          By Model           By File Type              │
│  Cursor  62% ████ claude-4  65% ████ Tests 78% ████████        │  ← BreakdownList
│  Claude  38% ██   sonnet    30% ███  Utils 54% █████           │
│                                                                 │
└─────────────────────────────────────────────────────────────────┘
```

### File Structure for Chrome Extension

```
packages/chrome/src/
├── components/
│   └── mesa/
│       ├── index.ts              # Barrel export
│       ├── colors.ts             # Primer color mappings
│       ├── ai-human-bar.ts       # Dual progress bar
│       ├── card-header.ts        # Branded headers
│       ├── stat-display.ts       # Hero numbers
│       ├── breakdown-list.ts     # Progress bar lists
│       ├── badge.ts              # Severity badges
│       └── heatmap.ts            # Activity calendar (Phase 2)
├── content/
│   ├── analytics-overlay.ts      # Repository Pulse view
│   ├── analytics-tab.ts          # Tab injection (existing)
│   ├── pr-summary.ts             # PR Summary card (new)
│   └── content.ts                # Main content script
└── lib/
    ├── github-api.ts             # Add fetchAnalytics()
    └── analytics-cache.ts        # Caching layer (new)
```

### Design Principles

1. **Use GitHub's Primer CSS** - Zero additional CSS needed
2. **Orange = AI, Green = Human** - Consistent color semantics
3. **Primer handles dark mode** - Automatic theme support
4. **Native feel** - UI should feel like GitHub, not a third-party overlay
5. **Minimal custom CSS** - Only ~10 lines for chart animations
