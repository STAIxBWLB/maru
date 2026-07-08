/**
 * Graph perf bench — `pnpm vitest bench src/lib/graph/perf.bench.ts`.
 *
 * Spec budgets (maru-vault-graph-spec §6, synthetic 2,000 nodes / 10k edges):
 *   - buildVaultGraph < 100ms
 *   - d3-force pre-run (300 ticks, same forces as layout.worker) ≤ 3s
 *   - viewport culling pass < 5ms (viewport showing ~20%)
 *
 * Numbers vary by hardware; the bench catches order-of-magnitude regressions.
 */

import {
  forceCollide,
  forceLink,
  forceManyBody,
  forceSimulation,
  type SimulationLinkDatum,
  type SimulationNodeDatum,
} from "d3-force";
import { bench, describe } from "vitest";
import type { VaultEntry } from "../types";
import { buildVaultGraph } from "./model";
import { findBridges, findHiddenLinks, findOrphans } from "./insights";

const NODE_COUNT = 2000;
const EDGE_COUNT = 10_000;

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

describe(`graph 2k nodes / ${model.edges.length} edges`, () => {
  bench("buildVaultGraph (<100ms budget)", () => {
    buildVaultGraph(entries);
  });

  bench("d3-force 300-tick pre-run (≤3s budget)", () => {
    interface N extends SimulationNodeDatum {
      r: number;
    }
    const nodes: N[] = model.nodes.map(() => ({ r: 6 }));
    const indexById = new Map(model.nodes.map((n, i) => [n.id, i]));
    const links: SimulationLinkDatum<N>[] = model.edges
      .map((e) => ({
        source: indexById.get(e.source)!,
        target: indexById.get(e.target)!,
      }))
      .filter((l) => l.source != null && l.target != null);
    const sim = forceSimulation<N>(nodes)
      .force("link", forceLink<N, SimulationLinkDatum<N>>(links).distance(60))
      .force("charge", forceManyBody().strength(-80))
      .force("collide", forceCollide<N>().radius((n) => n.r + 2))
      .stop();
    for (let i = 0; i < 300 && sim.alpha() > 0.01; i += 1) sim.tick();
  });

  bench("viewport culling pass (<5ms budget)", () => {
    // 1px-rect adaptation of viewportCulling.visibleSubset — mirrors GraphCanvas.
    const positions = new Float64Array(model.nodes.length * 2);
    for (let i = 0; i < model.nodes.length; i += 1) {
      positions[i * 2] = (i % 100) * 40;
      positions[i * 2 + 1] = Math.floor(i / 100) * 40;
    }
    const minX = 0;
    const minY = 0;
    const maxX = 800; // ~20% of the 4000px layout extent
    const maxY = 800;
    const visible = new Set<number>();
    for (let i = 0; i < model.nodes.length; i += 1) {
      const x = positions[i * 2];
      const y = positions[i * 2 + 1];
      if (x >= minX && x <= maxX && y >= minY && y <= maxY) visible.add(i);
    }
  });

  bench("insight pass — hidden links + bridges + orphans (<200ms budget)", () => {
    // Runs on demand (not per frame); this guards the O(Σd²) hidden-link scan
    // against blow-up at 2k nodes.
    findHiddenLinks(model);
    findBridges(model);
    findOrphans(model);
  });
});
