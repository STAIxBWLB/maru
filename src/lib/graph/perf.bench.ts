/**
 * Graph perf bench — `pnpm vitest bench src/lib/graph/perf.bench.ts`.
 *
 * V4 budgets (synthetic 10,000 nodes / 50k edges):
 *   - buildVaultGraph < 500ms
 *   - ForceAtlas2 warm layout (20 worker-equivalent iterations) ≤ 3s
 *   - visibility-mask update < 5ms
 *
 * Numbers vary by hardware; the bench catches order-of-magnitude regressions.
 */

import { MultiDirectedGraph } from "graphology";
import forceAtlas2, { inferSettings } from "graphology-layout-forceatlas2";
import { bench, describe } from "vitest";
import type { VaultEntry } from "../types";
import { buildAdjacency, buildVaultGraph } from "./model";
import { findBridges, findHiddenLinks, findOrphans } from "./insights";

const NODE_COUNT = 10_000;
const EDGE_COUNT = 50_000;

function syntheticEntries(): VaultEntry[] {
  const entries: VaultEntry[] = [];
  for (let i = 0; i < NODE_COUNT; i += 1) {
    const links: string[] = [];
    const linkCount = Math.floor(EDGE_COUNT / NODE_COUNT);
    for (let l = 0; l < linkCount; l += 1) {
      links.push(`note-${(i * 7 + l * 131) % NODE_COUNT}`);
    }
    entries.push({
      path: `/vault/notes/note-${i}.md`,
      relPath: `notes/note-${i}.md`,
      title: `note-${i}`,
      frontmatter: {
        type: ["insight", "decision", "observation", "person"][i % 4],
        domain: ["research", "projects", "operations"][i % 3],
        topics: [`[[moc-${i % 12}]]`],
      },
      updatedAt: null,
      wordCount: 100,
      snippet: "",
      fileKind: "md",
      versionCount: 0,
      links,
    });
  }
  for (let m = 0; m < 12; m += 1) {
    entries.push({
      path: `/vault/notes/moc-${m}.md`,
      relPath: `notes/moc-${m}.md`,
      title: `moc-${m}`,
      frontmatter: { type: "moc", domain: "projects" },
      updatedAt: null,
      wordCount: 10,
      snippet: "",
      fileKind: "md",
      versionCount: 0,
      links: [],
    });
  }
  return entries;
}

const entries = syntheticEntries();
const model = buildVaultGraph(entries);

describe(`graph 10k nodes / ${model.edges.length} edges`, () => {
  bench("buildVaultGraph (<500ms budget)", () => {
    buildVaultGraph(entries);
  });

  bench("ForceAtlas2 20-iteration warm layout (≤3s budget)", () => {
    const graph = new MultiDirectedGraph();
    model.nodes.forEach((node, i) => graph.addNode(node.id, {
      x: Math.cos(i) * Math.sqrt(i + 1),
      y: Math.sin(i) * Math.sqrt(i + 1),
      size: 6,
    }));
    model.edges.forEach((edge, i) => {
      if (graph.hasNode(edge.source) && graph.hasNode(edge.target)) {
        graph.addDirectedEdgeWithKey(`e:${i}`, edge.source, edge.target);
      }
    });
    forceAtlas2.assign(graph, {
      iterations: 20,
      settings: {
        ...inferSettings(graph.order),
        adjustSizes: true,
        barnesHutOptimize: true,
      },
    });
  });

  bench("visibility-mask update (<5ms budget)", () => {
    const visible = new Uint8Array(model.nodes.length);
    for (let i = 0; i < model.nodes.length; i += 1) {
      visible[i] = model.nodes[i].degree >= 3 && model.nodes[i].type !== "unresolved" ? 1 : 0;
    }
  });

  bench("insight pass — hidden links + bridges + orphans (<200ms budget)", () => {
    // Runs on demand (not per frame); this guards the O(Σd²) hidden-link scan
    // against blow-up at 10k nodes. Adjacency is shared via a per-model
    // WeakMap, so the second+ builders in this pass hit the cache.
    findHiddenLinks(model);
    findBridges(model);
    findOrphans(model);
  });

  bench("buildAdjacency cold (<50ms budget)", () => {
    // Spread defeats the per-model WeakMap cache to time an uncached build —
    // the first insight/focus consumer of a fresh model pays this once.
    buildAdjacency({ ...model });
  });
});
