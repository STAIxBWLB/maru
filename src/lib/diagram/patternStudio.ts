/**
 * Pattern Studio UI helpers — Report Pattern Studio Phase 2b.
 *
 * Pure doc→doc helpers (plus `StateTransformer` wrappers) backing the pattern
 * gallery and the detach prompt:
 *
 * - `newDocumentFromPattern` / `insertPatternAt`: create a fresh doc or insert
 *   a pattern into the current doc at a canvas position. Report patterns go
 *   through `createDataset` + `materializeView` (dataset + view + members);
 *   freeform legacy templates keep their center-based builders and stay
 *   view-less. Preset application funnels through the same path (patternId +
 *   theme/style/datasetSeed).
 * - `analyzeViewDrag`: classify a pending move/delete of view-linked members
 *   as either a strict subset (→ detach prompt) or a whole-membership gesture
 *   (→ stays linked, bounds offset via `offsetViewBounds`). Table nodes whose
 *   `meta.memberId` is the dataset pointer never trigger the prompt — they
 *   are the live projection surface, not detachable decorations.
 * - `detachViewMembersSnippet`: detach + stamp `meta.snippet` so the UI can
 *   badge ex-view content as a freeform "layout snippet".
 *
 * Converters and presets stay untouched; everything here composes the Phase
 * 2a pure functions.
 */

import type { StateTransformer } from "./actions";
import {
  detachViewMembers,
  materializeView,
  viewProjectionHash,
} from "./convert";
import { getPattern, passthroughT, type PatternDefinition, type TFn } from "./patterns";
import type { PatternPresetV1 } from "./presets";
import {
  createDatasetId,
  createPatternViewId,
  type PatternView,
  type PatternViewBounds,
  type ReportDataset,
} from "./reportTypes";
import {
  createDiagramId,
  createEmptyDoc,
  type DiagramDoc,
  type DiagramNode,
  type NodeId,
  type NodeStyle,
} from "./types";

export interface PatternApplyOpts {
  t?: TFn;
  theme?: string;
  /** Preset dataset seed used instead of the pattern's starter dataset. */
  datasetSeed?: ReportDataset;
  /** Preset style hints merged onto created member nodes (known keys only). */
  style?: Record<string, string | number | boolean>;
}

/** Derive apply-opts from a validated preset. */
export function presetApplyOpts(preset: PatternPresetV1, t?: TFn): PatternApplyOpts {
  return {
    t,
    ...(preset.theme !== undefined ? { theme: preset.theme } : {}),
    ...(preset.style !== undefined ? { style: preset.style } : {}),
    ...(preset.datasetSeed !== undefined ? { datasetSeed: preset.datasetSeed } : {}),
  };
}

const INSERT_W = 520;
const INSERT_H = 340;

function insertBounds(at: { x: number; y: number }): PatternViewBounds {
  return { x: at.x - INSERT_W / 2, y: at.y - INSERT_H / 2, w: INSERT_W, h: INSERT_H };
}

/** Filter a preset style bag down to known `NodeStyle` keys with matching types. */
export function presetNodeStyle(
  style: Record<string, string | number | boolean> | undefined,
): NodeStyle | undefined {
  if (!style) return undefined;
  const out: NodeStyle = {};
  for (const key of ["bg", "border", "fc"] as const) {
    const value = style[key];
    if (typeof value === "string") out[key] = value;
  }
  for (const key of ["bw", "br", "fs", "fw"] as const) {
    const value = style[key];
    if (typeof value === "number" && Number.isFinite(value)) out[key] = value;
  }
  const align = style.align;
  if (align === "left" || align === "center" || align === "right") out.align = align;
  return Object.keys(out).length > 0 ? out : undefined;
}

function applyPresetStyle(nodes: DiagramNode[], style: NodeStyle | undefined): DiagramNode[] {
  if (!style) return nodes;
  return nodes.map((node) => ({ ...node, style: { ...(node.style ?? {}), ...style } }));
}

function starterDataset(pattern: PatternDefinition, opts: PatternApplyOpts): ReportDataset {
  // Re-id the seed: a preset's stored dataset id must not collide with a
  // dataset already in the doc (applying the same preset twice, or a preset
  // saved from this very document, would otherwise alias two live views).
  if (opts.datasetSeed) return { ...opts.datasetSeed, id: createDatasetId() };
  if (!pattern.createDataset) {
    throw new Error(`pattern ${pattern.id} has no starter dataset`);
  }
  return pattern.createDataset({ t: opts.t ?? passthroughT });
}

