/**
 * Tests for SQLite-backed Delta Storage
 *
 * Verifies that appendDelta, readDeltas, readDeltasForFile, clearDeltas
 * work correctly with SQLite, and that legacy JSONL migration is transparent.
 */

import { describe, it, expect, beforeAll, afterAll } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import {
  appendDelta,
  readDeltas,
  readDeltasForFile,
  clearDeltas,
  getFilesWithDeltas,
  getLastAIDeltaForFile,
  getLastDeltaForFile,
  getDeltaStats,
  getDeltasPath,
  createAIDelta,
  createHumanDelta,
  computeDiff,
} from "../src/lib/delta";
import { setDatabasePath, closeDatabase } from "../src/lib/database";
import type { EditDelta, DeltaHunk } from "../src/lib/types";

// =============================================================================
// Test setup
// =============================================================================

let tmpDir: string;
let repoRoot: string;
let dbPath: string;
const baseSha = "a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6e7f8a9b0";

function makeAgentBlameDirs(root: string): void {
  const agentBlameDir = path.join(root, ".git", "agentblame", "working", baseSha);
  fs.mkdirSync(agentBlameDir, { recursive: true });
}

function jsonlPath(root: string): string {
  return getDeltasPath(root, baseSha);
}

function writeJsonl(root: string, deltas: EditDelta[]): void {
  const lines = deltas.map((d) => JSON.stringify(d)).join("\n") + "\n";
  fs.writeFileSync(jsonlPath(root), lines, "utf8");
}

function sampleHunks(overrides?: Partial<DeltaHunk>): DeltaHunk[] {
  return [{ oldStart: 1, oldCount: 0, newStart: 1, newCount: 3, ...overrides }];
}

function aiDelta(file: string, sessionId = "sess-abc123", promptId = 1, afterBlob?: string): EditDelta {
  return {
    ts: new Date().toISOString(),
    file,
    sessionId,
    promptId,
    hunks: sampleHunks(),
    afterBlob,
  };
}

function humanDelta(file: string, afterBlob?: string): EditDelta {
  return {
    ts: new Date().toISOString(),
    file,
    sessionId: null,
    promptId: null,
    hunks: sampleHunks(),
    afterBlob,
  };
}

beforeAll(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "agentblame-test-"));
  repoRoot = path.join(tmpDir, "repo");
  fs.mkdirSync(repoRoot, { recursive: true });
  makeAgentBlameDirs(repoRoot);

  dbPath = path.join(tmpDir, "test.db");
  setDatabasePath(dbPath);
});

afterAll(() => {
  closeDatabase();
  fs.rmSync(tmpDir, { recursive: true });
});

function resetDb(): void {
  closeDatabase();
  if (fs.existsSync(dbPath)) {
    fs.unlinkSync(dbPath);
  }
  if (fs.existsSync(jsonlPath(repoRoot))) {
    fs.unlinkSync(jsonlPath(repoRoot));
  }
  setDatabasePath(dbPath);
}

// =============================================================================
// Tests
// =============================================================================

describe("appendDelta (SQLite)", () => {
  it("stores a delta in SQLite", () => {
    resetDb();
    const delta = aiDelta("src/app.ts");
    appendDelta(repoRoot, baseSha, delta);

    const read = readDeltas(repoRoot, baseSha);
    expect(read.length).toBe(1);
    expect(read[0].file).toBe("src/app.ts");
    expect(read[0].sessionId).toBe("sess-abc123");
    expect(read[0].promptId).toBe(1);
    expect(read[0].hunks.length).toBe(1);
  });

  it("stores human deltas with null sessionId", () => {
    resetDb();
    const delta = humanDelta("src/app.ts");
    appendDelta(repoRoot, baseSha, delta);

    const read = readDeltas(repoRoot, baseSha);
    expect(read.length).toBe(1);
    expect(read[0].sessionId).toBeNull();
    expect(read[0].promptId).toBeNull();
  });

  it("preserves afterBlob when present", () => {
    resetDb();
    const delta = aiDelta("src/app.ts", "sess-abc", 1, "blob-sha-12345");
    appendDelta(repoRoot, baseSha, delta);

    const read = readDeltas(repoRoot, baseSha);
    expect(read[0].afterBlob).toBe("blob-sha-12345");
  });

  it("preserves multiple hunks", () => {
    resetDb();
    const delta: EditDelta = {
      ts: new Date().toISOString(),
      file: "src/app.ts",
      sessionId: "sess-abc",
      promptId: 1,
      hunks: [
        { oldStart: 1, oldCount: 2, newStart: 1, newCount: 3 },
        { oldStart: 10, oldCount: 1, newStart: 12, newCount: 0 },
      ],
    };
    appendDelta(repoRoot, baseSha, delta);

    const read = readDeltas(repoRoot, baseSha);
    expect(read[0].hunks.length).toBe(2);
    expect(read[0].hunks[0].oldStart).toBe(1);
    expect(read[0].hunks[1].oldStart).toBe(10);
  });

  it("appends multiple deltas in insertion order", () => {
    resetDb();
    appendDelta(repoRoot, baseSha, aiDelta("src/a.ts", "sess-1", 1));
    appendDelta(repoRoot, baseSha, aiDelta("src/b.ts", "sess-2", 2));
    appendDelta(repoRoot, baseSha, humanDelta("src/c.ts"));

    const read = readDeltas(repoRoot, baseSha);
    expect(read.length).toBe(3);
    expect(read[0].file).toBe("src/a.ts");
    expect(read[1].file).toBe("src/b.ts");
    expect(read[2].file).toBe("src/c.ts");
  });
});

