/**
 * Report Pattern Studio — typed report datasets and pattern views (schema v8).
 *
 * A `ReportDataset` holds structured report data (the important variant is the
 * `matrix` — a span-aware table model). A `PatternView` binds a dataset to a
 * visual pattern (`patternId`) placed on the diagram canvas. Non-matrix
 * payloads are typed skeletons to be fleshed out in Phase 2.
 *
 * Matrix span convention: a cell with `rowSpan`/`colSpan` > 1 anchors at its
 * (`rowId`, `colId`) and covers the rectangle extending right/down. Covered
 * positions hold no cell of their own, so every grid position is covered by
 * exactly one anchor cell — `validateMatrix` enforces this.
 */

import { createDiagramId } from "./types";
import type { ReportTableFixture } from "./__fixtures__/reports";

// ---------------------------------------------------------------------------
// Semantic tags
// ---------------------------------------------------------------------------

export type KnownSemanticTag =
  | "label"
  | "parent"
  | "owner"
  | "start"
  | "end"
  | "target"
  | "actual"
  | "status"
  | "evidence"
  | "from"
  | "to";

/** Known tags are enumerated, but any string is allowed for extension. */
export type SemanticTag = KnownSemanticTag | (string & {});

export const KNOWN_SEMANTIC_TAGS: readonly KnownSemanticTag[] = [
  "label",
  "parent",
  "owner",
  "start",
  "end",
  "target",
  "actual",
  "status",
  "evidence",
  "from",
  "to",
];

// ---------------------------------------------------------------------------
// Matrix dataset
// ---------------------------------------------------------------------------

export const MATRIX_MAX_ROWS = 200;
export const MATRIX_MAX_COLS = 50;
export const MATRIX_MAX_RENDERED_CELLS = 5000;

export interface MatrixColumn {
  id: string;
  width?: number;
  tag?: SemanticTag;
  headerLevel?: number;
}

export type MatrixRowRole = "data" | "header" | "group" | "subtotal";

export interface MatrixRow {
  id: string;
  height?: number;
  role: MatrixRowRole;
}

export type MatrixBorderSide = "top" | "right" | "bottom" | "left";

/** Per-cell style subset (CSS border shorthand per side). */
export interface MatrixCellStyle {
  align?: "left" | "center" | "right";
  bold?: boolean;
  bg?: string;
  color?: string;
  borders?: Partial<Record<MatrixBorderSide, string>>;
}

export interface MatrixCell {
  id: string;
  rowId: string;
  colId: string;
  rowSpan?: number;
  colSpan?: number;
  text: string;
  bullets?: string[];
  links?: string[];
  evidence?: string[];
  style?: MatrixCellStyle;
  role?: MatrixRowRole;
}

export interface MatrixDataset {
  id: string;
  kind: "matrix";
  name: string;
  columns: MatrixColumn[];
  rows: MatrixRow[];
  /** Keyed by stable cell id. */
  cells: Record<string, MatrixCell>;
}

// ---------------------------------------------------------------------------
// Non-matrix dataset skeletons (fleshed out in Phase 2)
// ---------------------------------------------------------------------------

export interface HierarchyNode {
  id: string;
  parentId: string | null;
  label: string;
  fields?: Record<string, string>;
}

export interface HierarchyDataset {
  id: string;
  kind: "hierarchy";
  name: string;
  nodes: HierarchyNode[];
}

export interface TimelineItem {
  id: string;
  label: string;
  start: string;
  end: string;
  owner?: string;
  status?: string;
}

export interface TimelineDataset {
  id: string;
  kind: "timeline";
  name: string;
  items: TimelineItem[];
}

export interface FlowNode {
  id: string;
  label: string;
  kind?: string;
}

export interface FlowLink {
  id: string;
  from: string;
  to: string;
  label?: string;
}

export interface FlowDataset {
  id: string;
  kind: "flow";
  name: string;
  nodes: FlowNode[];
  links: FlowLink[];
}

export interface NetworkNode {
  id: string;
  label: string;
  group?: string;
}

export interface NetworkLink {
  id: string;
  from: string;
  to: string;
  weight?: number;
}

export interface NetworkDataset {
  id: string;
  kind: "network";
  name: string;
  nodes: NetworkNode[];
  links: NetworkLink[];
}

