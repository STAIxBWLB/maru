import { describe, expect, it } from "vitest";

import {
  bbox,
  clamp,
  fitView,
  portPoint,
  rectContains,
  rectsIntersect,
  screenToCanvas,
  snap,
} from "./geometry";
import type { DiagramNode } from "./types";

const node = (id: string, x: number, y: number, w = 100, h = 50): DiagramNode => ({
  id,
  kind: "simple",
  x,
  y,
  w,
  h,
});

describe("geometry", () => {
  it("snap rounds to the nearest multiple", () => {
    expect(snap(13, 10)).toBe(10);
    expect(snap(17, 10)).toBe(20);
    expect(snap(13, 1)).toBe(13);
  });

  it("clamp respects bounds", () => {
    expect(clamp(5, 0, 10)).toBe(5);
    expect(clamp(-1, 0, 10)).toBe(0);
    expect(clamp(11, 0, 10)).toBe(10);
  });

  it("portPoint returns the midpoint of each side", () => {
    const n = node("a", 0, 0, 100, 50);
    expect(portPoint(n, "n")).toEqual({ x: 50, y: 0 });
    expect(portPoint(n, "s")).toEqual({ x: 50, y: 50 });
    expect(portPoint(n, "e")).toEqual({ x: 100, y: 25 });
    expect(portPoint(n, "w")).toEqual({ x: 0, y: 25 });
  });

  it("rectContains and rectsIntersect work for hit tests", () => {
    const r = { x: 0, y: 0, w: 10, h: 10 };
    expect(rectContains(r, 5, 5)).toBe(true);
    expect(rectContains(r, -1, 5)).toBe(false);
    expect(rectsIntersect(r, { x: 5, y: 5, w: 10, h: 10 })).toBe(true);
    expect(rectsIntersect(r, { x: 20, y: 20, w: 5, h: 5 })).toBe(false);
  });

  it("bbox returns null for empty input and a union otherwise", () => {
    expect(bbox([])).toBeNull();
    const box = bbox([node("a", 0, 0, 100, 50), node("b", 200, 200, 50, 50)])!;
    expect(box).toEqual({ x: 0, y: 0, w: 250, h: 250 });
  });

  it("fitView centers and scales to fit", () => {
    const v = fitView({
      nodes: [node("a", 0, 0, 1000, 1000)],
      viewportW: 500,
      viewportH: 500,
      padding: 0,
      minZoom: 0.1,
      maxZoom: 5,
    });
    expect(v.zoom).toBeCloseTo(0.5, 5);
    expect(v.px).toBeCloseTo(250 - 500 * 0.5, 5);
  });

  it("fitView with no nodes returns identity viewport", () => {
    const v = fitView({ nodes: [], viewportW: 400, viewportH: 200 });
    expect(v.zoom).toBe(1);
    expect(v.px).toBe(200);
    expect(v.py).toBe(100);
  });

  it("screenToCanvas inverts the viewport transform", () => {
    const v = { zoom: 2, px: 100, py: 50 };
    expect(screenToCanvas(200, 100, v)).toEqual({ x: 50, y: 25 });
  });
});
