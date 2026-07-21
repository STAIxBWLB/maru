/**
 * Table (matrix) store actions — typed StateTransformers over
 * `DiagramStateRoot`, mirroring the conventions in `actions.ts`.
 *
 * Structural ops (insert/delete/merge/split) are thin wrappers around the
 * pure `reportTypes` helpers: callers pre-compute the next matrix with the
 * pure function first so thrown errors (span anchors, non-rectangular
 * merges) surface before any state mutation, then dispatch
 * `updateMatrix(datasetId, () => next)` wrapped in `withSnapshot` — one
 * gesture, one undo entry.
 *
 * Lock rule: edits to a dataset whose linked table node (`meta.memberId`) is
 * locked are silently ignored, matching `updateNode`'s locked-node rule.
 */

import type { StateTransformer } from "./actions";
import { mkNode } from "./nodeKinds";
import {
  TABLE_PATTERN_ID,
  computeProjectionHash,
  createDatasetId,
  createPatternViewId,
  matrixFromRowsCols,
  type MatrixCellStyle,
  type MatrixDataset,
  type MatrixRowRole,
  type PatternView,
  type ReportDataset,
  type SemanticTag,
} from "./reportTypes";
import { applyCellStylePatch, pasteTextGridAt } from "./tableEditing";
import type {
  DiagramEdge,
  DiagramNode,
  DiagramPageFormat,
  NodeId,
  TableCellAddress,
  TableSelection,
} from "./types";

// ---------------------------------------------------------------------------
// Lookup helpers
// ---------------------------------------------------------------------------

export function findMatrixDataset(
  datasets: { id: string; kind: string }[] | undefined,
  datasetId: unknown,
): MatrixDataset | null {
  if (typeof datasetId !== "string" || !Array.isArray(datasets)) return null;
  const found = datasets.find((ds) => ds.id === datasetId && ds.kind === "matrix");
  return found ? (found as MatrixDataset) : null;
}

/** Matrix dataset linked to a table node via `meta.memberId` (set by migration/addTableNode). */
export function matrixForTableNode(
  node: DiagramNode | undefined,
  datasets: { id: string; kind: string }[] | undefined,
): MatrixDataset | null {
  if (!node || node.kind !== "table" || !node.meta) return null;
  return findMatrixDataset(datasets, (node.meta as Record<string, unknown>).memberId);
}

function isDatasetLocked(state: Parameters<StateTransformer>[0], datasetId: string): boolean {
  return state.doc.nodes.some(
    (node) =>
      node.locked &&
      node.meta !== undefined &&
      (node.meta as Record<string, unknown>).memberId === datasetId,
  );
}

// ---------------------------------------------------------------------------
// Generic matrix update
// ---------------------------------------------------------------------------

/** Apply `fn` to one matrix dataset; no-op when the dataset is missing/locked/unchanged. */
export function updateMatrix(
  datasetId: string,
  fn: (matrix: MatrixDataset) => MatrixDataset,
): StateTransformer {
  return (state) => {
    if (isDatasetLocked(state, datasetId)) return state;
    const datasets = state.doc.datasets ?? [];
    let changed = false;
    const next = datasets.map((ds) => {
      if (ds.id !== datasetId || ds.kind !== "matrix") return ds;
      const updated = fn(ds as MatrixDataset);
      if (updated !== ds) changed = true;
      return updated;
    });
    if (!changed) return state;
    return { ...state, doc: { ...state.doc, datasets: next } };
  };
}

// ---------------------------------------------------------------------------
// Node creation (linked dataset + pattern view, like the v7→v8 migration)
// ---------------------------------------------------------------------------

