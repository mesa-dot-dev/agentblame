/**
 * Agent Blame Command
 *
 * Shows AI attribution for each line in a file, similar to git blame.
 * Displays prompts and session information from git notes.
 */

import * as path from "node:path";
import * as fs from "node:fs";
import { getBlame, type BlameLine } from "./lib/git/gitBlame";
import { readNote } from "./lib/git/gitNotes";
import { getRepoRoot } from "./lib/git/gitCli";
import type { Attribution, SessionMetadata, PromptEntry } from "./lib/types";

/**
 * Format prompts for display - handles both array and legacy string formats
 */
function formatPrompts(p: PromptEntry[] | string | null, maxLength = 80): string | null {
  if (!p) return null;

  // Handle legacy string format
  if (typeof p === "string") {
    return p.length > maxLength ? p.substring(0, maxLength) + "..." : p;
  }

  // Handle new array format
  if (Array.isArray(p) && p.length > 0) {
    if (p.length === 1) {
      const content = p[0].content ?? "[content not stored]";
      return content.length > maxLength ? content.substring(0, maxLength) + "..." : content;
    }

    // Multiple prompts - show concatenated
    const combined = p.map((entry, i) => `[${i + 1}] ${entry.content ?? "[not stored]"}`).join(" → ");
    return combined.length > maxLength ? combined.substring(0, maxLength) + "..." : combined;
  }

  return null;
}

/**
 * Extract unique tool names from prompts
 */
function getToolsFromPrompts(p: PromptEntry[] | string | null): string[] {
  if (!p || typeof p === "string" || !Array.isArray(p)) return [];

  const toolSet = new Set<string>();
  for (const prompt of p) {
    if (prompt.tools) {
      for (const toolName of Object.keys(prompt.tools)) {
        toolSet.add(toolName);
      }
    }
  }
  return Array.from(toolSet).sort();
}

/**
 * Get total tool counts from prompts
 */
function getTotalToolCounts(p: PromptEntry[] | string | null): Record<string, number> {
  if (!p || typeof p === "string" || !Array.isArray(p)) return {};

  const totals: Record<string, number> = {};
  for (const prompt of p) {
    if (prompt.tools) {
      for (const [toolName, count] of Object.entries(prompt.tools)) {
        totals[toolName] = (totals[toolName] || 0) + count;
      }
    }
  }
  return totals;
}

// Terminal colors
const c = {
  reset: "\x1b[0m",
  bold: "\x1b[1m",
  dim: "\x1b[2m",
  cyan: "\x1b[36m",
  yellow: "\x1b[33m",
  green: "\x1b[32m",
  orange: "\x1b[38;2;184;101;64m",
  blue: "\x1b[34m",
  gray: "\x1b[90m",
  magenta: "\x1b[35m",
};

interface LineAttribution {
  line: BlameLine;
  sessionId: string | null;
  session: SessionMetadata | null;
  promptId?: number | null;
}

interface BlameOptions {
  json?: boolean;
  summary?: boolean;
  showPrompts?: boolean;
  verbose?: boolean; // Show full prompts instead of truncated
}

/**
 * Run agentblame on a file
 */
