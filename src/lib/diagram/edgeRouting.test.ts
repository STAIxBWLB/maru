import { beforeEach, describe, expect, it } from "vitest";

import {
  _routeCacheSizeForTests,
  clearRouteCache,
  defaultEdge,
  routeEdge,
} from "./edgeRouting";
import type { DiagramNode } from "./types";

const node = (id: string, x: number, y: number, w = 100, h = 50): DiagramNode => ({
  id,
  kind: "simple",
  x,
  y,
  w,
  h,
});

beforeEach(() => clearRouteCache());

describe("edgeRouting", () => {
  it("auto routes two same-row nodes with a single horizontal bend", () => {
    const a = node("a", 0, 0);
    const b = node("b", 300, 0);
    const edge = defaultEdge("e1", "a", "e", "b", "w");
    const r = routeEdge(edge, a, b)!;
    expect(r.path).toContain("M 100 25");
    expect(r.path).toContain("L 300 25");
  });

  it("auto routes orthogonal between vertical and horizontal ports", () => {
    const a = node("a", 0, 0);
    const b = node("b", 300, 200);
    const edge = defaultEdge("e1", "a", "s", "b", "w");
    const r = routeEdge(edge, a, b)!;
    expect(r.path.startsWith("M ")).toBe(true);
    expect(r.path).toContain("L");
  });

  it("straight mode emits a one-segment line", () => {
    const a = node("a", 0, 0);
    const b = node("b", 300, 200);
    const edge = defaultEdge("e1", "a", "e", "b", "w", { routeMode: "straight" });
    const r = routeEdge(edge, a, b)!;
    expect(r.path).toMatch(/^M \d+ \d+ L \d+ \d+$/);
  });

  it("returns null when an endpoint node is missing", () => {
    const a = node("a", 0, 0);
    const edge = defaultEdge("e1", "a", "e", "ghost", "w");
    expect(routeEdge(edge, a, undefined)).toBeNull();
  });

  it("midOff shifts the bend on same-axis routes", () => {
    const a = node("a", 0, 0);
    const b = node("b", 300, 0);
    const baseline = routeEdge(defaultEdge("e1", "a", "e", "b", "w"), a, b)!;
    const shifted = routeEdge(defaultEdge("e2", "a", "e", "b", "w", { midOff: 30 }), a, b)!;
    expect(baseline.path).not.toEqual(shifted.path);
  });

  it("keeps midOff = 0 routes byte-identical to the endpoint-midpoint anchor", () => {
    const cases: Array<[DiagramNode, DiagramNode, "n" | "s" | "e" | "w", "n" | "s" | "e" | "w"]> = [
      [node("a", 0, 0), node("b", 300, 40), "e", "w"],
      [node("a", 0, 0), node("b", 300, 40), "s", "n"],
      [node("a", 10, 0), node("b", 310, 0), "s", "s"],
      [node("a", 0, 0), node("b", 300, 200), "s", "w"],
    ];
    cases.forEach(([a, b, fromPort, toPort], i) => {
      const r = routeEdge(defaultEdge(`m${i}`, "a", fromPort, "b", toPort, { midOff: 0 }), a, b)!;
      const start = r.path.match(/^M (\S+) (\S+)/)!.slice(1).map(Number);
      const end = r.path.match(/L (\S+) (\S+)$/)!.slice(1).map(Number);
      const midpoint = { x: (start[0]! + end[0]!) / 2, y: (start[1]! + end[1]!) / 2 };
      expect(JSON.stringify(r.label)).toBe(JSON.stringify(midpoint));
      expect(JSON.stringify(r.mid)).toBe(JSON.stringify(midpoint));
    });
  });

  it("anchors the label on the middle segment of a midOff bracket", () => {
    // Sequence-style bracket: both ports on the bottom side, pushed 72px down.
    const a = node("a", 0, 0);
    const b = node("b", 300, 0);
    const r = routeEdge(defaultEdge("seq", "a", "s", "b", "s", { midOff: 72 }), a, b)!;
    expect(r.path).toBe("M 50 50 L 50 122 L 350 122 L 350 50");
    expect(r.label).toEqual({ x: 200, y: 122 });
    expect(r.mid).toEqual({ x: 200, y: 122 });
  });

  it("caches the same input, recomputes on node move", () => {
    const a = node("a", 0, 0);
    const b = node("b", 300, 0);
    const e = defaultEdge("e1", "a", "e", "b", "w");
    const first = routeEdge(e, a, b)!;
    const sizeAfterFirst = _routeCacheSizeForTests();
    const second = routeEdge(e, a, b)!;
    expect(second).toBe(first);
    expect(_routeCacheSizeForTests()).toBe(sizeAfterFirst);

    const moved = routeEdge(e, { ...a, x: 50 }, b)!;
    expect(moved).not.toBe(first);
    expect(_routeCacheSizeForTests()).toBe(sizeAfterFirst + 1);
  });
});
