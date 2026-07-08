// d3-force layout worker (maru-vault-graph-spec §2.2). The simulation lives
// here so the main thread never blocks.
//
// The worker is created ONCE per GraphView mount and reused across filter
// changes via `update` messages (no terminate/recreate). It keeps a per-id
// position store so surviving nodes warm-start from their last position
// instead of re-randomizing every time — the graph nudges to a new layout
// instead of exploding. `epoch` round-trips so the main thread can discard
// stale frames. An optional `seed` (restored from .maru/cache/graph-layout.json)
// primes the very first layout with the last session's positions.

import {
  forceCollide,
  forceLink,
  forceManyBody,
  forceSimulation,
  forceX,
  forceY,
  type Simulation,
  type SimulationLinkDatum,
  type SimulationNodeDatum,
} from "d3-force";

export interface LayoutNodeInput {
  /** Stable node id — keys the warm-start position store. */
  id: string;
  /** Index-aligned with the positions array. */
  radius: number;
  community: number | null;
}

export interface LayoutEdgeInput {
  source: number;
  target: number;
  fromFrontmatter: boolean;
}

export type LayoutRequest =
  | {
      type: "update";
      epoch: number;
      nodes: LayoutNodeInput[];
      edges: LayoutEdgeInput[];
      width: number;
      height: number;
      /** Optional restored positions (id → [x, y]) for a cold warm-start. */
      seed?: Record<string, [number, number]>;
    }
  | { type: "dragStart"; index: number }
  | { type: "dragMove"; index: number; x: number; y: number }
  | { type: "dragEnd"; index: number }
  | { type: "unpin"; index: number }
  | { type: "reheat" };

export type LayoutResponse =
  | { type: "tick"; epoch: number; positions: Float64Array }
  | { type: "done"; epoch: number; positions: Float64Array };

interface SimNode extends SimulationNodeDatum {
  index?: number;
  id: string;
  radius: number;
  community: number | null;
  cx?: number;
  cy?: number;
}

const MAX_COLD_TICKS = 300;
const MAX_WARM_TICKS = 140;
const ALPHA_MIN = 0.01;
const WARM_ALPHA = 0.55;
const TICKS_PER_POST = 3;

let simulation: Simulation<SimNode, SimulationLinkDatum<SimNode>> | null = null;
let simNodes: SimNode[] = [];
let currentEpoch = 0;
/** Last settled position per node id — survives filter changes for warm-start. */
const positionStore = new Map<string, { x: number; y: number }>();

function positionsArray(): Float64Array {
  const out = new Float64Array(simNodes.length * 2);
  for (let i = 0; i < simNodes.length; i += 1) {
    out[i * 2] = simNodes[i].x ?? 0;
    out[i * 2 + 1] = simNodes[i].y ?? 0;
  }
  return out;
}

/** Persist current positions back to the store so the next update warm-starts. */
function syncStore(): void {
  for (const node of simNodes) {
    if (node.x != null && node.y != null) {
      positionStore.set(node.id, { x: node.x, y: node.y });
    }
  }
}

function post(message: LayoutResponse, transfer?: Transferable[]) {
  (self as unknown as Worker).postMessage(message, transfer ?? []);
}

function communityCentroids(
  nodes: SimNode[],
  width: number,
  height: number,
): Map<number | null, { x: number; y: number }> {
  const communities = [...new Set(nodes.map((n) => n.community))];
  const centerX = width / 2;
  const centerY = height / 2;
  // A single community (or none) seeds at center — a 1-point "ring" would park
  // the whole graph off-viewport at the ring edge.
  const ringRadius = communities.length > 1 ? Math.min(width, height) / 3 : 0;
  const centroid = new Map<number | null, { x: number; y: number }>();
  communities.forEach((community, i) => {
    const angle = (2 * Math.PI * i) / Math.max(communities.length, 1);
    centroid.set(community, {
      x: centerX + ringRadius * Math.cos(angle),
      y: centerY + ringRadius * Math.sin(angle),
    });
  });
  return centroid;
}