export async function blame(
  filePath: string,
  options: BlameOptions = {}
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

  // Notes are fetched automatically via configured refspec (set up by agentblame init)
  // No need to fetch here - this keeps blame fast for local use

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
  const notesMap = new Map<string, Attribution>();

  for (const sha of uniqueShas) {
    const note = await readNote(repoRoot, sha);
    if (note) {
      notesMap.set(sha, note);
    }
  }

  // Build line attribution
  const lineAttributions: LineAttribution[] = blameResult.lines.map((line) => {
    const note = notesMap.get(line.sha);
    if (!note) {
      return { line, sessionId: null, session: null };
    }

    // Find attribution that covers this line
    const fileAttr = note.files[relativePath];
    if (!fileAttr) {
      // Try matching with different path formats
      const matchingPath = Object.keys(note.files).find(
        (p) =>
          p === relativePath ||
          p.endsWith(relativePath) ||
          relativePath.endsWith(p)
      );

      if (!matchingPath) {
        return { line, sessionId: null, session: null };
      }

      const altFileAttr = note.files[matchingPath];
      const aiRange = altFileAttr.aiRanges.find(
        (r) => line.origLine >= r.startLine && line.origLine <= r.endLine
      );

      if (aiRange) {
        return {
          line,
          sessionId: aiRange.sessionId,
          session: note.sessions[aiRange.sessionId] || null,
          promptId: aiRange.promptId,
        };
      }

      return { line, sessionId: null, session: null };
    }

    // Find matching AI range
    const aiRange = fileAttr.aiRanges.find(
      (r) => line.origLine >= r.startLine && line.origLine <= r.endLine
    );

    if (aiRange) {
      return {
        line,
        sessionId: aiRange.sessionId,
        session: note.sessions[aiRange.sessionId] || null,
        promptId: aiRange.promptId,
      };
    }

    return { line, sessionId: null, session: null };
  });

  // Collect unique sessions for prompt display
  const uniqueSessions = new Map<string, SessionMetadata>();
  for (const { sessionId, session } of lineAttributions) {
    if (sessionId && session && !uniqueSessions.has(sessionId)) {
      uniqueSessions.set(sessionId, session);
    }
  }

  // Output
  if (options.json) {
    outputJson(lineAttributions, relativePath, uniqueSessions);
  } else if (options.summary) {
    outputSummary(lineAttributions, relativePath, uniqueSessions);
  } else {
    outputFormatted(
      lineAttributions,
      relativePath,
      uniqueSessions,
      options.showPrompts,
      options.verbose
    );
  }
}

/**
 * Output formatted blame with attribution markers
 */