describe("readDeltas (SQLite)", () => {
  it("returns empty array when no deltas exist", () => {
    resetDb();
    const deltas = readDeltas(repoRoot, baseSha);
    expect(deltas).toEqual([]);
  });

  it("filters by file path", () => {
    resetDb();
    appendDelta(repoRoot, baseSha, aiDelta("src/a.ts"));
    appendDelta(repoRoot, baseSha, aiDelta("src/b.ts"));
    appendDelta(repoRoot, baseSha, aiDelta("src/a.ts"));

    const results = readDeltas(repoRoot, baseSha, "src/a.ts");
    expect(results.length).toBe(2);
    expect(results.every((d) => d.file === "src/a.ts")).toBe(true);
  });

  it("returns all deltas when no file filter", () => {
    resetDb();
    appendDelta(repoRoot, baseSha, aiDelta("src/a.ts"));
    appendDelta(repoRoot, baseSha, aiDelta("src/b.ts"));

    const results = readDeltas(repoRoot, baseSha);
    expect(results.length).toBe(2);
  });
});

describe("readDeltasForFile (SQLite)", () => {
  it("returns only deltas for the specified file", () => {
    resetDb();
    appendDelta(repoRoot, baseSha, aiDelta("src/a.ts"));
    appendDelta(repoRoot, baseSha, aiDelta("src/b.ts"));
    appendDelta(repoRoot, baseSha, humanDelta("src/a.ts"));
    appendDelta(repoRoot, baseSha, aiDelta("src/c.ts"));

    const results = readDeltasForFile(repoRoot, baseSha, "src/a.ts");
    expect(results.length).toBe(2);
    expect(results.every((d) => d.file === "src/a.ts")).toBe(true);
  });

  it("returns empty array for file with no deltas", () => {
    resetDb();
    appendDelta(repoRoot, baseSha, aiDelta("src/a.ts"));

    const results = readDeltasForFile(repoRoot, baseSha, "src/nonexistent.ts");
    expect(results).toEqual([]);
  });

  it("returns deltas in chronological order (by id)", () => {
    resetDb();
    const d1 = aiDelta("src/a.ts", "sess-1", 1);
    const d2 = aiDelta("src/a.ts", "sess-2", 2);
    const d3 = humanDelta("src/a.ts");

    appendDelta(repoRoot, baseSha, d1);
    appendDelta(repoRoot, baseSha, d2);
    appendDelta(repoRoot, baseSha, d3);

    const results = readDeltasForFile(repoRoot, baseSha, "src/a.ts");
    expect(results.length).toBe(3);
    expect(results[0].sessionId).toBe("sess-1");
    expect(results[1].sessionId).toBe("sess-2");
    expect(results[2].sessionId).toBeNull();
  });
});

describe("clearDeltas (SQLite)", () => {
  it("removes all deltas for a base_sha", () => {
    resetDb();
    appendDelta(repoRoot, baseSha, aiDelta("src/a.ts"));
    appendDelta(repoRoot, baseSha, aiDelta("src/b.ts"));
    expect(readDeltas(repoRoot, baseSha).length).toBe(2);

    clearDeltas(repoRoot, baseSha);
    expect(readDeltas(repoRoot, baseSha)).toEqual([]);
  });

  it("does not affect deltas for other base_shas", () => {
    resetDb();
    const otherSha = "b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6e7f8a9b01";
    appendDelta(repoRoot, baseSha, aiDelta("src/a.ts"));
    appendDelta(repoRoot, otherSha, aiDelta("src/b.ts"));

    clearDeltas(repoRoot, baseSha);

    expect(readDeltas(repoRoot, baseSha)).toEqual([]);
    expect(readDeltas(repoRoot, otherSha).length).toBe(1);
  });
});