function updateSimulation(
  nodes: LayoutNodeInput[],
  edges: LayoutEdgeInput[],
  width: number,
  height: number,
  seed?: Record<string, [number, number]>,
): void {
  simulation?.stop();
  const hadPriorLayout = positionStore.size > 0 || (seed != null && Object.keys(seed).length > 0);

  simNodes = nodes.map((n, index) => ({
    index,
    id: n.id,
    radius: n.radius,
    community: n.community,
  }));

  const centroid = communityCentroids(simNodes, width, height);
  const centerX = width / 2;
  const centerY = height / 2;
  for (const node of simNodes) {
    const c = centroid.get(node.community) ?? { x: centerX, y: centerY };
    node.cx = c.x;
    node.cy = c.y;
    // Warm-start priority: live store → disk seed → community centroid + jitter.
    const prior = positionStore.get(node.id) ?? seedPoint(seed, node.id);
    if (prior) {
      node.x = prior.x;
      node.y = prior.y;
    } else {
      node.x = c.x + (Math.random() - 0.5) * 80;
      node.y = c.y + (Math.random() - 0.5) * 80;
    }
  }

  const links: (SimulationLinkDatum<SimNode> & { fromFrontmatter: boolean })[] =
    edges.map((e) => ({
      source: e.source,
      target: e.target,
      fromFrontmatter: e.fromFrontmatter,
    }));

  simulation = forceSimulation<SimNode>(simNodes)
    .force(
      "link",
      forceLink<SimNode, SimulationLinkDatum<SimNode> & { fromFrontmatter: boolean }>(
        links,
      ).distance((l) => (l.fromFrontmatter ? 40 : 60)),
    )
    .force("charge", forceManyBody().strength(-80))
    .force("collide", forceCollide<SimNode>().radius((n) => n.radius + 2))
    .force("x", forceX<SimNode>((n) => n.cx ?? centerX).strength(0.05))
    .force("y", forceY<SimNode>((n) => n.cy ?? centerY).strength(0.05))
    .stop();

  // Warm layouts start cooler and settle in fewer ticks (nodes already near
  // their final positions); cold layouts run the full anneal.
  const maxTicks = hadPriorLayout ? MAX_WARM_TICKS : MAX_COLD_TICKS;
  simulation.alpha(hadPriorLayout ? WARM_ALPHA : 1);

  let ticks = 0;
  while (ticks < maxTicks && simulation.alpha() > ALPHA_MIN) {
    simulation.tick();
    ticks += 1;
    if (ticks % (TICKS_PER_POST * 10) === 0) {
      post({ type: "tick", epoch: currentEpoch, positions: positionsArray() });
    }
  }
  syncStore();
  const final = positionsArray();
  post({ type: "done", epoch: currentEpoch, positions: final }, [final.buffer]);

  // Keep ticking on demand (drag re-heat) via d3's own timer.
  let tickCount = 0;
  simulation.on("tick", () => {
    tickCount += 1;
    if (tickCount % TICKS_PER_POST === 0) {
      post({ type: "tick", epoch: currentEpoch, positions: positionsArray() });
    }
  });
  simulation.on("end", () => {
    syncStore();
    post({ type: "done", epoch: currentEpoch, positions: positionsArray() });
  });
}

function seedPoint(
  seed: Record<string, [number, number]> | undefined,
  id: string,
): { x: number; y: number } | null {
  const p = seed?.[id];
  return p ? { x: p[0], y: p[1] } : null;
}

self.onmessage = (event: MessageEvent<LayoutRequest>) => {
  const message = event.data;
  switch (message.type) {
    case "update":
      currentEpoch = message.epoch;
      updateSimulation(message.nodes, message.edges, message.width, message.height, message.seed);
      break;
    case "dragStart": {
      if (!simulation) return;
      const node = simNodes[message.index];
      if (!node) return;
      node.fx = node.x;
      node.fy = node.y;
      simulation.alphaTarget(0.3).restart();
      break;
    }
    case "dragMove": {
      const node = simNodes[message.index];
      if (!node) return;
      node.fx = message.x;
      node.fy = message.y;
      break;
    }
    case "dragEnd": {
      if (!simulation) return;
      simulation.alphaTarget(0);
      syncStore();
      // Keep fx/fy — drag pins the node (double-click unpins).
      break;
    }
    case "unpin": {
      const node = simNodes[message.index];
      if (!node) return;
      node.fx = null;
      node.fy = null;
      simulation?.alpha(0.3).restart();
      break;
    }
    case "reheat": {
      if (!simulation) return;
      for (const node of simNodes) {
        node.fx = null;
        node.fy = null;
      }
      simulation.alpha(1).restart();
      break;
    }
  }
};