interface CreatedProjection {
  nodes: DiagramNode[];
  edges: DiagramDoc["edges"];
  dataset?: ReportDataset;
  view?: PatternView;
}

function createProjection(
  pattern: PatternDefinition,
  bounds: PatternViewBounds,
  opts: PatternApplyOpts,
): CreatedProjection {
  const t = opts.t ?? passthroughT;
  if (pattern.freeform) {
    // Legacy templates build around a center point and ignore the dataset arg.
    const out = pattern.buildView({
      dataset: undefined as unknown as ReportDataset,
      bounds,
      theme: opts.theme,
      t,
    });
    return { nodes: applyPresetStyle(out.nodes, presetNodeStyle(opts.style)), edges: out.edges };
  }
  const dataset = starterDataset(pattern, opts);
  const viewId = createPatternViewId();
  const { nodes, edges } = materializeView(pattern, dataset, viewId, bounds, {
    t,
    ...(opts.theme !== undefined ? { theme: opts.theme } : {}),
  });
  const view: PatternView = {
    id: viewId,
    datasetId: dataset.id,
    patternId: pattern.id,
    bounds,
    ...(opts.theme !== undefined ? { theme: opts.theme } : {}),
    nodeIds: nodes.map((node) => node.id),
    edgeIds: edges.map((edge) => edge.id),
    projectionHash: viewProjectionHash(pattern.id, dataset, bounds),
  };
  return {
    nodes: applyPresetStyle(nodes, presetNodeStyle(opts.style)),
    edges,
    dataset,
    view,
  };
}

/**
 * Insert a pattern into the current doc at a canvas position. Report patterns
 * add a dataset + view + members (like `addTableNode`); freeform templates
 * add bare nodes/edges. Returns the updated doc plus inserted node ids.
 */
export function insertPatternAt(
  doc: DiagramDoc,
  patternId: string,
  at: { x: number; y: number },
  opts: PatternApplyOpts = {},
): { doc: DiagramDoc; nodeIds: NodeId[] } {
  const pattern = getPattern(patternId);
  if (!pattern) throw new Error(`pattern not found: ${patternId}`);
  const created = createProjection(pattern, insertBounds(at), opts);
  const next: DiagramDoc = {
    ...doc,
    nodes: [...doc.nodes, ...created.nodes],
    edges: [...doc.edges, ...created.edges],
    ...(created.dataset ? { datasets: [...(doc.datasets ?? []), created.dataset] } : {}),
    ...(created.view ? { views: [...(doc.views ?? []), created.view] } : {}),
  };
  return { doc: next, nodeIds: created.nodes.map((node) => node.id) };
}

/** Insert + select the inserted members (dispatch via `withSnapshot`). */
export function insertPatternAtAction(
  patternId: string,
  at: { x: number; y: number },
  opts: PatternApplyOpts = {},
): StateTransformer {
  return (state) => {
    const { doc, nodeIds } = insertPatternAt(state.doc, patternId, at, opts);
    if (doc === state.doc) return state;
    return {
      ...state,
      doc,
      ephemeral: {
        ...state.ephemeral,
        selection: { nodes: new Set(nodeIds), edges: new Set() },
        tableSelection: null,
      },
    };
  };
}

/** Fresh document built from a pattern (the gallery's "New document" action). */
export function newDocumentFromPattern(
  patternId: string,
  opts: PatternApplyOpts & { docTitle?: string } = {},
): DiagramDoc {
  const pattern = getPattern(patternId);
  if (!pattern) throw new Error(`pattern not found: ${patternId}`);
  const t = opts.t ?? passthroughT;
  const fresh = createEmptyDoc(createDiagramId());
  const docTitle = opts.docTitle ?? t(pattern.labelKey);
  if (pattern.freeform) {
    // Matches the legacy template apply path: build around (400, 300).
    const created = createProjection(
      pattern,
      { x: 400 - INSERT_W / 2, y: 300 - INSERT_H / 2, w: INSERT_W, h: INSERT_H },
      opts,
    );
    return { ...fresh, nodes: created.nodes, edges: created.edges, docTitle };
  }
  const created = createProjection(pattern, { x: 120, y: 96, w: 560, h: 360 }, opts);
  return {
    ...fresh,
    nodes: created.nodes,
    edges: created.edges,
    docTitle,
    ...(created.dataset ? { datasets: [created.dataset] } : {}),
    ...(created.view ? { views: [created.view] } : {}),
  };
}

