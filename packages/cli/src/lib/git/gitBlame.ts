/**
 * Git Blame Parser
 *
 * Parses git blame output to get commit information per line
 */

import { runGit } from "./gitCli";

export interface BlameLine {
  lineNumber: number;
  origLine: number; // Original line number in the commit (for attribution matching)
  sha: string;
  author: string;
  authorTime: Date;
  content: string;
}

export interface BlameResult {
  file: string;
  lines: BlameLine[];
  commits: Map<string, { author: string; time: Date }>;
}

/**
 * Run git blame and parse the output
 */
export async function getBlame(
  repoRoot: string,
  filePath: string,
): Promise<BlameResult> {
  // Use --porcelain for machine-readable output
  const result = await runGit(
    repoRoot,
    ["blame", "--porcelain", filePath],
    30000,
  );

  if (result.exitCode !== 0) {
    throw new Error(`git blame failed: ${result.stderr}`);
  }

  return parseBlameOutput(filePath, result.stdout);
}

/**
 * Parse git blame --porcelain output
 *
 * Format:
 * <sha> <orig-line> <final-line> <num-lines>
 * author <name>
 * author-mail <email>
 * author-time <timestamp>
 * author-tz <timezone>
 * committer <name>
 * ...
 * filename <path>
 * \t<content>
 */
function parseBlameOutput(filePath: string, output: string): BlameResult {
  const lines: BlameLine[] = [];
  const commits = new Map<string, { author: string; time: Date }>();

  const rawLines = output.split("\n");
  let i = 0;
  let lineNumber = 0;

  while (i < rawLines.length) {
    const headerLine = rawLines[i];
    if (!headerLine || !headerLine.match(/^[0-9a-f]{40}/)) {
      i++;
      continue;
    }

    // Parse header: <sha> <orig-line> <final-line> [<num-lines>]
    const parts = headerLine.split(" ");
    const sha = parts[0];
    const origLine = parseInt(parts[1], 10);
    lineNumber++;

    // Parse metadata until we hit the content line (starts with \t)
    let author = "";
    let authorTime = new Date();
    i++;

    while (i < rawLines.length && !rawLines[i].startsWith("\t")) {
      const line = rawLines[i];
      if (line.startsWith("author ")) {
        author = line.slice(7);
      } else if (line.startsWith("author-time ")) {
        authorTime = new Date(parseInt(line.slice(12), 10) * 1000);
      }
      i++;
    }

    // Get content (line starting with \t)
    let content = "";
    if (i < rawLines.length && rawLines[i].startsWith("\t")) {
      content = rawLines[i].slice(1);
      i++;
    }

    // Store commit info
    if (!commits.has(sha)) {
      commits.set(sha, { author, time: authorTime });
    }

    lines.push({
      lineNumber,
      origLine,
      sha,
      author,
      authorTime,
      content,
    });
  }

  return { file: filePath, lines, commits };
}
