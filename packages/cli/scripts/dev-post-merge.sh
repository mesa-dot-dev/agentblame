#!/bin/bash
#
# Dev Post-Merge Script
#
# Simulates what GitHub Actions would run after a PR merge.
# Use this to test analytics locally without waiting for CI.
#
# Usage:
#   ./scripts/dev-post-merge.sh           # Process most recent PR
#   ./scripts/dev-post-merge.sh --all     # Process all PRs in history
#
# Run this after pulling a merged PR from GitHub.
#

set -e

# Colors
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
CYAN='\033[0;36m'
RED='\033[0;31m'
NC='\033[0m' # No Color

# Use current directory as repo root
REPO_ROOT="$(pwd)"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
CLI_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"

# Check for --all flag
PROCESS_ALL=false
if [ "$1" = "--all" ]; then
  PROCESS_ALL=true
fi

# Function to process a single PR
process_pr() {
  local COMMIT_SHA="$1"
  local PR_NUMBER="$2"
  local PR_TITLE="$3"
  local PR_AUTHOR="$4"

  # Get commit SHAs
  local MERGE_SHA="$COMMIT_SHA"
  local BASE_SHA=$(git rev-parse ${COMMIT_SHA}~1 2>/dev/null || git rev-parse $COMMIT_SHA)
  local HEAD_SHA="$MERGE_SHA"

  echo -e "${CYAN}[dev-post-merge]${NC} Processing PR #$PR_NUMBER: $PR_TITLE"

  # Export environment variables
  export PR_NUMBER
  export PR_TITLE
  export PR_AUTHOR
  export BASE_SHA
  export HEAD_SHA
  export MERGE_SHA

  # Run the post-merge script
  bun "$CLI_DIR/src/post-merge.ts"
}

if [ "$PROCESS_ALL" = true ]; then
  echo -e "${CYAN}[dev-post-merge]${NC} Finding all PR merge commits..."

  # Collect all merge commits with PR numbers (oldest first for proper analytics accumulation)
  MERGE_COMMITS=()
  for i in $(seq 0 50); do
    COMMIT_SHA=$(git log -1 --skip=$i --pretty=%H 2>/dev/null)
    if [ -z "$COMMIT_SHA" ]; then
      break
    fi
    MSG=$(git log -1 --skip=$i --pretty=%s 2>/dev/null)
    NUM=$(echo "$MSG" | grep -oE '#[0-9]+' | head -1 | tr -d '#')
    if [ -n "$NUM" ]; then
      MERGE_COMMITS+=("$COMMIT_SHA:$NUM")
    fi
  done

  if [ ${#MERGE_COMMITS[@]} -eq 0 ]; then
    echo -e "${RED}[dev-post-merge]${NC} No PR merge commits found"
    exit 1
  fi

  echo -e "${CYAN}[dev-post-merge]${NC} Found ${#MERGE_COMMITS[@]} PRs to process"

  # Process in reverse order (oldest first) so analytics build up correctly
  for ((i=${#MERGE_COMMITS[@]}-1; i>=0; i--)); do
    IFS=':' read -r COMMIT_SHA PR_NUMBER <<< "${MERGE_COMMITS[$i]}"

    # Get PR title and author
    PR_TITLE=$(git log -1 $COMMIT_SHA --pretty=%s | sed "s/ (#$PR_NUMBER)$//" | sed 's/^Merge pull request #[0-9]* from [^ ]* //')

    PR_AUTHOR=""
    if command -v gh &> /dev/null; then
      PR_AUTHOR=$(gh pr view "$PR_NUMBER" --json author --jq '.author.login' 2>/dev/null || true)
    fi
    if [ -z "$PR_AUTHOR" ]; then
      PR_AUTHOR=$(git config github.user 2>/dev/null || git log -1 $COMMIT_SHA --pretty=%ae)
    fi

    process_pr "$COMMIT_SHA" "$PR_NUMBER" "$PR_TITLE" "$PR_AUTHOR"
    echo ""
  done
else
  echo -e "${CYAN}[dev-post-merge]${NC} Finding most recent PR merge commit..."

  # Find the most recent commit with a PR number (look back up to 20 commits)
  COMMIT_SHA=""
  COMMIT_MSG=""
  PR_NUMBER=""

  for i in $(seq 0 19); do
    MSG=$(git log -1 --skip=$i --pretty=%B 2>/dev/null)
    NUM=$(echo "$MSG" | grep -oE '#[0-9]+' | head -1 | tr -d '#')
    if [ -n "$NUM" ]; then
      COMMIT_SHA=$(git log -1 --skip=$i --pretty=%H)
      COMMIT_MSG="$MSG"
      PR_NUMBER="$NUM"
      break
    fi
  done

  if [ -z "$PR_NUMBER" ]; then
    echo -e "${RED}[dev-post-merge]${NC} Could not find any PR merge commit in recent history"
    echo ""
    echo -e "${YELLOW}Tip: Make sure you have merged PRs with (#123) format${NC}"
    exit 1
  fi

  # Get PR title from commit message (first line, minus the PR number suffix)
  PR_TITLE=$(git log -1 $COMMIT_SHA --pretty=%s | sed "s/ (#$PR_NUMBER)$//" | sed 's/^Merge pull request #[0-9]* from [^ ]* //')

  # Get author username from gh CLI (preferred) or fallback to git
  PR_AUTHOR=""
  if command -v gh &> /dev/null && [ -n "$PR_NUMBER" ]; then
    PR_AUTHOR=$(gh pr view "$PR_NUMBER" --json author --jq '.author.login' 2>/dev/null || true)
  fi
  if [ -z "$PR_AUTHOR" ]; then
    PR_AUTHOR=$(git config github.user 2>/dev/null || git log -1 $COMMIT_SHA --pretty=%ae)
  fi

  echo -e "${CYAN}[dev-post-merge]${NC} Found PR merge:"
  echo "  PR Number: #$PR_NUMBER"
  echo "  PR Title:  $PR_TITLE"
  echo "  PR Author: $PR_AUTHOR"
  echo "  Commit:    ${COMMIT_SHA:0:7}"
  echo ""

  process_pr "$COMMIT_SHA" "$PR_NUMBER" "$PR_TITLE" "$PR_AUTHOR"
fi

echo ""
echo -e "${CYAN}[dev-post-merge]${NC} Syncing notes with remote..."

# Fetch notes first to avoid conflicts
git fetch origin refs/notes/agentblame:refs/notes/agentblame 2>/dev/null || true
git fetch origin refs/notes/agentblame-analytics:refs/notes/agentblame-analytics 2>/dev/null || true

# Push attribution notes (force to overwrite)
git push origin refs/notes/agentblame:refs/notes/agentblame --force 2>/dev/null && echo "  Pushed attribution notes" || echo "  (no attribution notes to push)"

# Push analytics notes (force to overwrite)
git push origin refs/notes/agentblame-analytics:refs/notes/agentblame-analytics --force 2>/dev/null && echo "  Pushed analytics notes" || echo "  (no analytics notes to push)"

# Get repo URL for display
REPO_URL=$(git remote get-url origin 2>/dev/null | sed 's/\.git$//' | sed 's/git@github.com:/https:\/\/github.com\//')

echo ""
echo -e "${GREEN}[dev-post-merge]${NC} Done! Analytics should now be visible on GitHub Insights."
echo ""
echo "View at: ${REPO_URL}/pulse"
echo "(Look for 'Agent Blame' in the Insights sidebar)"
