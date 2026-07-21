/**
 * Table (matrix) editing primitives — pure, dependency-free logic shared by
 * the canvas renderer (`TableView.tsx`), the export renderer (`renderSvg.ts`),
 * the ribbon, and the keyboard layer. Nothing here touches React or the store.
 *
 * Grid convention mirrors `reportTypes.ts`: a cell with rowSpan/colSpan > 1
 * anchors at its (rowId, colId) and covers the rectangle extending right/down;
 * covered positions hold no cell of their own.
 */

import {
  MATRIX_MAX_COLS,
  MATRIX_MAX_RENDERED_CELLS,
  MATRIX_MAX_ROWS,
  type MatrixCell,
  type MatrixCellStyle,
  type MatrixDataset,
  type MatrixRowRole,
} from "./reportTypes";
import type { DiagramNode, TableCellAddress, TableSelection } from "./types";

// ---------------------------------------------------------------------------
// Shared presentation constants (canvas + export must agree)
// ---------------------------------------------------------------------------

export const TABLE_ROLE_FILLS: Record<MatrixRowRole, string> = {
  header: "#eef2f7",
  group: "#e2e8f0",
  subtotal: "#f8fafc",
  data: "#ffffff",
};

export const TABLE_GRID_BORDER = "#94a3b8";
export const TABLE_TEXT_COLOR = "#111827";
export const TABLE_MIN_COL_WIDTH = 16;
export const TABLE_MIN_ROW_HEIGHT = 16;

export interface ParsedBorder {
  width: number;
  color: string;
  dash: boolean;
}

/**
 * Parse the small CSS border shorthand subset used by `MatrixCellStyle`
 * (e.g. "2px solid #dc2626", "1px dashed gray", "none"). Returns null when
 * the side is unspecified (caller falls back to the default grid border).
 */
export function parseBorderShorthand(raw: string | undefined): ParsedBorder | null {
  if (raw === undefined) return null;
  const text = raw.trim().toLowerCase();
  if (text === "" || text === "none" || text === "0") {
    return { width: 0, color: "transparent", dash: false };
  }
  const widthMatch = text.match(/(\d+(?:\.\d+)?)px/);
  // Color: hex / rgb() first, otherwise the first token that isn't a
  // border-style keyword or the width token.
  const STYLE_WORDS = new Set(["solid", "dashed", "dotted", "double", "none", "hidden"]);
  let color: string | null = null;
  const hexOrFn = text.match(/#[0-9a-f]{3,8}\b|rgba?\([^)]*\)/);
  if (hexOrFn) {
    color = hexOrFn[0];
  } else {
    for (const token of text.split(/\s+/)) {
      if (STYLE_WORDS.has(token) || /^\d/.test(token)) continue;
      color = token;
      break;
    }
  }
  return {
    width: widthMatch ? Number(widthMatch[1]) : 1,
    color: color ?? TABLE_GRID_BORDER,
    dash: text.includes("dashed") || text.includes("dotted"),
  };
}

// ---------------------------------------------------------------------------
// Grid + address lookup
// ---------------------------------------------------------------------------

/** Map every grid position to the anchor cell covering it. */
export function matrixGrid(matrix: MatrixDataset): (MatrixCell | null)[][] {
  const rowIndex = new Map(matrix.rows.map((row, i) => [row.id, i]));
  const colIndex = new Map(matrix.columns.map((col, i) => [col.id, i]));
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
        if (!row || r + dr >= grid.length || c + dc >= row.length) continue;
        row[c + dc] = cell;
      }
    }
  }
  return grid;
}

/** Grid position of the anchor cell at `addr` (its own top-left), or null. */
export function cellIndex(
  matrix: MatrixDataset,
  addr: TableCellAddress,
): { r: number; c: number } | null {
  const r = matrix.rows.findIndex((row) => row.id === addr.rowId);
  const c = matrix.columns.findIndex((col) => col.id === addr.colId);
  if (r < 0 || c < 0) return null;
  return { r, c };
}

/** The anchor cell object at `addr` (must anchor at exactly that position). */
export function cellAtAddr(
  matrix: MatrixDataset,
  addr: TableCellAddress,
): MatrixCell | null {
  for (const cell of Object.values(matrix.cells)) {
    if (cell.rowId === addr.rowId && cell.colId === addr.colId) return cell;
  }
  return null;
}

/** The anchor cell covering grid position (r, c), or null when out of range. */
export function coveringCell(
  matrix: MatrixDataset,
  grid: (MatrixCell | null)[][],
  r: number,
  c: number,
): MatrixCell | null {
  if (r < 0 || c < 0 || r >= matrix.rows.length || c >= matrix.columns.length) return null;
  return grid[r]?.[c] ?? null;
}

