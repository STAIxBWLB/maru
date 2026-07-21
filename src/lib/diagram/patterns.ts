/**
 * Pattern registry — Report Pattern Studio Phase 2a.
 *
 * A `PatternDefinition` knows how to project a typed `ReportDataset` onto the
 * canvas (`buildView`) and, for report patterns, how to seed a starter dataset
 * (`createDataset`). The 15 report patterns are dataset-driven and
 * deterministic: the same (dataset, bounds, theme, t) input always produces
 * the same nodes/edges, including member ids, so projections can be
 * regenerated and compared by hash. The 11 legacy templates are registered as
 * `freeform` entries — they keep their existing builders and ids, are not
 * dataset-backed, and are therefore non-convertible (Phase 2b rewires the
 * picker; `TEMPLATE_LIST` stays the builder source until then).
 *
 * Layout conventions: all generators lay members out proportionally inside
 * the view bounds, so moving/resizing the whole-view bounds moves/scales the
 * projection on regeneration. Member nodes carry `meta.memberId` pointing at
 * the backing dataset element (hierarchy node id, timeline item id, ...; for
 * the table pattern it is the dataset id itself, matching `addTableNode`).
 * `meta.viewId` is stamped by the doc-level materializer in `convert.ts`.
 */

import { defaultEdge } from "./edgeRouting";
import { mkNode } from "./nodeKinds";
import {
  TABLE_PATTERN_ID,
  createDatasetId,
  matrixFromRowsCols,
  type FlowDataset,
  type HierarchyDataset,
  type MatrixDataset,
  type NetworkDataset,
  type PatternViewBounds,
  type ReportDataset,
  type ReportDatasetKind,
  type ScorecardDataset,
  type SemanticTag,
  type TimelineDataset,
} from "./reportTypes";
import { TEMPLATE_LIST } from "./templates";
import { createDiagramId, type DiagramEdge, type DiagramNode, type NodeKind } from "./types";

export type TFn = (key: string, vars?: Record<string, string | number>) => string;

/** Identity translator — yields i18n keys; UIs pass a real `t`. */
export const passthroughT: TFn = (key) => key;

export interface FieldMappingSuggestion {
  /** Source field key: matrix column id, or a semantic tag for record datasets. */
  source: string;
  /** Human label for the source field (header text / field name). */
  sourceLabel: string;
  /** Semantic tag currently attached to the source field, when known. */
  sourceTag: SemanticTag | null;
  /** Proposed target tag (null = leave unmapped). */
  target: SemanticTag | null;
}

export interface PatternViewOutput {
  nodes: DiagramNode[];
  edges: DiagramEdge[];
}

export interface BuildViewArgs {
  dataset: ReportDataset;
  bounds: PatternViewBounds;
  theme?: string;
  t: TFn;
}

export interface PatternDefinition {
  id: string;
  /** Dataset kind this pattern natively projects. */
  family: ReportDatasetKind;
  /** Same-family switch targets (always includes `family`). */
  compatibleFamilies: ReportDatasetKind[];
  /** Freeform entries (legacy templates) are not dataset-backed/convertible. */
  freeform?: boolean;
  labelKey: string;
  descriptionKey: string;
  buildView(args: BuildViewArgs): PatternViewOutput;
  /** Starter dataset for "new document" / "insert" flows. */
  createDataset?(args: { t: TFn }): ReportDataset;
  /** Proposed field mapping for cross-family conversion previews. */
  suggestMapping?(dataset: ReportDataset): FieldMappingSuggestion[];
}

// ---------------------------------------------------------------------------
// Deterministic member ids + shared layout helpers
// ---------------------------------------------------------------------------

function memberId(datasetId: string, index: number): string {
  return `${datasetId}:m${index}`;
}

interface LayoutBox {
  x: number;
  y: number;
  w: number;
  h: number;
}

