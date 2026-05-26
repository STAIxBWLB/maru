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
