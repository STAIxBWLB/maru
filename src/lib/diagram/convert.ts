/**
 * Semantic conversion engine — Report Pattern Studio Phase 2a.
 *
 * Pure doc→doc functions (plus dataset→dataset extraction helpers) that
 * reproject typed report datasets between patterns:
 *
 * - Same-family switch (`switchViewPattern`): regenerates a view's members
 *   from the SAME dataset through another pattern of the same family. No
 *   dataset copy; dataset object identity is preserved. Problem→objective
 *   tree is this kind of switch — labels and structure survive exactly, no
 *   semantic rewriting.
 * - Linked views (`addLinkedView`): a second live view of one dataset.
 * - Cross-family conversion (`convertToNewDataset`): builds a NEW dataset of
 *   the target kind from extracted records + a field mapping, leaving the
 *   source dataset and view untouched. Unmapped/dropped source fields always
 *   produce warnings — never silent loss.
 * - Projection sync (`regenerateView`): re-runs `buildView` after dataset
 *   edits. Override rule (kept deliberately simple): whole-view bounds drive
 *   member layout (generators lay out proportionally inside bounds, so a
 *   bounds move/resize moves/scales the projection); member text always comes
 *   from the dataset (dataset wins); member STYLE overrides survive keyed by
 *   stable member index, but only when the member count is unchanged —
 *   otherwise styles reset to the pattern defaults.
 * - Detach (`detachViewMembers` / `detachWholeView`): strips view linkage so
 *   content becomes freeform ("layout snippet") and non-convertible.
 *   Exception: a `table` node's `meta.memberId` IS its dataset pointer (the
 *   table renderer reads the matrix through it), so detaching strips
 *   `meta.viewId` but keeps `memberId` when it references an existing
 *   dataset — the snippet keeps rendering its last data.
 *
 * All doc functions throw on invalid preconditions (unknown ids, family
 * mismatch, freeform targets) so callers pre-compute the next doc and let
 * errors surface BEFORE dispatching a snapshot, mirroring the `mergeCells` /
 * `updateMatrix` pattern. The `*Action` wrappers adapt them to
 * `StateTransformer`s for `withSnapshot`.
 */

import type { StateTransformer } from "./actions";
import {
  KNOWN_SEMANTIC_TAGS,
  computeProjectionHash,
  createDatasetId,
  createPatternViewId,
  type FlowDataset,
  type HierarchyDataset,
  type MatrixDataset,
  type NetworkDataset,
  type PatternView,
  type PatternViewBounds,
  type ReportDataset,
  type ScorecardDataset,
  type SemanticTag,
  type TimelineDataset,
} from "./reportTypes";
import { getPattern, passthroughT, type PatternDefinition, type TFn } from "./patterns";
import { createDiagramId, type DiagramDoc, type DiagramEdge, type DiagramNode } from "./types";

export interface ConversionOpts {
  t?: TFn;
  theme?: string;
}

// ---------------------------------------------------------------------------
// Warnings (i18n keys, localized when a translator is supplied)
// ---------------------------------------------------------------------------

export interface ConversionWarning {
  key: string;
  vars?: Record<string, string>;
}

function formatWarnings(warnings: ConversionWarning[], t?: TFn): string[] {
  const translate = t ?? passthroughT;
  return warnings.map((warning) => translate(warning.key, warning.vars));
}

function warn(
  warnings: ConversionWarning[],
  key: string,
  vars?: Record<string, string>,
): void {
  warnings.push({ key, vars });
}

// ---------------------------------------------------------------------------
// Classification
// ---------------------------------------------------------------------------

export type ConversionKind = "same-family" | "cross-family" | "freeform";

/**
 * Classify a view→pattern conversion. Detached content has no view entry, so
 * it classifies as "freeform" (non-convertible), as do legacy templates and
 * views whose dataset is gone.
 */
export function classifyConversion(
  doc: DiagramDoc,
  sourceViewId: string,
  targetPatternId: string,
): ConversionKind {
  const pattern = getPattern(targetPatternId);
  if (!pattern || pattern.freeform) return "freeform";
  const view = (doc.views ?? []).find((v) => v.id === sourceViewId);
  if (!view) return "freeform";
  const dataset = (doc.datasets ?? []).find((ds) => ds.id === view.datasetId);
  if (!dataset) return "freeform";
  return pattern.family === dataset.kind ? "same-family" : "cross-family";
}

// ---------------------------------------------------------------------------
// Record extraction (datasets → tag-keyed records)
// ---------------------------------------------------------------------------

/** Source field key → text. Matrix sources key by column id; others by tag. */
export type DatasetRecord = Record<string, string>;

export interface ExtractedRecords {
  records: DatasetRecord[];
  /** Ordered source fields, for mapping UIs + positional fallback. */
  fields: { key: string; tag: SemanticTag | null; label: string }[];
  /** Endpoint-label links carried by flow/network sources. */
  links: { from: string; to: string; label?: string }[];
  warnings: ConversionWarning[];
}