function outputFormatted(
  lines: LineAttribution[],
  filePath: string,
  sessions: Map<string, SessionMetadata>,
  showPrompts = true,
  verbose = false
): void {
  console.log("");
  console.log(`  ${c.bold}${c.cyan}${filePath}${c.reset}`);
  console.log(`  ${c.dim}${"─".repeat(70)}${c.reset}`);

  // Build prompt index map: sessionId:promptId -> "P1", "P2", etc.
  const promptIndexMap = new Map<string, string>();
  let promptCounter = 1;

  // Show session prompts at the top if enabled
  if (showPrompts && sessions.size > 0) {
    console.log(`  ${c.bold}Prompts:${c.reset}`);
    for (const [sessionId, session] of sessions) {
      const agent =
        session.agent === "cursor"
          ? "Cursor"
          : session.agent === "opencode"
            ? "OpenCode"
            : "Claude";
      const model = session.model || "";
      const modelStr = model ? ` (${model})` : "";

      // Show each prompt with its index
      if (session.prompts && Array.isArray(session.prompts)) {
        for (let i = 0; i < session.prompts.length; i++) {
          const prompt = session.prompts[i];
          const promptKey = `${sessionId}:${prompt.id ?? i + 1}`; // Use prompt.id if available
          const promptIdx = `P${promptCounter}`;
          promptIndexMap.set(promptKey, promptIdx);

          console.log(
            `  ${c.magenta}[${promptIdx}]${c.reset} ${c.orange}${agent}${c.reset}${c.dim}${modelStr}${c.reset}`
          );

          // Show full or truncated prompt based on verbose flag
          const content = prompt.content ?? "[content not stored]";
          if (verbose && prompt.content) {
            // Show full prompt, wrapped
            const promptLines = content.split("\n");
            for (const pline of promptLines) {
              console.log(`       ${c.dim}"${pline}"${c.reset}`);
            }
          } else {
            const truncatedPrompt = content.length > 60
              ? content.substring(0, 60) + "..."
              : content;
            console.log(`       ${c.dim}"${truncatedPrompt}"${c.reset}`);
          }

          // Show tools for this prompt
          if (prompt.tools && Object.keys(prompt.tools).length > 0) {
            const toolStr = Object.entries(prompt.tools)
              .map(([name, count]) => `${name}: ${count}`)
              .join(", ");
            console.log(`       ${c.dim}Tools: ${toolStr}${c.reset}`);
          }

          promptCounter++;
        }
      } else if (session.prompts && typeof session.prompts === "string") {
        // Legacy string format
        const promptKey = `${sessionId}:null`;
        const promptIdx = `P${promptCounter}`;
        promptIndexMap.set(promptKey, promptIdx);

        const legacyPrompt = session.prompts as string;

        console.log(
          `  ${c.magenta}[${promptIdx}]${c.reset} ${c.orange}${agent}${c.reset}${c.dim}${modelStr}${c.reset}`
        );

        if (verbose) {
          console.log(`       ${c.dim}"${legacyPrompt}"${c.reset}`);
        } else {
          const truncatedPrompt = legacyPrompt.length > 60
            ? legacyPrompt.substring(0, 60) + "..."
            : legacyPrompt;
          console.log(`       ${c.dim}"${truncatedPrompt}"${c.reset}`);
        }
        promptCounter++;
      }
    }
    console.log(`  ${c.dim}${"─".repeat(70)}${c.reset}`);
  }

  // Calculate column widths dynamically based on actual data
  const lineNumWidth = lines.length.toString().length;

  // Find max prompt index actually used in this file
  let maxPromptIdxUsed = 0;
  for (const { sessionId, promptId } of lines) {
    if (sessionId) {
      const promptKey = `${sessionId}:${promptId ?? "null"}`;
      const promptIdx = promptIndexMap.get(promptKey);
      if (promptIdx) {
        const num = parseInt(promptIdx.slice(1), 10); // Extract number from "P1", "P99", etc.
        if (num > maxPromptIdxUsed) maxPromptIdxUsed = num;
      }
    }
  }
  const promptColWidth = maxPromptIdxUsed > 0 ? `P${maxPromptIdxUsed}`.length : 0;

  for (const { line, sessionId, session, promptId } of lines) {
    const sha = `${c.yellow}${line.sha.slice(0, 7)}${c.reset}`;
    const author = `${c.blue}${line.author.slice(0, 12).padEnd(12)}${c.reset}`;
    const date = `${c.dim}${formatDate(line.authorTime)}${c.reset}`;

    // Get prompt index if available
    const promptKey = `${sessionId}:${promptId ?? "null"}`;
    const promptIdx = sessionId ? promptIndexMap.get(promptKey) : null;

    // Build separate prompt and line number columns
    let promptColStr: string;
    if (promptIdx && promptColWidth > 0) {
      const padded = promptIdx.padStart(promptColWidth);
      promptColStr = `${c.magenta}${padded}${c.reset}`;
    } else if (promptColWidth > 0) {
      promptColStr = " ".repeat(promptColWidth);
    } else {
      promptColStr = "";
    }

    const lineNumPadded = `${c.dim}${line.lineNumber.toString().padStart(lineNumWidth)}${c.reset}`;

    // Build the output with separate prompt and line number columns
    const promptCol = promptColWidth > 0 ? `${c.dim}│${c.reset} ${promptColStr} ` : "";
    console.log(
      `  ${sha} ${author} ${date} ${promptCol}${c.dim}│${c.reset} ${lineNumPadded} ${c.dim}│${c.reset} ${line.content}`
    );
  }

  // Print summary (excluding empty lines)
  const nonEmptyLines = filterNonEmptyLines(lines);
  const aiGenerated = nonEmptyLines.filter((l) => l.sessionId !== null).length;
  const human = nonEmptyLines.length - aiGenerated;
  const aiPct =
    nonEmptyLines.length > 0
      ? Math.round((aiGenerated / nonEmptyLines.length) * 100)
      : 0;
  const humanPct = 100 - aiPct;

  // Summary bar
  const barWidth = 40;
  const aiBarWidth = Math.round((aiPct / 100) * barWidth);
  const humanBarWidth = barWidth - aiBarWidth;
  const aiBar = `${c.orange}${"█".repeat(aiBarWidth)}${c.reset}`;
  const humanBar = `${c.dim}${"░".repeat(humanBarWidth)}${c.reset}`;

  console.log(`  ${c.dim}${"─".repeat(70)}${c.reset}`);
  console.log(`  ${aiBar}${humanBar}`);
  console.log(
    `  ${c.orange}AI: ${aiGenerated} lines (${aiPct}%)${c.reset}  ${c.dim}│${c.reset}  ${c.green}Human: ${human} lines (${humanPct}%)${c.reset}`
  );
  console.log("");
}

