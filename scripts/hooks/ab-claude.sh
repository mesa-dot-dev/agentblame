#!/bin/bash
# Agent Blame Claude Code Hook
# Captures AI edits from Claude Code's PostToolUse hook (Edit/Write/MultiEdit)

AB_DIR="$HOME/.agentblame"
LOGS_DIR="$AB_DIR/logs"
LOG_FILE="$LOGS_DIR/claude-generated.log"

mkdir -p "$LOGS_DIR"

# Read hook payload from stdin
PAYLOAD=$(cat)

# Append payload with timestamp
TIMESTAMP=$(date -u +"%Y-%m-%dT%H:%M:%SZ")
echo "{\"timestamp\":\"$TIMESTAMP\",\"hook\":\"PostToolUse\",\"payload\":$PAYLOAD}" >> "$LOG_FILE"