export function addTableNode(
  x: number,
  y: number,
  rowCount = 3,
  colCount = 3,
): StateTransformer {
  return (state) => {
    const node = mkNode("table", x, y);
    const dataset = matrixFromRowsCols(rowCount, colCount, { id: createDatasetId() });
    const view: PatternView = {
      id: createPatternViewId(),
      datasetId: dataset.id,
      patternId: TABLE_PATTERN_ID,
      bounds: { x: node.x, y: node.y, w: node.w, h: node.h },
      nodeIds: [node.id],
      edgeIds: [],
      projectionHash: computeProjectionHash({
        patternId: TABLE_PATTERN_ID,
        dataset,
        bounds: { x: node.x, y: node.y, w: node.w, h: node.h },
      }),
    };
    const linked: DiagramNode = {
      ...node,
      meta: { ...(node.meta ?? {}), viewId: view.id, memberId: dataset.id },
    };
    return {
      ...state,
      doc: {
        ...state.doc,
        nodes: [...state.doc.nodes, linked],
        datasets: [...(state.doc.datasets ?? []), dataset],
        views: [...(state.doc.views ?? []), view],
      },
      ephemeral: {
        ...state.ephemeral,
        selection: { nodes: new Set([linked.id]), edges: new Set() },
        tableSelection: null,
      },
    };
  };
}

// ---------------------------------------------------------------------------
// Selection (ephemeral — never snapshotted)
// ---------------------------------------------------------------------------

export function setTableSelection(selection: TableSelection | null): StateTransformer {
  return (state) => ({
    ...state,
    ephemeral: { ...state.ephemeral, tableSelection: selection },
  });
}

// ---------------------------------------------------------------------------
// Cell content + style
// ---------------------------------------------------------------------------

export function setCellText(
  datasetId: string,
  cellId: string,
  text: string,
): StateTransformer {
  return updateMatrix(datasetId, (matrix) => {
    const cell = matrix.cells[cellId];
    if (!cell || cell.text === text) return matrix;
    return { ...matrix, cells: { ...matrix.cells, [cellId]: { ...cell, text } } };
  });
}

/** Multi-cell fill: set the same text on every cell in the range. */
export function setCellsText(
  datasetId: string,
  cellIds: string[],
  text: string,
): StateTransformer {
  return updateMatrix(datasetId, (matrix) => {
    const cells = { ...matrix.cells };
    let changed = false;
    for (const id of cellIds) {
      const cell = cells[id];
      if (!cell || cell.text === text) continue;
      cells[id] = { ...cell, text };
      changed = true;
    }
    return changed ? { ...matrix, cells } : matrix;
  });
}

/** Clear the text of every cell in the range (Delete/Backspace). */
export function clearCellsText(datasetId: string, cellIds: string[]): StateTransformer {
  return setCellsText(datasetId, cellIds, "");
}

/** Merge a style patch onto every cell in the range (alignment/bold/bg/color/borders). */
export function setCellsStyle(
  datasetId: string,
  cellIds: string[],
  patch: MatrixCellStyle,
): StateTransformer {
  return updateMatrix(datasetId, (matrix) => {
    const cells = { ...matrix.cells };
    let changed = false;
    for (const id of cellIds) {
      const cell = cells[id];
      if (!cell) continue;
      const next = applyCellStylePatch(cell, patch);
      if (next !== cell) {
        cells[id] = next;
        changed = true;
      }
    }
    return changed ? { ...matrix, cells } : matrix;
  });
}

// ---------------------------------------------------------------------------
// Row roles + column semantic tags
// ---------------------------------------------------------------------------

export function setRowRole(
  datasetId: string,
  rowId: string,
  role: MatrixRowRole,
): StateTransformer {
  return updateMatrix(datasetId, (matrix) => {
    const rows = matrix.rows.map((row) =>
      row.id === rowId && row.role !== role ? { ...row, role } : row,
    );
    if (rows.every((row, i) => row === matrix.rows[i])) return matrix;
    return { ...matrix, rows };
  });
}

