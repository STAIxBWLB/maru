import { describe, expect, it } from "vitest";

import { NSIZES, PHASE_1_KINDS, mkNode } from "./nodeKinds";

describe("nodeKinds", () => {
  it("mkNode places a simple node with default size", () => {
    const n = mkNode("simple", 10, 20);
    expect(n.kind).toBe("simple");
    expect(n.x).toBe(10);
    expect(n.y).toBe(20);
    expect(n.w).toBe(NSIZES.simple.w);
    expect(n.h).toBe(NSIZES.simple.h);
    expect(n.id).toBeTruthy();
  });

  it("respects size overrides via opts", () => {
    const n = mkNode("simple", 0, 0, { w: 200, h: 80, title: "Hi" });
    expect(n.w).toBe(200);
    expect(n.h).toBe(80);
    expect(n.title).toBe("Hi");
  });

  it("keeps text node default title locale-neutral", () => {
    const n = mkNode("text", 0, 0);
    expect(n.title).toBe("");
  });

  it("uses explicit id when provided", () => {
    const n = mkNode("simple", 0, 0, { id: "fixed" });
    expect(n.id).toBe("fixed");
  });

  it("PHASE_1_KINDS lists what the toolbar exposes", () => {
    expect(PHASE_1_KINDS).toEqual(["simple", "text"]);
  });
});
