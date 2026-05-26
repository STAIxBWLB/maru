import { describe, expect, it } from "vitest";

import {
  HISTORY_CAP,
  createCoalescer,
  emptyHistory,
  redo,
  snapshot,
  undo,
} from "./history";
import { createEmptyDoc } from "./types";

describe("history", () => {
  it("snapshot dedupes identical consecutive entries", () => {
    const doc = createEmptyDoc("doc", 1);
    const h1 = snapshot(emptyHistory(), doc);
    const h2 = snapshot(h1, doc);
    expect(h1.past).toHaveLength(1);
    expect(h2).toBe(h1);
  });

  it("snapshot drops the future branch", () => {
    const doc = createEmptyDoc("doc", 1);
    const h = { past: ["x", "y"], future: ["z"] };
    const next = snapshot(h, doc);
    expect(next.future).toEqual([]);
  });

  it("caps history at HISTORY_CAP", () => {
    const doc = createEmptyDoc("doc", 1);
    let h = emptyHistory();
    for (let i = 0; i < HISTORY_CAP + 5; i += 1) {
      h = snapshot(h, { ...doc, docTitle: `t-${i}` });
    }
    expect(h.past.length).toBe(HISTORY_CAP);
  });

  it("undo restores the previous doc; redo restores the next one", () => {
    const d1 = createEmptyDoc("doc", 1);
    const d2 = { ...d1, docTitle: "two" };
    const d3 = { ...d1, docTitle: "three" };
    let h = snapshot(emptyHistory(), d1);
    h = snapshot(h, d2);
    const undone = undo(h, d3);
    expect(undone?.doc.docTitle).toBe("two");
    const redone = redo(undone!.history, undone!.doc);
    expect(redone?.doc.docTitle).toBe("three");
  });

  it("coalescer suppresses snapshots within windowMs", () => {
    const c = createCoalescer(500);
    expect(c.shouldSnapshot(0)).toBe(true);
    c.reset(0);
    expect(c.shouldSnapshot(100)).toBe(false);
    expect(c.shouldSnapshot(600)).toBe(true);
  });
});