/** Grid-layout `count` slots inside `bounds`, `cols` columns wide. */
function gridBoxes(bounds: PatternViewBounds, count: number, cols: number): LayoutBox[] {
  const rows = Math.max(1, Math.ceil(count / cols));
  const cellW = bounds.w / cols;
  const cellH = bounds.h / rows;
  const boxes: LayoutBox[] = [];
  for (let i = 0; i < count; i += 1) {
    const col = i % cols;
    const row = Math.floor(i / cols);
    const w = Math.min(200, cellW * 0.8);
    const h = Math.min(90, cellH * 0.7);
    boxes.push({
      x: bounds.x + col * cellW + (cellW - w) / 2,
      y: bounds.y + row * cellH + (cellH - h) / 2,
      w,
      h,
    });
  }
  return boxes;
}

/** Layered layout: `depthOf` gives each id a depth; layers stack vertically. */
function layeredBoxes(
  ids: string[],
  depthOf: (id: string) => number,
  maxDepth: number,
  bounds: PatternViewBounds,
): Map<string, LayoutBox> {
  const layers: string[][] = [];
  for (const id of ids) {
    const depth = Math.min(Math.max(0, depthOf(id)), maxDepth);
    while (layers.length <= depth) layers.push([]);
    layers[depth]!.push(id);
  }
  const boxes = new Map<string, LayoutBox>();
  const layerH = bounds.h / (maxDepth + 1);
  layers.forEach((layer, depth) => {
    const cellW = bounds.w / Math.max(1, layer.length);
    layer.forEach((id, i) => {
      const w = Math.min(200, cellW * 0.75);
      const h = Math.min(72, layerH * 0.6);
      boxes.set(id, {
        x: bounds.x + i * cellW + (cellW - w) / 2,
        y: bounds.y + depth * layerH + (layerH - h) / 2,
        w,
        h,
      });
    });
  });
  return boxes;
}

const PROJECTION_STYLE: DiagramNode["style"] = {
  bg: "#FFFFFF",
  border: "#1F2937",
  fc: "#1A1A1A",
  fs: 12,
  fw: 600,
  bw: 1.2,
};

function projectionNode(
  kind: NodeKind,
  box: LayoutBox,
  id: string,
  title: string,
  extra: { body?: string; bullets?: string[]; member?: string; style?: DiagramNode["style"] } = {},
): DiagramNode {
  return mkNode(kind, box.x, box.y, {
    id,
    w: box.w,
    h: box.h,
    title,
    body: extra.body,
    bullets: extra.bullets,
    style: extra.style ?? PROJECTION_STYLE,
    meta: extra.member !== undefined ? { memberId: extra.member } : undefined,
  });
}

function projectionEdge(id: string, from: string, to: string, label?: string): DiagramEdge {
  return defaultEdge(id, from, "s", to, "n", {
    color: "#374151",
    ...(label ? { label } : {}),
  });
}

// ---------------------------------------------------------------------------
// Family projections
// ---------------------------------------------------------------------------

/** Matrix-family patterns render through the typed table node. */
function buildMatrixProjection(dataset: MatrixDataset, bounds: PatternViewBounds): PatternViewOutput {
  const node = mkNode("table", bounds.x, bounds.y, {
    id: memberId(dataset.id, 0),
    w: bounds.w,
    h: bounds.h,
    title: dataset.name,
    meta: { memberId: dataset.id },
  });
  return { nodes: [node], edges: [] };
}