function matrixHeaderLabel(matrix: MatrixDataset, colId: string, index: number): string {
  const headerRow = matrix.rows.find((row) => row.role === "header") ?? matrix.rows[0];
  if (headerRow) {
    const cell = Object.values(matrix.cells).find(
      (c) => c.rowId === headerRow.id && c.colId === colId,
    );
    if (cell?.text.trim()) return cell.text.trim();
  }
  return `Column ${index + 1}`;
}

function matrixToRecords(matrix: MatrixDataset, warnings: ConversionWarning[]): DatasetRecord[] {
  // Anchor-cell lookup per grid position (span-aware).
  const rowIndex = new Map(matrix.rows.map((row, i) => [row.id, i]));
  const colIndex = new Map(matrix.columns.map((col, i) => [col.id, i]));
  const grid: (string | null)[][] = matrix.rows.map(() => matrix.columns.map(() => null));
  for (const cell of Object.values(matrix.cells)) {
    const r = rowIndex.get(cell.rowId);
    const c = colIndex.get(cell.colId);
    if (r === undefined || c === undefined) continue;
    for (let dr = 0; dr < (cell.rowSpan ?? 1); dr += 1) {
      for (let dc = 0; dc < (cell.colSpan ?? 1); dc += 1) {
        const row = grid[r + dr];
        if (row && r + dr < grid.length && c + dc < row.length) row[c + dc] = cell.id;
      }
    }
  }
  const cellText = (id: string | null): string => (id ? (matrix.cells[id]?.text ?? "") : "");
  let dropped = 0;
  const records: DatasetRecord[] = [];
  matrix.rows.forEach((row, r) => {
    if (row.role !== "data") {
      if (matrix.columns.some((col, c) => cellText(grid[r]?.[c] ?? null).trim())) dropped += 1;
      return;
    }
    const record: DatasetRecord = {};
    matrix.columns.forEach((col, c) => {
      record[col.id] = cellText(grid[r]?.[c] ?? null);
    });
    if (Object.values(record).some((text) => text.trim())) records.push(record);
  });
  if (dropped > 0) {
    warn(warnings, "diagram.pattern.warn.droppedRows", { count: String(dropped) });
  }
  return records;
}

/** Extract tag-keyed records (+ carried links) from any dataset kind. */
export function datasetToRecords(dataset: ReportDataset): ExtractedRecords {
  const warnings: ConversionWarning[] = [];
  switch (dataset.kind) {
    case "matrix": {
      const matrix = dataset as MatrixDataset;
      return {
        records: matrixToRecords(matrix, warnings),
        fields: matrix.columns.map((col, i) => ({
          key: col.id,
          tag: col.tag ?? null,
          label: matrixHeaderLabel(matrix, col.id, i),
        })),
        links: [],
        warnings,
      };
    }
    case "hierarchy": {
      const hierarchy = dataset as HierarchyDataset;
      const byId = new Map(hierarchy.nodes.map((n) => [n.id, n]));
      return {
        records: hierarchy.nodes.map((node) => ({
          label: node.label,
          parent: (node.parentId && byId.get(node.parentId)?.label) || "",
          ...(node.fields ?? {}),
        })),
        fields: [
          { key: "label", tag: "label", label: "label" },
          { key: "parent", tag: "parent", label: "parent" },
        ],
        links: [],
        warnings,
      };
    }
    case "timeline": {
      const timeline = dataset as TimelineDataset;
      return {
        records: timeline.items.map((item) => ({
          label: item.label,
          start: item.start,
          end: item.end,
          owner: item.owner ?? "",
          status: item.status ?? "",
        })),
        fields: ["label", "start", "end", "owner", "status"].map((tag) => ({
          key: tag,
          tag,
          label: tag,
        })),
        links: [],
        warnings,
      };
    }
    case "scorecard": {
      const scorecard = dataset as ScorecardDataset;
      return {
        records: scorecard.entries.map((entry) => ({
          label: entry.label,
          target: entry.target ?? "",
          actual: entry.actual ?? "",
          status: entry.status ?? "",
          evidence: entry.evidence ?? "",
        })),
        fields: ["label", "target", "actual", "status", "evidence"].map((tag) => ({
          key: tag,
          tag,
          label: tag,
        })),
        links: [],
        warnings,
      };
    }
    case "flow":
    case "network": {
      const graph = dataset as FlowDataset | NetworkDataset;
      const labelOf = new Map(graph.nodes.map((n) => [n.id, n.label]));
      const links = graph.links
        .filter((link) => labelOf.has(link.from) && labelOf.has(link.to))
        .map((link) => ({
          from: labelOf.get(link.from)!,
          to: labelOf.get(link.to)!,
          ...(("label" in link && link.label) ? { label: link.label } : {}),
        }));
      return {
        records: graph.nodes.map((node) => ({
          label: node.label,
          ...("group" in node && node.group ? { group: node.group } : {}),
        })),
        fields: [
          { key: "label", tag: "label", label: "label" },
          { key: "from", tag: "from", label: "from" },
          { key: "to", tag: "to", label: "to" },
        ],
        links,
        warnings,
      };
    }
  }
}

