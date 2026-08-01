import { describe, expect, it } from "vitest";
import {
  aggregateGapTypeCounts,
  appendGapFeedbackDigest,
  buildGapDiffRows,
  buildGapFeedbackDigest,
  emptyGapTypeCounts,
  filterGapHunks,
  GAP_FEEDBACK_SECTION_HEADER,
  GAP_HUNK_TYPES,
  gapEntrySize,
  gapHunkRangeLabel,
  gapLogDayKey,
  gapTrend,
  gapTypeCountKey,
  groupGapLogByDay,
} from "../lib/gapAnalysis";
import type { GapHunk, GapLogEntry } from "../lib/types";

function hunk(overrides: Partial<GapHunk>): GapHunk {
  return {
    op: "replace",
    oldStart: 1,
    oldLines: 1,
    newStart: 1,
    newLines: 1,
    lines: [],
    hunkType: "direct-edit",
    evidence: [],
    ...overrides,
  };
}

function logEntry(overrides: Partial<GapLogEntry>): GapLogEntry {
  return {
    at: "2026-07-28T09:00:00",
    draftId: "d1",
    promotedTo: "docs/a.md",
    addedLines: 2,
    removedLines: 1,
    byType: emptyGapTypeCounts(),
    hunkCount: 1,
    ...overrides,
  };
}

describe("filterGapHunks", () => {
  const hunks = [
    hunk({ op: "equal", hunkType: "formatting" }),
    hunk({ op: "replace", hunkType: "external-info" }),
    hunk({ op: "insert", hunkType: "direct-edit" }),
    hunk({ op: "delete", hunkType: "formatting" }),
  ];

  it("keeps equal hunks regardless of the active type set", () => {
    const result = filterGapHunks(hunks, new Set());
    expect(result).toHaveLength(1);
    expect(result[0].op).toBe("equal");
  });

  it("keeps non-equal hunks whose type is active", () => {
    const result = filterGapHunks(hunks, new Set(["external-info", "formatting"]));
    expect(result.map((entry) => entry.hunkType)).toEqual([
      "formatting",
      "external-info",
      "formatting",
    ]);
  });
});

describe("gapHunkRangeLabel", () => {
  it("formats unified-diff ranges", () => {
    expect(
      gapHunkRangeLabel(
        hunk({ oldStart: 3, oldLines: 4, newStart: 3, newLines: 6 }),
      ),
    ).toBe("@@ -3,4 +3,6 @@");
  });
});

describe("buildGapDiffRows", () => {
  it("assigns per-side line numbers and blanks the other side", () => {
    const rows = buildGapDiffRows(
      hunk({
        oldStart: 10,
        newStart: 12,
        lines: [
          { kind: " ", text: "ctx" },
          { kind: "-", text: "old" },
          { kind: "+", text: "new" },
          { kind: "+", text: "extra" },
        ],
      }),
    );
    expect(rows).toEqual([
      { kind: " ", oldLineNo: 10, newLineNo: 12, text: "ctx" },
      { kind: "-", oldLineNo: 11, newLineNo: null, text: "old" },
      { kind: "+", oldLineNo: null, newLineNo: 13, text: "new" },
      { kind: "+", oldLineNo: null, newLineNo: 14, text: "extra" },
    ]);
  });
});

describe("aggregateGapTypeCounts", () => {
  it("sums per-type counts across entries", () => {
    const totals = aggregateGapTypeCounts([
      logEntry({
        byType: { externalInfo: 1, directEdit: 2, crossDocReference: 0, formatting: 1 },
      }),
      logEntry({
        byType: { externalInfo: 0, directEdit: 1, crossDocReference: 3, formatting: 0 },
      }),
    ]);
    expect(totals).toEqual({ externalInfo: 1, directEdit: 3, crossDocReference: 3, formatting: 1 });
  });

  it("returns zeros for an empty log", () => {
    expect(aggregateGapTypeCounts([])).toEqual(emptyGapTypeCounts());
  });
});

describe("gapTypeCountKey", () => {
  it("covers every hunk type", () => {
    for (const type of GAP_HUNK_TYPES) {
      expect(gapTypeCountKey(type)).toBeDefined();
    }
    expect(gapTypeCountKey("external-info")).toBe("externalInfo");
    expect(gapTypeCountKey("cross-doc-reference")).toBe("crossDocReference");
  });
});

describe("groupGapLogByDay", () => {
  it("groups newest-first entries by local calendar day", () => {
    const groups = groupGapLogByDay([
      logEntry({ at: "2026-07-29T10:00:00", draftId: "d2" }),
      logEntry({ at: "2026-07-29T08:00:00", draftId: "d1" }),
      logEntry({ at: "2026-07-28T23:30:00", draftId: "d1" }),
    ]);
    expect(groups.map((group) => group.day)).toEqual(["2026-07-29", "2026-07-28"]);
    expect(groups[0].entries.map((entry) => entry.draftId)).toEqual(["d2", "d1"]);
    expect(groups[1].entries).toHaveLength(1);
  });

  it("falls back to the raw date prefix for unparseable timestamps", () => {
    const groups = groupGapLogByDay([logEntry({ at: "2026-07-30Tbroken" })]);
    expect(groups[0].day).toBe("2026-07-30");
  });

  it("buckets on the same key the date filter compares against", () => {
    // The log panel filters by gapLogDayKey and renders groupGapLogByDay
    // headings. If the two disagreed, a range would drop rows it should keep.
    const entries = [
      logEntry({ at: "2026-07-29T10:00:00" }),
      logEntry({ at: "2026-07-28T23:30:00" }),
      logEntry({ at: "2026-07-30Tbroken" }),
    ];
    for (const group of groupGapLogByDay(entries)) {
      for (const entry of group.entries) {
        expect(gapLogDayKey(entry.at)).toBe(group.day);
      }
    }
    // Keys are ISO, so the panel's lexicographic range comparison is ordered.
    expect(gapLogDayKey("2026-07-28T23:30:00") < gapLogDayKey("2026-07-29T10:00:00")).toBe(true);
    expect(gapLogDayKey("2026-08-01T00:00:00") > gapLogDayKey("2026-07-31T23:59:00")).toBe(true);
  });
});