export function setColumnTag(
  datasetId: string,
  colId: string,
  tag: SemanticTag | null,
): StateTransformer {
  return updateMatrix(datasetId, (matrix) => {
    const columns = matrix.columns.map((col) => {
      if (col.id !== colId) return col;
      if (tag === null) {
        if (col.tag === undefined) return col;
        const next = { ...col };
        delete next.tag;
        return next;
      }
      return col.tag === tag ? col : { ...col, tag };
    });
    if (columns.every((col, i) => col === matrix.columns[i])) return matrix;
    return { ...matrix, columns };
  });
}

// ---------------------------------------------------------------------------
// Resize (drag gestures wrap these in withSnapshot with a per-gesture coalescer)
// ---------------------------------------------------------------------------

export function setColumnWidth(
  datasetId: string,
  colId: string,
  width: number,
): StateTransformer {
  const clamped = Math.max(16, Math.round(width));
  return updateMatrix(datasetId, (matrix) => {
    const columns = matrix.columns.map((col) =>
      col.id === colId && col.width !== clamped ? { ...col, width: clamped } : col,
    );
    if (columns.every((col, i) => col === matrix.columns[i])) return matrix;
    return { ...matrix, columns };
  });
}

export function setRowHeight(
  datasetId: string,
  rowId: string,
  height: number,
): StateTransformer {
  const clamped = Math.max(16, Math.round(height));
  return updateMatrix(datasetId, (matrix) => {
    const rows = matrix.rows.map((row) =>
      row.id === rowId && row.height !== clamped ? { ...row, height: clamped } : row,
    );
    if (rows.every((row, i) => row === matrix.rows[i])) return matrix;
    return { ...matrix, rows };
  });
}

// ---------------------------------------------------------------------------
// Page frame
// ---------------------------------------------------------------------------

export function setDocPage(page: DiagramPageFormat): StateTransformer {
  return (state) => {
    const normalized = page === "free" ? undefined : page;
    if (state.doc.page === normalized) return state;
    return { ...state, doc: { ...state.doc, page: normalized } };
  };
}

// ---------------------------------------------------------------------------
// Clipboard (nodes + cell ranges)
// ---------------------------------------------------------------------------