/**
 * Output summary only
 */
function outputSummary(
  lines: LineAttribution[],
  filePath: string,
  sessions: Map<string, SessionMetadata>
): void {
  const nonEmptyLines = filterNonEmptyLines(lines);
  const aiGenerated = nonEmptyLines.filter((l) => l.sessionId !== null).length;
  const human = nonEmptyLines.length - aiGenerated;

  console.log(`\n${filePath}:`);
  console.log(`  Total lines:   ${nonEmptyLines.length}`);
  console.log(
    `  AI-generated:  ${aiGenerated} (${pct(aiGenerated, nonEmptyLines.length)})`
  );
  console.log(`  Human:         ${human} (${pct(human, nonEmptyLines.length)})`);
  console.log("");

  // Session breakdown
  const sessionCounts = new Map<string, number>();
  for (const { sessionId } of nonEmptyLines) {
    if (sessionId) {
      sessionCounts.set(sessionId, (sessionCounts.get(sessionId) || 0) + 1);
    }
  }

  if (sessionCounts.size > 0) {
    console.log("  By session:");
    for (const [sessionId, count] of sessionCounts) {
      const session = sessions.get(sessionId);
      const agent = session?.agent || "unknown";
      const model = session?.model || "";
      console.log(`    ${sessionId.slice(0, 8)} [${agent}${model ? ` - ${model}` : ""}]: ${count} lines`);
    }
    console.log("");
  }

  // Agent breakdown
  const agentCounts = new Map<string, number>();
  for (const { session } of nonEmptyLines) {
    if (session) {
      const agent = session.agent;
      agentCounts.set(agent, (agentCounts.get(agent) || 0) + 1);
    }
  }

  if (agentCounts.size > 0) {
    console.log("  By agent:");
    for (const [agent, count] of agentCounts) {
      console.log(`    ${agent}: ${count} lines`);
    }
    console.log("");
  }

  // Show prompts
  if (sessions.size > 0) {
    console.log("  Prompts:");
    for (const [sessionId, session] of sessions) {
      const formattedPrompt = formatPrompts(session.prompts, 60);
      if (formattedPrompt) {
        console.log(`    ${sessionId.slice(0, 8)}: "${formattedPrompt}"`);
      }
    }
    console.log("");
  }
}

/**
 * Output as JSON
 */
function outputJson(
  lines: LineAttribution[],
  filePath: string,
  sessions: Map<string, SessionMetadata>
): void {
  const nonEmptyLines = filterNonEmptyLines(lines);

  const output = {
    file: filePath,
    sessions: Object.fromEntries(
      Array.from(sessions.entries()).map(([id, session]) => [
        id,
        {
          agent: session.agent,
          model: session.model,
          prompts: session.prompts, // includes tool counts per prompt
          timestamp: session.startedAt,
          toolCounts: getTotalToolCounts(session.prompts), // aggregated for convenience
        },
      ])
    ),
    lines: lines.map(({ line, sessionId, session }) => ({
      lineNumber: line.lineNumber,
      sha: line.sha,
      author: line.author,
      date: line.authorTime.toISOString(),
      content: line.content,
      attribution: sessionId
        ? {
            sessionId,
            agent: session?.agent || null,
            model: session?.model || null,
            prompts: session?.prompts || null,
          }
        : null,
    })),
    summary: {
      total: nonEmptyLines.length,
      aiGenerated: nonEmptyLines.filter((l) => l.sessionId !== null).length,
      human: nonEmptyLines.filter((l) => l.sessionId === null).length,
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