// ---------------------------------------------------------------------------
// Field mapping resolution
// ---------------------------------------------------------------------------

/** User-confirmed mapping: target semantic tag → source field key. */
export type FieldMapping = Record<string, string>;

interface MappingSpec {
  /** Tags filled positionally (in order) when neither user-mapped nor tagged. */
  positional: SemanticTag[];
  /** Tags used only when user-mapped or explicitly tagged on the source. */
  optional: SemanticTag[];
}

const MAPPING_SPECS: Record<ReportDataset["kind"], MappingSpec> = {
  hierarchy: { positional: ["label", "parent"], optional: [] },
  timeline: { positional: ["label", "start", "end"], optional: ["owner", "status"] },
  scorecard: {
    positional: ["label"],
    optional: ["target", "actual", "status", "evidence"],
  },
  flow: { positional: ["label"], optional: ["from", "to"] },
  network: { positional: ["label"], optional: ["from", "to"] },
  matrix: {
    positional: ["label"],
    optional: ["parent", "owner", "start", "end", "target", "actual", "status", "evidence"],
  },
};

export interface ResolvedMapping {
  /** target tag → source field key */
  mapping: FieldMapping;
  warnings: ConversionWarning[];
}

/**
 * Resolve the effective mapping: user-confirmed assignments win, explicit
 * source tags fill the rest, still-missing positional tags fall back to
 * remaining source fields in order (with one warning), and every unconsumed
 * source field produces an `unmappedColumn` warning.
 */
export function resolveMapping(
  fields: ExtractedRecords["fields"],
  userMapping: FieldMapping,
  spec: MappingSpec,
): ResolvedMapping {
  const warnings: ConversionWarning[] = [];
  const knownKeys = new Set(fields.map((f) => f.key));
  const mapping: FieldMapping = {};
  const used = new Set<string>();

  for (const [tag, key] of Object.entries(userMapping)) {
    if (!knownKeys.has(key)) {
      warn(warnings, "diagram.pattern.warn.unknownMappingSource", { field: key });
      continue;
    }
    mapping[tag] = key;
    used.add(key);
  }

  const wanted = [...spec.positional, ...spec.optional];
  for (const tag of wanted) {
    if (mapping[tag]) continue;
    const tagged = fields.find((f) => f.tag === tag && !used.has(f.key));
    if (tagged) {
      mapping[tag] = tagged.key;
      used.add(tagged.key);
    }
  }

  const positionalFilled: string[] = [];
  for (const tag of spec.positional) {
    if (mapping[tag]) continue;
    const next = fields.find((f) => !used.has(f.key));
    if (!next) continue;
    mapping[tag] = next.key;
    used.add(next.key);
    positionalFilled.push(tag);
  }
  if (positionalFilled.length > 0) {
    warn(warnings, "diagram.pattern.warn.positionalFallback", {
      fields: positionalFilled.join(", "),
    });
  }

  // Label is non-negotiable: reuse the first field when everything is taken.
  if (!mapping.label && fields.length > 0) {
    mapping.label = fields[0]!.key;
    used.add(fields[0]!.key);
  }

  for (const field of fields) {
    // from/to are structural tags, not columns to consume — skip the warning
    // for record sources that only carry them for link mode.
    if (!used.has(field.key) && field.key !== "from" && field.key !== "to") {
      warn(warnings, "diagram.pattern.warn.unmappedColumn", { field: field.label });
    }
  }
  return { mapping, warnings };
}

// ---------------------------------------------------------------------------
// Target dataset builders (records + mapping → new dataset)
// ---------------------------------------------------------------------------

function buildHierarchyFromRecords(
  records: DatasetRecord[],
  mapping: FieldMapping,
  name: string,
  warnings: ConversionWarning[],
): HierarchyDataset {
  const nodes: HierarchyDataset["nodes"] = [];
  const parentLabels: (string | null)[] = [];
  let skipped = 0;
  for (const record of records) {
    const label = (record[mapping.label ?? ""] ?? "").trim();
    if (!label) {
      skipped += 1;
      continue;
    }
    nodes.push({ id: createDiagramId("hn"), parentId: null, label });
    parentLabels.push(mapping.parent ? (record[mapping.parent] ?? "").trim() : null);
  }
  if (skipped > 0) {
    warn(warnings, "diagram.pattern.warn.missingLabel", { count: String(skipped) });
  }
  // Second pass: resolve parent labels to ids (first match wins).
  const byLabel = new Map<string, string>();
  for (const node of nodes) {
    if (!byLabel.has(node.label)) byLabel.set(node.label, node.id);
  }
  nodes.forEach((node, i) => {
    const parentLabel = parentLabels[i];
    if (!parentLabel) return;
    const parentId = byLabel.get(parentLabel);
    if (parentId && parentId !== node.id) {
      node.parentId = parentId;
    } else {
      warn(warnings, "diagram.pattern.warn.unmatchedParent", { value: parentLabel });
    }
  });
  return { id: createDatasetId(), kind: "hierarchy", name, nodes };
}

