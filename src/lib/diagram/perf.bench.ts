/**
 * Diagram perf bench — runs with `pnpm vitest bench src/lib/diagram/perf.bench.ts`.
 *
 * Tracks three hot paths against the Phase 6 budget:
 *   - viewport culling on 1000 nodes (>20k ops/sec target)
 *   - edge route resolution with cache warmth
 *   - findInDoc across titles + bodies
 *
 * Numbers vary by hardware; the bench primarily catches regressions that
 * change orders of magnitude.
 */

import { bench, describe } from "vitest";

import { defaultEdge } from "./edgeRouting";
import { findInDoc } from "./findReplace";
import { mkNode } from "./nodeKinds";
import { routeEdge } from "./edgeRouting";
import { createEmptyDoc, type DiagramDoc, type DiagramEdge, type DiagramNode } from "./types";
import { visibleSubset } from "./viewportCulling";

function buildFixture(count: number): DiagramDoc {
  const doc = createEmptyDoc("bench", 0);
  const cols = Math.ceil(Math.sqrt(count));
  const nodes: DiagramNode[] = [];
  for (let i = 0; i < count; i += 1) {
    const x = (i % cols) * 160;
    const y = Math.floor(i / cols) * 90;
    nodes.push(mkNode("simple", x, y, { title: `Node ${i + 1}` }));
  }
  doc.nodes = nodes;
  const edges: DiagramEdge[] = [];
  for (let i = 0; i + 1 < count; i += 1) {
    edges.push(defaultEdge(`edge-${i}`, nodes[i]!.id, "e", nodes[i + 1]!.id, "w"));
  }
  doc.edges = edges;
  return doc;
}

const small = buildFixture(50);
const medium = buildFixture(200);
const large = buildFixture(1000);

describe("viewport culling", () => {
  bench("visibleSubset / 1000 nodes / small viewport", () => {
    visibleSubset({
      nodes: large.nodes,
      edges: large.edges,
      viewport: { x: 0, y: 0, w: 800, h: 600 },
    });
  });

  bench("visibleSubset / 200 nodes / no cull (full viewport)", () => {
    visibleSubset({
      nodes: medium.nodes,
      edges: medium.edges,
      viewport: { x: -10_000, y: -10_000, w: 30_000, h: 30_000 },
    });
  });
});

describe("edge routing", () => {
  bench("routeEdge / 200 edges / warm cache", () => {
    const nodes = new Map(medium.nodes.map((n) => [n.id, n] as const));
    for (const edge of medium.edges) {
      routeEdge(edge, nodes.get(edge.fromNode), nodes.get(edge.toNode));
    }
  });
});

describe("find/replace", () => {
  bench("findInDoc / 200 nodes", () => {
    findInDoc(medium, "Node 1");
  });
  bench("findInDoc / 50 nodes (small)", () => {
    findInDoc(small, "Node 1");
  });
});