/** Address of the anchor cell covering grid position (r, c). */
export function addrAtPosition(
  matrix: MatrixDataset,
  grid: (MatrixCell | null)[][],
  r: number,
  c: number,
): TableCellAddress | null {
  const cell = coveringCell(matrix, grid, r, c);
  return cell ? { rowId: cell.rowId, colId: cell.colId } : null;
}

// ---------------------------------------------------------------------------
// Layout
// ---------------------------------------------------------------------------

export interface TableLayout {
  colX: number[];
  colW: number[];
  rowY: number[];
  rowH: number[];
  totalW: number;
  totalH: number;
}

/**
 * Resolve column widths / row heights inside the node bounds (w × h).
 * Explicit `column.width` / `row.height` win; unset tracks share the
 * remaining space equally (min-clamped so a huge explicit track can't crush
 * them below usability). When every track is explicit the table lays out
 * as-is and may under/overflow the node rect.
 */
export function computeTableLayout(
  matrix: MatrixDataset,
  w: number,
  h: number,
): TableLayout {
  const cols = matrix.columns.length;
  const rows = matrix.rows.length;

  const colW: number[] = new Array<number>(cols).fill(0);
  const explicitColSum = matrix.columns.reduce((sum, col) => sum + (col.width ?? 0), 0);
  const unsetCols = matrix.columns.filter((col) => col.width === undefined).length;
  const colShare =
    unsetCols > 0
      ? Math.max(TABLE_MIN_COL_WIDTH, (w - explicitColSum) / unsetCols)
      : 0;
  for (let i = 0; i < cols; i += 1) {
    colW[i] = matrix.columns[i]?.width ?? (unsetCols > 0 ? colShare : w / Math.max(1, cols));
  }

  const rowH: number[] = new Array<number>(rows).fill(0);
  const explicitRowSum = matrix.rows.reduce((sum, row) => sum + (row.height ?? 0), 0);
  const unsetRows = matrix.rows.filter((row) => row.height === undefined).length;
  const rowShare =
    unsetRows > 0
      ? Math.max(TABLE_MIN_ROW_HEIGHT, (h - explicitRowSum) / unsetRows)
      : 0;
  for (let i = 0; i < rows; i += 1) {
    rowH[i] = matrix.rows[i]?.height ?? (unsetRows > 0 ? rowShare : h / Math.max(1, rows));
  }

  const colX: number[] = [];
  const rowY: number[] = [];
  let x = 0;
  for (let i = 0; i < cols; i += 1) {
    colX.push(x);
    x += colW[i] ?? 0;
  }
  let y = 0;
  for (let i = 0; i < rows; i += 1) {
    rowY.push(y);
    y += rowH[i] ?? 0;
  }
  return { colX, colW, rowY, rowH, totalW: x, totalH: y };
}

export interface CellRect {
  x: number;
  y: number;
  w: number;
  h: number;
}

/** Span-aware rect of `cell` (anchored at grid position r, c) in node-local units. */
export function cellRect(
  matrix: MatrixDataset,
  layout: TableLayout,
  cell: MatrixCell,
  r: number,
  c: number,
): CellRect {
  const rowSpan = Math.min(cell.rowSpan ?? 1, matrix.rows.length - r);
  const colSpan = Math.min(cell.colSpan ?? 1, matrix.columns.length - c);
  let wSum = 0;
  for (let i = c; i < c + colSpan; i += 1) wSum += layout.colW[i] ?? 0;
  let hSum = 0;
  for (let i = r; i < r + rowSpan; i += 1) hSum += layout.rowH[i] ?? 0;
  return {
    x: layout.colX[c] ?? 0,
    y: layout.rowY[r] ?? 0,
    w: wSum,
    h: hSum,
  };
}

/** Address of the cell covering node-local point (x, y), or null outside the grid. */
export function addrAtLocalPoint(
  matrix: MatrixDataset,
  layout: TableLayout,
  x: number,
  y: number,
): TableCellAddress | null {
  let c = -1;
  for (let i = 0; i < layout.colX.length; i += 1) {
    const left = layout.colX[i] ?? 0;
    if (x >= left && x < left + (layout.colW[i] ?? 0)) {
      c = i;
      break;
    }
  }
  let r = -1;
  for (let i = 0; i < layout.rowY.length; i += 1) {
    const top = layout.rowY[i] ?? 0;
    if (y >= top && y < top + (layout.rowH[i] ?? 0)) {
      r = i;
      break;
    }
  }
  if (r < 0 || c < 0) return null;
  return addrAtPosition(matrix, matrixGrid(matrix), r, c);
}

