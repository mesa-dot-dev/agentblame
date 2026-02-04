/**
 * Agent Blame Configuration
 *
 * Manages user preferences stored in git config.
 * Settings are stored per-repo in .git/config under [agentblame] section.
 */

import { runGit } from "./git/gitCli";

/**
 * Configuration keys and their defaults
 */
export interface AgentBlameConfig {
  /** Whether to store actual prompt content (default: true) */
  storePromptContent: boolean;
  traceHooks: boolean;
}

const CONFIG_DEFAULTS: AgentBlameConfig = {
  storePromptContent: false,  // Default: don't store prompt text (privacy-first)
  traceHooks: false,          // don't leave debug trace files around unless user opts in
};

const CONFIG_PREFIX = "agentblame";

/**
 * Get a configuration value
 */
export async function getConfig<K extends keyof AgentBlameConfig>(
  repoRoot: string,
  key: K
): Promise<AgentBlameConfig[K]> {
  try {
    const result = await runGit(repoRoot, [
      "config",
      "--local",
      "--get",
      `${CONFIG_PREFIX}.${key}`,
    ]);

    // git config --get returns exit code 1 if key not found
    if (result.exitCode !== 0) {
      return CONFIG_DEFAULTS[key];
    }

    const value = result.stdout.trim();

    // Parse based on type
    if (typeof CONFIG_DEFAULTS[key] === "boolean") {
      return (value === "true") as unknown as AgentBlameConfig[K];
    }

    return value as unknown as AgentBlameConfig[K];
  } catch {
    // Return default if not set
    return CONFIG_DEFAULTS[key];
  }
}

/**
 * Set a configuration value
 */
export async function setConfig<K extends keyof AgentBlameConfig>(
  repoRoot: string,
  key: K,
  value: AgentBlameConfig[K]
): Promise<void> {
  await runGit(repoRoot, [
    "config",
    "--local",
    `${CONFIG_PREFIX}.${key}`,
    String(value),
  ]);
}

/**
 * Unset a configuration value (revert to default)
 */
export async function unsetConfig<K extends keyof AgentBlameConfig>(
  repoRoot: string,
  key: K
): Promise<void> {
  try {
    await runGit(repoRoot, [
      "config",
      "--local",
      "--unset",
      `${CONFIG_PREFIX}.${key}`,
    ]);
  } catch {
    // Ignore if not set
  }
}

/**
 * Get all configuration values
 */
export async function getAllConfig(
  repoRoot: string
): Promise<AgentBlameConfig> {
  const config: AgentBlameConfig = { ...CONFIG_DEFAULTS };

  for (const key of Object.keys(CONFIG_DEFAULTS) as (keyof AgentBlameConfig)[]) {
    config[key] = await getConfig(repoRoot, key);
  }

  return config;
}

/**
 * List all configuration with their current values and defaults
 */
export async function listConfig(
  repoRoot: string
): Promise<Array<{ key: string; value: string; default: string; isDefault: boolean }>> {
  const result: Array<{ key: string; value: string; default: string; isDefault: boolean }> = [];

  for (const key of Object.keys(CONFIG_DEFAULTS) as (keyof AgentBlameConfig)[]) {
    const currentValue = await getConfig(repoRoot, key);
    const defaultValue = CONFIG_DEFAULTS[key];
    const isDefault = currentValue === defaultValue;

    result.push({
      key,
      value: String(currentValue),
      default: String(defaultValue),
      isDefault,
    });
  }

  return result;
}

/**
 * Valid config keys for user input validation
 */
export const VALID_CONFIG_KEYS = Object.keys(CONFIG_DEFAULTS) as (keyof AgentBlameConfig)[];

/**
 * Parse a string value to the appropriate type for a config key
 */
export function parseConfigValue<K extends keyof AgentBlameConfig>(
  key: K,
  value: string
): AgentBlameConfig[K] | null {
  const defaultValue = CONFIG_DEFAULTS[key];

  if (typeof defaultValue === "boolean") {
    if (value === "true" || value === "1" || value === "yes") {
      return true as unknown as AgentBlameConfig[K];
    }
    if (value === "false" || value === "0" || value === "no") {
      return false as unknown as AgentBlameConfig[K];
    }
    return null; // Invalid boolean value
  }

  return value as unknown as AgentBlameConfig[K];
}
