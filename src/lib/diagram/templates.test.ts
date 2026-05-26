import { describe, expect, it } from "vitest";

import {
  TEMPLATE_LIST,
  getTemplateById,
} from "./templates";

const fakeT = (key: string) => key;

describe("templates", () => {
  it("registers a non-empty list with unique ids", () => {
    const ids = TEMPLATE_LIST.map((t) => t.id);
    expect(ids.length).toBeGreaterThan(5);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("includes a blank template that produces an empty bundle", () => {
    const blank = getTemplateById("blank")!;
    const out = blank.build(0, 0, fakeT);
    expect(out.nodes).toEqual([]);
    expect(out.edges).toEqual([]);
  });

  it("PDCA cycle wires 4 cardinal edges", () => {
    const pdca = getTemplateById("pdca-cycle")!;
    const { nodes, edges } = pdca.build(0, 0, fakeT);
    expect(nodes).toHaveLength(4);
    expect(edges).toHaveLength(4);
  });

  it("each template uses i18n keys (no raw Korean) for titles", () => {
    for (const tpl of TEMPLATE_LIST) {
      const bundle = tpl.build(0, 0, fakeT);
      for (const node of bundle.nodes) {
        if (!node.title) continue;
        // Translated strings would equal the key in the fake translator
        expect(node.title).toMatch(/^diagram\.template\./);
      }
    }
  });

  it("nodes produced are positionally valid (non-NaN x/y/w/h)", () => {
    for (const tpl of TEMPLATE_LIST) {
      const { nodes } = tpl.build(1000, 1000, fakeT);
      for (const n of nodes) {
        expect(Number.isFinite(n.x)).toBe(true);
        expect(Number.isFinite(n.y)).toBe(true);
        expect(n.w).toBeGreaterThan(0);
        expect(n.h).toBeGreaterThan(0);
      }
    }
  });
});
