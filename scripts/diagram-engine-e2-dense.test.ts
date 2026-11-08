import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { combinedCorpus, denseContents, generateDenseScenes } from "./diagram-engine-e2-dense.mjs";

function positioned(spec) {
  const nodes = spec.components ?? spec.nodes;
  return nodes.map((node) => {
    if (spec.diagram_type === "architecture") return { id: node.id, x: 64 + node.col * 280, y: 160 + node.row * 200, w: 180, h: 88 };
    if (spec.diagram_type === "workflow") return { id: node.id, x: 120 + node.col * 236, y: 144 + node.yOffset, w: 180, h: 88 };
    return { id: node.id, x: 88 + node.stage * 328, y: 160 + node.row * 152, w: 180, h: 88 };
  });
}
function edgeList(spec) { return spec.connections ?? spec.edges ?? spec.flows; }
function properCross(a, b, c, d) {
  const orient = (p, q, r) => (q.x - p.x) * (r.y - p.y) - (q.y - p.y) * (r.x - p.x);
  const opposite = (x, y) => (x < 0 && y > 0) || (x > 0 && y < 0);
  return opposite(orient(a, b, c), orient(a, b, d)) && opposite(orient(c, d, a), orient(c, d, b));
}

describe("seeded dense whole-scene fixtures", () => {
  it("is byte-stable and matches the checked-in synthetic originals", () => {
    expect(denseContents()).toBe(denseContents());
    expect(readFileSync("src-tauri/crates/maru-diagram-engine/testdata/dense-scenes.json", "utf8")).toBe(denseContents());
    expect(generateDenseScenes().cases.map((item) => item.spec.diagram_type)).toEqual(["architecture", "workflow", "dataflow"]);
  });

  it("has 200 non-overlapping nodes, open default ports and many crossing long edges per graph", () => {
    for (const item of generateDenseScenes().cases) {
      const spec = item.spec;
      const nodes = positioned(spec);
      const edges = edgeList(spec);
      expect(nodes).toHaveLength(200);
      expect(edges).toHaveLength(48);
      expect(new Set(nodes.map((node) => node.id)).size).toBe(200);
      const inside = (x, y, b) => x > b.x && x < b.x + b.w && y > b.y && y < b.y + b.h;
      for (const [index, node] of nodes.entries()) {
        for (const other of nodes.slice(index + 1)) {
          expect(node.x < other.x + other.w && other.x < node.x + node.w && node.y < other.y + other.h && other.y < node.y + node.h).toBe(false);
        }
        const ports = [[node.x - 10, node.y + 44], [node.x + node.w + 10, node.y + 44], [node.x + 90, node.y - 10], [node.x + 90, node.y + node.h + 10]];
        for (const [x, y] of ports) expect(nodes.some((other) => other.id !== node.id && inside(x, y, other))).toBe(false);
      }
      const centers = new Map(nodes.map((node) => [node.id, { x: node.x + 90, y: node.y + 44 }]));
      const long = edges.filter((edge) => edge.id.startsWith("long-"));
      expect(long).toHaveLength(32);
      expect(new Set(long.map((edge) => edge.from)).size).toBe(32);
      expect(new Set(long.map((edge) => edge.to)).size).toBe(32);
      let crossings = 0;
      for (const [index, edge] of long.entries()) {
        for (const other of long.slice(index + 1)) {
          if (properCross(centers.get(edge.from), centers.get(edge.to), centers.get(other.from), centers.get(other.to))) crossings += 1;
        }
      }
      expect(crossings).toBeGreaterThan(20);
      for (const edge of edges) {
        expect(centers.has(edge.from) && centers.has(edge.to)).toBe(true);
        expect(edge).not.toHaveProperty("route");
        expect(edge).not.toHaveProperty("fromSide");
        expect(edge).not.toHaveProperty("via");
      }
    }
  });

  it("combines base parity and every dense case with deterministic source hashes", () => {
    const base = JSON.stringify({ schemaVersion: 2, cases: [{ id: "base-case", inputJson: "{}" }] });
    const first = combinedCorpus(base, denseContents());
    expect(first).toBe(combinedCorpus(base, denseContents()));
    const combined = JSON.parse(first);
    expect(combined.cases).toHaveLength(4);
    expect(combined.cases[0].id).toBe("base-case");
    expect(combined.cases.slice(1).every((item) => item.origin.kind === "synthetic-seeded" && item.expectedCoreOk === true)).toBe(true);
    expect(combined.determinismSources.paritySha256).toMatch(/^[a-f0-9]{64}$/);
    expect(combined.determinismSources.denseSha256).toMatch(/^[a-f0-9]{64}$/);
    expect(() => combinedCorpus("{", denseContents())).toThrow("invalid JSON");
    const duplicate = JSON.stringify({ cases: [{ id: generateDenseScenes().cases[0].id, inputJson: "{}" }] });
    expect(() => combinedCorpus(duplicate, denseContents())).toThrow("duplicate IDs");
  });
});