/** Address of the cell under a canvas-space point for a table node. */
export function addrAtCanvasPoint(
  matrix: MatrixDataset,
  node: DiagramNode,
  canvasX: number,
  canvasY: number,
): TableCellAddress | null {
  const layout = computeTableLayout(matrix, node.w, node.h);
  return addrAtLocalPoint(matrix, layout, canvasX - node.x, canvasY - node.y);
}

// ---------------------------------------------------------------------------
// Ranges
// ---------------------------------------------------------------------------

export interface TableRange {
  r1: number;
  c1: number;
  r2: number;
  c2: number;
}

/** Anchor+focus → normalized index rectangle (null when either end is stale). */
export function normalizeRange(
  matrix: MatrixDataset,
  sel: Pick<TableSelection, "anchor" | "focus">,
): TableRange | null {
  const a = cellIndex(matrix, sel.anchor);
  const f = cellIndex(matrix, sel.focus);
  if (!a || !f) return null;
  return {
    r1: Math.min(a.r, f.r),
    c1: Math.min(a.c, f.c),
    r2: Math.max(a.r, f.r),
    c2: Math.max(a.c, f.c),
  };
}

/**
 * Grow a range until no covering span sticks out of it (Excel-style: merging
 * a selection that half-covers a merged cell includes the whole cell).
 */
export function expandRangeToSpans(
  matrix: MatrixDataset,
  range: TableRange,
): TableRange {
  const grid = matrixGrid(matrix);
  let { r1, c1, r2, c2 } = range;
  let changed = true;
  while (changed) {
    changed = false;
    for (let r = r1; r <= r2; r += 1) {
      for (let c = c1; c <= c2; c += 1) {
        const cell = coveringCell(matrix, grid, r, c);
        if (!cell) continue;
        const anchor = cellIndex(matrix, cell);
        if (!anchor) continue;
        const cellR2 = anchor.r + (cell.rowSpan ?? 1) - 1;
        const cellC2 = anchor.c + (cell.colSpan ?? 1) - 1;
        if (anchor.r < r1) { r1 = anchor.r; changed = true; }
        if (anchor.c < c1) { c1 = anchor.c; changed = true; }
        if (cellR2 > r2) { r2 = cellR2; changed = true; }
        if (cellC2 > c2) { c2 = cellC2; changed = true; }
      }
    }
  }
  return { r1, c1, r2, c2 };
}

/** Unique ids of anchor cells covering a range (reading order). */
export function anchorIdsInRange(matrix: MatrixDataset, range: TableRange): string[] {
  const grid = matrixGrid(matrix);
  const seen = new Set<string>();
  const ids: string[] = [];
  for (let r = range.r1; r <= range.r2; r += 1) {
    for (let c = range.c1; c <= range.c2; c += 1) {
      const cell = coveringCell(matrix, grid, r, c);
      if (cell && !seen.has(cell.id)) {
        seen.add(cell.id);
        ids.push(cell.id);
      }
    }
  }
  return ids;
}

/** Count non-empty cells among the given cell ids. */
export function nonEmptyCellCount(matrix: MatrixDataset, cellIds: string[]): number {
  let count = 0;
  for (const id of cellIds) {
    if ((matrix.cells[id]?.text ?? "").trim()) count += 1;
  }
  return count;
}

// ---------------------------------------------------------------------------
// Keyboard movement
// ---------------------------------------------------------------------------

/**
 * Move the focus cell by (dr, dc), clamped to the grid and resolving to the
 * covering anchor (so landing inside a span selects its anchor). With
 * `extend` the anchor stays put (range grows); otherwise both ends move.
 */
export function moveFocus(
  matrix: MatrixDataset,
  sel: TableSelection,
  dr: number,
  dc: number,
  extend: boolean,
): TableSelection {
  const focus = cellIndex(matrix, sel.focus);
  if (!focus) return sel;
  const r = Math.max(0, Math.min(matrix.rows.length - 1, focus.r + dr));
  const c = Math.max(0, Math.min(matrix.columns.length - 1, focus.c + dc));
  const addr = addrAtPosition(matrix, matrixGrid(matrix), r, c);
  if (!addr) return sel;
  return extend ? { ...sel, focus: addr } : { ...sel, anchor: addr, focus: addr };
}

// ---------------------------------------------------------------------------
// TSV copy / paste
// ---------------------------------------------------------------------------

function escapeTsvCell(text: string): string {
  return text
    .replace(/\\/g, "\\\\")
    .replace(/\t/g, "\\t")
    .replace(/\r?\n/g, "\\n");
}