// ---------------------------------------------------------------------------
// Selection → view resolution (conversion entry)
// ---------------------------------------------------------------------------

/**
 * The view to convert, given the current selection: exactly one selected node
 * stamped with a `meta.viewId` that resolves to an existing view.
 */
export function singleLinkedViewId(doc: DiagramDoc, selectedIds: Iterable<NodeId>): string | null {
  const ids = [...selectedIds];
  if (ids.length !== 1) return null;
  const node = doc.nodes.find((n) => n.id === ids[0]);
  const viewId = node?.meta?.viewId;
  if (typeof viewId !== "string") return null;
  return (doc.views ?? []).some((view) => view.id === viewId) ? viewId : null;
}

// ---------------------------------------------------------------------------
// View drag/delete analysis (detach prompt)
// ---------------------------------------------------------------------------

export interface ViewDragAnalysis {
  /** Views where the gesture covers a strict subset of members → prompt to detach. */
  subsets: { viewId: string; memberIds: NodeId[] }[];
  /** Views whose ENTIRE membership is in the gesture → stay linked (bounds offset). */
  full: string[];
}

function isTableDatasetPointer(node: DiagramNode | undefined, datasetId: string): boolean {
  return node?.kind === "table" && node.meta?.memberId === datasetId;
}

/**
 * Classify a pending move/delete of `ids` against the doc's pattern views.
 * A gesture covering every member of a view stays linked; a strict subset of
 * non-table-pointer members requires the detach prompt.
 */
export function analyzeViewDrag(doc: DiagramDoc, ids: Iterable<NodeId>): ViewDragAnalysis {
  const idSet = new Set(ids);
  const subsets: ViewDragAnalysis["subsets"] = [];
  const full: string[] = [];
  for (const view of doc.views ?? []) {
    const dragged = view.nodeIds.filter((id) => idSet.has(id));
    if (dragged.length === 0) continue;
    if (dragged.length === view.nodeIds.length) {
      full.push(view.id);
      continue;
    }
    const memberIds = dragged.filter(
      (id) => !isTableDatasetPointer(doc.nodes.find((n) => n.id === id), view.datasetId),
    );
    if (memberIds.length > 0) subsets.push({ viewId: view.id, memberIds });
  }
  return { subsets, full };
}

/**
 * Offset whole-view bounds after a linked whole-membership drag, keeping the
 * projection hash in sync so the move does not count as a projection drift.
 */
export function offsetViewBounds(
  doc: DiagramDoc,
  viewIds: string[],
  dx: number,
  dy: number,
): DiagramDoc {
  if (viewIds.length === 0 || (dx === 0 && dy === 0)) return doc;
  const targets = new Set(viewIds);
  let changed = false;
  const views = (doc.views ?? []).map((view) => {
    if (!targets.has(view.id)) return view;
    const dataset = (doc.datasets ?? []).find((ds) => ds.id === view.datasetId);
    if (!dataset) return view;
    changed = true;
    const bounds = { ...view.bounds, x: view.bounds.x + dx, y: view.bounds.y + dy };
    return {
      ...view,
      bounds,
      projectionHash: viewProjectionHash(view.patternId, dataset, bounds),
    };
  });
  return changed ? { ...doc, views } : doc;
}

// ---------------------------------------------------------------------------
// Detach with snippet marker
// ---------------------------------------------------------------------------

/**
 * Detach members from a view and stamp `meta.snippet` so the UI can badge the
 * ex-view content as a freeform layout snippet.
 */
export function detachViewMembersSnippet(
  doc: DiagramDoc,
  viewId: string,
  nodeIds: NodeId[],
): DiagramDoc {
  const detached = detachViewMembers(doc, viewId, nodeIds);
  if (detached === doc) return doc;
  const ids = new Set(nodeIds);
  return {
    ...detached,
    nodes: detached.nodes.map((node) =>
      ids.has(node.id) ? { ...node, meta: { ...(node.meta ?? {}), snippet: true } } : node,
    ),
  };
}

export function detachViewMembersSnippetAction(
  viewId: string,
  nodeIds: NodeId[],
): StateTransformer {
  return (state) => {
    const next = detachViewMembersSnippet(state.doc, viewId, nodeIds);
    if (next === state.doc) return state;
    return { ...state, doc: next };
  };
}

export function offsetViewBoundsAction(viewIds: string[], dx: number, dy: number): StateTransformer {
  return (state) => {
    const next = offsetViewBounds(state.doc, viewIds, dx, dy);
    if (next === state.doc) return state;
    return { ...state, doc: next };
  };
}
