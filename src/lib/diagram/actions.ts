/**
 * Typed actions wrapping the diagram store.
 *
 * Each action is a pure transformer over {@link DiagramStateRoot}. UI handlers
 * call `store.setState(addNode(...))` rather than constructing the next state
 * inline. This keeps mutations centralized and trivially unit-testable.
 *
 * History coalescing: callers wrap mutating actions in
 * {@link withSnapshot} which snapshots the *previous* doc into `past` before
 * applying the change, modulo the per-mutation coalescer (drag continuations
 * skip the snapshot; drag-ends commit one).
 */

import {
  createCoalescer,
  redo as historyRedo,
  snapshot as historySnapshot,
  undo as historyUndo,
  type Coalescer,
} from "./history";
import { mkNode, type MkNodeOpts } from "./nodeKinds";
import type {
  DiagramEdge,
  DiagramNode,
  DiagramStateRoot,
  EdgePort,
  EphemeralState,
  NodeId,
  NodeKind,
  Tool,
  Viewport,
} from "./types";

export type StateTransformer = (state: DiagramStateRoot) => DiagramStateRoot;

interface SnapshotOpts {
  coalesce?: boolean;
  /** Optional clock injection (testing). */
  now?: () => number;
}

/**
 * Wrap a transformer so the *previous* doc is pushed to history.past before
 * the new state replaces it. Updates `updatedAt` on every commit.
 */
export function withSnapshot(
  inner: StateTransformer,
  coalescer: Coalescer,
  opts: SnapshotOpts = {},
): StateTransformer {
  return (state) => {
    const next = inner(state);
    if (next === state) return state;
    const now = opts.now ? opts.now() : Date.now();
    const shouldSnapshot = opts.coalesce ? coalescer.shouldSnapshot(now) : true;
    coalescer.reset(now);
    if (!shouldSnapshot) {
      return {
        ...next,
        doc: { ...next.doc, updatedAt: now },
      };
    }
    const past = historySnapshot(state.ephemeral.history, state.doc);
    return {
      doc: { ...next.doc, updatedAt: now },
      ephemeral: { ...next.ephemeral, history: past },
    };
  };
}

export function defaultCoalescer(): Coalescer {
  return createCoalescer(500);
}

export function addNode(
  kind: NodeKind,
  x: number,
  y: number,
  opts: MkNodeOpts = {},
): StateTransformer {
  return (state) => {
    const node = mkNode(kind, x, y, opts);
    return {
      ...state,
      doc: { ...state.doc, nodes: [...state.doc.nodes, node] },
      ephemeral: {
        ...state.ephemeral,
        selection: { nodes: new Set([node.id]), edges: new Set() },
      },
    };
  };
}

export function removeNodes(ids: Iterable<NodeId>): StateTransformer {
  return (state) => {
    const set = new Set(ids);
    if (set.size === 0) return state;
    const nodes = state.doc.nodes.filter((n) => !set.has(n.id));
    const edges = state.doc.edges.filter((e) => !set.has(e.fromNode) && !set.has(e.toNode));
    return {
      ...state,
      doc: { ...state.doc, nodes, edges },
      ephemeral: {
        ...state.ephemeral,
        selection: { nodes: new Set(), edges: new Set() },
      },
    };
  };
}

export function moveNodes(
  ids: Iterable<NodeId>,
  dx: number,
  dy: number,
): StateTransformer {
  return (state) => {
    if (dx === 0 && dy === 0) return state;
    const set = new Set(ids);
    if (set.size === 0) return state;
    const nodes = state.doc.nodes.map((n) =>
      set.has(n.id) ? { ...n, x: n.x + dx, y: n.y + dy } : n,
    );
    return { ...state, doc: { ...state.doc, nodes } };
  };
}

export function updateNode(
  id: NodeId,
  patch: Partial<DiagramNode>,
): StateTransformer {
  return (state) => {
    const nodes = state.doc.nodes.map((n) => (n.id === id ? { ...n, ...patch } : n));
    return { ...state, doc: { ...state.doc, nodes } };
  };
}

export function addEdge(edge: DiagramEdge): StateTransformer {
  return (state) => ({
    ...state,
    doc: { ...state.doc, edges: [...state.doc.edges, edge] },
  });
}

export function removeEdges(ids: Iterable<string>): StateTransformer {
  return (state) => {
    const set = new Set(ids);
    if (set.size === 0) return state;
    const edges = state.doc.edges.filter((e) => !set.has(e.id));
    return { ...state, doc: { ...state.doc, edges } };
  };
}

export function setSelection(
  nodes: Iterable<NodeId>,
  edges: Iterable<string> = [],
): StateTransformer {
  return (state) => ({
    ...state,
    ephemeral: {
      ...state.ephemeral,
      selection: { nodes: new Set(nodes), edges: new Set(edges) },
    },
  });
}

export function setViewport(viewport: Viewport): StateTransformer {
  return (state) => ({
    ...state,
    ephemeral: { ...state.ephemeral, viewport },
  });
}

export function setTool(tool: Tool): StateTransformer {
  return (state) => ({
    ...state,
    ephemeral: { ...state.ephemeral, tool },
  });
}

export function setSnapSize(size: number): StateTransformer {
  const clamped = Math.max(1, Math.min(200, Math.round(size)));
  return (state) => ({
    ...state,
    ephemeral: {
      ...state.ephemeral,
      ui: { ...state.ephemeral.ui, snapSize: clamped },
    },
  });
}

export function toggleSnap(value?: boolean): StateTransformer {
  return (state) => ({
    ...state,
    ephemeral: {
      ...state.ephemeral,
      ui: { ...state.ephemeral.ui, snapOn: value ?? !state.ephemeral.ui.snapOn },
    },
  });
}

export function toggleSmartGuides(value?: boolean): StateTransformer {
  return (state) => ({
    ...state,
    ephemeral: {
      ...state.ephemeral,
      ui: { ...state.ephemeral.ui, smartGuideOn: value ?? !state.ephemeral.ui.smartGuideOn },
    },
  });
}

export function setDocTitle(docTitle: string): StateTransformer {
  return (state) => ({
    ...state,
    doc: { ...state.doc, docTitle },
  });
}

export function replaceDoc(doc: DiagramStateRoot["doc"]): StateTransformer {
  return (state) => ({
    ...state,
    doc,
    ephemeral: {
      ...state.ephemeral,
      selection: { nodes: new Set(), edges: new Set() },
      history: { past: [], future: [] },
    } satisfies EphemeralState,
  });
}

export function undo(): StateTransformer {
  return (state) => {
    const next = historyUndo(state.ephemeral.history, state.doc);
    if (!next) return state;
    return {
      doc: next.doc,
      ephemeral: { ...state.ephemeral, history: next.history },
    };
  };
}

export function redo(): StateTransformer {
  return (state) => {
    const next = historyRedo(state.ephemeral.history, state.doc);
    if (!next) return state;
    return {
      doc: next.doc,
      ephemeral: { ...state.ephemeral, history: next.history },
    };
  };
}

export function startPendingConnect(
  fromNodeId: NodeId,
  fromPort: EdgePort,
): StateTransformer {
  return (state) => ({
    ...state,
    ephemeral: {
      ...state.ephemeral,
      pendingConnect: { fromNodeId, fromPort },
    },
  });
}

export function clearPendingConnect(): StateTransformer {
  return (state) => ({
    ...state,
    ephemeral: { ...state.ephemeral, pendingConnect: null },
  });
}
