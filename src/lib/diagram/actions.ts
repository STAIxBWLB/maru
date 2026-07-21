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
  alignNodes,
  distributeNodes,
  equalizeSize,
  type AlignMode,
  type DistributeAxis,
  type EqualizeAxis,
} from "./alignment";
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
  EdgeId,
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
    const removable = new Set(
      state.doc.nodes.filter((n) => set.has(n.id) && !n.locked).map((n) => n.id),
    );
    if (removable.size === 0) return state;
    const nodes = state.doc.nodes.filter((n) => !removable.has(n.id));
    const edges = state.doc.edges.filter((e) => !removable.has(e.fromNode) && !removable.has(e.toNode));
    return {
      ...state,
      doc: { ...state.doc, nodes, edges },
      ephemeral: {
        ...state.ephemeral,
        selection: {
          nodes: new Set([...state.ephemeral.selection.nodes].filter((id) => !removable.has(id))),
          edges: new Set(),
        },
        tableSelection:
          state.ephemeral.tableSelection && !removable.has(state.ephemeral.tableSelection.nodeId)
            ? state.ephemeral.tableSelection
            : null,
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
    let changed = false;
    const nodes = state.doc.nodes.map((n) =>
      set.has(n.id) && !n.locked
        ? (changed = true, { ...n, x: n.x + dx, y: n.y + dy })
        : n,
    );
    if (!changed) return state;
    return { ...state, doc: { ...state.doc, nodes } };
  };
}

function lockedNodePatchAllowed(patch: Partial<DiagramNode>): boolean {
  return Object.keys(patch).every((key) => key === "locked" || key === "hidden");
}

