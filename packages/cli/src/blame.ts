/**
 * Agent Blame Command
 *
 * Shows AI attribution for each line in a file, similar to git blame
 */

import * as path from "node:path";
import * as fs from "node:fs";
import {
  getBlame,
  readNote,
  fetchNotesQuiet,
  getRepoRoot,
  type BlameLine,
  type GitNotesAttribution,
  type MatchType,
} from "./lib";

// Terminal colors
const c = {
  reset: "\x1b[0m",
  bold: "\x1b[1m",
  dim: "\x1b[2m",
  cyan: "\x1b[36m",
  yellow: "\x1b[33m",
  green: "\x1b[32m",
  orange: "\x1b[38;5;166m", // Mesa Orange - matches gutter color
  blue: "\x1b[34m",
  gray: "\x1b[90m",
};

// Attribution entry from git notes
type NoteAttribution = GitNotesAttribution["attributions"][number];

interface LineAttribution {
  line: BlameLine;
  attribution: NoteAttribution | null;
}

interface BlameOptions {
  json?: boolean;
  summary?: boolean;
}

/**
 * Run agentblame on a file
 */
export async function blame(
  filePath: string,
  options: BlameOptions = {},
): Promise<void> {
  // Resolve file path
  const absolutePath = path.resolve(filePath);

  // Check file exists
  if (!fs.existsSync(absolutePath)) {
    console.error(`Error: File not found: ${absolutePath}`);
    process.exit(1);
  }

  // Check it's a file, not directory
  const stat = fs.statSync(absolutePath);
  if (!stat.isFile()) {
    console.error(`Error: Not a file: ${absolutePath}`);
    process.exit(1);
  }

  const repoRoot = await getRepoRoot(path.dirname(absolutePath));

  if (!repoRoot) {
    console.error("Error: Not in a git repository");
    process.exit(1);
  }

  // Get relative path and validate it's within repo
  const relativePath = path.relative(repoRoot, absolutePath);
  if (relativePath.startsWith("..")) {
    console.error("Error: File is outside the repository");
    process.exit(1);
  }

  // Fetch latest notes from remote (silent, ignores errors)
  await fetchNotesQuiet(repoRoot);

  // Get blame data
  let blameResult: Awaited<ReturnType<typeof getBlame>>;
  try {
    blameResult = await getBlame(repoRoot, relativePath);
  } catch (err) {
    console.error(`Error: ${err}`);
    process.exit(1);
  }

  // Fetch notes for all unique commits
  const uniqueShas = [...new Set(blameResult.lines.map((l) => l.sha))];
  const notesMap = new Map<string, NoteAttribution[]>();

  for (const sha of uniqueShas) {
    const note = await readNote(repoRoot, sha);
    if (note?.attributions) {
      notesMap.set(sha, note.attributions);
    }
  }

  // Build line attribution
  const lineAttributions: LineAttribution[] = blameResult.lines.map((line) => {
    const commitNotes = notesMap.get(line.sha) || [];
    // Find attribution that covers this line (must match path AND line number range)
    const attr = commitNotes.find((a) => {
      const pathMatches =
        a.path === relativePath ||
        a.path.endsWith(relativePath) ||
        relativePath.endsWith(a.path);

      if (!pathMatches) return false;

      // Check if original line number (at commit time) is within the attribution range
      return line.origLine >= a.startLine && line.origLine <= a.endLine;
    });
    return { line, attribution: attr || null };
  });

  // Output
  if (options.json) {
    outputJson(lineAttributions, relativePath);
  } else if (options.summary) {
    outputSummary(lineAttributions, relativePath);
  } else {
    outputFormatted(lineAttributions, relativePath);
  }
}

/**
 * Output formatted blame with attribution markers
 */