describe("gapTrend", () => {
  it("orders oldest to newest and marks direction per step", () => {
    const trend = gapTrend([
      logEntry({ at: "2026-07-30T09:00:00", addedLines: 1, removedLines: 1 }), // size 2
      logEntry({ at: "2026-07-28T09:00:00", addedLines: 5, removedLines: 3 }), // size 8
      logEntry({ at: "2026-07-29T09:00:00", addedLines: 2, removedLines: 2 }), // size 4
    ]);
    expect(trend.map((point) => point.size)).toEqual([8, 4, 2]);
    expect(trend.map((point) => point.direction)).toEqual([null, "down", "down"]);
  });

  it("marks growth and plateaus", () => {
    const trend = gapTrend([
      logEntry({ at: "2026-07-28T09:00:00", addedLines: 1, removedLines: 0 }),
      logEntry({ at: "2026-07-29T09:00:00", addedLines: 3, removedLines: 0 }),
      logEntry({ at: "2026-07-30T09:00:00", addedLines: 3, removedLines: 0 }),
    ]);
    expect(trend.map((point) => point.direction)).toEqual([null, "up", "flat"]);
  });

  it("handles a single entry", () => {
    const trend = gapTrend([logEntry({})]);
    expect(trend).toHaveLength(1);
    expect(trend[0].direction).toBeNull();
    expect(trend[0].size).toBe(gapEntrySize(logEntry({})));
  });
});

describe("buildGapFeedbackDigest", () => {
  it("returns an empty string for no entries", () => {
    expect(buildGapFeedbackDigest([])).toBe("");
  });

  it("aggregates line and per-type totals across entries", () => {
    const digest = buildGapFeedbackDigest([
      logEntry({
        at: "2026-07-29T09:00:00",
        addedLines: 3,
        removedLines: 1,
        byType: { externalInfo: 2, directEdit: 1, crossDocReference: 0, formatting: 0 },
      }),
      logEntry({
        at: "2026-07-30T09:00:00",
        addedLines: 2,
        removedLines: 2,
        byType: { externalInfo: 1, directEdit: 0, crossDocReference: 1, formatting: 1 },
      }),
    ]);
    const lines = digest.split("\n");
    expect(lines[0]).toContain("최근 초안 2건");
    expect(lines[0]).toContain("추가 5줄");
    expect(lines[0]).toContain("삭제 3줄");
    expect(lines[0]).toContain("외부 정보 3건");
    expect(lines[0]).toContain("직접 수정 1건");
    expect(lines[0]).toContain("교차 참조 1건");
    expect(lines[0]).toContain("서식 1건");
  });

  it("adds a hint for the dominant type only", () => {
    const digest = buildGapFeedbackDigest([
      logEntry({ byType: { externalInfo: 4, directEdit: 1, crossDocReference: 0, formatting: 0 } }),
    ]);
    expect(digest).toContain("가장 잦은 수정 유형은 외부 정보 추가");
    expect(digest).toContain("출처·수치·날짜");
  });

  it("hints cross-doc references when those dominate", () => {
    const digest = buildGapFeedbackDigest([
      logEntry({ byType: { externalInfo: 0, directEdit: 0, crossDocReference: 3, formatting: 1 } }),
    ]);
    expect(digest).toContain("교차 문서 참조");
    expect(digest).toContain("[[위키링크]]");
  });

  it("omits the hint line when every type count is zero", () => {
    const digest = buildGapFeedbackDigest([logEntry({ addedLines: 0, removedLines: 0 })]);
    expect(digest.split("\n")).toHaveLength(1);
  });

  it("keeps only the most recent maxEntries entries", () => {
    const entries = Array.from({ length: 5 }, (_, index) =>
      logEntry({
        at: `2026-07-2${index}T09:00:00`,
        addedLines: 1,
        byType: { externalInfo: index === 0 ? 9 : 0, directEdit: 1, crossDocReference: 0, formatting: 0 },
      }),
    );
    const digest = buildGapFeedbackDigest(entries, 2);
    // Only the two newest (07-23, 07-24) count: the old 9-external-info entry is out.
    expect(digest).toContain("최근 초안 2건");
    expect(digest).toContain("추가 2줄");
    expect(digest).toContain("외부 정보 0건");
    expect(digest).toContain("가장 잦은 수정 유형은 직접 수정");
  });
});

describe("appendGapFeedbackDigest", () => {
  it("returns the prompt unchanged for an empty digest", () => {
    expect(appendGapFeedbackDigest("run extract-tasks", "")).toBe("run extract-tasks");
  });

  it("appends a delimited section to an existing prompt", () => {
    const result = appendGapFeedbackDigest("run extract-tasks", "digest body");
    expect(result).toBe(
      `run extract-tasks\n\n${GAP_FEEDBACK_SECTION_HEADER}\n\ndigest body`,
    );
  });

  it("produces just the section for an empty prompt", () => {
    const result = appendGapFeedbackDigest("", "digest body");
    expect(result).toBe(`${GAP_FEEDBACK_SECTION_HEADER}\n\ndigest body`);
  });
});
