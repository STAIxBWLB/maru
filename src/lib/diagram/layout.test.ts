import { describe, expect, it } from "vitest";

import { layoutDoc } from "./layout";
import { createEmptyDoc, type DiagramDoc, type DiagramEdge, type DiagramNode } from "./types";

const node = (id: string, x: number, y: number, extra: Partial<DiagramNode> = {}): DiagramNode => ({
  id,
  kind: "simple",
  x,
  y,
  w: 80,
  h: 40,
  ...extra,
});

const edge = (id: string, from: string, to: string): DiagramEdge => ({
  id,
  fromNode: from,
  fromPort: "s",
  toNode: to,
  toPort: "n",
});

const doc = (nodes: DiagramNode[], edges: DiagramEdge[]): DiagramDoc => ({
  ...createEmptyDoc("doc-layout-test", 0),
  nodes,
  edges,
});

const posOf = (result: DiagramDoc, id: string) => {
  const n = result.nodes.find((n) => n.id === id)!;
  return { x: n.x, y: n.y };
};

// a→b, a→c, b→d, c→d diamond plus isolated e.
const diamondDoc = () =>
  doc(
    [node("a", 999, 999), node("b", 999, 999), node("c", 999, 999), node("d", 999, 999), node("e", 999, 999)],
    [edge("e1", "a", "b"), edge("e2", "a", "c"), edge("e3", "b", "d"), edge("e4", "c", "d")],
  );

