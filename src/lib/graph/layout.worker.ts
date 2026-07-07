// d3-force layout worker (maru-vault-graph-spec §2.2). The simulation lives
// here so the main thread never blocks: init pre-runs to alpha<0.01 (or
// ~300 ticks) and streams throttled positions; drag re-heats locally with
// alphaTarget(0.3). Positions are session memory only.
// ponytail: pin 사용이 잦아지면 .anchor/cache/graph-layout.json 영속화.

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
      type: "init";
      nodes: LayoutNodeInput[];
      edges: LayoutEdgeInput[];
      width: number;
      height: number;
    }
  | { type: "dragStart"; index: number }
  | { type: "dragMove"; index: number; x: number; y: number }
  | { type: "dragEnd"; index: number }
  | { type: "unpin"; index: number }
  | { type: "reheat" };

export type LayoutResponse =
  | { type: "tick"; positions: Float64Array }
  | { type: "done"; positions: Float64Array };

interface SimNode extends SimulationNodeDatum {
  index?: number;
  radius: number;
  community: number | null;
}

const MAX_INIT_TICKS = 300;
const ALPHA_MIN = 0.01;
const TICKS_PER_POST = 3;

let simulation: Simulation<SimNode, SimulationLinkDatum<SimNode>> | null = null;
let simNodes: SimNode[] = [];

function positionsArray(): Float64Array {
  const out = new Float64Array(simNodes.length * 2);
  for (let i = 0; i < simNodes.length; i += 1) {
    out[i * 2] = simNodes[i].x ?? 0;
    out[i * 2 + 1] = simNodes[i].y ?? 0;
  }
  return out;
}

function post(message: LayoutResponse, transfer?: Transferable[]) {
  (self as unknown as Worker).postMessage(message, transfer ?? []);
}

function seedPositions(
  nodes: SimNode[],
  width: number,
  height: number,
): void {
  // Circular community seeding + jitter: nodes of a community start near a
  // shared centroid so the force layout converges into visible clusters.
  const communities = [...new Set(nodes.map((n) => n.community))];
  const centerX = width / 2;
  const centerY = height / 2;
  // Single community (or none) seeds at the center — a 1-point "ring" would
  // otherwise park the whole graph at the ring edge, off-viewport.
  const ringRadius = communities.length > 1 ? Math.min(width, height) / 3 : 0;
  const centroid = new Map<number | null, { x: number; y: number }>();
  communities.forEach((community, i) => {
    const angle = (2 * Math.PI * i) / Math.max(communities.length, 1);
    centroid.set(community, {
      x: centerX + ringRadius * Math.cos(angle),
      y: centerY + ringRadius * Math.sin(angle),
    });
  });
  for (const node of nodes) {
    const c = centroid.get(node.community) ?? { x: centerX, y: centerY };
    node.x = c.x + (Math.random() - 0.5) * 80;
    node.y = c.y + (Math.random() - 0.5) * 80;
  }
  // Store centroids on nodes for forceX/Y access.
  for (const node of nodes) {
    const c = centroid.get(node.community) ?? { x: centerX, y: centerY };
    (node as SimNode & { cx: number; cy: number }).cx = c.x;
    (node as SimNode & { cx: number; cy: number }).cy = c.y;
  }
}

function initSimulation(
  nodes: LayoutNodeInput[],
  edges: LayoutEdgeInput[],
  width: number,
  height: number,
): void {
  simulation?.stop();
  simNodes = nodes.map((n, index) => ({
    index,
    radius: n.radius,
    community: n.community,
  }));
  seedPositions(simNodes, width, height);

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
    .force(
      "collide",
      forceCollide<SimNode>().radius((n) => n.radius + 2),
    )
    .force(
      "x",
      forceX<SimNode>((n) => (n as SimNode & { cx?: number }).cx ?? width / 2).strength(0.05),
    )
    .force(
      "y",
      forceY<SimNode>((n) => (n as SimNode & { cy?: number }).cy ?? height / 2).strength(0.05),
    )
    .stop();

  // Pre-run: tick synchronously, streaming throttled positions so the UI can
  // show layout progress, then post the final frame.
  let ticks = 0;
  while (ticks < MAX_INIT_TICKS && simulation.alpha() > ALPHA_MIN) {
    simulation.tick();
    ticks += 1;
    if (ticks % (TICKS_PER_POST * 10) === 0) {
      post({ type: "tick", positions: positionsArray() });
    }
  }
  const final = positionsArray();
  post({ type: "done", positions: final }, [final.buffer]);

  // After pre-run, keep ticking on demand (drag re-heat) via d3's own timer.
  simulation.on("tick", () => {
    const stamp = (simulation as unknown as { __tickCount?: number }) ?? {};
    stamp.__tickCount = (stamp.__tickCount ?? 0) + 1;
    if (stamp.__tickCount % TICKS_PER_POST === 0) {
      post({ type: "tick", positions: positionsArray() });
    }
  });
  simulation.on("end", () => {
    post({ type: "done", positions: positionsArray() });
  });
}

self.onmessage = (event: MessageEvent<LayoutRequest>) => {
  const message = event.data;
  switch (message.type) {
    case "init":
      initSimulation(message.nodes, message.edges, message.width, message.height);
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
