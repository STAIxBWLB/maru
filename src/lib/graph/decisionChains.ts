// Decision-chain lanes (maru-vault-graph-spec §3 F3(c)). Deterministic — NOT
// force-directed: supersedes edges group type=decision notes into chains,
// each chain renders as one horizontal timeline lane (oldest → newest);
// isolated decisions go to a side rail.

import type { GraphModel, GraphNode } from "./model";

export interface DecisionChain {
  /** Chain members, date ascending (nulls last, id tiebreak). */
  nodes: GraphNode[];
}

export interface DecisionChainLayout {
  chains: DecisionChain[];
  /** Decisions with no supersedes relation — side rail, date descending. */
  isolated: GraphNode[];
}

const SUPERSEDES_RELATIONS = new Set(["supersedes", "superseded_by"]);

function compareByDate(a: GraphNode, b: GraphNode): number {
  if (a.date && b.date) return a.date.localeCompare(b.date) || a.id.localeCompare(b.id);
  if (a.date) return -1;
  if (b.date) return 1;
  return a.id.localeCompare(b.id);
}

/** Group decision notes into supersedes chains. Cycle-safe: connected
 *  components over the (undirected) supersedes relation, so a malformed
 *  A→B→A loop still terminates and lands in one chain. */
export function buildDecisionChains(model: GraphModel): DecisionChainLayout {
  const decisions = new Map(
    model.nodes.filter((n) => n.type === "decision").map((n) => [n.id, n]),
  );

  const adjacency = new Map<string, Set<string>>();
  for (const edge of model.edges) {
    if (!SUPERSEDES_RELATIONS.has(edge.relation)) continue;
    if (!decisions.has(edge.source) || !decisions.has(edge.target)) continue;
    (adjacency.get(edge.source) ?? adjacency.set(edge.source, new Set()).get(edge.source)!)
      .add(edge.target);
    (adjacency.get(edge.target) ?? adjacency.set(edge.target, new Set()).get(edge.target)!)
      .add(edge.source);
  }

  const visited = new Set<string>();
  const chains: DecisionChain[] = [];
  for (const id of adjacency.keys()) {
    if (visited.has(id)) continue;
    const members: GraphNode[] = [];
    const stack = [id];
    while (stack.length > 0) {
      const current = stack.pop()!;
      if (visited.has(current)) continue; // cycle guard
      visited.add(current);
      const node = decisions.get(current);
      if (node) members.push(node);
      for (const neighbor of adjacency.get(current) ?? []) {
        if (!visited.has(neighbor)) stack.push(neighbor);
      }
    }
    if (members.length > 1) {
      chains.push({ nodes: members.sort(compareByDate) });
    } else if (members.length === 1) {
      // A supersedes edge whose partner isn't a decision note — treat as isolated.
      visited.add(members[0].id);
    }
  }

  const isolated = [...decisions.values()]
    .filter((n) => !chains.some((chain) => chain.nodes.some((m) => m.id === n.id)))
    .sort((a, b) => compareByDate(b, a));

  chains.sort(
    (a, b) => compareByDate(b.nodes[b.nodes.length - 1], a.nodes[a.nodes.length - 1]),
  );
  return { chains, isolated };
}