function buildTimelineFromRecords(
  records: DatasetRecord[],
  mapping: FieldMapping,
  name: string,
  warnings: ConversionWarning[],
): TimelineDataset {
  const items: TimelineDataset["items"] = [];
  let skipped = 0;
  for (const record of records) {
    const label = (record[mapping.label ?? ""] ?? "").trim();
    if (!label) {
      skipped += 1;
      continue;
    }
    items.push({
      id: createDiagramId("ti"),
      label,
      start: record[mapping.start ?? ""] ?? "",
      end: record[mapping.end ?? ""] ?? "",
      ...(mapping.owner && record[mapping.owner]?.trim()
        ? { owner: record[mapping.owner] }
        : {}),
      ...(mapping.status && record[mapping.status]?.trim()
        ? { status: record[mapping.status] }
        : {}),
    });
  }
  if (skipped > 0) {
    warn(warnings, "diagram.pattern.warn.missingLabel", { count: String(skipped) });
  }
  return { id: createDatasetId(), kind: "timeline", name, items };
}

function buildScorecardFromRecords(
  records: DatasetRecord[],
  mapping: FieldMapping,
  name: string,
  warnings: ConversionWarning[],
): ScorecardDataset {
  const entries: ScorecardDataset["entries"] = [];
  let skipped = 0;
  for (const record of records) {
    const label = (record[mapping.label ?? ""] ?? "").trim();
    if (!label) {
      skipped += 1;
      continue;
    }
    const pick = (tag: string): string | undefined => {
      const key = mapping[tag];
      const value = key ? record[key] : undefined;
      return value?.trim() ? value : undefined;
    };
    entries.push({
      id: createDiagramId("kpi"),
      label,
      ...(pick("target") !== undefined ? { target: pick("target") } : {}),
      ...(pick("actual") !== undefined ? { actual: pick("actual") } : {}),
      ...(pick("status") !== undefined ? { status: pick("status") } : {}),
      ...(pick("evidence") !== undefined ? { evidence: pick("evidence") } : {}),
    });
  }
  if (skipped > 0) {
    warn(warnings, "diagram.pattern.warn.missingLabel", { count: String(skipped) });
  }
  return { id: createDatasetId(), kind: "scorecard", name, entries };
}

function buildFlowFromRecords(
  records: DatasetRecord[],
  mapping: FieldMapping,
  carriedLinks: ExtractedRecords["links"],
  name: string,
  warnings: ConversionWarning[],
): FlowDataset {
  const nodeIds = new Map<string, string>();
  const nodeFor = (label: string): string => {
    const existing = nodeIds.get(label);
    if (existing) return existing;
    const id = createDiagramId("fn");
    nodeIds.set(label, id);
    return id;
  };
  const links: FlowDataset["links"] = [];
  const linkMode = Boolean(mapping.from && mapping.to);
  if (linkMode) {
    for (const record of records) {
      const from = (record[mapping.from!] ?? "").trim();
      const to = (record[mapping.to!] ?? "").trim();
      if (!from || !to) continue;
      const label = mapping.label ? record[mapping.label]?.trim() : "";
      links.push({
        id: createDiagramId("fl"),
        from: nodeFor(from),
        to: nodeFor(to),
        ...(label ? { label } : {}),
      });
    }
  } else {
    // Sequence mode: chain the label records in order.
    const ordered = records
      .map((record) => (record[mapping.label ?? ""] ?? "").trim())
      .filter((label) => label.length > 0);
    for (const label of ordered) nodeFor(label);
    for (let i = 1; i < ordered.length; i += 1) {
      links.push({
        id: createDiagramId("fl"),
        from: nodeFor(ordered[i - 1]!),
        to: nodeFor(ordered[i]!),
      });
    }
  }
  // Carried links (flow/network sources) are preserved when endpoints exist.
  for (const link of carriedLinks) {
    if (!nodeIds.has(link.from) || !nodeIds.has(link.to)) continue;
    links.push({
      id: createDiagramId("fl"),
      from: nodeFor(link.from)!,
      to: nodeFor(link.to)!,
      ...(link.label ? { label: link.label } : {}),
    });
  }
  const nodes: FlowDataset["nodes"] = [...nodeIds.entries()].map(([label, id]) => ({ id, label }));
  return { id: createDatasetId(), kind: "flow", name, nodes, links };
}

