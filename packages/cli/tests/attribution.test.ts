/**
 * Tests for Attribution Module
 */

import { describe, it, expect } from "bun:test";
import {
  applyDelta,
  mergeAttributions,
  countAILines,
  countHumanLines,
} from "../src/lib/attribution";
import type { EditDelta, LineAttribution, ComputedFileAttribution } from "../src/lib/types";

describe("applyDelta", () => {
  it("adds AI attribution for new lines", () => {
    const attributions: LineAttribution[] = [];
    const delta: EditDelta = {
      ts: new Date().toISOString(),
      file: "test.ts",
      sessionId: "abc123",
      promptId: 1,
      hunks: [
        { oldStart: 1, oldCount: 0, newStart: 1, newCount: 3 },
      ],
    };

    const result = applyDelta(attributions, delta, 0);
    expect(result.lineCount).toBe(3);
    expect(result.attributions.length).toBe(1);
    expect(result.attributions[0].startLine).toBe(1);
    expect(result.attributions[0].endLine).toBe(3);
    expect(result.attributions[0].sessionId).toBe("abc123");
  });

  it("shifts existing attributions on insertion", () => {
    const attributions: LineAttribution[] = [
      { startLine: 5, endLine: 10, sessionId: "abc123", promptId: 1 },
    ];
    const delta: EditDelta = {
      ts: new Date().toISOString(),
      file: "test.ts",
      sessionId: "def456",
      promptId: 2,
      hunks: [
        { oldStart: 2, oldCount: 0, newStart: 2, newCount: 3 },
      ],
    };

    const result = applyDelta(attributions, delta, 10);
    // Original range should be shifted by 3
    const original = result.attributions.find(a => a.sessionId === "abc123");
    expect(original?.startLine).toBe(8); // 5 + 3
    expect(original?.endLine).toBe(13); // 10 + 3
  });

  it("removes attributions for deleted lines", () => {
    const attributions: LineAttribution[] = [
      { startLine: 5, endLine: 10, sessionId: "abc123", promptId: 1 },
    ];
    const delta: EditDelta = {
      ts: new Date().toISOString(),
      file: "test.ts",
      sessionId: null, // human edit
      promptId: null,
      hunks: [
        { oldStart: 5, oldCount: 6, newStart: 5, newCount: 0 }, // Delete lines 5-10
      ],
    };

    const result = applyDelta(attributions, delta, 10);
    // Attribution for deleted lines should be removed
    expect(result.attributions.length).toBe(0);
  });

  it("handles human edits (sessionId: null)", () => {
    const attributions: LineAttribution[] = [];
    const delta: EditDelta = {
      ts: new Date().toISOString(),
      file: "test.ts",
      sessionId: null, // human edit
      promptId: null,
      hunks: [
        { oldStart: 1, oldCount: 0, newStart: 1, newCount: 5 },
      ],
    };

    const result = applyDelta(attributions, delta, 0);
    // Human edits don't add attributions (they're counted as gaps)
    expect(result.attributions.length).toBe(0);
    expect(result.lineCount).toBe(5);
  });
});

describe("mergeAttributions", () => {
  it("merges adjacent ranges with same session and prompt", () => {
    const attrs: LineAttribution[] = [
      { startLine: 1, endLine: 3, sessionId: "abc123", promptId: 1 },
      { startLine: 4, endLine: 6, sessionId: "abc123", promptId: 1 },
    ];

    const merged = mergeAttributions(attrs);
    expect(merged.length).toBe(1);
    expect(merged[0].startLine).toBe(1);
    expect(merged[0].endLine).toBe(6);
  });

  it("does not merge non-adjacent ranges", () => {
    const attrs: LineAttribution[] = [
      { startLine: 1, endLine: 3, sessionId: "abc123", promptId: 1 },
      { startLine: 5, endLine: 7, sessionId: "abc123", promptId: 1 },
    ];

    const merged = mergeAttributions(attrs);
    expect(merged.length).toBe(2);
  });

  it("does not merge ranges with different sessions", () => {
    const attrs: LineAttribution[] = [
      { startLine: 1, endLine: 3, sessionId: "abc123", promptId: 1 },
      { startLine: 4, endLine: 6, sessionId: "def456", promptId: 1 },
    ];

    const merged = mergeAttributions(attrs);
    expect(merged.length).toBe(2);
  });

  it("handles overlapping ranges", () => {
    const attrs: LineAttribution[] = [
      { startLine: 1, endLine: 5, sessionId: "abc123", promptId: 1 },
      { startLine: 3, endLine: 7, sessionId: "abc123", promptId: 1 },
    ];

    const merged = mergeAttributions(attrs);
    expect(merged.length).toBe(1);
    expect(merged[0].startLine).toBe(1);
    expect(merged[0].endLine).toBe(7);
  });
});

describe("countAILines and countHumanLines", () => {
  it("counts AI lines correctly", () => {
    const attribution: ComputedFileAttribution = {
      aiRanges: [
        { startLine: 1, endLine: 5, sessionId: "abc123", promptId: 1 },
        { startLine: 10, endLine: 15, sessionId: "abc123", promptId: 1 },
      ],
      humanRanges: [
        { startLine: 6, endLine: 9 },
      ],
    };

    expect(countAILines(attribution)).toBe(11); // 5 + 6
  });

  it("counts human lines correctly", () => {
    const attribution: ComputedFileAttribution = {
      aiRanges: [
        { startLine: 1, endLine: 5, sessionId: "abc123", promptId: 1 },
      ],
      humanRanges: [
        { startLine: 6, endLine: 10 },
        { startLine: 15, endLine: 20 },
      ],
    };

    expect(countHumanLines(attribution)).toBe(11); // 5 + 6
  });
});