function buildHierarchyProjection(dataset: HierarchyDataset, bounds: PatternViewBounds): PatternViewOutput {
  const nodes = dataset.nodes;
  if (nodes.length === 0) return { nodes: [], edges: [] };
  const byId = new Map(nodes.map((n) => [n.id, n]));
  const depthCache = new Map<string, number>();
  const depthOf = (id: string): number => {
    const cached = depthCache.get(id);
    if (cached !== undefined) return cached;
    depthCache.set(id, 0); // cycle guard
    const node = byId.get(id);
    let depth = 0;
    if (node?.parentId && byId.has(node.parentId) && node.parentId !== id) {
      depth = depthOf(node.parentId) + 1;
    }
    depthCache.set(id, depth);
    return depth;
  };
  const maxDepth = nodes.reduce((max, n) => Math.max(max, depthOf(n.id)), 0);
  const boxes = layeredBoxes(nodes.map((n) => n.id), depthOf, maxDepth, bounds);
  const outNodes: DiagramNode[] = [];
  const outEdges: DiagramEdge[] = [];
  nodes.forEach((n, i) => {
    const box = boxes.get(n.id)!;
    outNodes.push(
      projectionNode("simple", box, memberId(dataset.id, i), n.label, { member: n.id }),
    );
    if (n.parentId && byId.has(n.parentId)) {
      const parentIndex = nodes.findIndex((p) => p.id === n.parentId);
      outEdges.push(
        projectionEdge(
          `${dataset.id}:e${i}`,
          memberId(dataset.id, parentIndex),
          memberId(dataset.id, i),
        ),
      );
    }
  });
  return { nodes: outNodes, edges: outEdges };
}

function buildTimelineProjection(
  dataset: TimelineDataset,
  bounds: PatternViewBounds,
  t: TFn,
): PatternViewOutput {
  const items = dataset.items
    .map((item, index) => ({ item, index }))
    .sort((a, b) => a.item.start.localeCompare(b.item.start) || a.index - b.index);
  if (items.length === 0) return { nodes: [], edges: [] };
  const boxes = gridBoxes(bounds, items.length, items.length);
  const outNodes: DiagramNode[] = [];
  const outEdges: DiagramEdge[] = [];
  items.forEach(({ item }, i) => {
    const lines = [`${item.start} – ${item.end}`];
    if (item.owner) lines.push(`${t("diagram.pattern.field.owner")}: ${item.owner}`);
    if (item.status) lines.push(`${t("diagram.pattern.field.status")}: ${item.status}`);
    outNodes.push(
      projectionNode("simple", boxes[i]!, memberId(dataset.id, i), item.label, {
        body: lines.join("\n"),
        member: item.id,
      }),
    );
    if (i > 0) {
      outEdges.push(
        projectionEdge(`${dataset.id}:e${i}`, memberId(dataset.id, i - 1), memberId(dataset.id, i)),
      );
    }
  });
  return { nodes: outNodes, edges: outEdges };
}

function buildFlowProjection(dataset: FlowDataset, bounds: PatternViewBounds): PatternViewOutput {
  const nodes = dataset.nodes;
  if (nodes.length === 0) return { nodes: [], edges: [] };
  const byId = new Map(nodes.map((n) => [n.id, n]));
  const order = new Map(nodes.map((n, i) => [n.id, i]));
  // Longest-path depth from sources (Kahn); unlinked nodes stay at depth 0.
  const indegree = new Map<string, number>(nodes.map((n) => [n.id, 0]));
  for (const link of dataset.links) {
    if (byId.has(link.to) && byId.has(link.from)) {
      indegree.set(link.to, (indegree.get(link.to) ?? 0) + 1);
    }
  }
  const depth = new Map<string, number>(nodes.map((n) => [n.id, 0]));
  const queue = nodes.filter((n) => (indegree.get(n.id) ?? 0) === 0).map((n) => n.id);
  const remaining = new Map(indegree);
  while (queue.length > 0) {
    const id = queue.shift()!;
    for (const link of dataset.links) {
      if (link.from !== id || !byId.has(link.to)) continue;
      depth.set(link.to, Math.max(depth.get(link.to) ?? 0, (depth.get(id) ?? 0) + 1));
      const left = (remaining.get(link.to) ?? 0) - 1;
      remaining.set(link.to, left);
      if (left <= 0) queue.push(link.to);
    }
  }
  const maxDepth = nodes.reduce((max, n) => Math.max(max, depth.get(n.id) ?? 0), 0);
  const boxes = layeredBoxes(
    nodes.map((n) => n.id),
    (id) => depth.get(id) ?? 0,
    maxDepth,
    bounds,
  );
  const outNodes: DiagramNode[] = nodes.map((n, i) =>
    projectionNode(
      n.kind === "decision" ? "diamond" : "simple",
      boxes.get(n.id)!,
      memberId(dataset.id, i),
      n.label,
      { member: n.id },
    ),
  );
  const outEdges: DiagramEdge[] = [];
  dataset.links.forEach((link, i) => {
    const from = order.get(link.from);
    const to = order.get(link.to);
    if (from === undefined || to === undefined) return;
    outEdges.push(
      projectionEdge(
        `${dataset.id}:e${i}`,
        memberId(dataset.id, from),
        memberId(dataset.id, to),
        link.label,
      ),
    );
  });
  return { nodes: outNodes, edges: outEdges };
}

