import { describe, expect, it } from "vitest";

import { deserializeDoc, serializeDoc } from "./persistence";
import { createEmptyDoc } from "./types";

describe("page frame normalization", () => {
  it("keeps valid non-free formats", () => {
    const doc = deserializeDoc(JSON.stringify({ v: 8, nodes: [], edges: [], page: "a4-portrait" }));
    expect(doc.page).toBe("a4-portrait");
  });

  it("normalizes free and unknown values to absent", () => {
    expect(deserializeDoc(JSON.stringify({ v: 8, nodes: [], edges: [], page: "free" })).page).toBeUndefined();
    expect(deserializeDoc(JSON.stringify({ v: 8, nodes: [], edges: [], page: "tabloid" })).page).toBeUndefined();
    expect(deserializeDoc(JSON.stringify({ v: 8, nodes: [], edges: [] })).page).toBeUndefined();
  });

  it("v7-migrated docs stay free (no page frame)", () => {
    const doc = deserializeDoc(JSON.stringify({ v: 7, nodes: [], edges: [] }));
    expect(doc.page).toBeUndefined();
  });

  it("round-trips through serialize/deserialize", () => {
    const doc = { ...createEmptyDoc("doc-1", 1), page: "16:9" as const };
    const restored = deserializeDoc(serializeDoc(doc));
    expect(restored.page).toBe("16:9");
  });
});