function buildNetworkFromRecords(
  records: DatasetRecord[],
  mapping: FieldMapping,
  carriedLinks: ExtractedRecords["links"],
  name: string,
): NetworkDataset {
  const nodes: NetworkDataset["nodes"] = [];
  const nodeIds = new Map<string, string>();
  const nodeFor = (label: string, group?: string): string => {
    const existing = nodeIds.get(label);
    if (existing) return existing;
    const id = createDiagramId("nn");
    nodeIds.set(label, id);
    nodes.push({ id, label, ...(group?.trim() ? { group } : {}) });
    return id;
  };
  for (const record of records) {
    const label = (record[mapping.label ?? ""] ?? "").trim();
    if (label) nodeFor(label, record.group);
  }
  const links: NetworkDataset["links"] = [];
  if (mapping.from && mapping.to) {
    for (const record of records) {
      const from = (record[mapping.from!] ?? "").trim();
      const to = (record[mapping.to!] ?? "").trim();
      if (!from || !to) continue;
      links.push({ id: createDiagramId("nl"), from: nodeFor(from), to: nodeFor(to) });
    }
  }
  for (const link of carriedLinks) {
    if (!nodeIds.has(link.from) || !nodeIds.has(link.to)) continue;
    links.push({ id: createDiagramId("nl"), from: nodeFor(link.from)!, to: nodeFor(link.to)! });
  }
  return { id: createDatasetId(), kind: "network", name, nodes, links };
}

function buildMatrixFromRecords(
  records: DatasetRecord[],
  mapping: FieldMapping,
  name: string,
): MatrixDataset {
  const entries = Object.entries(mapping).sort(
    ([a], [b]) =>
      (KNOWN_SEMANTIC_TAGS.indexOf(a as (typeof KNOWN_SEMANTIC_TAGS)[number]) + 1 || 99) -
      (KNOWN_SEMANTIC_TAGS.indexOf(b as (typeof KNOWN_SEMANTIC_TAGS)[number]) + 1 || 99),
  );
  const columns = entries.map(([tag]) => ({
    id: createDiagramId("col"),
    ...(KNOWN_SEMANTIC_TAGS.includes(tag as (typeof KNOWN_SEMANTIC_TAGS)[number])
      ? { tag: tag as SemanticTag }
      : {}),
  }));
  const rows: MatrixDataset["rows"] = [];
  const cells: MatrixDataset["cells"] = {};
  for (const record of records) {
    const row = { id: createDiagramId("row"), role: "data" as const };
    rows.push(row);
    entries.forEach(([, sourceKey], c) => {
      const col = columns[c]!;
      const cell = {
        id: createDiagramId("cell"),
        rowId: row.id,
        colId: col.id,
        text: record[sourceKey] ?? "",
      };
      cells[cell.id] = cell;
    });
  }
  return { id: createDatasetId(), kind: "matrix", name, columns, rows, cells };
}

// ---------------------------------------------------------------------------
// Tag-driven matrix extraction helpers (exported per spec)
// ---------------------------------------------------------------------------

export interface ExtractionResult<T extends ReportDataset> {
  dataset: T;
  warnings: ConversionWarning[];
}

function extractFromMatrix<T extends ReportDataset>(
  matrix: MatrixDataset,
  userMapping: FieldMapping,
  targetKind: ReportDataset["kind"],
  build: (
    records: DatasetRecord[],
    mapping: FieldMapping,
    warnings: ConversionWarning[],
  ) => T,
): ExtractionResult<T> {
  const warnings: ConversionWarning[] = [];
  const records = matrixToRecords(matrix, warnings);
  const fields = matrix.columns.map((col, i) => ({
    key: col.id,
    tag: col.tag ?? null,
    label: matrixHeaderLabel(matrix, col.id, i),
  }));
  const resolved = resolveMapping(fields, userMapping, MAPPING_SPECS[targetKind]);
  warnings.push(...resolved.warnings);
  return { dataset: build(records, resolved.mapping, warnings), warnings };
}

export function matrixToHierarchy(
  matrix: MatrixDataset,
  mapping: FieldMapping = {},
): ExtractionResult<HierarchyDataset> {
  return extractFromMatrix(matrix, mapping, "hierarchy", (records, resolved, warnings) =>
    buildHierarchyFromRecords(records, resolved, matrix.name, warnings),
  );
}

export function matrixToTimeline(
  matrix: MatrixDataset,
  mapping: FieldMapping = {},
): ExtractionResult<TimelineDataset> {
  return extractFromMatrix(matrix, mapping, "timeline", (records, resolved, warnings) =>
    buildTimelineFromRecords(records, resolved, matrix.name, warnings),
  );
}

export function matrixToScorecard(
  matrix: MatrixDataset,
  mapping: FieldMapping = {},
): ExtractionResult<ScorecardDataset> {
  return extractFromMatrix(matrix, mapping, "scorecard", (records, resolved, warnings) =>
    buildScorecardFromRecords(records, resolved, matrix.name, warnings),
  );
}

export function matrixToFlow(
  matrix: MatrixDataset,
  mapping: FieldMapping = {},
): ExtractionResult<FlowDataset> {
  return extractFromMatrix(matrix, mapping, "flow", (records, resolved, warnings) =>
    buildFlowFromRecords(records, resolved, [], matrix.name, warnings),
  );
}

