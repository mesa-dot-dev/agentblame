#!/bin/bash
# Agent Blame Cursor Hook
# Captures AI edits from Cursor's afterFileEdit and afterTabFileEdit hooks

AB_DIR="$HOME/.agentblame"
LOGS_DIR="$AB_DIR/logs"

mkdir -p "$LOGS_DIR"

# Read hook payload from stdin
PAYLOAD=$(cat)

# Determine hook type from payload or environment
HOOK_TYPE="${CURSOR_HOOK_TYPE:-afterFileEdit}"

# Route to appropriate log file
if [ "$HOOK_TYPE" = "afterTabFileEdit" ]; then
  LOG_FILE="$LOGS_DIR/cursor-assisted.log"
else
  LOG_FILE="$LOGS_DIR/cursor-generated.log"
fi

# Append payload with timestamp
TIMESTAMP=$(date -u +"%Y-%m-%dT%H:%M:%SZ")
echo "{\"timestamp\":\"$TIMESTAMP\",\"hook\":\"$HOOK_TYPE\",\"payload\":$PAYLOAD}" >> "$LOG_FILE"
