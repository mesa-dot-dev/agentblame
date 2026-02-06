#!/usr/bin/env node

/**
 * Post-install script for agentblame CLI.
 * Creates the global ~/.agentblame/ directory and initializes the database.
 */

const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");

const globalDir = path.join(os.homedir(), ".agentblame");
const logsDir = path.join(globalDir, "logs");

try {
  // Create directories if they don't exist
  if (!fs.existsSync(globalDir)) {
    fs.mkdirSync(globalDir, { recursive: true });
    console.log("Created ~/.agentblame/");
  }
  if (!fs.existsSync(logsDir)) {
    fs.mkdirSync(logsDir, { recursive: true });
  }
  console.log("Agent Blame ready. Run 'agentblame enable' in a git repo to start tracking.");
} catch (err) {
  // Silent failure - don't break npm install
  console.error("Warning: Could not create ~/.agentblame/ directory:", err.message);
}