function buildNetworkProjection(dataset: NetworkDataset, bounds: PatternViewBounds): PatternViewOutput {
  const nodes = dataset.nodes;
  if (nodes.length === 0) return { nodes: [], edges: [] };
  const order = new Map(nodes.map((n, i) => [n.id, i]));
  const cx = bounds.x + bounds.w / 2;
  const cy = bounds.y + bounds.h / 2;
  const radius = Math.max(40, Math.min(bounds.w, bounds.h) / 2 - 50);
  const outNodes: DiagramNode[] = nodes.map((n, i) => {
    const angle = (2 * Math.PI * i) / nodes.length - Math.PI / 2;
    const w = 150;
    const h = 60;
    return projectionNode(
      "simple",
      { x: cx + radius * Math.cos(angle) - w / 2, y: cy + radius * Math.sin(angle) - h / 2, w, h },
      memberId(dataset.id, i),
      n.label,
      { member: n.id, body: n.group },
    );
  });
  const outEdges: DiagramEdge[] = [];
  dataset.links.forEach((link, i) => {
    const from = order.get(link.from);
    const to = order.get(link.to);
    if (from === undefined || to === undefined) return;
    outEdges.push(
      projectionEdge(`${dataset.id}:e${i}`, memberId(dataset.id, from), memberId(dataset.id, to)),
    );
  });
  return { nodes: outNodes, edges: outEdges };
}

function buildScorecardProjection(
  dataset: ScorecardDataset,
  bounds: PatternViewBounds,
  t: TFn,
): PatternViewOutput {
  const entries = dataset.entries;
  if (entries.length === 0) return { nodes: [], edges: [] };
  const boxes = gridBoxes(bounds, entries.length, 1);
  const outNodes: DiagramNode[] = entries.map((entry, i) => {
    const bullets: string[] = [];
    if (entry.target !== undefined) bullets.push(`${t("diagram.pattern.field.target")}: ${entry.target}`);
    if (entry.actual !== undefined) bullets.push(`${t("diagram.pattern.field.actual")}: ${entry.actual}`);
    if (entry.status !== undefined) bullets.push(`${t("diagram.pattern.field.status")}: ${entry.status}`);
    if (entry.evidence !== undefined) bullets.push(`${t("diagram.pattern.field.evidence")}: ${entry.evidence}`);
    return projectionNode("section", boxes[i]!, memberId(dataset.id, i), entry.label, {
      bullets,
      member: entry.id,
    });
  });
  return { nodes: outNodes, edges: [] };
}

function buildProjection(args: BuildViewArgs, family: ReportDatasetKind): PatternViewOutput {
  const { dataset, bounds, t } = args;
  if (dataset.kind !== family) return { nodes: [], edges: [] };
  switch (family) {
    case "matrix":
      return buildMatrixProjection(dataset as MatrixDataset, bounds);
    case "hierarchy":
      return buildHierarchyProjection(dataset as HierarchyDataset, bounds);
    case "timeline":
      return buildTimelineProjection(dataset as TimelineDataset, bounds, t);
    case "flow":
      return buildFlowProjection(dataset as FlowDataset, bounds);
    case "network":
      return buildNetworkProjection(dataset as NetworkDataset, bounds);
    case "scorecard":
      return buildScorecardProjection(dataset as ScorecardDataset, bounds, t);
  }
}