function newId(prefix: string): string {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
    return `${prefix}-${crypto.randomUUID().slice(0, 8)}`;
  }
  return `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
}

/**
 * Re-link cloned nodes after duplicate/paste. A cloned table must not alias
 * the original's dataset (`updateMatrix` matches by id, so editing the copy
 * would edit the original) — it gets a shallow dataset copy (structural
 * sharing is safe: matrix updates are immutable) plus a fresh table view.
 * Cloned members of other pattern views detach as snippets: no view lists
 * the clone in its membership.
 */
export function relinkClonedNodes(
  doc: { datasets?: { id: string; kind: string }[] },
  cloned: DiagramNode[],
): { nodes: DiagramNode[]; datasets: ReportDataset[]; views: PatternView[] } {
  const datasets: ReportDataset[] = [];
  const views: PatternView[] = [];
  const nodes = cloned.map((node) => {
    const meta = node.meta as Record<string, unknown> | undefined;
    if (!meta || (meta.viewId === undefined && meta.memberId === undefined)) return node;
    const matrix = matrixForTableNode(node, doc.datasets);
    if (matrix) {
      const dataset: MatrixDataset = { ...matrix, id: createDatasetId() };
      const bounds = { x: node.x, y: node.y, w: node.w, h: node.h };
      const view: PatternView = {
        id: createPatternViewId(),
        datasetId: dataset.id,
        patternId: TABLE_PATTERN_ID,
        bounds,
        nodeIds: [node.id],
        edgeIds: [],
        projectionHash: computeProjectionHash({
          patternId: TABLE_PATTERN_ID,
          dataset,
          bounds,
        }),
      };
      datasets.push(dataset);
      views.push(view);
      return { ...node, meta: { ...meta, viewId: view.id, memberId: dataset.id } };
    }
    const detached: Record<string, unknown> = { ...meta, snippet: true };
    delete detached.viewId;
    delete detached.memberId;
    return { ...node, meta: detached };
  });
  return { nodes, datasets, views };
}

/** Copy the selected nodes (plus edges internal to the selection) to the session clipboard. */
export function copyNodesToClipboard(): StateTransformer {
  return (state) => {
    const ids = state.ephemeral.selection.nodes;
    if (ids.size === 0) return state;
    const nodes = state.doc.nodes
      .filter((node) => ids.has(node.id))
      .map((node) => ({ ...node, style: node.style ? { ...node.style } : undefined, meta: node.meta ? { ...node.meta } : undefined }));
    const edges = state.doc.edges
      .filter((edge) => ids.has(edge.fromNode) && ids.has(edge.toNode))
      .map((edge) => ({ ...edge }));
    return {
      ...state,
      ephemeral: { ...state.ephemeral, clipboard: { kind: "nodes", nodes, edges } },
    };
  };
}

/** Copy a serialized cell range (TSV grid) to the session clipboard. */
export function copyCellsToClipboard(texts: string[][]): StateTransformer {
  return (state) => ({
    ...state,
    ephemeral: { ...state.ephemeral, clipboard: { kind: "cells", texts } },
  });
}

/**
 * Paste the clipboard. Node clipboards paste offset like duplicate (fresh
 * ids, edges remapped, pasted nodes selected). Cell clipboards paste at the
 * active cell of the current table selection (clipped, span-covered cells
 * skipped). Caller wraps in `withSnapshot` — the nodes branch is a doc
 * mutation, the cells branch routes through `updateMatrix`.
 */
export function pasteClipboard(offsetX = 24, offsetY = 24): StateTransformer {
  return (state) => {
    const clip = state.ephemeral.clipboard;
    if (!clip) return state;

    if (clip.kind === "cells") {
      const ts = state.ephemeral.tableSelection;
      if (!ts) return state;
      const node = state.doc.nodes.find((n) => n.id === ts.nodeId);
      const matrix = matrixForTableNode(node, state.doc.datasets);
      if (!node || !matrix) return state;
      return updateMatrix(matrix.id, (m) => pasteTextGridAt(m, ts.focus, clip.texts))(state);
    }

    if (clip.nodes.length === 0) return state;
    const idMap = new Map<NodeId, NodeId>();
    const pasted: DiagramNode[] = clip.nodes
      .filter((node) => !node.locked)
      .map((node) => {
        const nextId = newId("node");
        idMap.set(node.id, nextId);
        return {
          ...node,
          style: node.style ? { ...node.style } : undefined,
          meta: node.meta ? { ...node.meta } : undefined,
          id: nextId,
          x: node.x + offsetX,
          y: node.y + offsetY,
        };
      });
    if (pasted.length === 0) return state;
    const pastedEdges: DiagramEdge[] = [];
    for (const edge of clip.edges) {
      const fromMapped = idMap.get(edge.fromNode);
      const toMapped = idMap.get(edge.toNode);
      if (fromMapped && toMapped) {
        pastedEdges.push({ ...edge, id: newId("edge"), fromNode: fromMapped, toNode: toMapped });
      }
    }
    const relinked = relinkClonedNodes(state.doc, pasted);
    return {
      ...state,
      doc: {
        ...state.doc,
        nodes: [...state.doc.nodes, ...relinked.nodes],
        edges: [...state.doc.edges, ...pastedEdges],
        ...(relinked.datasets.length > 0
          ? { datasets: [...(state.doc.datasets ?? []), ...relinked.datasets] }
          : {}),
        ...(relinked.views.length > 0
          ? { views: [...(state.doc.views ?? []), ...relinked.views] }
          : {}),
      },
      ephemeral: {
        ...state.ephemeral,
        selection: { nodes: new Set(relinked.nodes.map((n) => n.id)), edges: new Set() },
        tableSelection: null,
      },
    };
  };
}