export function matrixToNetwork(
  matrix: MatrixDataset,
  mapping: FieldMapping = {},
): ExtractionResult<NetworkDataset> {
  return extractFromMatrix(matrix, mapping, "network", (records, resolved, _warnings) =>
    buildNetworkFromRecords(records, resolved, [], matrix.name),
  );
}

// ---------------------------------------------------------------------------
// View materialization (deterministic, view-scoped member ids)
// ---------------------------------------------------------------------------

export function viewProjectionHash(
  patternId: string,
  dataset: ReportDataset,
  bounds: PatternViewBounds,
): string {
  return computeProjectionHash({ patternId, dataset, bounds });
}

/**
 * Run `buildView` and remap member ids into the view's namespace
 * (`<base>#<viewId>`), stamping `meta.viewId`. Deterministic when the
 * pattern's `buildView` is deterministic (all report patterns are), so
 * regenerating an unchanged view reproduces identical members.
 */
export function materializeView(
  pattern: PatternDefinition,
  dataset: ReportDataset,
  viewId: string,
  bounds: PatternViewBounds,
  opts: ConversionOpts = {},
): { nodes: DiagramNode[]; edges: DiagramEdge[] } {
  const out = pattern.buildView({ dataset, bounds, theme: opts.theme, t: opts.t ?? passthroughT });
  const idMap = new Map(out.nodes.map((node) => [node.id, `${node.id}#${viewId}`]));
  const nodes: DiagramNode[] = out.nodes.map((node) => ({
    ...node,
    id: idMap.get(node.id)!,
    meta: { ...(node.meta ?? {}), viewId },
  }));
  const edges: DiagramEdge[] = out.edges.map((edge) => ({
    ...edge,
    id: `${edge.id}#${viewId}`,
    fromNode: idMap.get(edge.fromNode) ?? edge.fromNode,
    toNode: idMap.get(edge.toNode) ?? edge.toNode,
  }));
  return { nodes, edges };
}

function requireViewAndPattern(
  doc: DiagramDoc,
  viewId: string,
  patternId?: string,
): { view: PatternView; pattern: PatternDefinition; dataset: ReportDataset } {
  const view = (doc.views ?? []).find((v) => v.id === viewId);
  if (!view) throw new Error(`pattern view not found: ${viewId}`);
  const pattern = getPattern(patternId ?? view.patternId);
  if (!pattern) throw new Error(`pattern not found: ${patternId ?? view.patternId}`);
  const dataset = (doc.datasets ?? []).find((ds) => ds.id === view.datasetId);
  if (!dataset) throw new Error(`dataset not found: ${view.datasetId}`);
  return { view, pattern, dataset };
}

function replaceViewMembers(
  doc: DiagramDoc,
  view: PatternView,
  nodes: DiagramNode[],
  edges: DiagramEdge[],
  patch: Partial<PatternView>,
): DiagramDoc {
  const oldNodeIds = new Set(view.nodeIds);
  const oldEdgeIds = new Set(view.edgeIds);
  const nextView: PatternView = {
    ...view,
    ...patch,
    nodeIds: nodes.map((node) => node.id),
    edgeIds: edges.map((edge) => edge.id),
  };
  return {
    ...doc,
    nodes: [...doc.nodes.filter((node) => !oldNodeIds.has(node.id)), ...nodes],
    edges: [...doc.edges.filter((edge) => !oldEdgeIds.has(edge.id)), ...edges],
    views: (doc.views ?? []).map((v) => (v.id === view.id ? nextView : v)),
  };
}

// ---------------------------------------------------------------------------
// Same-family switch + linked views
// ---------------------------------------------------------------------------

/** Regenerate a view's members from the SAME dataset via another same-family pattern. */
export function switchViewPattern(
  doc: DiagramDoc,
  viewId: string,
  targetPatternId: string,
  opts: ConversionOpts = {},
): DiagramDoc {
  const { view, pattern, dataset } = requireViewAndPattern(doc, viewId, targetPatternId);
  if (pattern.freeform) throw new Error(`pattern ${targetPatternId} is freeform`);
  if (pattern.family !== dataset.kind) {
    throw new Error(
      `pattern ${targetPatternId} (${pattern.family}) is not same-family with dataset ${dataset.id} (${dataset.kind})`,
    );
  }
  const { nodes, edges } = materializeView(pattern, dataset, view.id, view.bounds, {
    ...opts,
    theme: opts.theme ?? view.theme,
  });
  return replaceViewMembers(doc, view, nodes, edges, {
    patternId: pattern.id,
    projectionHash: viewProjectionHash(pattern.id, dataset, view.bounds),
  });
}