export function updateNode(
  id: NodeId,
  patch: Partial<DiagramNode>,
): StateTransformer {
  return (state) => {
    let changed = false;
    const nodes = state.doc.nodes.map((n) => {
      if (n.id !== id) return n;
      if (n.locked && !lockedNodePatchAllowed(patch)) return n;
      changed = true;
      return { ...n, ...patch };
    });
    if (!changed) return state;
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
  return (state) => {
    const nextNodes = new Set(nodes);
    // A table's cell selection is only meaningful while its node is selected.
    const tableSelection =
      state.ephemeral.tableSelection && nextNodes.has(state.ephemeral.tableSelection.nodeId)
        ? state.ephemeral.tableSelection
        : null;
    return {
      ...state,
      ephemeral: {
        ...state.ephemeral,
        selection: { nodes: nextNodes, edges: new Set(edges) },
        tableSelection,
      },
    };
  };
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

export function toggleFocusMode(value?: boolean): StateTransformer {
  return (state) => ({
    ...state,
    ephemeral: {
      ...state.ephemeral,
      ui: { ...state.ephemeral.ui, focusMode: value ?? !state.ephemeral.ui.focusMode },
    },
  });
}

export function nudgeSelection(dx: number, dy: number): StateTransformer {
  return (state) => {
    const ids = state.ephemeral.selection.nodes;
    if (ids.size === 0 || (dx === 0 && dy === 0)) return state;
    let changed = false;
    const nodes = state.doc.nodes.map((n) =>
      ids.has(n.id) && !n.locked
        ? (changed = true, { ...n, x: n.x + dx, y: n.y + dy })
        : n,
    );
    if (!changed) return state;
    return { ...state, doc: { ...state.doc, nodes } };
  };
}

export function selectAllNodes(): StateTransformer {
  return (state) => ({
    ...state,
    ephemeral: {
      ...state.ephemeral,
      selection: {
        nodes: new Set(state.doc.nodes.map((n) => n.id)),
        edges: new Set(),
      },
    },
  });
}

function newId(prefix: string): string {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
    return `${prefix}-${crypto.randomUUID().slice(0, 8)}`;
  }
  return `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
}

export function duplicateSelection(offsetX = 24, offsetY = 24): StateTransformer {
  return (state) => {
    const selectedIds = state.ephemeral.selection.nodes;
    if (selectedIds.size === 0) return state;
    const idMap = new Map<NodeId, NodeId>();
    const cloned: DiagramNode[] = [];
    for (const node of state.doc.nodes) {
      if (!selectedIds.has(node.id)) continue;
      if (node.locked) continue;
      const nextId = newId("node");
      idMap.set(node.id, nextId);
      cloned.push({ ...node, id: nextId, x: node.x + offsetX, y: node.y + offsetY });
    }
    if (cloned.length === 0) return state;
    const clonedEdges: DiagramEdge[] = [];
    for (const edge of state.doc.edges) {
      const fromMapped = idMap.get(edge.fromNode);
      const toMapped = idMap.get(edge.toNode);
      if (fromMapped && toMapped) {
        clonedEdges.push({
          ...edge,
          id: newId("edge"),
          fromNode: fromMapped,
          toNode: toMapped,
        });
      }
    }
    return {
      ...state,
      doc: {
        ...state.doc,
        nodes: [...state.doc.nodes, ...cloned],
        edges: [...state.doc.edges, ...clonedEdges],
      },
      ephemeral: {
        ...state.ephemeral,
        selection: {
          nodes: new Set(cloned.map((n) => n.id)),
          edges: new Set(),
        },
      },
    };
  };
}

export function setNodeMeta(id: NodeId, patch: Record<string, unknown>): StateTransformer {
  return (state) => {
    let changed = false;
    const nodes = state.doc.nodes.map((n) => {
      if (n.id !== id || n.locked) return n;
      changed = true;
      return { ...n, meta: { ...(n.meta ?? {}), ...patch } };
    });
    if (!changed) return state;
    return { ...state, doc: { ...state.doc, nodes } };
  };
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
      tableSelection: null,
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

// ============================================================================
// Selection ops (Phase 3)
// ============================================================================

function unlockedNodeIds(state: DiagramStateRoot): Set<NodeId> {
  return new Set(
    state.doc.nodes
      .filter((node) => state.ephemeral.selection.nodes.has(node.id) && !node.locked)
      .map((node) => node.id),
  );
}

export function alignSelection(mode: AlignMode): StateTransformer {
  return (state) => {
    const ids = unlockedNodeIds(state);
    if (ids.size < 2) return state;
    const nodes = alignNodes(state.doc.nodes, ids, mode);
    if (nodes === state.doc.nodes) return state;
    return { ...state, doc: { ...state.doc, nodes } };
  };
}

export function distributeSelection(axis: DistributeAxis): StateTransformer {
  return (state) => {
    const ids = unlockedNodeIds(state);
    if (ids.size < 3) return state;
    const nodes = distributeNodes(state.doc.nodes, ids, axis);
    if (nodes === state.doc.nodes) return state;
    return { ...state, doc: { ...state.doc, nodes } };
  };
}

export function equalizeSelection(axis: EqualizeAxis): StateTransformer {
  return (state) => {
    const ids = unlockedNodeIds(state);
    if (ids.size < 2) return state;
    const nodes = equalizeSize(state.doc.nodes, ids, axis);
    if (nodes === state.doc.nodes) return state;
    return { ...state, doc: { ...state.doc, nodes } };
  };
}

// ============================================================================
// Z-order (Phase 3)
// ============================================================================

function reorderNodes(
  nodes: DiagramNode[],
  ids: Set<NodeId>,
  mode: "front" | "back" | "forward" | "backward",
): DiagramNode[] {
  const unlockedIds = new Set(nodes.filter((n) => ids.has(n.id) && !n.locked).map((n) => n.id));
  if (unlockedIds.size === 0) return nodes;
  if (mode === "front") {
    const moved = nodes.filter((n) => unlockedIds.has(n.id));
    const rest = nodes.filter((n) => !unlockedIds.has(n.id));
    return [...rest, ...moved];
  }
  if (mode === "back") {
    const moved = nodes.filter((n) => unlockedIds.has(n.id));
    const rest = nodes.filter((n) => !unlockedIds.has(n.id));
    return [...moved, ...rest];
  }
  // forward / backward = one step
  const out = [...nodes];
  if (mode === "forward") {
    // iterate from end to start to avoid stepping on already-moved entries
    for (let i = out.length - 2; i >= 0; i -= 1) {
      if (unlockedIds.has(out[i]!.id) && !unlockedIds.has(out[i + 1]!.id)) {
        [out[i], out[i + 1]] = [out[i + 1]!, out[i]!];
      }
    }
  } else {
    for (let i = 1; i < out.length; i += 1) {
      if (unlockedIds.has(out[i]!.id) && !unlockedIds.has(out[i - 1]!.id)) {
        [out[i], out[i - 1]] = [out[i - 1]!, out[i]!];
      }
    }
  }
  return out;
}

export function bringToFront(): StateTransformer {
  return (state) => {
    const ids = state.ephemeral.selection.nodes;
    if (ids.size === 0) return state;
    return { ...state, doc: { ...state.doc, nodes: reorderNodes(state.doc.nodes, ids, "front") } };
  };
}

export function sendToBack(): StateTransformer {
  return (state) => {
    const ids = state.ephemeral.selection.nodes;
    if (ids.size === 0) return state;
    return { ...state, doc: { ...state.doc, nodes: reorderNodes(state.doc.nodes, ids, "back") } };
  };
}

export function bringForward(): StateTransformer {
  return (state) => {
    const ids = state.ephemeral.selection.nodes;
    if (ids.size === 0) return state;
    return { ...state, doc: { ...state.doc, nodes: reorderNodes(state.doc.nodes, ids, "forward") } };
  };
}

export function sendBackward(): StateTransformer {
  return (state) => {
    const ids = state.ephemeral.selection.nodes;
    if (ids.size === 0) return state;
    return { ...state, doc: { ...state.doc, nodes: reorderNodes(state.doc.nodes, ids, "backward") } };
  };
}

/** Move one node to a specific index (drag-reorder in the layers panel). */
export function moveNodeToIndex(nodeId: NodeId, toIndex: number): StateTransformer {
  return (state) => {
    const current = state.doc.nodes;
    const fromIndex = current.findIndex((n) => n.id === nodeId);
    if (fromIndex < 0) return state;
    if (current[fromIndex]?.locked) return state;
    const clamped = Math.max(0, Math.min(current.length - 1, toIndex));
    if (clamped === fromIndex) return state;
    const next = [...current];
    const [item] = next.splice(fromIndex, 1);
    if (!item) return state;
    next.splice(clamped, 0, item);
    return { ...state, doc: { ...state.doc, nodes: next } };
  };
}

// ============================================================================
// Lock / hide (Phase 3)
// ============================================================================

export function setNodeLocked(id: NodeId, locked: boolean): StateTransformer {
  return updateNode(id, { locked });
}

export function setNodeHidden(id: NodeId, hidden: boolean): StateTransformer {
  return updateNode(id, { hidden });
}

// ============================================================================
// Style copy / paste (Phase 3)
// ============================================================================

const STYLE_KEYS: Array<keyof NonNullable<DiagramNode["style"]>> = [
  "bg",
  "border",
  "fc",
  "bw",
  "br",
  "fs",
  "fw",
  "align",
];

/**
 * Snapshot the style of a single node into a string-keyed object that callers
 * keep in their own state (we deliberately keep styleClipboard *outside* the
 * store so it survives undo/redo and doesn't enlarge the history snapshot).
 */
export function pickStyle(node: DiagramNode): DiagramNode["style"] {
  const out: Record<string, unknown> = {};
  if (!node.style) return undefined;
  for (const key of STYLE_KEYS) {
    if (node.style[key] !== undefined) out[key] = node.style[key];
  }
  return out as DiagramNode["style"];
}

/** Paste a style onto every selected node (merging on top of any existing style). */
export function pasteStyleToSelection(style: DiagramNode["style"]): StateTransformer {
  return (state) => {
    const ids = state.ephemeral.selection.nodes;
    if (!style || ids.size === 0) return state;
    let changed = false;
    const nodes = state.doc.nodes.map((n) => {
      if (!ids.has(n.id) || n.locked) return n;
      changed = true;
      return { ...n, style: { ...n.style, ...style } };
    });
    if (!changed) return state;
    return { ...state, doc: { ...state.doc, nodes } };
  };
}

export function updateEdge(
  id: EdgeId,
  patch: Partial<DiagramEdge>,
): StateTransformer {
  return (state) => {
    const edges = state.doc.edges.map((e) => (e.id === id ? { ...e, ...patch } : e));
    return { ...state, doc: { ...state.doc, edges } };
  };
}