// ---------------------------------------------------------------------------
// suggestMapping
// ---------------------------------------------------------------------------

/** Cell text anchored at (rowIndex, colIndex), used as a column header label. */
function matrixHeaderText(matrix: MatrixDataset, rowIndex: number, colId: string): string {
  const row = matrix.rows[rowIndex];
  if (!row) return "";
  const direct = Object.values(matrix.cells).find(
    (cell) => cell.rowId === row.id && cell.colId === colId,
  );
  return direct?.text ?? "";
}

function suggestMatrixMapping(dataset: ReportDataset): FieldMappingSuggestion[] {
  if (dataset.kind !== "matrix") return [];
  const matrix = dataset as MatrixDataset;
  const headerRowIndex = matrix.rows.findIndex((row) => row.role === "header");
  const labelRow = headerRowIndex >= 0 ? headerRowIndex : 0;
  return matrix.columns.map((col, i) => ({
    source: col.id,
    sourceLabel: matrixHeaderText(matrix, labelRow, col.id) || `Column ${i + 1}`,
    sourceTag: col.tag ?? null,
    target: col.tag ?? null,
  }));
}

const RECORD_FIELDS: Partial<Record<ReportDatasetKind, SemanticTag[]>> = {
  hierarchy: ["label", "parent"],
  timeline: ["label", "start", "end", "owner", "status"],
  flow: ["label", "from", "to"],
  network: ["label", "from", "to"],
  scorecard: ["label", "target", "actual", "status", "evidence"],
};

function suggestRecordMapping(dataset: ReportDataset): FieldMappingSuggestion[] {
  const tags = RECORD_FIELDS[dataset.kind] ?? [];
  return tags.map((tag) => ({
    source: tag,
    sourceLabel: tag,
    sourceTag: tag,
    target: tag,
  }));
}

function suggestMappingFor(dataset: ReportDataset): FieldMappingSuggestion[] {
  return dataset.kind === "matrix" ? suggestMatrixMapping(dataset) : suggestRecordMapping(dataset);
}

// ---------------------------------------------------------------------------
// Starter datasets
// ---------------------------------------------------------------------------

function starterMatrix(
  name: string,
  columns: { text: string; tag?: SemanticTag }[],
  rows: string[][],
): MatrixDataset {
  const matrix = matrixFromRowsCols(rows.length + 1, columns.length, {
    id: createDatasetId(),
    name,
  });
  const headerRow = matrix.rows[0]!;
  headerRow.role = "header";
  const cells = { ...matrix.cells };
  const setText = (rowId: string, colId: string, text: string) => {
    const cell = Object.values(cells).find((c) => c.rowId === rowId && c.colId === colId);
    if (cell) cells[cell.id] = { ...cell, text };
  };
  const nextColumns = matrix.columns.map((col, i) => {
    setText(headerRow.id, col.id, columns[i]?.text ?? "");
    return columns[i]?.tag ? { ...col, tag: columns[i]!.tag } : col;
  });
  rows.forEach((texts, r) => {
    const row = matrix.rows[r + 1];
    if (!row) return;
    texts.forEach((text, c) => {
      const col = matrix.columns[c];
      if (col) setText(row.id, col.id, text);
    });
  });
  return { ...matrix, columns: nextColumns, cells };
}

function starterHierarchy(name: string, rootLabel: string, childLabels: string[]): HierarchyDataset {
  const rootId = createDiagramId("hn");
  return {
    id: createDatasetId(),
    kind: "hierarchy",
    name,
    nodes: [
      { id: rootId, parentId: null, label: rootLabel },
      ...childLabels.map((label) => ({
        id: createDiagramId("hn"),
        parentId: rootId,
        label,
      })),
    ],
  };
}