/** Add a second live view of an existing dataset. */
export function addLinkedView(
  doc: DiagramDoc,
  datasetId: string,
  patternId: string,
  bounds: PatternViewBounds,
  opts: ConversionOpts = {},
): DiagramDoc {
  const dataset = (doc.datasets ?? []).find((ds) => ds.id === datasetId);
  if (!dataset) throw new Error(`dataset not found: ${datasetId}`);
  const pattern = getPattern(patternId);
  if (!pattern) throw new Error(`pattern not found: ${patternId}`);
  if (pattern.freeform) throw new Error(`pattern ${patternId} is freeform`);
  if (pattern.family !== dataset.kind) {
    throw new Error(
      `pattern ${patternId} (${pattern.family}) cannot project dataset ${datasetId} (${dataset.kind})`,
    );
  }
  const viewId = createPatternViewId();
  const { nodes, edges } = materializeView(pattern, dataset, viewId, bounds, opts);
  const view: PatternView = {
    id: viewId,
    datasetId,
    patternId,
    bounds,
    ...(opts.theme ? { theme: opts.theme } : {}),
    nodeIds: nodes.map((node) => node.id),
    edgeIds: edges.map((edge) => edge.id),
    projectionHash: viewProjectionHash(patternId, dataset, bounds),
  };
  return {
    ...doc,
    nodes: [...doc.nodes, ...nodes],
    edges: [...doc.edges, ...edges],
    views: [...(doc.views ?? []), view],
  };
}

// ---------------------------------------------------------------------------
// Cross-family conversion (new dataset; source untouched)
// ---------------------------------------------------------------------------

export interface CrossConversionResult {
  doc: DiagramDoc;
  warnings: string[];
}

/**
 * Convert a view's dataset into a NEW dataset of the target pattern's family.
 * The source dataset + view are left untouched. `mapping` is the
 * user-confirmed target-tag → source-field assignment; unresolved tags fall
 * back to source tags, then positionally (with warnings).
 */
export function convertToNewDataset(
  doc: DiagramDoc,
  sourceViewId: string,
  targetPatternId: string,
  mapping: FieldMapping = {},
  opts: ConversionOpts & { bounds?: PatternViewBounds } = {},
): CrossConversionResult {
  const { view, pattern, dataset } = requireViewAndPattern(doc, sourceViewId, targetPatternId);
  if (pattern.freeform) throw new Error(`pattern ${targetPatternId} is freeform`);
  if (pattern.family === dataset.kind) {
    throw new Error(`pattern ${targetPatternId} is same-family; use switchViewPattern`);
  }
  const extracted = datasetToRecords(dataset);
  const warnings: ConversionWarning[] = [...extracted.warnings];
  const resolved = resolveMapping(extracted.fields, mapping, MAPPING_SPECS[pattern.family]);
  warnings.push(...resolved.warnings);
  if (extracted.links.length > 0 && pattern.family !== "flow" && pattern.family !== "network") {
    warn(warnings, "diagram.pattern.warn.droppedLinks", {
      count: String(extracted.links.length),
    });
  }

  let newDataset: ReportDataset;
  switch (pattern.family) {
    case "hierarchy":
      newDataset = buildHierarchyFromRecords(extracted.records, resolved.mapping, dataset.name, warnings);
      break;
    case "timeline":
      newDataset = buildTimelineFromRecords(extracted.records, resolved.mapping, dataset.name, warnings);
      break;
    case "scorecard":
      newDataset = buildScorecardFromRecords(extracted.records, resolved.mapping, dataset.name, warnings);
      break;
    case "flow":
      newDataset = buildFlowFromRecords(extracted.records, resolved.mapping, extracted.links, dataset.name, warnings);
      break;
    case "network":
      newDataset = buildNetworkFromRecords(extracted.records, resolved.mapping, extracted.links, dataset.name);
      break;
    case "matrix":
      newDataset = buildMatrixFromRecords(extracted.records, resolved.mapping, dataset.name);
      break;
  }

  const bounds = opts.bounds ?? {
    x: view.bounds.x + 48,
    y: view.bounds.y + 48,
    w: view.bounds.w,
    h: view.bounds.h,
  };
  const viewId = createPatternViewId();
  const { nodes, edges } = materializeView(pattern, newDataset, viewId, bounds, opts);
  const newView: PatternView = {
    id: viewId,
    datasetId: newDataset.id,
    patternId: pattern.id,
    bounds,
    ...(opts.theme ? { theme: opts.theme } : {}),
    nodeIds: nodes.map((node) => node.id),
    edgeIds: edges.map((edge) => edge.id),
    projectionHash: viewProjectionHash(pattern.id, newDataset, bounds),
  };
  return {
    doc: {
      ...doc,
      nodes: [...doc.nodes, ...nodes],
      edges: [...doc.edges, ...edges],
      datasets: [...(doc.datasets ?? []), newDataset],
      views: [...(doc.views ?? []), newView],
    },
    warnings: formatWarnings(warnings, opts.t),
  };
}

// ---------------------------------------------------------------------------
// Projection sync
// ---------------------------------------------------------------------------

/**
 * Re-run `buildView` for a view after dataset edits. No-op when the
 * projection hash (pattern + dataset + bounds) is unchanged. Member style
 * overrides survive keyed by member index only when the member count is
 * unchanged; otherwise styles reset to pattern defaults. Member text always
 * regenerates from the dataset.
 */
