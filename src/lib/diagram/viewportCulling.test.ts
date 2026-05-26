import { describe, expect, it } from "vitest";

import type { DiagramEdge, DiagramNode } from "./types";
import { visibleSubset } from "./viewportCulling";

const node = (id: string, x: number, y: number, w = 100, h = 50): DiagramNode => ({
  id,
  kind: "simple",
  x,
  y,
  w,
  h,
});

const edge = (id: string, from: string, to: string): DiagramEdge => ({
  id,
  fromNode: from,
  fromPort: "e",
  toNode: to,
  toPort: "w",
});

describe("visibleSubset", () => {
  it("keeps only nodes within the (padded) viewport", () => {
    const nodes = [node("a", 0, 0), node("b", 500, 500), node("c", -200, -200)];
    const { nodes: visible, full } = visibleSubset({
      nodes,
      edges: [],
      viewport: { x: -50, y: -50, w: 200, h: 200 },
      padding: 0,
    });
    expect(visible.map((n) => n.id)).toEqual(["a"]);
    expect(full).toBe(false);
  });

  it("padding pulls neighbouring nodes back into the visible set", () => {
    const nodes = [node("a", 0, 0), node("b", 250, 0)];
    const close = visibleSubset({
      nodes,
      edges: [],
      viewport: { x: 0, y: 0, w: 200, h: 100 },
      padding: 60,
    });
    expect(close.nodes.map((n) => n.id).sort()).toEqual(["a", "b"]);
  });

  it("forceVisible keeps selected nodes regardless of position", () => {
    const nodes = [node("a", 9999, 9999)];
    const { nodes: visible } = visibleSubset({
      nodes,
      edges: [],
      viewport: { x: 0, y: 0, w: 100, h: 100 },
      forceVisible: new Set(["a"]),
    });
    expect(visible).toHaveLength(1);
  });

  it("skips hidden nodes", () => {
    const nodes = [{ ...node("a", 0, 0), hidden: true }, node("b", 10, 10)];
    const { nodes: visible } = visibleSubset({
      nodes,
      edges: [],
      viewport: { x: -50, y: -50, w: 200, h: 200 },
    });
    expect(visible.map((n) => n.id)).toEqual(["b"]);
  });

  it("keeps an edge when either endpoint is visible", () => {
    const nodes = [node("a", 0, 0), node("b", 9999, 9999)];
    const edges = [edge("e1", "a", "b")];
    const { edges: visible } = visibleSubset({
      nodes,
      edges,
      viewport: { x: -50, y: -50, w: 200, h: 200 },
    });
    expect(visible).toHaveLength(1);
  });

  it("returns full=true when nothing is culled", () => {
    const nodes = [node("a", 0, 0)];
    const r = visibleSubset({
      nodes,
      edges: [],
      viewport: { x: -50, y: -50, w: 200, h: 200 },
    });
    expect(r.full).toBe(true);
  });
});