describe("getFilesWithDeltas", () => {
  it("returns unique file paths", () => {
    resetDb();
    appendDelta(repoRoot, baseSha, aiDelta("src/a.ts"));
    appendDelta(repoRoot, baseSha, aiDelta("src/b.ts"));
    appendDelta(repoRoot, baseSha, aiDelta("src/a.ts")); // duplicate file

    const files = getFilesWithDeltas(repoRoot, baseSha);
    expect(files.length).toBe(2);
    expect(files).toContain("src/a.ts");
    expect(files).toContain("src/b.ts");
  });

  it("returns empty array when no deltas", () => {
    resetDb();
    expect(getFilesWithDeltas(repoRoot, baseSha)).toEqual([]);
  });
});

describe("getLastAIDeltaForFile", () => {
  it("returns the most recent AI delta", () => {
    resetDb();
    appendDelta(repoRoot, baseSha, aiDelta("src/a.ts", "sess-1", 1));
    appendDelta(repoRoot, baseSha, humanDelta("src/a.ts"));
    appendDelta(repoRoot, baseSha, aiDelta("src/a.ts", "sess-2", 2));

    const last = getLastAIDeltaForFile(repoRoot, baseSha, "src/a.ts");
    expect(last).not.toBeNull();
    expect(last!.sessionId).toBe("sess-2");
  });

  it("returns null when file has no AI deltas", () => {
    resetDb();
    appendDelta(repoRoot, baseSha, humanDelta("src/a.ts"));

    const last = getLastAIDeltaForFile(repoRoot, baseSha, "src/a.ts");
    expect(last).toBeNull();
  });
});

describe("getLastDeltaForFile", () => {
  it("returns the most recent delta (AI or human)", () => {
    resetDb();
    appendDelta(repoRoot, baseSha, aiDelta("src/a.ts", "sess-1", 1));
    appendDelta(repoRoot, baseSha, humanDelta("src/a.ts"));

    const last = getLastDeltaForFile(repoRoot, baseSha, "src/a.ts");
    expect(last).not.toBeNull();
    expect(last!.sessionId).toBeNull(); // human is last
  });

  it("returns null when file has no deltas", () => {
    resetDb();
    expect(getLastDeltaForFile(repoRoot, baseSha, "src/nonexistent.ts")).toBeNull();
  });
});

describe("getDeltaStats", () => {
  it("computes correct statistics", () => {
    resetDb();
    appendDelta(repoRoot, baseSha, aiDelta("src/a.ts", "sess-1", 1));
    appendDelta(repoRoot, baseSha, aiDelta("src/b.ts", "sess-2", 2));
    appendDelta(repoRoot, baseSha, humanDelta("src/c.ts"));

    const stats = getDeltaStats(repoRoot, baseSha);
    expect(stats.totalDeltas).toBe(3);
    expect(stats.aiDeltas).toBe(2);
    expect(stats.humanDeltas).toBe(1);
    expect(stats.files).toBe(3);
    expect(stats.totalAdditions).toBe(9); // 3 hunks × 3 newCount
  });

  it("returns zeros when no deltas", () => {
    resetDb();
    const stats = getDeltaStats(repoRoot, baseSha);
    expect(stats.totalDeltas).toBe(0);
    expect(stats.aiDeltas).toBe(0);
    expect(stats.humanDeltas).toBe(0);
    expect(stats.files).toBe(0);
  });
});

