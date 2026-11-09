import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { combinedCorpus, denseContents, generateDenseScenes } from "./diagram-engine-e2-dense.mjs";

function positioned(spec) {
  const nodes = spec.components ?? spec.nodes;
  return nodes.map((node) => {
    if (spec.diagram_type === "architecture") {
      const layout = spec.layout;
      const [w, h] = node.size ?? [120, 60];
      return { id: node.id, x: layout.origin[0] + node.col * (layout.cellW + layout.gapX), y: layout.origin[1] + node.row * (layout.cellH + layout.gapY), w, h };
    }
    const w = node.width;
    const h = node.height;
    if (spec.diagram_type === "workflow") {
      const centers = [88, 220, 300, 430, 500, 625];
      const lane = spec.lanes.findIndex((candidate) => candidate.id === node.lane);
      return { id: node.id, x: centers[node.col] - w / 2, y: 52 + lane * 124 + 30 + (74 - h) / 2 + (node.yOffset ?? 0), w, h };
    }
    return { id: node.id, x: 100 + node.stage * 215 - w / 2, y: 128 + node.row * 114 + (node.yOffset ?? 0), w, h };
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
        const ports = [[node.x - 10, node.y + node.h / 2], [node.x + node.w + 10, node.y + node.h / 2], [node.x + node.w / 2, node.y - 10], [node.x + node.w / 2, node.y + node.h + 10]];
        for (const [x, y] of ports) expect(nodes.some((other) => other.id !== node.id && inside(x, y, { x: other.x - 4, y: other.y - 4, w: other.w + 8, h: other.h + 8 }))).toBe(false);
      }
      const centers = new Map(nodes.map((node) => [node.id, { x: node.x + node.w / 2, y: node.y + node.h / 2 }]));
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

it("keeps every layered boundary input in the deterministic combined corpus",()=>{
  const base={cases:[{id:"parity",inputJson:"{}"}],boundaryCases:[{id:"boundary",inputJson:"{}",boundary:{layer:"model-difference"}}]};
  const report=JSON.parse(combinedCorpus(JSON.stringify(base),denseContents()));
  expect(report.cases.map((item:{id:string})=>item.id).slice(0,2)).toEqual(["parity","boundary"]);
});