function outputFormatted(lines: LineAttribution[], filePath: string): void {
  console.log("");
  console.log(`  ${c.bold}${c.cyan}${filePath}${c.reset}`);
  console.log(`  ${c.dim}${"─".repeat(70)}${c.reset}`);

  // Calculate column widths
  const maxLineNum = lines.length.toString().length;

  for (const { line, attribution } of lines) {
    const sha = `${c.yellow}${line.sha.slice(0, 7)}${c.reset}`;
    const author = `${c.blue}${line.author.slice(0, 12).padEnd(12)}${c.reset}`;
    const date = `${c.dim}${formatDate(line.authorTime)}${c.reset}`;
    const lineNum = `${c.dim}${line.lineNumber.toString().padStart(maxLineNum)}${c.reset}`;

    // Attribution info - use fixed width column (must fit longest: "✨ Cursor - claude-4.5-opus-high-thinking")
    const ATTR_WIDTH = 44;
    let attrInfo = "";
    let visibleLen = 0;
    if (attribution) {
      const provider = attribution.provider === "cursor" ? "Cursor" : "Claude";
      const model = attribution.model && attribution.model !== "claude" ? attribution.model : "";
      const label = model ? `${provider} - ${model}` : provider;
      visibleLen = label.length + 3; // +2 for emoji (renders 2-wide) + 1 space
      attrInfo = `${c.orange}✨ ${label}${c.reset}`;
    }

    const attrPadded = attribution
      ? attrInfo + " ".repeat(Math.max(0, ATTR_WIDTH - visibleLen))
      : " ".repeat(ATTR_WIDTH);

    console.log(
      `  ${sha} ${author} ${date} ${attrPadded} ${c.dim}│${c.reset} ${lineNum} ${c.dim}│${c.reset} ${line.content}`,
    );
  }

  // Print summary (excluding empty lines)
  const nonEmptyLines = filterNonEmptyLines(lines);
  const aiGenerated = nonEmptyLines.filter(
    (l) => l.attribution?.category === "ai_generated",
  ).length;
  const human = nonEmptyLines.length - aiGenerated;
  const aiPct = nonEmptyLines.length > 0 ? Math.round((aiGenerated / nonEmptyLines.length) * 100) : 0;
  const humanPct = 100 - aiPct;

  // Summary bar
  const barWidth = 40;
  const aiBarWidth = Math.round((aiPct / 100) * barWidth);
  const humanBarWidth = barWidth - aiBarWidth;
  const aiBar = `${c.orange}${"█".repeat(aiBarWidth)}${c.reset}`;
  const humanBar = `${c.dim}${"░".repeat(humanBarWidth)}${c.reset}`;

  console.log(`  ${c.dim}${"─".repeat(70)}${c.reset}`);
  console.log(`  ${aiBar}${humanBar}`);
  console.log(`  ${c.orange}✨ AI: ${aiGenerated} (${aiPct}%)${c.reset}  ${c.dim}│${c.reset}  ${c.green}👤 Human: ${human} (${humanPct}%)${c.reset}`);
  console.log("");
}

/**
 * Output summary only
 */
function outputSummary(lines: LineAttribution[], filePath: string): void {
  // Exclude empty lines from counting
  const nonEmptyLines = filterNonEmptyLines(lines);
  const aiGenerated = nonEmptyLines.filter(
    (l) => l.attribution?.category === "ai_generated",
  ).length;
  const human = nonEmptyLines.length - aiGenerated;

  console.log(`\n${filePath}:`);
  console.log(`  Total lines:   ${nonEmptyLines.length}`);
  console.log(
    `  AI-generated:  ${aiGenerated} (${pct(aiGenerated, nonEmptyLines.length)})`,
  );
  console.log(`  Human:         ${human} (${pct(human, nonEmptyLines.length)})`);
  console.log("");

  // Provider breakdown
  const providers = new Map<string, number>();
  const matchTypes = new Map<string, number>();
  for (const { attribution } of lines) {
    if (attribution) {
      const provider = attribution.provider;
      providers.set(provider, (providers.get(provider) || 0) + 1);

      const matchType = attribution.matchType;
      matchTypes.set(matchType, (matchTypes.get(matchType) || 0) + 1);
    }
  }

  if (providers.size > 0) {
    console.log("  By provider:");
    for (const [provider, count] of providers) {
      console.log(`    ${provider}: ${count} lines`);
    }
    console.log("");
  }

  if (matchTypes.size > 0) {
    console.log("  By match type:");
    for (const [matchType, count] of matchTypes) {
      console.log(`    ${matchType}: ${count} lines`);
    }
    console.log("");
  }
}

/**
 * Output as JSON
 */
function outputJson(lines: LineAttribution[], filePath: string): void {
  // Exclude empty lines from summary counting
  const nonEmptyLines = filterNonEmptyLines(lines);
  const output = {
    file: filePath,
    lines: lines.map(({ line, attribution }) => ({
      lineNumber: line.lineNumber,
      sha: line.sha,
      author: line.author,
      date: line.authorTime.toISOString(),
      content: line.content,
      attribution: attribution
        ? {
            category: attribution.category,
            provider: attribution.provider,
            model: attribution.model,
            matchType: attribution.matchType,
            contentHash: attribution.contentHash,
          }
        : null,
    })),
    summary: {
      total: nonEmptyLines.length,
      aiGenerated: nonEmptyLines.filter(
        (l) => l.attribution?.category === "ai_generated",
      ).length,
      human: nonEmptyLines.filter((l) => !l.attribution).length,
    },
  };

  console.log(JSON.stringify(output, null, 2));
}

function formatDate(date: Date): string {
  return date.toISOString().slice(0, 10);
}

function pct(n: number, total: number): string {
  if (total === 0) return "0%";
  return `${Math.round((n / total) * 100)}%`;
}

/**
 * Check if a line is empty (whitespace-only)
 */
function isEmptyLine(line: LineAttribution): boolean {
  return line.line.content.trim() === "";
}

/**
 * Filter out empty lines from attribution list
 */
function filterNonEmptyLines(lines: LineAttribution[]): LineAttribution[] {
  return lines.filter((l) => !isEmptyLine(l));
}