describe("JSONL → SQLite migration", () => {
  it("transparently migrates JSONL deltas on read", () => {
    resetDb();
    // Write JSONL manually (simulating pre-migration state)
    const deltas = [
      aiDelta("src/legacy.ts", "sess-legacy", 99),
      humanDelta("src/legacy.ts"),
    ];
    writeJsonl(repoRoot, deltas);

    // Verify JSONL file exists
    expect(fs.existsSync(jsonlPath(repoRoot))).toBe(true);

    // Read — should trigger migration
    const read = readDeltasForFile(repoRoot, baseSha, "src/legacy.ts");
    expect(read.length).toBe(2);
    expect(read[0].sessionId).toBe("sess-legacy");
    expect(read[1].sessionId).toBeNull();

    // JSONL file should be deleted after migration
    expect(fs.existsSync(jsonlPath(repoRoot))).toBe(false);

    // Second read should still return the same data (from SQLite now)
    const read2 = readDeltasForFile(repoRoot, baseSha, "src/legacy.ts");
    expect(read2.length).toBe(2);
    expect(read2[0].sessionId).toBe("sess-legacy");
  });

  it("transparently migrates JSONL deltas on append", () => {
    resetDb();
    // Write JSONL manually
    const legacyDeltas = [aiDelta("src/legacy.ts", "sess-legacy", 99)];
    writeJsonl(repoRoot, legacyDeltas);

    // Append a new delta via SQLite — should trigger migration first
    appendDelta(repoRoot, baseSha, aiDelta("src/new.ts", "sess-new", 1));

    // Both legacy and new deltas should be in SQLite
    const all = readDeltas(repoRoot, baseSha);
    expect(all.length).toBe(2);
    expect(all[0].file).toBe("src/legacy.ts");
    expect(all[1].file).toBe("src/new.ts");

    // JSONL should be gone
    expect(fs.existsSync(jsonlPath(repoRoot))).toBe(false);
  });

  it("handles empty JSONL files gracefully", () => {
    resetDb();
    // Write empty JSONL
    fs.writeFileSync(jsonlPath(repoRoot), "", "utf8");

    const read = readDeltas(repoRoot, baseSha);
    expect(read).toEqual([]);

    // Empty JSONL should be cleaned up
    expect(fs.existsSync(jsonlPath(repoRoot))).toBe(false);
  });

  it("handles malformed JSONL lines gracefully", () => {
    resetDb();
    // Write JSONL with one valid and one malformed line
    const validDelta = JSON.stringify(aiDelta("src/valid.ts"));
    fs.writeFileSync(jsonlPath(repoRoot), `${validDelta}\n{invalid json\n`, "utf8");

    // Migration should skip the malformed line
    const read = readDeltas(repoRoot, baseSha);
    expect(read.length).toBe(1);
    expect(read[0].file).toBe("src/valid.ts");

    // JSONL should be cleaned up
    expect(fs.existsSync(jsonlPath(repoRoot))).toBe(false);
  });

  it("is idempotent — calling migrate multiple times is safe", () => {
    resetDb();
    const deltas = [aiDelta("src/idempotent.ts", "sess-1", 1)];
    writeJsonl(repoRoot, deltas);

    // First read triggers migration
    const read1 = readDeltas(repoRoot, baseSha);
    expect(read1.length).toBe(1);

    // Write JSONL again (simulating race)
    writeJsonl(repoRoot, [aiDelta("src/idempotent2.ts", "sess-2", 2)]);

    // Second read — SQLite already has data, should clean up JSONL without duplicating
    const read2 = readDeltas(repoRoot, baseSha);
    expect(read2.length).toBe(1); // Still 1, not 2
    expect(read2[0].file).toBe("src/idempotent.ts");

    // JSONL should be cleaned up
    expect(fs.existsSync(jsonlPath(repoRoot))).toBe(false);
  });
});

describe("computeDiff (unchanged)", () => {
  // These tests verify computeDiff still works identically
  it("detects single line insertion", () => {
    const hunks = computeDiff("line 1\nline 3", "line 1\nline 2\nline 3");
    expect(hunks.length).toBe(1);
    expect(hunks[0].newCount).toBe(1);
  });

  it("detects single line deletion", () => {
    const hunks = computeDiff("line 1\nline 2\nline 3", "line 1\nline 3");
    expect(hunks.length).toBe(1);
    expect(hunks[0].oldCount).toBe(1);
  });
});

describe("createAIDelta / createHumanDelta (unchanged)", () => {
  it("createAIDelta sets sessionId and promptId", () => {
    const delta = createAIDelta("test.ts", "sess-1", 5, sampleHunks(), "blob-1");
    expect(delta.file).toBe("test.ts");
    expect(delta.sessionId).toBe("sess-1");
    expect(delta.promptId).toBe(5);
    expect(delta.afterBlob).toBe("blob-1");
    expect(delta.hunks.length).toBe(1);
  });

  it("createHumanDelta sets null sessionId and promptId", () => {
    const delta = createHumanDelta("test.ts", sampleHunks(), "blob-2");
    expect(delta.sessionId).toBeNull();
    expect(delta.promptId).toBeNull();
    expect(delta.afterBlob).toBe("blob-2");
  });
});
