/**
 * Tests for Delta Module
 */

import { describe, it, expect } from "bun:test";
import { computeDiff, computeDiffDetailed } from "../src/lib/delta";

describe("computeDiff", () => {
  it("returns empty array for identical content", () => {
    const content = "line 1\nline 2\nline 3";
    const hunks = computeDiff(content, content);
    expect(hunks).toEqual([]);
  });

  it("detects single line insertion", () => {
    const before = "line 1\nline 3";
    const after = "line 1\nline 2\nline 3";
    const hunks = computeDiff(before, after);
    expect(hunks.length).toBe(1);
    expect(hunks[0].oldStart).toBe(2);
    expect(hunks[0].oldCount).toBe(0);
    expect(hunks[0].newStart).toBe(2);
    expect(hunks[0].newCount).toBe(1);
  });

  it("detects single line deletion", () => {
    const before = "line 1\nline 2\nline 3";
    const after = "line 1\nline 3";
    const hunks = computeDiff(before, after);
    expect(hunks.length).toBe(1);
    expect(hunks[0].oldStart).toBe(2);
    expect(hunks[0].oldCount).toBe(1);
    expect(hunks[0].newStart).toBe(2);
    expect(hunks[0].newCount).toBe(0);
  });

  it("detects modification", () => {
    const before = "line 1\nold line\nline 3";
    const after = "line 1\nnew line\nline 3";
    const hunks = computeDiff(before, after);
    expect(hunks.length).toBe(1);
    expect(hunks[0].oldStart).toBe(2);
    expect(hunks[0].oldCount).toBe(1);
    expect(hunks[0].newStart).toBe(2);
    expect(hunks[0].newCount).toBe(1);
  });

  it("handles multiple hunks", () => {
    const before = "a\nb\nc\nd\ne";
    const after = "a\nB\nc\nD\ne";
    const hunks = computeDiff(before, after);
    expect(hunks.length).toBe(2);
  });

  it("handles new file (empty before)", () => {
    const before = "";
    const after = "line 1\nline 2";
    const hunks = computeDiff(before, after);
    expect(hunks.length).toBe(1);
    expect(hunks[0].newCount).toBe(2);
  });
});

describe("computeDiffDetailed", () => {
  it("counts additions and deletions correctly", () => {
    const before = "line 1\nline 2\nline 3";
    const after = "line 1\nnew line 2\nnew line 3\nline 4";
    const result = computeDiffDetailed(before, after);
    expect(result.additions).toBe(3); // 3 new lines
    expect(result.deletions).toBe(2); // 2 old lines removed
  });
});