function unescapeTsvCell(text: string): string {
  // Single left-to-right pass so escaped backslashes round-trip correctly.
  let out = "";
  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i];
    if (ch === "\\" && i + 1 < text.length) {
      const next = text[i + 1];
      if (next === "n") { out += "\n"; i += 1; continue; }
      if (next === "t") { out += "\t"; i += 1; continue; }
      if (next === "\\") { out += "\\"; i += 1; continue; }
    }
    out += ch;
  }
  return out;
}

/**
 * Serialize a range as TSV. Positions covered by a span contribute their
 * anchor's text only at the anchor's own position (elsewhere ""), matching
 * spreadsheet copy behavior.
 */
export function serializeRangeToTsv(matrix: MatrixDataset, range: TableRange): string {
  const grid = matrixGrid(matrix);
  const lines: string[] = [];
  for (let r = range.r1; r <= range.r2; r += 1) {
    const parts: string[] = [];
    for (let c = range.c1; c <= range.c2; c += 1) {
      const cell = coveringCell(matrix, grid, r, c);
      if (!cell) {
        parts.push("");
        continue;
      }
      const isAnchor =
        cell.rowId === matrix.rows[r]?.id && cell.colId === matrix.columns[c]?.id;
      parts.push(isAnchor ? escapeTsvCell(cell.text) : "");
    }
    lines.push(parts.join("\t"));
  }
  return lines.join("\n");
}

/** Parse TSV text into a string grid (unescaping \\n \\t \\\\ sequences). */
export function parseTsv(text: string): string[][] {
  const normalized = text.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
  return normalized.split("\n").map((line) => line.split("\t").map(unescapeTsvCell));
}

/**
 * Paste a text grid with its top-left at `addr`. Clipped to the matrix
 * bounds; positions covered by another anchor's span are skipped (the anchor
 * itself, when targeted, receives the text). Pure: returns the same matrix
 * reference when nothing changed.
 */
export function pasteTextGridAt(
  matrix: MatrixDataset,
  addr: TableCellAddress,
  texts: string[][],
): MatrixDataset {
  const start = cellIndex(matrix, addr);
  if (!start || texts.length === 0) return matrix;
  const grid = matrixGrid(matrix);
  const cells = { ...matrix.cells };
  let changed = false;
  for (let i = 0; i < texts.length; i += 1) {
    const line = texts[i];
    if (!line) continue;
    for (let j = 0; j < line.length; j += 1) {
      const r = start.r + i;
      const c = start.c + j;
      if (r >= matrix.rows.length || c >= matrix.columns.length) continue;
      const cover = coveringCell(matrix, grid, r, c);
      if (!cover) continue;
      const isAnchor =
        cover.rowId === matrix.rows[r]?.id && cover.colId === matrix.columns[c]?.id;
      if (!isAnchor) continue;
      const value = line[j] ?? "";
      if (cover.text === value) continue;
      cells[cover.id] = { ...cover, text: value };
      changed = true;
    }
  }
  return changed ? { ...matrix, cells } : matrix;
}

// ---------------------------------------------------------------------------
// Limits
// ---------------------------------------------------------------------------

/** Total rendered (span-expanded) cell count — the metric MATRIX_MAX_RENDERED_CELLS caps. */
export function renderedCellCount(matrix: MatrixDataset): number {
  let count = 0;
  for (const cell of Object.values(matrix.cells)) {
    count += (cell.rowSpan ?? 1) * (cell.colSpan ?? 1);
  }
  return count;
}

export function canInsertRow(matrix: MatrixDataset): boolean {
  return (
    matrix.rows.length + 1 <= MATRIX_MAX_ROWS &&
    renderedCellCount(matrix) + matrix.columns.length <= MATRIX_MAX_RENDERED_CELLS
  );
}

export function canInsertColumn(matrix: MatrixDataset): boolean {
  return (
    matrix.columns.length + 1 <= MATRIX_MAX_COLS &&
    renderedCellCount(matrix) + matrix.rows.length <= MATRIX_MAX_RENDERED_CELLS
  );
}

// ---------------------------------------------------------------------------
// Style helpers (fill / painter)
// ---------------------------------------------------------------------------

/** Merge a style patch onto a cell; undefined patch keys clear the attribute. */
export function applyCellStylePatch(
  cell: MatrixCell,
  patch: MatrixCellStyle,
): MatrixCell {
  const next: MatrixCellStyle = { ...(cell.style ?? {}) };
  for (const [key, value] of Object.entries(patch)) {
    if (value === undefined) delete (next as Record<string, unknown>)[key];
    else (next as Record<string, unknown>)[key] = value;
  }
  return { ...cell, style: next };
}