// ---------------------------------------------------------------------------
// Report pattern registry
// ---------------------------------------------------------------------------

function defineReportPattern(def: {
  id: string;
  family: ReportDatasetKind;
  compatibleFamilies?: ReportDatasetKind[];
  createDataset?(args: { t: TFn }): ReportDataset;
}): PatternDefinition {
  return {
    id: def.id,
    family: def.family,
    compatibleFamilies: def.compatibleFamilies ?? [def.family],
    labelKey: `diagram.pattern.${def.id.replace(/^report\./, "").replace(/-([a-z])/g, (_, c: string) => c.toUpperCase())}.label`,
    descriptionKey: `diagram.pattern.${def.id.replace(/^report\./, "").replace(/-([a-z])/g, (_, c: string) => c.toUpperCase())}.description`,
    buildView: (args) => buildProjection(args, def.family),
    createDataset: def.createDataset,
    suggestMapping: suggestMappingFor,
  };
}

const REPORT_PATTERNS: PatternDefinition[] = [
  {
    id: TABLE_PATTERN_ID,
    family: "matrix",
    compatibleFamilies: ["matrix"],
    labelKey: "diagram.pattern.table.label",
    descriptionKey: "diagram.pattern.table.description",
    buildView: (args) => buildProjection(args, "matrix"),
    createDataset: ({ t }) =>
      starterMatrix(
        t("diagram.pattern.table.label"),
        [
          { text: t("diagram.pattern.field.label"), tag: "label" },
          { text: t("diagram.pattern.field.status"), tag: "status" },
          { text: t("diagram.pattern.field.evidence"), tag: "evidence" },
        ],
        [
          [t("diagram.pattern.starter.item1"), "", ""],
          [t("diagram.pattern.starter.item2"), "", ""],
        ],
      ),
    suggestMapping: suggestMappingFor,
  },
  defineReportPattern({
    id: "report.irregular-table",
    family: "matrix",
    createDataset: ({ t }) =>
      starterMatrix(
        t("diagram.pattern.irregularTable.label"),
        [
          { text: t("diagram.pattern.field.label"), tag: "label" },
          { text: t("diagram.pattern.field.owner"), tag: "owner" },
          { text: t("diagram.pattern.field.status"), tag: "status" },
        ],
        [
          [t("diagram.pattern.starter.item1"), "", ""],
          [t("diagram.pattern.starter.item2"), "", ""],
          [t("diagram.pattern.starter.item3"), "", ""],
        ],
      ),
  }),
  defineReportPattern({
    id: "report.pdm",
    family: "matrix",
    createDataset: ({ t }) =>
      starterMatrix(
        t("diagram.pattern.pdm.label"),
        [
          { text: t("diagram.pattern.pdm.col.narrative"), tag: "label" },
          { text: t("diagram.pattern.pdm.col.indicator") },
          { text: t("diagram.pattern.pdm.col.mov") },
          { text: t("diagram.pattern.pdm.col.assumption") },
        ],
        [
          [t("diagram.pattern.pdm.row.goal"), "", "", ""],
          [t("diagram.pattern.pdm.row.purpose"), "", "", ""],
          [t("diagram.pattern.pdm.row.output"), "", "", ""],
          [t("diagram.pattern.pdm.row.activities"), "", "", ""],
        ],
      ),
  }),
  defineReportPattern({
    id: "report.raci",
    family: "matrix",
    createDataset: ({ t }) =>
      starterMatrix(
        t("diagram.pattern.raci.label"),
        [
          { text: t("diagram.pattern.field.label"), tag: "label" },
          { text: t("diagram.pattern.starter.roleA") },
          { text: t("diagram.pattern.starter.roleB") },
        ],
        [
          [t("diagram.pattern.starter.item1"), "A", "R"],
          [t("diagram.pattern.starter.item2"), "I", "C"],
        ],
      ),
  }),
  defineReportPattern({
    id: "report.checklist",
    family: "matrix",
    createDataset: ({ t }) =>
      starterMatrix(
        t("diagram.pattern.checklist.label"),
        [
          { text: t("diagram.pattern.field.label"), tag: "label" },
          { text: t("diagram.pattern.field.status"), tag: "status" },
          { text: t("diagram.pattern.field.evidence"), tag: "evidence" },
        ],
        [
          [t("diagram.pattern.starter.item1"), "", ""],
          [t("diagram.pattern.starter.item2"), "", ""],
        ],
      ),
  }),
  defineReportPattern({
    id: "report.curriculum-matrix",
    family: "matrix",
    createDataset: ({ t }) =>
      starterMatrix(
        t("diagram.pattern.curriculumMatrix.label"),
        [
          { text: t("diagram.pattern.field.label"), tag: "label" },
          { text: t("diagram.pattern.starter.competencyA") },
          { text: t("diagram.pattern.starter.competencyB") },
        ],
        [
          [t("diagram.pattern.starter.item1"), "", ""],
          [t("diagram.pattern.starter.item2"), "", ""],
        ],
      ),
  }),
  defineReportPattern({
    id: "report.before-after",
    family: "matrix",
    createDataset: ({ t }) =>
      starterMatrix(
        t("diagram.pattern.beforeAfter.label"),
        [
          { text: t("diagram.pattern.field.label"), tag: "label" },
          { text: t("diagram.pattern.starter.before"), tag: "from" },
          { text: t("diagram.pattern.starter.after"), tag: "to" },
        ],
        [
          [t("diagram.pattern.starter.item1"), "", ""],
          [t("diagram.pattern.starter.item2"), "", ""],
        ],
      ),
  }),
  defineReportPattern({
    id: "report.comparison",
    family: "matrix",
    createDataset: ({ t }) =>
      starterMatrix(
        t("diagram.pattern.comparison.label"),
        [
          { text: t("diagram.pattern.field.label"), tag: "label" },
          { text: t("diagram.pattern.starter.optionA") },
          { text: t("diagram.pattern.starter.optionB") },
        ],
        [
          [t("diagram.pattern.starter.criterion1"), "", ""],
          [t("diagram.pattern.starter.criterion2"), "", ""],
        ],
      ),
  }),
  defineReportPattern({
    id: "report.strategy-cascade",
    family: "hierarchy",
    createDataset: ({ t }) =>
      starterHierarchy(
        t("diagram.pattern.strategyCascade.label"),
        t("diagram.pattern.starter.root"),
        [t("diagram.pattern.starter.childA"), t("diagram.pattern.starter.childB")],
      ),
  }),
  defineReportPattern({
    id: "report.problem-tree",
    family: "hierarchy",
    createDataset: ({ t }) =>
      starterHierarchy(
        t("diagram.pattern.problemTree.label"),
        t("diagram.pattern.starter.root"),
        [t("diagram.pattern.starter.childA"), t("diagram.pattern.starter.childB")],
      ),
  }),
  defineReportPattern({
    id: "report.objective-tree",
    family: "hierarchy",
    createDataset: ({ t }) =>
      starterHierarchy(
        t("diagram.pattern.objectiveTree.label"),
        t("diagram.pattern.starter.root"),
        [t("diagram.pattern.starter.childA"), t("diagram.pattern.starter.childB")],
      ),
  }),
  defineReportPattern({
    id: "report.budget",
    family: "hierarchy",
    createDataset: ({ t }) =>
      starterHierarchy(
        t("diagram.pattern.budget.label"),
        t("diagram.pattern.starter.root"),
        [t("diagram.pattern.starter.childA"), t("diagram.pattern.starter.childB")],
      ),
  }),
  defineReportPattern({
    id: "report.timeline",
    family: "timeline",
    createDataset: ({ t }): TimelineDataset => ({
      id: createDatasetId(),
      kind: "timeline",
      name: t("diagram.pattern.timeline.label"),
      items: [
        { id: createDiagramId("ti"), label: t("diagram.pattern.starter.item1"), start: "2026-01", end: "2026-03" },
        { id: createDiagramId("ti"), label: t("diagram.pattern.starter.item2"), start: "2026-04", end: "2026-08" },
        { id: createDiagramId("ti"), label: t("diagram.pattern.starter.item3"), start: "2026-09", end: "2026-12" },
      ],
    }),
  }),
  defineReportPattern({
    id: "report.process",
    family: "flow",
    createDataset: ({ t }): FlowDataset => {
      const ids = [0, 1, 2, 3].map(() => createDiagramId("fn"));
      return {
        id: createDatasetId(),
        kind: "flow",
        name: t("diagram.pattern.process.label"),
        nodes: ids.map((id, i) => ({
          id,
          label: t(`diagram.pattern.starter.step${i + 1}`),
        })),
        links: ids.slice(0, -1).map((from, i) => ({
          id: createDiagramId("fl"),
          from,
          to: ids[i + 1]!,
        })),
      };
    },
  }),
  defineReportPattern({
    id: "report.stakeholder",
    family: "network",
    createDataset: ({ t }): NetworkDataset => {
      const ids = [0, 1, 2].map(() => createDiagramId("nn"));
      return {
        id: createDatasetId(),
        kind: "network",
        name: t("diagram.pattern.stakeholder.label"),
        nodes: ids.map((id, i) => ({
          id,
          label: t(`diagram.pattern.starter.actor${i + 1}`),
        })),
        links: [
          { id: createDiagramId("nl"), from: ids[0]!, to: ids[1]! },
          { id: createDiagramId("nl"), from: ids[1]!, to: ids[2]! },
        ],
      };
    },
  }),
  defineReportPattern({
    id: "report.kpi-scorecard",
    family: "scorecard",
    createDataset: ({ t }): ScorecardDataset => ({
      id: createDatasetId(),
      kind: "scorecard",
      name: t("diagram.pattern.kpiScorecard.label"),
      entries: [1, 2, 3].map((i) => ({
        id: createDiagramId("kpi"),
        label: t(`diagram.pattern.starter.item${i}`),
        target: "100%",
        actual: "-",
        status: t("diagram.pattern.starter.statusOnTrack"),
        evidence: "",
      })),
    }),
  }),
];

