#!/bin/bash
#
# Load Test Analytics Fixture
#
# Loads the test analytics JSON into a repository's git notes for testing
# the Chrome extension locally.
#
# Usage:
#   ./scripts/load-test-analytics.sh [repo-path]
#
# If no repo-path is provided, uses the current directory.
#
# Example:
#   ./scripts/load-test-analytics.sh ~/Code/Sandbox/agentblame-sandbox
#

set -e

# Colors
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
CYAN='\033[0;36m'
RED='\033[0;31m'
NC='\033[0m' # No Color

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
FIXTURE_FILE="$SCRIPT_DIR/../fixtures/test-analytics.json"

# Get target repo path
REPO_PATH="${1:-$(pwd)}"

# Validate it's a git repo
if [ ! -d "$REPO_PATH/.git" ]; then
  echo -e "${RED}Error:${NC} $REPO_PATH is not a git repository"
  exit 1
fi

# Check fixture exists
if [ ! -f "$FIXTURE_FILE" ]; then
  echo -e "${RED}Error:${NC} Fixture file not found: $FIXTURE_FILE"
  exit 1
fi

cd "$REPO_PATH"

echo -e "${CYAN}[load-test-analytics]${NC} Loading test analytics into: $REPO_PATH"

# Get the root commit (anchor for analytics)
ROOT_COMMIT=$(git rev-list --max-parents=0 HEAD | head -1)
echo -e "${CYAN}[load-test-analytics]${NC} Root commit: ${ROOT_COMMIT:0:7}"

# Add the analytics note
git notes --ref=agentblame-analytics add -f -m "$(cat "$FIXTURE_FILE")" "$ROOT_COMMIT"

echo -e "${GREEN}[load-test-analytics]${NC} Test analytics loaded successfully!"
echo ""
echo "To push to remote (optional):"
echo "  git push origin refs/notes/agentblame-analytics:refs/notes/agentblame-analytics --force"
echo ""
echo "To view the analytics:"
echo "  git notes --ref=agentblame-analytics show $ROOT_COMMIT"
