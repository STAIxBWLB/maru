import { describe, expect, it } from "vitest";
import {
  defaultPromoteDocumentPath,
  draftItemId,
  draftItemKind,
  filterDraftItems,
  formatConfidence,
  formatScheduleTime,
  mergeDraftItems,
  slugifyDraftTitle,
  sortDraftItemsNewestFirst,
  type DraftListItem,
} from "../lib/drafts";
import type { DraftEntry, ScratchpadEntry } from "../lib/types";

function draft(overrides: Partial<DraftEntry>): DraftEntry {
  return {
    id: "d1",
    kind: "task",
    title: "Draft",
    status: "new",
    source: "claude",
    originRefs: [],
    bodyPath: ".maru/drafts/d1/body.md",
    createdAt: "2026-07-01T00:00:00Z",
    updatedAt: "2026-07-01T00:00:00Z",
    ...overrides,
  };
}

function idea(overrides: Partial<ScratchpadEntry>): ScratchpadEntry {
  return {
    collection: "ideation",
    relativePath: "ideas/i1.md",
    name: "Idea",
    source: "manual",
    format: "markdown",
    updatedAt: "2026-07-01T00:00:00Z",
    sizeBytes: 10,
    preview: "preview",
    revision: "r1",
    stale: false,
    editable: true,
    ...overrides,
  };
}

describe("mergeDraftItems", () => {
  it("combines drafts and ideation entries with discriminants", () => {
    const items = mergeDraftItems([draft({ id: "a" })], [idea({ relativePath: "ideas/x.md" })]);
    expect(items).toHaveLength(2);
    expect(items[0].itemKind).toBe("draft");
    expect(items[1].itemKind).toBe("idea");
    expect(draftItemId(items[0])).toBe("draft:a");
    expect(draftItemId(items[1])).toBe("idea:ideas/x.md");
  });

  it("maps ideation entries to the idea kind", () => {
    const items = mergeDraftItems([], [idea({})]);
    expect(draftItemKind(items[0])).toBe("idea");
  });
});

describe("filterDraftItems", () => {
  const items: DraftListItem[] = mergeDraftItems(
    [
      draft({ id: "new-task", kind: "task", status: "new" }),
      draft({ id: "review-impl", kind: "implementation", status: "in-review" }),
      draft({ id: "gone", kind: "task", status: "discarded" }),
    ],
    [idea({ relativePath: "ideas/i1.md" })],
  );

  it("open filter hides discarded drafts but keeps ideas", () => {
    const visible = filterDraftItems(items, "all", "open");
    expect(visible.map(draftItemId)).toEqual([
      "draft:new-task",
      "draft:review-impl",
      "idea:ideas/i1.md",
    ]);
  });

  it("all filter shows everything", () => {
    expect(filterDraftItems(items, "all", "all")).toHaveLength(4);
  });

  it("kind filter narrows to a single kind", () => {
    const visible = filterDraftItems(items, "task", "all");
    expect(visible.map(draftItemId)).toEqual(["draft:new-task", "draft:gone"]);
  });

  it("idea kind filter keeps only ideation entries", () => {
    const visible = filterDraftItems(items, "idea", "open");
    expect(visible.map(draftItemId)).toEqual(["idea:ideas/i1.md"]);
  });

  it("a specific status filter hides ideas and non-matching drafts", () => {
    const visible = filterDraftItems(items, "all", "discarded");
    expect(visible.map(draftItemId)).toEqual(["draft:gone"]);
  });
});

describe("sortDraftItemsNewestFirst", () => {
  it("orders by updatedAt descending with untimestamped items last", () => {
    const items = mergeDraftItems(
      [
        draft({ id: "old", updatedAt: "2026-07-01T00:00:00Z" }),
        draft({ id: "new", updatedAt: "2026-07-20T00:00:00Z" }),
      ],
      [idea({ relativePath: "ideas/no-date.md", updatedAt: null })],
    );
    const sorted = sortDraftItemsNewestFirst(items);
    expect(sorted.map(draftItemId)).toEqual([
      "draft:new",
      "draft:old",
      "idea:ideas/no-date.md",
    ]);
  });
});

describe("slugifyDraftTitle", () => {
  it("slugifies latin and korean titles", () => {
    expect(slugifyDraftTitle("Weekly Report #12!")).toBe("weekly-report-12");
    expect(slugifyDraftTitle("주간 보고서 초안")).toBe("주간-보고서-초안");
  });

  it("falls back for empty slugs", () => {
    expect(slugifyDraftTitle("!!!")).toBe("draft");
    expect(slugifyDraftTitle("   ")).toBe("draft");
  });

  it("builds a default promote path under the configured directory", () => {
    expect(defaultPromoteDocumentPath("My Draft", "_incoming")).toBe(
      "_incoming/my-draft.md",
    );
    expect(defaultPromoteDocumentPath("My Draft", "proposals/incoming")).toBe(
      "proposals/incoming/my-draft.md",
    );
  });
});

describe("formatScheduleTime", () => {
  it("zero-pads hour and minute", () => {
    expect(formatScheduleTime(7, 5)).toBe("07:05");
    expect(formatScheduleTime(23, 59)).toBe("23:59");
  });

  it("clamps out-of-range values", () => {
    expect(formatScheduleTime(25, 90)).toBe("23:59");
    expect(formatScheduleTime(-1, -5)).toBe("00:00");
  });
});

describe("formatConfidence", () => {
  it("handles fractions, percentages, and empty values", () => {
    expect(formatConfidence(0.85)).toBe("85%");
    expect(formatConfidence(72)).toBe("72%");
    expect(formatConfidence(null)).toBe("");
    expect(formatConfidence(undefined)).toBe("");
    expect(formatConfidence(Number.NaN)).toBe("");
  });
});
