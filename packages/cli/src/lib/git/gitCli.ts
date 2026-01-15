import { spawn } from "node:child_process";

export interface GitResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

/**
 * Run a git command and return the result
 */
export async function runGit(
  cwd: string,
  args: string[],
  timeoutMs = 30000,
): Promise<GitResult> {
  return new Promise((resolve) => {
    const proc = spawn("git", args, {
      cwd,
      timeout: timeoutMs,
      stdio: ["ignore", "pipe", "pipe"],
    });

    let stdout = "";
    let stderr = "";

    proc.stdout.on("data", (data) => {
      stdout += data.toString();
    });

    proc.stderr.on("data", (data) => {
      stderr += data.toString();
    });

    proc.on("close", (code) => {
      resolve({
        exitCode: code ?? 1,
        stdout,
        stderr,
      });
    });

    proc.on("error", (err) => {
      resolve({
        exitCode: 1,
        stdout,
        stderr: err.message,
      });
    });
  });
}

/**
 * Check if a directory is a git repository
 */
export async function isGitRepo(dir: string): Promise<boolean> {
  const result = await runGit(dir, ["rev-parse", "--git-dir"], 5000);
  return result.exitCode === 0;
}

/**
 * Get the root of the git repository
 */
export async function getRepoRoot(dir: string): Promise<string | null> {
  const result = await runGit(dir, ["rev-parse", "--show-toplevel"], 5000);
  if (result.exitCode !== 0) return null;
  return result.stdout.trim() || null;
}