// ---------------------------------------------------------------------------
// Legacy templates as freeform pattern entries
// ---------------------------------------------------------------------------

const TEMPLATE_PATTERNS: PatternDefinition[] = TEMPLATE_LIST.map((tpl) => ({
  id: tpl.id,
  // Freeform entries carry an inert family; `freeform: true` blocks every
  // dataset-driven path (conversion, regeneration, linked views).
  family: "matrix",
  compatibleFamilies: [],
  freeform: true,
  labelKey: tpl.labelKey,
  descriptionKey: tpl.descriptionKey,
  buildView: ({ bounds, t }) => tpl.build(bounds.x + bounds.w / 2, bounds.y + bounds.h / 2, t),
}));

// ---------------------------------------------------------------------------
// Registry accessors
// ---------------------------------------------------------------------------

export const PATTERN_LIST: PatternDefinition[] = [...REPORT_PATTERNS, ...TEMPLATE_PATTERNS];

const PATTERN_INDEX = new Map(PATTERN_LIST.map((pattern) => [pattern.id, pattern]));

export function getPattern(id: string): PatternDefinition | undefined {
  return PATTERN_INDEX.get(id);
}

/** Dataset-driven (non-freeform) report patterns, registry order. */
export const REPORT_PATTERN_LIST: PatternDefinition[] = REPORT_PATTERNS.filter(
  (pattern) => !pattern.freeform,
);

export function patternsForFamily(kind: ReportDatasetKind): PatternDefinition[] {
  return REPORT_PATTERN_LIST.filter((pattern) => pattern.family === kind);
}
