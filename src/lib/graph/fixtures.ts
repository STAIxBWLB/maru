// Deterministic seeded graph fixtures — shared by the perf bench, the derive
// unit tests, and the web-mode e2e dense-vault mock (api.ts scanVault hook).
// Seeded PRNG keeps benches and e2e runs reproducible.

import type { VaultEntry } from "../types";

function mulberry32(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const TYPES = ["insight", "decision", "observation", "person", "meeting", "reference"];
const DOMAINS = ["research", "projects", "operations", "teaching", "people", "ai-practice"];

/** `nodeCount` markdown notes with ~`edgeCount/nodeCount` outgoing body links
 *  each (random targets, self-links skipped). A fifth of the notes carry a
 *  frontmatter `topics` wikilink so relation facets are non-trivial. */
export function generateGraphEntries(
  nodeCount: number,
  edgeCount: number,
  seed = 42,
  rootPath = "/vault",
): VaultEntry[] {
  const rand = mulberry32(seed);
  const outDegree = Math.max(1, Math.round(edgeCount / Math.max(1, nodeCount)));
  const entries: VaultEntry[] = [];
  for (let i = 0; i < nodeCount; i += 1) {
    const links: string[] = [];
    for (let l = 0; l < outDegree; l += 1) {
      const target = Math.floor(rand() * nodeCount);
      if (target !== i) links.push(`note-${target}`);
    }
    const frontmatter: Record<string, unknown> = {
      type: TYPES[i % TYPES.length],
      domain: DOMAINS[i % DOMAINS.length],
    };
    if (i % 5 === 0 && nodeCount > 1) {
      frontmatter.topics = [`[[note-${(i + 1) % nodeCount}]]`];
    }
    entries.push({
      path: `${rootPath}/notes/note-${i}.md`,
      relPath: `notes/note-${i}.md`,
      title: `note-${i}`,
      frontmatter,
      updatedAt: null,
      wordCount: 100,
      snippet: "",
      fileKind: "md",
      versionCount: 0,
      links,
    });
  }
  return entries;
}

/** Named presets. `filtered-empty` is not a fixture — it is a derive state
 *  (any non-empty model + filters that exclude everything). */
export const GRAPH_FIXTURES = {
  tiny: () => generateGraphEntries(4, 3),
  empty: (): VaultEntry[] => [],
  dense: () => generateGraphEntries(1_200, 6_000),
  stress: () => generateGraphEntries(10_000, 50_000),
} as const;

/** Web-mode e2e dense vault (opt-in via the "maru:e2e:graph-dense" flag). */
export function denseMockEntries(rootPath: string): VaultEntry[] {
  return generateGraphEntries(1_200, 6_000, 42, rootPath);
}