describe("layoutDoc", () => {
  it("is deterministic: two runs deep-equal", () => {
    const input = diamondDoc();
    const first = layoutDoc(input);
    const second = layoutDoc(input);
    expect(second).toEqual(first);
    expect(second.doc.nodes).toEqual(first.doc.nodes);
  });

  it("places a small fixed graph at exact coordinates", () => {
    const result = layoutDoc(diamondDoc());
    expect(result.changed).toBe(true);
    expect(result.diagnostics).toEqual([]);
    // Layer 0: a. Layer 1: b, c (id order, 200px step). Layer 2: d.
    // Isolated e is appended on its own row below the deepest connected layer.
    expect(posOf(result.doc, "a")).toEqual({ x: 40, y: 40 });
    expect(posOf(result.doc, "b")).toEqual({ x: 40, y: 160 });
    expect(posOf(result.doc, "c")).toEqual({ x: 240, y: 160 });
    expect(posOf(result.doc, "d")).toEqual({ x: 40, y: 280 });
    expect(posOf(result.doc, "e")).toEqual({ x: 40, y: 400 });
  });

  it("keeps each node's w/h and supports a custom origin", () => {
    const input = doc([node("a", 0, 0, { w: 120, h: 64 }), node("b", 0, 0, { w: 200, h: 32 })], [
      edge("e1", "a", "b"),
    ]);
    const result = layoutDoc(input, { origin: { x: 100, y: 50 } });
    expect(posOf(result.doc, "a")).toEqual({ x: 100, y: 50 });
    expect(posOf(result.doc, "b")).toEqual({ x: 100, y: 170 });
    expect(result.doc.nodes.find((n) => n.id === "a")).toMatchObject({ w: 120, h: 64 });
    expect(result.doc.nodes.find((n) => n.id === "b")).toMatchObject({ w: 200, h: 32 });
  });

  it("lays out hidden nodes too (visibility is a view concern)", () => {
    const input = doc([node("a", 1, 1), node("b", 2, 2, { hidden: true })], [edge("e1", "a", "b")]);
    const result = layoutDoc(input);
    expect(posOf(result.doc, "b")).toEqual({ x: 40, y: 160 });
    expect(result.doc.nodes.find((n) => n.id === "b")!.hidden).toBe(true);
  });

  it("scope: only scoped nodes move, out-of-scope positions stay byte-identical", () => {
    const input = doc(
      [node("out1", 7, 13), node("a", 500, 500), node("b", 500, 500), node("out2", 42, 84)],
      [edge("e1", "a", "b"), edge("e2", "out1", "a"), edge("e3", "b", "out2")],
    );
    const result = layoutDoc(input, { scope: new Set(["a", "b"]) });
    expect(result.changed).toBe(true);
    expect(posOf(result.doc, "a")).toEqual({ x: 40, y: 40 });
    expect(posOf(result.doc, "b")).toEqual({ x: 40, y: 160 });
    // Out-of-scope nodes keep exact positions.
    expect(posOf(result.doc, "out1")).toEqual({ x: 7, y: 13 });
    expect(posOf(result.doc, "out2")).toEqual({ x: 42, y: 84 });
    // Edges are untouched.
    expect(result.doc.edges).toBe(input.edges);
    // The two boundary edges would have pulled out-of-scope nodes in a
    // whole-doc layout; that is reported instead of done.
    expect(result.diagnostics).toContainEqual({
      key: "diagram.layout.scopePreserved",
      params: { count: 2 },
    });
  });

  it("locked and pinned nodes keep positions and are reported", () => {
    const input = doc(
      [
        node("locked1", 11, 22, { locked: true }),
        node("pinned1", 33, 44, { meta: { pinned: true } }),
        node("a", 500, 500),
        node("b", 500, 500),
      ],
      [edge("e1", "a", "b"), edge("e2", "locked1", "a"), edge("e3", "b", "pinned1")],
    );
    const result = layoutDoc(input);
    expect(result.changed).toBe(true);
    expect(posOf(result.doc, "locked1")).toEqual({ x: 11, y: 22 });
    expect(posOf(result.doc, "pinned1")).toEqual({ x: 33, y: 44 });
    expect(posOf(result.doc, "a")).toEqual({ x: 40, y: 40 });
    expect(posOf(result.doc, "b")).toEqual({ x: 40, y: 160 });
    expect(result.diagnostics).toContainEqual({
      key: "diagram.layout.pinnedKept",
      params: { count: 2 },
    });
  });

  it("breaks cycles deterministically by node id order and terminates", () => {
    // a→b→c→a pure cycle: a gets depth 0 (first in id order), b 1, c 2.
    const cyclic = () =>
      doc(
        [node("a", 900, 900), node("b", 900, 900), node("c", 900, 900)],
        [edge("e1", "a", "b"), edge("e2", "b", "c"), edge("e3", "c", "a")],
      );
    const first = layoutDoc(cyclic());
    const second = layoutDoc(cyclic());
    expect(second).toEqual(first);
    expect(first.changed).toBe(true);
    expect(posOf(first.doc, "a")).toEqual({ x: 40, y: 40 });
    expect(posOf(first.doc, "b")).toEqual({ x: 40, y: 160 });
    expect(posOf(first.doc, "c")).toEqual({ x: 40, y: 280 });
  });

  it("reports infeasible when every node in scope is locked or pinned", () => {
    const input = doc(
      [node("a", 1, 2, { locked: true }), node("b", 3, 4, { meta: { pinned: true } })],
      [edge("e1", "a", "b")],
    );
    const result = layoutDoc(input);
    expect(result.changed).toBe(false);
    expect(result.doc).toBe(input);
    expect(result.diagnostics).toContainEqual({ key: "diagram.layout.infeasible" });
    expect(result.diagnostics).toContainEqual({
      key: "diagram.layout.pinnedKept",
      params: { count: 2 },
    });
  });

  it("reports infeasible for an empty scope", () => {
    const input = doc([node("a", 1, 2)], []);
    const result = layoutDoc(input, { scope: new Set() });
    expect(result.changed).toBe(false);
    expect(result.doc).toBe(input);
    expect(result.diagnostics).toEqual([{ key: "diagram.layout.infeasible" }]);
  });

  it("reports changed:false when positions already match", () => {
    const input = doc([node("a", 40, 40), node("b", 40, 160)], [edge("e1", "a", "b")]);
    const result = layoutDoc(input);
    expect(result.changed).toBe(false);
    expect(result.doc).toBe(input);
  });
});