export function regenerateView(doc: DiagramDoc, viewId: string, opts: ConversionOpts = {}): DiagramDoc {
  const { view, pattern, dataset } = requireViewAndPattern(doc, viewId);
  if (pattern.freeform) throw new Error(`pattern ${view.patternId} is freeform`);
  const hash = viewProjectionHash(pattern.id, dataset, view.bounds);
  if (hash === view.projectionHash) return doc;
  const { nodes, edges } = materializeView(pattern, dataset, view.id, view.bounds, {
    ...opts,
    theme: opts.theme ?? view.theme,
  });
  const oldMembers = view.nodeIds
    .map((id) => doc.nodes.find((node) => node.id === id))
    .filter((node): node is DiagramNode => Boolean(node));
  if (oldMembers.length === nodes.length) {
    oldMembers.forEach((old, i) => {
      if (old.style) nodes[i]!.style = { ...old.style };
    });
  }
  return replaceViewMembers(doc, view, nodes, edges, { projectionHash: hash });
}

// ---------------------------------------------------------------------------
// Detach (projection → freeform layout snippet)
// ---------------------------------------------------------------------------

function stripLinkage(node: DiagramNode, datasetIds: Set<string>): DiagramNode {
  if (!node.meta) return node;
  const meta = { ...node.meta };
  delete meta.viewId;
  // A table node's memberId is its dataset pointer — keep it so the detached
  // snippet keeps rendering; everything else loses member linkage.
  const memberId = meta.memberId;
  if (!(node.kind === "table" && typeof memberId === "string" && datasetIds.has(memberId))) {
    delete meta.memberId;
  }
  const next = { ...node };
  if (Object.keys(meta).length > 0) next.meta = meta;
  else delete next.meta;
  return next;
}

/** Detach selected members from a view: they become freeform, the view keeps the rest. */
export function detachViewMembers(doc: DiagramDoc, viewId: string, nodeIds: string[]): DiagramDoc {
  const view = (doc.views ?? []).find((v) => v.id === viewId);
  if (!view) return doc;
  const ids = new Set(nodeIds.filter((id) => view.nodeIds.includes(id)));
  if (ids.size === 0) return doc;
  const datasetIds = new Set((doc.datasets ?? []).map((ds) => ds.id));
  return {
    ...doc,
    nodes: doc.nodes.map((node) => (ids.has(node.id) ? stripLinkage(node, datasetIds) : node)),
    views: (doc.views ?? []).map((v) =>
      v.id === viewId ? { ...v, nodeIds: v.nodeIds.filter((id) => !ids.has(id)) } : v,
    ),
  };
}

/** Remove the whole view entry; members stay on canvas as freeform content. */
export function detachWholeView(doc: DiagramDoc, viewId: string): DiagramDoc {
  const view = (doc.views ?? []).find((v) => v.id === viewId);
  if (!view) return doc;
  const ids = new Set(view.nodeIds);
  const datasetIds = new Set((doc.datasets ?? []).map((ds) => ds.id));
  return {
    ...doc,
    nodes: doc.nodes.map((node) => (ids.has(node.id) ? stripLinkage(node, datasetIds) : node)),
    views: (doc.views ?? []).filter((v) => v.id !== viewId),
  };
}

// ---------------------------------------------------------------------------
// StateTransformer wrappers (dispatch via withSnapshot; pre-compute the pure
// doc first so thrown errors surface before any state mutation)
// ---------------------------------------------------------------------------

/** Apply a pure doc→doc function; no-op when the doc is unchanged. */
export function applyDocChange(fn: (doc: DiagramDoc) => DiagramDoc): StateTransformer {
  return (state) => {
    const next = fn(state.doc);
    if (next === state.doc) return state;
    return { ...state, doc: next };
  };
}

export function switchViewPatternAction(
  viewId: string,
  targetPatternId: string,
  opts: ConversionOpts = {},
): StateTransformer {
  return applyDocChange((doc) => switchViewPattern(doc, viewId, targetPatternId, opts));
}

export function addLinkedViewAction(
  datasetId: string,
  patternId: string,
  bounds: PatternViewBounds,
  opts: ConversionOpts = {},
): StateTransformer {
  return applyDocChange((doc) => addLinkedView(doc, datasetId, patternId, bounds, opts));
}

/**
 * Dispatch a pre-computed doc (e.g. from `convertToNewDataset`, which also
 * returns warnings the UI shows before committing).
 */
export function replaceDoc(nextDoc: DiagramDoc): StateTransformer {
  return applyDocChange(() => nextDoc);
}

export function regenerateViewAction(viewId: string, opts: ConversionOpts = {}): StateTransformer {
  return applyDocChange((doc) => regenerateView(doc, viewId, opts));
}

export function detachViewMembersAction(viewId: string, nodeIds: string[]): StateTransformer {
  return applyDocChange((doc) => detachViewMembers(doc, viewId, nodeIds));
}

export function detachWholeViewAction(viewId: string): StateTransformer {
  return applyDocChange((doc) => detachWholeView(doc, viewId));
}