export interface ScorecardEntry {
  id: string;
  label: string;
  target?: string;
  actual?: string;
  status?: string;
  evidence?: string;
}

export interface ScorecardDataset {
  id: string;
  kind: "scorecard";
  name: string;
  entries: ScorecardEntry[];
}

export type ReportDataset =
  | MatrixDataset
  | HierarchyDataset
  | TimelineDataset
  | FlowDataset
  | NetworkDataset
  | ScorecardDataset;

export type ReportDatasetKind = ReportDataset["kind"];

// ---------------------------------------------------------------------------
// Pattern views
// ---------------------------------------------------------------------------

export interface PatternViewBounds {
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface PatternView {
  id: string;
  datasetId: string;
  patternId: string;
  bounds: PatternViewBounds;
  theme?: string;
  nodeIds: string[];
  edgeIds: string[];
  projectionHash: string;
  page?: number;
}

/** Well-known pattern ids. */
export const TABLE_PATTERN_ID = "table";

// ---------------------------------------------------------------------------
// Typed node metadata (replaces ad-hoc `meta` keys for new features)
// ---------------------------------------------------------------------------

export interface TypedNodeMeta {
  viewId?: string;
  memberId?: string;
  src?: string;
  name?: string;
  memo?: string;
  status?: string;
  progress?: number;
  number?: number;
}

export const TYPED_NODE_META_KEYS: readonly (keyof TypedNodeMeta)[] = [
  "viewId",
  "memberId",
  "src",
  "name",
  "memo",
  "status",
  "progress",
  "number",
];

// ---------------------------------------------------------------------------
// Stable id generators (same pattern as `createDiagramId`)
// ---------------------------------------------------------------------------

export function createDatasetId(): string {
  return createDiagramId("dataset");
}

export function createPatternViewId(): string {
  return createDiagramId("view");
}

export function createMatrixRowId(): string {
  return createDiagramId("row");
}

export function createMatrixColumnId(): string {
  return createDiagramId("col");
}

export function createMatrixCellId(): string {
  return createDiagramId("cell");
}

// ---------------------------------------------------------------------------
// Projection hash (stable stringify + FNV-1a — no dependencies)
// ---------------------------------------------------------------------------

function stableStringify(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  const obj = value as Record<string, unknown>;
  const keys = Object.keys(obj).sort();
  const parts = keys.map((k) => `${JSON.stringify(k)}:${stableStringify(obj[k])}`);
  return `{${parts.join(",")}}`;
}

/** 32-bit FNV-1a over the stable stringification of `input`. */
export function computeProjectionHash(input: unknown): string {
  const text = stableStringify(input);
  let hash = 0x811c9dc5;
  for (let i = 0; i < text.length; i += 1) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(16).padStart(8, "0");
}

// ---------------------------------------------------------------------------
// Matrix construction
// ---------------------------------------------------------------------------

/** Build an empty rows×cols matrix with fresh stable ids. */
export function matrixFromRowsCols(
  rowCount: number,
  colCount: number,
  opts: { id?: string; name?: string } = {},
): MatrixDataset {
  const rows: MatrixRow[] = [];
  const columns: MatrixColumn[] = [];
  const cells: Record<string, MatrixCell> = {};
  for (let c = 0; c < colCount; c += 1) {
    columns.push({ id: createMatrixColumnId() });
  }
  for (let r = 0; r < rowCount; r += 1) {
    const row: MatrixRow = { id: createMatrixRowId(), role: "data" };
    rows.push(row);
    for (const col of columns) {
      const cell: MatrixCell = {
        id: createMatrixCellId(),
        rowId: row.id,
        colId: col.id,
        text: "",
      };
      cells[cell.id] = cell;
    }
  }
  return {
    id: opts.id ?? createDatasetId(),
    kind: "matrix",
    name: opts.name ?? "",
    columns,
    rows,
    cells,
  };
}

function inferRowRole(cells: { text: string; colSpan?: number }[], colCount: number): MatrixRowRole {
  if (cells.length === 1) {
    const only = cells[0];
    if (only && (only.colSpan ?? 1) >= colCount) return "group";
  }
  const first = cells[0]?.text.trim() ?? "";
  if (/^(subtotal|total)/i.test(first)) return "subtotal";
  return "data";
}

/** Adapt a Phase 0 report-table fixture into a valid matrix dataset. */
export function fixtureToMatrix(fixture: ReportTableFixture): MatrixDataset {
  const columns: MatrixColumn[] = fixture.columns.map(() => ({ id: createMatrixColumnId() }));
  const rows: MatrixRow[] = [];
  const cells: Record<string, MatrixCell> = {};
  // Positions covered by a rowSpan anchored in an earlier row. Fixture rows
  // omit covered cells, so the column cursor must skip these positions.
  const covered = new Set<string>();
  fixture.rows.forEach((fixtureRow, r) => {
    const row: MatrixRow = { id: createMatrixRowId(), role: inferRowRole(fixtureRow, columns.length) };
    rows.push(row);
    let c = 0;
    for (const fixtureCell of fixtureRow) {
      while (covered.has(`${r}:${c}`)) c += 1;
      if (c >= columns.length) break;
      const col = columns[c];
      if (!col) break;
      const colSpan = Math.max(1, fixtureCell.colSpan ?? 1);
      const rowSpan = Math.max(1, fixtureCell.rowSpan ?? 1);
      // Clamp spans so the adapter never emits an out-of-range cell, even for
      // a malformed fixture.
      const clampedColSpan = Math.min(colSpan, columns.length - c);
      const clampedRowSpan = Math.min(rowSpan, fixture.rows.length - r);
      const cell: MatrixCell = {
        id: createMatrixCellId(),
        rowId: row.id,
        colId: col.id,
        text: fixtureCell.text,
      };
      if (clampedRowSpan > 1) cell.rowSpan = clampedRowSpan;
      if (clampedColSpan > 1) cell.colSpan = clampedColSpan;
      cells[cell.id] = cell;
      for (let dr = 0; dr < clampedRowSpan; dr += 1) {
        for (let dc = 0; dc < clampedColSpan; dc += 1) {
          if (dr === 0 && dc === 0) continue;
          covered.add(`${r + dr}:${c + dc}`);
        }
      }
      c += clampedColSpan;
    }
  });
  return {
    id: createDatasetId(),
    kind: "matrix",
    name: fixture.title,
    columns,
    rows,
    cells,
  };
}

// ---------------------------------------------------------------------------
// Grid occupancy + validation
// ---------------------------------------------------------------------------

/**
 * Map every grid position to the anchor cell covering it, or null when a
 * referenced row/col does not exist (a validation error, handled separately).
 */
function buildGrid(matrix: MatrixDataset): (MatrixCell | null)[][] {
  const rowIndex = new Map(matrix.rows.map((row, i) => [row.id, i]));
  const colIndex = new Map(matrix.columns.map((col, i) => [col.id, i]));
  const grid: (MatrixCell | null)[][] = matrix.rows.map(() =>
    matrix.columns.map(() => null),
  );
  for (const cell of Object.values(matrix.cells)) {
    const r = rowIndex.get(cell.rowId);
    const c = colIndex.get(cell.colId);
    if (r === undefined || c === undefined) continue;
    const rowSpan = cell.rowSpan ?? 1;
    const colSpan = cell.colSpan ?? 1;
    for (let dr = 0; dr < rowSpan; dr += 1) {
      for (let dc = 0; dc < colSpan; dc += 1) {
        const row = grid[r + dr];
        if (!row || r + dr >= grid.length || c + dc >= row.length) continue;
        row[c + dc] = cell;
      }
    }
  }
  return grid;
}

function isPositiveInt(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value >= 1;
}

export interface MatrixValidationResult {
  ok: boolean;
  errors: string[];
}

/**
 * Span-invariant validation: every cell references an existing row/column,
 * spans are positive integers staying in range, every grid position is
 * covered exactly once (no gaps, no overlaps), and the size limits
 * (200 rows / 50 cols / 5000 rendered cells) hold.
 */
export function validateMatrix(matrix: MatrixDataset): MatrixValidationResult {
  const errors: string[] = [];
  if (matrix.rows.length > MATRIX_MAX_ROWS) {
    errors.push(`too many rows: ${matrix.rows.length} > ${MATRIX_MAX_ROWS}`);
  }
  if (matrix.columns.length > MATRIX_MAX_COLS) {
    errors.push(`too many columns: ${matrix.columns.length} > ${MATRIX_MAX_COLS}`);
  }

  const rowIndex = new Map(matrix.rows.map((row, i) => [row.id, i]));
  const colIndex = new Map(matrix.columns.map((col, i) => [col.id, i]));
  let rendered = 0;

  for (const cell of Object.values(matrix.cells)) {
    const r = rowIndex.get(cell.rowId);
    const c = colIndex.get(cell.colId);
    if (r === undefined) errors.push(`cell ${cell.id}: unknown rowId ${cell.rowId}`);
    if (c === undefined) errors.push(`cell ${cell.id}: unknown colId ${cell.colId}`);
    if (r === undefined || c === undefined) continue;
    const rowSpan = cell.rowSpan ?? 1;
    const colSpan = cell.colSpan ?? 1;
    if (!isPositiveInt(rowSpan) || !isPositiveInt(colSpan)) {
      errors.push(`cell ${cell.id}: spans must be positive integers`);
      continue;
    }
    if (r + rowSpan > matrix.rows.length || c + colSpan > matrix.columns.length) {
      errors.push(`cell ${cell.id}: span out of range`);
      continue;
    }
    rendered += rowSpan * colSpan;
  }
  if (rendered > MATRIX_MAX_RENDERED_CELLS) {
    errors.push(`too many rendered cells: ${rendered} > ${MATRIX_MAX_RENDERED_CELLS}`);
  }

  if (errors.length === 0) {
    // First pass guarantees every cell is anchored in range, so writes stay
    // inside the grid. Track overlaps at write time: a position claimed by a
    // second anchor is an overlap even if it would later be overwritten.
    const grid: (MatrixCell | null)[][] = matrix.rows.map(() =>
      matrix.columns.map(() => null),
    );
    for (const cell of Object.values(matrix.cells)) {
      const r = rowIndex.get(cell.rowId);
      const c = colIndex.get(cell.colId);
      if (r === undefined || c === undefined) continue;
      for (let dr = 0; dr < (cell.rowSpan ?? 1); dr += 1) {
        for (let dc = 0; dc < (cell.colSpan ?? 1); dc += 1) {
          const row = grid[r + dr];
          if (!row) continue;
          if (row[c + dc]) {
            errors.push(`cell ${cell.id}: overlapping span at (${r + dr}, ${c + dc})`);
          } else {
            row[c + dc] = cell;
          }
        }
      }
    }
    for (let r = 0; r < grid.length; r += 1) {
      const row = grid[r];
      if (!row) continue;
      for (let c = 0; c < row.length; c += 1) {
        if (!row[c]) errors.push(`position (${r}, ${c}): uncovered`);
      }
    }
  }

  return { ok: errors.length === 0, errors };
}

// ---------------------------------------------------------------------------
// Immutable merge / split / insert / delete helpers
// ---------------------------------------------------------------------------

function cloneMatrix(matrix: MatrixDataset): MatrixDataset {
  const cells: Record<string, MatrixCell> = {};
  for (const [id, cell] of Object.entries(matrix.cells)) {
    cells[id] = { ...cell };
  }
  return {
    ...matrix,
    columns: matrix.columns.map((col) => ({ ...col })),
    rows: matrix.rows.map((row) => ({ ...row })),
    cells,
  };
}

/**
 * Merge the given anchor cells into a single cell. The selected cells must
 * exactly tile a rectangle; non-empty texts are joined with `\n` in reading
 * order. The top-left anchor survives (id, style, role).
 */
export function mergeCells(matrix: MatrixDataset, cellIds: string[]): MatrixDataset {
  if (cellIds.length < 2) return matrix;
  const rowIndex = new Map(matrix.rows.map((row, i) => [row.id, i]));
  const colIndex = new Map(matrix.columns.map((col, i) => [col.id, i]));
  const selected = new Map<string, { cell: MatrixCell; r: number; c: number }>();
  for (const id of cellIds) {
    const cell = matrix.cells[id];
    if (!cell) throw new Error(`mergeCells: unknown cell ${id}`);
    const r = rowIndex.get(cell.rowId);
    const c = colIndex.get(cell.colId);
    if (r === undefined || c === undefined) throw new Error(`mergeCells: cell ${id} out of range`);
    selected.set(id, { cell, r, c });
  }
  let minR = Infinity;
  let minC = Infinity;
  let maxR = -Infinity;
  let maxC = -Infinity;
  for (const { cell, r, c } of selected.values()) {
    minR = Math.min(minR, r);
    minC = Math.min(minC, c);
    maxR = Math.max(maxR, r + (cell.rowSpan ?? 1) - 1);
    maxC = Math.max(maxC, c + (cell.colSpan ?? 1) - 1);
  }
  // The selected cells must tile the bounding rectangle exactly.
  const grid = buildGrid(matrix);
  for (let r = minR; r <= maxR; r += 1) {
    for (let c = minC; c <= maxC; c += 1) {
      const cover = grid[r]?.[c];
      if (!cover || !selected.has(cover.id)) {
        throw new Error("mergeCells: selection is not a complete rectangle");
      }
    }
  }
  const texts: string[] = [];
  let anchor: MatrixCell | undefined;
  for (let r = minR; r <= maxR; r += 1) {
    for (let c = minC; c <= maxC; c += 1) {
      const cover = grid[r]?.[c];
      if (!cover) continue;
      if (cover.rowId === matrix.rows[r]?.id && cover.colId === matrix.columns[c]?.id) {
        if (!anchor) anchor = cover;
        if (cover.text.trim()) texts.push(cover.text);
      }
    }
  }
  if (!anchor) throw new Error("mergeCells: empty selection");
  const next = cloneMatrix(matrix);
  for (const id of selected.keys()) {
    if (id !== anchor.id) delete next.cells[id];
  }
  const merged = next.cells[anchor.id];
  if (!merged) throw new Error("mergeCells: anchor lost");
  merged.text = texts.join("\n");
  if (maxR - minR > 0) merged.rowSpan = maxR - minR + 1;
  else delete merged.rowSpan;
  if (maxC - minC > 0) merged.colSpan = maxC - minC + 1;
  else delete merged.colSpan;
  return next;
}

/**
 * Split a spanning cell back into 1×1 cells. The anchor keeps its id and
 * text; the newly exposed positions get fresh empty cells.
 */
export function splitCell(matrix: MatrixDataset, cellId: string): MatrixDataset {
  const cell = matrix.cells[cellId];
  if (!cell) throw new Error(`splitCell: unknown cell ${cellId}`);
  const rowSpan = cell.rowSpan ?? 1;
  const colSpan = cell.colSpan ?? 1;
  if (rowSpan === 1 && colSpan === 1) return matrix;
  const rowIndex = new Map(matrix.rows.map((row, i) => [row.id, i]));
  const colIndex = new Map(matrix.columns.map((col, i) => [col.id, i]));
  const r = rowIndex.get(cell.rowId);
  const c = colIndex.get(cell.colId);
  if (r === undefined || c === undefined) throw new Error(`splitCell: cell ${cellId} out of range`);
  const next = cloneMatrix(matrix);
  const anchor = next.cells[cellId];
  if (!anchor) throw new Error(`splitCell: cell ${cellId} lost`);
  delete anchor.rowSpan;
  delete anchor.colSpan;
  for (let dr = 0; dr < rowSpan; dr += 1) {
    for (let dc = 0; dc < colSpan; dc += 1) {
      if (dr === 0 && dc === 0) continue;
      const row = matrix.rows[r + dr];
      const col = matrix.columns[c + dc];
      if (!row || !col) continue;
      const fresh: MatrixCell = {
        id: createMatrixCellId(),
        rowId: row.id,
        colId: col.id,
        text: "",
      };
      next.cells[fresh.id] = fresh;
    }
  }
  return next;
}

/** Insert an empty row at `index` (0..rows.length), extending spans that cross it. */
export function insertRow(
  matrix: MatrixDataset,
  index: number,
  role: MatrixRowRole = "data",
): MatrixDataset {
  if (index < 0 || index > matrix.rows.length) {
    throw new Error(`insertRow: index ${index} out of range`);
  }
  const next = cloneMatrix(matrix);
  const row: MatrixRow = { id: createMatrixRowId(), role };
  next.rows.splice(index, 0, row);
  // Extend spans that started above and cover the insertion point.
  for (const cell of Object.values(next.cells)) {
    const r = matrix.rows.findIndex((row0) => row0.id === cell.rowId);
    const span = cell.rowSpan ?? 1;
    if (r >= 0 && r < index && r + span > index) {
      cell.rowSpan = span + 1;
    }
  }
  // Fill positions in the new row not covered by an extended span.
  const grid = buildGrid(next);
  for (let c = 0; c < next.columns.length; c += 1) {
    if (grid[index]?.[c]) continue;
    const col = next.columns[c];
    if (!col) continue;
    const cell: MatrixCell = {
      id: createMatrixCellId(),
      rowId: row.id,
      colId: col.id,
      text: "",
    };
    next.cells[cell.id] = cell;
  }
  return next;
}

/**
 * Delete a row. Refuses (throws) when the row anchors a multi-row span;
 * spans crossing the row from above are shrunk.
 */
export function deleteRow(matrix: MatrixDataset, rowId: string): MatrixDataset {
  const index = matrix.rows.findIndex((row) => row.id === rowId);
  if (index < 0) throw new Error(`deleteRow: unknown row ${rowId}`);
  for (const cell of Object.values(matrix.cells)) {
    if (cell.rowId === rowId && (cell.rowSpan ?? 1) > 1) {
      throw new Error(`deleteRow: row ${rowId} anchors a multi-row span`);
    }
  }
  const next = cloneMatrix(matrix);
  next.rows.splice(index, 1);
  for (const cell of Object.values(next.cells)) {
    if (cell.rowId === rowId) {
      delete next.cells[cell.id];
      continue;
    }
    const r = matrix.rows.findIndex((row0) => row0.id === cell.rowId);
    const span = cell.rowSpan ?? 1;
    if (r >= 0 && r < index && r + span > index) {
      if (span - 1 > 1) cell.rowSpan = span - 1;
      else delete cell.rowSpan;
    }
  }
  return next;
}

/** Insert an empty column at `index` (0..columns.length), extending spans that cross it. */
export function insertColumn(
  matrix: MatrixDataset,
  index: number,
  opts: { tag?: SemanticTag; headerLevel?: number } = {},
): MatrixDataset {
  if (index < 0 || index > matrix.columns.length) {
    throw new Error(`insertColumn: index ${index} out of range`);
  }
  const next = cloneMatrix(matrix);
  const col: MatrixColumn = { id: createMatrixColumnId(), ...opts };
  next.columns.splice(index, 0, col);
  for (const cell of Object.values(next.cells)) {
    const c = matrix.columns.findIndex((col0) => col0.id === cell.colId);
    const span = cell.colSpan ?? 1;
    if (c >= 0 && c < index && c + span > index) {
      cell.colSpan = span + 1;
    }
  }
  const grid = buildGrid(next);
  for (let r = 0; r < next.rows.length; r += 1) {
    if (grid[r]?.[index]) continue;
    const row = next.rows[r];
    if (!row) continue;
    const cell: MatrixCell = {
      id: createMatrixCellId(),
      rowId: row.id,
      colId: col.id,
      text: "",
    };
    next.cells[cell.id] = cell;
  }
  return next;
}

/**
 * Delete a column. Refuses (throws) when the column anchors a multi-column
 * span; spans crossing the column from the left are shrunk.
 */
export function deleteColumn(matrix: MatrixDataset, colId: string): MatrixDataset {
  const index = matrix.columns.findIndex((col) => col.id === colId);
  if (index < 0) throw new Error(`deleteColumn: unknown column ${colId}`);
  for (const cell of Object.values(matrix.cells)) {
    if (cell.colId === colId && (cell.colSpan ?? 1) > 1) {
      throw new Error(`deleteColumn: column ${colId} anchors a multi-column span`);
    }
  }
  const next = cloneMatrix(matrix);
  next.columns.splice(index, 1);
  for (const cell of Object.values(next.cells)) {
    if (cell.colId === colId) {
      delete next.cells[cell.id];
      continue;
    }
    const c = matrix.columns.findIndex((col0) => col0.id === cell.colId);
    const span = cell.colSpan ?? 1;
    if (c >= 0 && c < index && c + span > index) {
      if (span - 1 > 1) cell.colSpan = span - 1;
      else delete cell.colSpan;
    }
  }
  return next;
}
