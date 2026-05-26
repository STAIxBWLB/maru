import { describe, expect, it } from "vitest";

import { alignNodes, distributeNodes, equalizeSize } from "./alignment";
import type { DiagramNode } from "./types";

const node = (id: string, x: number, y: number, w = 80, h = 40): DiagramNode => ({
  id,
  kind: "simple",
  x,
  y,
  w,
  h,
});

describe("alignment", () => {
  it("alignNodes('left') snaps to the minimum x", () => {
    const nodes = [node("a", 100, 0), node("b", 200, 0), node("c", 50, 0)];
    const out = alignNodes(nodes, ["a", "b", "c"], "left");
    expect(out.map((n) => n.x)).toEqual([50, 50, 50]);
  });

  it("alignNodes('right') aligns right edges", () => {
    const nodes = [node("a", 0, 0, 100), node("b", 0, 0, 50)];
    const out = alignNodes(nodes, ["a", "b"], "right");
    expect(out.find((n) => n.id === "a")!.x).toBe(0);
    expect(out.find((n) => n.id === "b")!.x).toBe(50);
  });

  it("alignNodes('center-h') centers the bounding bbox", () => {
    const nodes = [node("a", 0, 0, 80), node("b", 200, 0, 40)];
    const out = alignNodes(nodes, ["a", "b"], "center-h");
    // bbox spans x=0..240, centerX=120
    expect(out.find((n) => n.id === "a")!.x).toBe(80);
    expect(out.find((n) => n.id === "b")!.x).toBe(100);
  });

  it("alignNodes is a no-op for <2 selected", () => {
    const nodes = [node("a", 0, 0)];
    expect(alignNodes(nodes, ["a"], "left")).toBe(nodes);
  });

  it("distributeNodes spaces middle nodes evenly", () => {
    const nodes = [node("a", 0, 0, 40), node("b", 80, 0, 40), node("c", 200, 0, 40)];
    const out = distributeNodes(nodes, ["a", "b", "c"], "h");
    // center of a = 20, center of c = 220, step = 100, middle center at 120
    expect(out.find((n) => n.id === "b")!.x).toBe(100);
  });

  it("distributeNodes is a no-op for <3 selected", () => {
    const nodes = [node("a", 0, 0), node("b", 100, 0)];
    expect(distributeNodes(nodes, ["a", "b"], "h")).toBe(nodes);
  });

  it("equalizeSize sets width to the maximum", () => {
    const nodes = [node("a", 0, 0, 60), node("b", 0, 0, 120)];
    const out = equalizeSize(nodes, ["a", "b"], "w");
    expect(out.find((n) => n.id === "a")!.w).toBe(120);
    expect(out.find((n) => n.id === "b")!.w).toBe(120);
  });

  it("equalizeSize on h works likewise", () => {
    const nodes = [node("a", 0, 0, 60, 30), node("b", 0, 0, 60, 80)];
    const out = equalizeSize(nodes, ["a", "b"], "h");
    expect(out.find((n) => n.id === "a")!.h).toBe(80);
    expect(out.find((n) => n.id === "b")!.h).toBe(80);
  });
});
