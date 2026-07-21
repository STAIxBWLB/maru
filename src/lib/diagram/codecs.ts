/**
 * Diagram codec registry — Report Pattern Studio Phase 3.
 *
 * One registry drives the unified import/export dialog, the file picker
 * accept list, and the clipboard format mapping. Each codec declares its
 * capabilities and its export fidelity up front:
 *
 * - `lossless`   — re-opening the export reproduces the document/dataset
 *                  exactly (Maru JSON, Maru SVG with embedded metadata).
 * - `structural` — structure (nodes/edges or rows/columns/spans) survives;
 *                  presentation details (positions, styles) may not.
 * - `visual`     — pixels/vector image only; no editable structure.
 *
 * Warnings and ignored-field lists are i18n keys ({@link CodecWarning.key})
 * rendered by the dialog — codecs never carry user-visible strings.
 *
 * Arbitrary SVG without Maru metadata is imported image-only (`visual`); no
 * codec claims lossless conversion for foreign SVG or Mermaid.
 */

import { rasterise } from "./export";
import { docToMermaid, mermaidToDoc } from "./mermaid";
import { mkNode } from "./nodeKinds";
import { deserializeDoc, serializeDoc } from "./persistence";
import { renderDocToSvg } from "./renderSvg";
import {
  MATRIX_MAX_COLS,
  MATRIX_MAX_RENDERED_CELLS,
  MATRIX_MAX_ROWS,
  createDatasetId,
  createMatrixCellId,
  createMatrixColumnId,
  createMatrixRowId,
  matrixFromRowsCols,
  type MatrixCell,
  type MatrixCellStyle,
  type MatrixDataset,
  type MatrixRowRole,
  type ReportDataset,
} from "./reportTypes";
import { escapeHtml, sanitizeCssColor } from "./richText";
import { escapeTsvCell, matrixGrid, parseTsv, renderedCellCount } from "./tableEditing";
import { createDiagramId, createEmptyDoc, type DiagramDoc } from "./types";

// ---------------------------------------------------------------------------
// Registry types
// ---------------------------------------------------------------------------

export type CodecFidelity = "lossless" | "structural" | "visual";

export interface CodecWarning {
  /** i18n key under `diagram.codec.warn.*`. */
  key: string;
  params?: Record<string, string | number>;
}

export type CodecParseResult =
  | { kind: "dataset"; dataset: ReportDataset }
  | { kind: "doc"; doc: DiagramDoc };

export interface CodecParseOutcome {
  result: CodecParseResult;
  fidelity: CodecFidelity;
  warnings: CodecWarning[];
  ignoredFields?: string[];
}

export interface CodecSerializeOutcome {
  bytes: string | Uint8Array;
  fidelity: CodecFidelity;
  warnings: CodecWarning[];
  ignoredFields?: string[];
}

/** What a codec consumes/produces: whole docs, matrix datasets, or pixels. */
export type CodecDataKind = "doc" | "matrix" | "visual";

export interface DiagramCodec {
  id: string;
  /** i18n key for the human-readable format label. */
  labelKey: string;
  extensions: string[];
  canImport: boolean;
  canExport: boolean;
  /** Declared fidelity for export (import fidelity is reported per parse). */
  exportFidelity: CodecFidelity;
  dataKind: CodecDataKind;
  /** Rust bridge export kind (`diagram_export_blob*` whitelist). Undefined = no byte sink (PDF prints). */
  exportKind?: string;
  parse?(bytes: string | Uint8Array, filename?: string): CodecParseOutcome;
  serialize?(input: {
    doc: DiagramDoc;
    datasetId?: string;
  }): CodecSerializeOutcome | Promise<CodecSerializeOutcome>;
}

// ---------------------------------------------------------------------------
// Shared helpers
// ---------------------------------------------------------------------------

function toText(bytes: string | Uint8Array): string {
  return typeof bytes === "string" ? bytes : new TextDecoder().decode(bytes);
}

function toBase64(text: string): string {
  const bytes = new TextEncoder().encode(text);
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin);
}

/**
 * Expand a matrix to a plain text grid: a spanning cell contributes its text
 * at its anchor position and "" at covered positions (spreadsheet behavior).
 */
export function expandMatrixToGrid(matrix: MatrixDataset): string[][] {
  const grid = matrixGrid(matrix);
  return matrix.rows.map((row, r) =>
    matrix.columns.map((col, c) => {
      const cell = grid[r]?.[c];
      if (!cell) return "";
      return cell.rowId === row.id && cell.colId === col.id ? cell.text : "";
    }),
  );
}

function matrixHasSpans(matrix: MatrixDataset): boolean {
  return Object.values(matrix.cells).some(
    (cell) => (cell.rowSpan ?? 1) > 1 || (cell.colSpan ?? 1) > 1,
  );
}

/** Build a matrix from a ragged text grid (padded to the widest row). */
export function matrixFromTextGrid(
  grid: string[][],
  opts: { name?: string; header?: boolean } = {},
): MatrixDataset {
  const colCount = Math.max(1, ...grid.map((row) => row.length));
  const rowCount = Math.max(1, grid.length);
  const matrix = matrixFromRowsCols(rowCount, colCount, { name: opts.name ?? "" });
  const rowIndex = new Map(matrix.rows.map((row, i) => [row.id, i]));
  const colIndex = new Map(matrix.columns.map((col, i) => [col.id, i]));
  const cells: Record<string, MatrixCell> = {};
  for (const cell of Object.values(matrix.cells)) {
    const r = rowIndex.get(cell.rowId) ?? 0;
    const c = colIndex.get(cell.colId) ?? 0;
    cells[cell.id] = { ...cell, text: grid[r]?.[c] ?? "" };
  }
  const first = matrix.rows[0];
  if (opts.header && first) first.role = "header";
  return { ...matrix, cells };
}

/** True when the matrix exceeds the editor limits and needs range gating. */
export function matrixExceedsLimits(matrix: MatrixDataset): boolean {
  return (
    matrix.rows.length > MATRIX_MAX_ROWS ||
    matrix.columns.length > MATRIX_MAX_COLS ||
    renderedCellCount(matrix) > MATRIX_MAX_RENDERED_CELLS
  );
}

/** Inclusive 0-based row/column range. */
export interface MatrixRangeSelection {
  r1: number;
  c1: number;
  r2: number;
  c2: number;
}

/**
 * Slice a matrix to an inclusive range. Spans crossing the range edge are
 * clipped (their text/style survive only when the anchor itself is inside);
 * clipped rectangles of a grid tiling tile the range exactly, so the result
 * always passes `validateMatrix` coverage.
 */
export function sliceMatrix(matrix: MatrixDataset, sel: MatrixRangeSelection): MatrixDataset {
  const r1 = Math.max(0, Math.min(sel.r1, matrix.rows.length - 1));
  const c1 = Math.max(0, Math.min(sel.c1, matrix.columns.length - 1));
  const r2 = Math.max(r1, Math.min(sel.r2, matrix.rows.length - 1));
  const c2 = Math.max(c1, Math.min(sel.c2, matrix.columns.length - 1));

  const grid = matrixGrid(matrix);
  const sourceRowIndex = new Map(matrix.rows.map((row, i) => [row.id, i]));
  const sourceColIndex = new Map(matrix.columns.map((col, i) => [col.id, i]));

  const rows = matrix.rows.slice(r1, r2 + 1).map((row) => ({
    id: createMatrixRowId(),
    role: row.role,
    ...(row.height !== undefined ? { height: row.height } : {}),
  }));
  const columns = matrix.columns.slice(c1, c2 + 1).map((col) => ({
    id: createMatrixColumnId(),
    ...(col.width !== undefined ? { width: col.width } : {}),
    ...(col.tag !== undefined ? { tag: col.tag } : {}),
    ...(col.headerLevel !== undefined ? { headerLevel: col.headerLevel } : {}),
  }));

  const cells: Record<string, MatrixCell> = {};
  const seen = new Set<string>();
  for (let r = r1; r <= r2; r += 1) {
    for (let c = c1; c <= c2; c += 1) {
      const anchor = grid[r]?.[c];
      if (!anchor || seen.has(anchor.id)) continue;
      seen.add(anchor.id);
      const ar = sourceRowIndex.get(anchor.rowId) ?? r;
      const ac = sourceColIndex.get(anchor.colId) ?? c;
      // First reading-order contact with the anchor inside the range is the
      // clipped rectangle's top-left.
      const anchorInside = ar >= r1 && ac >= c1;
      const rowSpan = Math.min(ar + (anchor.rowSpan ?? 1), r2 + 1) - r;
      const colSpan = Math.min(ac + (anchor.colSpan ?? 1), c2 + 1) - c;
      const row = rows[r - r1];
      const col = columns[c - c1];
      if (!row || !col) continue;
      const cell: MatrixCell = {
        id: createMatrixCellId(),
        rowId: row.id,
        colId: col.id,
        text: anchorInside ? anchor.text : "",
      };
      if (rowSpan > 1) cell.rowSpan = rowSpan;
      if (colSpan > 1) cell.colSpan = colSpan;
      if (anchorInside && anchor.style) cell.style = { ...anchor.style };
      if (anchorInside && anchor.role) cell.role = anchor.role;
      cells[cell.id] = cell;
    }
  }
  return {
    id: createDatasetId(),
    kind: "matrix",
    name: matrix.name,
    columns,
    rows,
    cells,
  };
}

function requireMatrix(doc: DiagramDoc, datasetId: string | undefined): MatrixDataset {
  const datasets = doc.datasets ?? [];
  const found = datasetId
    ? datasets.find((ds) => ds.id === datasetId)
    : datasets.find((ds) => ds.kind === "matrix");
  if (!found || found.kind !== "matrix") {
    throw new Error("matrix_dataset_not_found");
  }
  return found as MatrixDataset;
}

// ---------------------------------------------------------------------------
// CSV (RFC-4180)
// ---------------------------------------------------------------------------

function csvEscapeField(field: string): string {
  return /[",\r\n]/.test(field) ? `"${field.replace(/"/g, '""')}"` : field;
}

export function serializeGridToCsv(grid: string[][]): string {
  return grid.map((row) => row.map(csvEscapeField).join(",")).join("\r\n") + "\r\n";
}

/** Parse CSV with quoted fields (embedded commas, quotes, and newlines). */
export function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let inQuotes = false;
  let pending = false; // true when the row/field has content worth committing
  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i]!;
    if (inQuotes) {
      if (ch === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i += 1;
        } else {
          inQuotes = false;
        }
      } else {
        field += ch;
      }
      continue;
    }
    if (ch === '"') {
      inQuotes = true;
      pending = true;
    } else if (ch === ",") {
      row.push(field);
      field = "";
      pending = true;
    } else if (ch === "\n" || ch === "\r") {
      if (ch === "\r" && text[i + 1] === "\n") i += 1;
      row.push(field);
      rows.push(row);
      row = [];
      field = "";
      pending = false;
    } else {
      field += ch;
      pending = true;
    }
  }
  if (pending || field.length > 0 || row.length > 0) {
    row.push(field);
    rows.push(row);
  }
  return rows;
}

// ---------------------------------------------------------------------------
// Markdown table (GitHub flavored)
// ---------------------------------------------------------------------------

const MD_SEPARATOR_RE = /^\|?[\s:|-]+\|$/;

function markdownEscapeCell(text: string): { out: string; multiline: boolean } {
  const multiline = /\r?\n/.test(text);
  return {
    out: text.replace(/\|/g, "\\|").replace(/\r?\n/g, "<br>"),
    multiline,
  };
}

export function serializeMatrixToMarkdown(matrix: MatrixDataset): {
  text: string;
  multilineFlattened: boolean;
} {
  const grid = expandMatrixToGrid(matrix);
  let multilineFlattened = false;
  const renderRow = (cells: string[]): string => {
    const parts = cells.map((cell) => {
      const { out, multiline } = markdownEscapeCell(cell);
      if (multiline) multilineFlattened = true;
      return out;
    });
    return `| ${parts.join(" | ")} |`;
  };
  const header = grid[0] ?? [];
  const separator = `| ${header.map(() => "---").join(" | ")} |`;
  const body = grid.slice(1).map(renderRow);
  const lines = [renderRow(header), separator, ...body];
  return { text: lines.join("\n") + "\n", multilineFlattened };
}

function splitMarkdownRow(line: string): string[] {
  let inner = line.trim();
  if (inner.startsWith("|")) inner = inner.slice(1);
  if (inner.endsWith("|")) inner = inner.slice(0, -1);
  const cells: string[] = [];
  let current = "";
  for (let i = 0; i < inner.length; i += 1) {
    const ch = inner[i]!;
    if (ch === "\\" && inner[i + 1] === "|") {
      current += "|";
      i += 1;
    } else if (ch === "|") {
      cells.push(current.trim());
      current = "";
    } else {
      current += ch;
    }
  }
  cells.push(current.trim());
  return cells.map((cell) => cell.replace(/<br\s*\/?>/gi, "\n"));
}

/** Parse a GitHub-style markdown table into a text grid (header row first). */
export function parseMarkdownTable(text: string): string[][] {
  const lines = text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.startsWith("|"));
  if (lines.length === 0) throw new Error("markdown_table_not_found");
  const rows = lines.filter((line, index) => !(index === 1 && MD_SEPARATOR_RE.test(line)));
  return rows.map(splitMarkdownRow);
}

// ---------------------------------------------------------------------------
// HTML table
// ---------------------------------------------------------------------------

function cellStyleToCss(style: MatrixCellStyle | undefined): string {
  if (!style) return "";
  const parts: string[] = [];
  if (style.align) parts.push(`text-align:${style.align}`);
  if (style.bold) parts.push("font-weight:bold");
  if (style.bg) parts.push(`background-color:${style.bg}`);
  if (style.color) parts.push(`color:${style.color}`);
  if (style.borders) {
    for (const [side, value] of Object.entries(style.borders)) {
      if (value) parts.push(`border-${side}:${value}`);
    }
  }
  return parts.join(";");
}

/** Serialize a matrix as a clean `<table>` with spans + inline cell styles. */
export function serializeMatrixToHtml(matrix: MatrixDataset): string {
  const grid = matrixGrid(matrix);
  const rowsHtml = matrix.rows.map((row, r) => {
    const cellsHtml: string[] = [];
    matrix.columns.forEach((col, c) => {
      const cell = grid[r]?.[c];
      if (!cell || cell.rowId !== row.id || cell.colId !== col.id) return;
      const tag = row.role === "header" ? "th" : "td";
      let attrs = "";
      if ((cell.rowSpan ?? 1) > 1) attrs += ` rowspan="${cell.rowSpan}"`;
      if ((cell.colSpan ?? 1) > 1) attrs += ` colspan="${cell.colSpan}"`;
      const css = cellStyleToCss(cell.style);
      if (css) attrs += ` style="${css}"`;
      const body = escapeHtml(cell.text).replace(/\r?\n/g, "<br>");
      cellsHtml.push(`<${tag}${attrs}>${body}</${tag}>`);
    });
    return `<tr>${cellsHtml.join("")}</tr>`;
  });
  return `<table>\n${rowsHtml.join("\n")}\n</table>\n`;
}

interface HtmlPlacement {
  r: number;
  c: number;
  rowSpan: number;
  colSpan: number;
  text: string;
  style?: MatrixCellStyle;
}

function htmlCellText(el: Element): string {
  const holder = el.ownerDocument.createElement("div");
  holder.innerHTML = el.innerHTML.replace(/<br\s*\/?>/gi, "\n");
  return (holder.textContent ?? "").replace(/ /g, " ").trim();
}

function htmlCellStyle(el: Element): MatrixCellStyle | undefined {
  // Parse the raw attribute (not CSSOM) so hex colors survive round-trips —
  // CSSOM normalizes "#123456" to "rgb(18, 52, 86)".
  const raw = el.getAttribute("style");
  if (!raw) return undefined;
  const style: MatrixCellStyle = {};
  for (const decl of raw.split(";")) {
    const [prop, ...rest] = decl.split(":");
    const value = rest.join(":").trim();
    if (!value) continue;
    switch (prop?.trim().toLowerCase()) {
      case "text-align":
        if (value === "left" || value === "center" || value === "right") {
          style.align = value;
        }
        break;
      case "font-weight":
        if (value === "bold" || Number(value) >= 600) style.bold = true;
        break;
      case "background-color": {
        const bg = sanitizeCssColor(value);
        if (bg) style.bg = bg;
        break;
      }
      case "color": {
        const color = sanitizeCssColor(value);
        if (color) style.color = color;
        break;
      }
      default:
        break;
    }
  }
  return Object.keys(style).length > 0 ? style : undefined;
}

/**
 * Parse the first `<table>` in an HTML document into a matrix, honoring
 * rowspan/colspan (the Excel/Word/HWP paste path). Header rows are rows that
 * contain a `<th>` or live inside `<thead>`.
 */
export function htmlTableToMatrix(html: string, name = ""): MatrixDataset {
  const parsed = new DOMParser().parseFromString(html, "text/html");
  const table = parsed.querySelector("table");
  if (!table) throw new Error("html_table_not_found");
  const trs = [...table.querySelectorAll("tr")];
  if (trs.length === 0) throw new Error("html_table_not_found");

  const covered = new Set<string>();
  const placements: HtmlPlacement[] = [];
  const headerRows: boolean[] = [];
  let colCount = 0;
  trs.forEach((tr, r) => {
    const inHead = tr.closest("thead") !== null;
    let hasTh = false;
    let c = 0;
    for (const cell of tr.children) {
      const tag = cell.tagName.toLowerCase();
      if (tag !== "td" && tag !== "th") continue;
      if (tag === "th") hasTh = true;
      while (covered.has(`${r}:${c}`)) c += 1;
      const rowSpan = Math.max(
        1,
        Math.min(Number(cell.getAttribute("rowspan")) || 1, trs.length - r),
      );
      // Clamp colspan: a hostile/corrupt attribute (colspan="1000000") would
      // otherwise inflate colCount and the covered set before the size gate
      // ever sees the matrix. Real spans never exceed the column limit.
      const rawColSpan = Math.max(
        1,
        Math.min(Number(cell.getAttribute("colspan")) || 1, MATRIX_MAX_COLS),
      );
      // A span may not cross a position covered by an earlier rowspan —
      // otherwise two anchors overlap and the matrix tiling is invalid.
      let colSpan = 1;
      while (colSpan < rawColSpan && !covered.has(`${r}:${c + colSpan}`)) colSpan += 1;
      const style = htmlCellStyle(cell);
      placements.push({
        r,
        c,
        rowSpan,
        colSpan,
        text: htmlCellText(cell),
        ...(style ? { style } : {}),
      });
      for (let dr = 0; dr < rowSpan; dr += 1) {
        for (let dc = 0; dc < colSpan; dc += 1) {
          if (dr === 0 && dc === 0) continue;
          covered.add(`${r + dr}:${c + dc}`);
        }
      }
      c += colSpan;
      colCount = Math.max(colCount, c);
    }
    headerRows.push(inHead || hasTh);
  });
  colCount = Math.max(1, colCount);

  const rows = trs.map((_, i) => ({
    id: createMatrixRowId(),
    role: (headerRows[i] ? "header" : "data") as MatrixRowRole,
  }));
  const columns = Array.from({ length: colCount }, () => ({ id: createMatrixColumnId() }));
  const cells: Record<string, MatrixCell> = {};
  for (const p of placements) {
    const colSpan = Math.min(p.colSpan, colCount - p.c);
    const row = rows[p.r];
    const col = columns[p.c];
    if (!row || !col) continue;
    const cell: MatrixCell = {
      id: createMatrixCellId(),
      rowId: row.id,
      colId: col.id,
      text: p.text,
    };
    if (p.rowSpan > 1) cell.rowSpan = p.rowSpan;
    if (colSpan > 1) cell.colSpan = colSpan;
    if (p.style) cell.style = p.style;
    cells[cell.id] = cell;
  }
  return { id: createDatasetId(), kind: "matrix", name, columns, rows, cells };
}

// ---------------------------------------------------------------------------
// Maru SVG (SVG + embedded canonical doc JSON)
// ---------------------------------------------------------------------------

const MARU_SVG_METADATA_ID = "maru-diagram";

function escapeXmlText(text: string): string {
  return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function unescapeXmlText(text: string): string {
  return text.replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&amp;/g, "&");
}

/** Embed the canonical doc JSON so the SVG re-opens losslessly in Maru. */
export function embedDocMetadata(svg: string, doc: DiagramDoc): string {
  const json = escapeXmlText(serializeDoc(doc));
  const openEnd = svg.indexOf(">");
  if (openEnd < 0) return svg;
  return (
    svg.slice(0, openEnd + 1) +
    `<metadata id="${MARU_SVG_METADATA_ID}">${json}</metadata>` +
    svg.slice(openEnd + 1)
  );
}

/** Extract the embedded doc JSON, or null for arbitrary (foreign) SVG. */
export function extractDocMetadata(svg: string): string | null {
  const match = svg.match(
    new RegExp(`<metadata[^>]*\\bid="${MARU_SVG_METADATA_ID}"[^>]*>([\\s\\S]*?)</metadata>`),
  );
  if (!match || match[1] === undefined) return null;
  return unescapeXmlText(match[1]);
}

function svgToImageDoc(svg: string, filename?: string): DiagramDoc {
  const doc = createEmptyDoc(createDiagramId());
  const node = mkNode("image", 0, 0, { title: filename ?? "" });
  node.meta = { ...node.meta, src: `data:image/svg+xml;base64,${toBase64(svg)}` };
  const title = filename ? filename.replace(/\.[^.]+$/, "") : "";
  return { ...doc, nodes: [node], docTitle: title };
}

// ---------------------------------------------------------------------------
// Raster helpers (PNG/JPG export)
// ---------------------------------------------------------------------------

async function rasterizeDoc(
  doc: DiagramDoc,
  mime: "image/png" | "image/jpeg",
  background: string | null,
): Promise<Uint8Array> {
  const rendered = renderDocToSvg(doc, { padding: 40 });
  const el = new DOMParser().parseFromString(rendered.svg, "image/svg+xml").documentElement;
  const ratio =
    typeof window !== "undefined" ? Math.min(2, Math.max(1, window.devicePixelRatio || 1)) : 1;
  const result = await rasterise(el as unknown as SVGSVGElement, mime, background, ratio, 0.92);
  return new Uint8Array(await result.blob.arrayBuffer());
}

// ---------------------------------------------------------------------------
// Tabular codec plumbing
// ---------------------------------------------------------------------------

const TABULAR_IGNORED_FIELDS = ["styles", "spans", "rowRoles", "semanticTags"];

function spansWarning(matrix: MatrixDataset): CodecWarning[] {
  return matrixHasSpans(matrix) ? [{ key: "diagram.codec.warn.spansFlattened" }] : [];
}

function makeTabularCodec(opts: {
  id: string;
  extension: string;
  exportKind: string;
  serializeGrid: (matrix: MatrixDataset) => { text: string; extraWarnings: CodecWarning[] };
  parseGrid: (text: string) => string[][];
  headerOnImport: boolean;
}): DiagramCodec {
  return {
    id: opts.id,
    labelKey: `diagram.codec.label.${opts.id}`,
    extensions: [opts.extension],
    canImport: true,
    canExport: true,
    exportFidelity: "structural",
    dataKind: "matrix",
    exportKind: opts.exportKind,
    parse(bytes, filename) {
      const grid = opts.parseGrid(toText(bytes));
      const dataset = matrixFromTextGrid(grid, {
        name: filename ? filename.replace(/\.[^.]+$/, "") : "",
        header: opts.headerOnImport,
      });
      return {
        result: { kind: "dataset", dataset },
        fidelity: "structural" as const,
        warnings: [],
        ignoredFields: ["styles", "spans"],
      };
    },
    serialize({ doc, datasetId }) {
      const matrix = requireMatrix(doc, datasetId);
      const { text, extraWarnings } = opts.serializeGrid(matrix);
      return {
        bytes: text,
        fidelity: "structural" as const,
        warnings: [...spansWarning(matrix), ...extraWarnings],
        ignoredFields: TABULAR_IGNORED_FIELDS,
      };
    },
  };
}

// ---------------------------------------------------------------------------
// Registry
// ---------------------------------------------------------------------------

const maruJsonCodec: DiagramCodec = {
  id: "maru-json",
  labelKey: "diagram.codec.label.maru-json",
  extensions: [".json", ".cmd.json"],
  canImport: true,
  canExport: true,
  exportFidelity: "lossless",
  dataKind: "doc",
  exportKind: "json",
  parse(bytes) {
    return {
      result: { kind: "doc", doc: deserializeDoc(toText(bytes)) },
      fidelity: "lossless",
      warnings: [],
    };
  },
  serialize({ doc }) {
    return { bytes: serializeDoc(doc), fidelity: "lossless", warnings: [] };
  },
};

const csvCodec = makeTabularCodec({
  id: "csv",
  extension: ".csv",
  exportKind: "csv",
  headerOnImport: true,
  serializeGrid: (matrix) => ({
    text: serializeGridToCsv(expandMatrixToGrid(matrix)),
    extraWarnings: [],
  }),
  parseGrid: parseCsv,
});

const tsvCodec = makeTabularCodec({
  id: "tsv",
  extension: ".tsv",
  exportKind: "tsv",
  headerOnImport: true,
  serializeGrid: (matrix) => ({
    text: expandMatrixToGrid(matrix)
      .map((row) => row.map(escapeTsvCell).join("\t"))
      .join("\n"),
    extraWarnings: [],
  }),
  parseGrid: parseTsv,
});

const markdownTableCodec = makeTabularCodec({
  id: "markdown-table",
  extension: ".md",
  exportKind: "md",
  headerOnImport: true,
  serializeGrid: (matrix) => {
    const { text, multilineFlattened } = serializeMatrixToMarkdown(matrix);
    return {
      text,
      extraWarnings: multilineFlattened
        ? [{ key: "diagram.codec.warn.multilineFlattened" }]
        : [],
    };
  },
  parseGrid: parseMarkdownTable,
});

const htmlTableCodec: DiagramCodec = {
  id: "html-table",
  labelKey: "diagram.codec.label.html-table",
  extensions: [".html"],
  canImport: true,
  canExport: true,
  exportFidelity: "structural",
  dataKind: "matrix",
  exportKind: "html",
  parse(bytes, filename) {
    const dataset = htmlTableToMatrix(
      toText(bytes),
      filename ? filename.replace(/\.[^.]+$/, "") : "",
    );
    return {
      result: { kind: "dataset", dataset },
      fidelity: "structural",
      warnings: [],
    };
  },
  serialize({ doc, datasetId }) {
    const matrix = requireMatrix(doc, datasetId);
    return {
      bytes: serializeMatrixToHtml(matrix),
      fidelity: "structural",
      warnings: [],
    };
  },
};

const maruSvgCodec: DiagramCodec = {
  id: "maru-svg",
  labelKey: "diagram.codec.label.maru-svg",
  extensions: [".svg"],
  canImport: true,
  canExport: true,
  exportFidelity: "lossless",
  dataKind: "doc",
  exportKind: "svg",
  parse(bytes, filename) {
    const text = toText(bytes);
    const embedded = extractDocMetadata(text);
    if (embedded !== null) {
      return {
        result: { kind: "doc", doc: deserializeDoc(embedded) },
        fidelity: "lossless" as const,
        warnings: [],
      };
    }
    return {
      result: { kind: "doc", doc: svgToImageDoc(text, filename) },
      fidelity: "visual" as const,
      warnings: [{ key: "diagram.codec.warn.svgImageOnly" }],
    };
  },
  serialize({ doc }) {
    const rendered = renderDocToSvg(doc, { padding: 40 });
    const text = `<?xml version="1.0" encoding="UTF-8" standalone="no"?>\n${embedDocMetadata(rendered.svg, doc)}`;
    return { bytes: text, fidelity: "lossless", warnings: [] };
  },
};

/** Plain SVG export without Maru metadata — visual only, cannot re-open. */
const svgImageCodec: DiagramCodec = {
  id: "svg-image",
  labelKey: "diagram.codec.label.svg-image",
  extensions: [".svg"],
  canImport: false,
  canExport: true,
  exportFidelity: "visual",
  dataKind: "visual",
  exportKind: "svg",
  serialize({ doc }) {
    const rendered = renderDocToSvg(doc, { padding: 40 });
    const text = `<?xml version="1.0" encoding="UTF-8" standalone="no"?>\n${rendered.svg}`;
    return {
      bytes: text,
      fidelity: "visual",
      warnings: [{ key: "diagram.codec.warn.visualOnly" }],
    };
  },
};

const mermaidCodec: DiagramCodec = {
  id: "mermaid",
  labelKey: "diagram.codec.label.mermaid",
  extensions: [".mmd"],
  canImport: true,
  canExport: true,
  exportFidelity: "structural",
  dataKind: "doc",
  exportKind: "mmd",
  parse(bytes) {
    return {
      result: { kind: "doc", doc: mermaidToDoc(toText(bytes)) },
      fidelity: "structural",
      warnings: [{ key: "diagram.codec.warn.mermaidImport" }],
      ignoredFields: ["positions", "styles"],
    };
  },
  serialize({ doc }) {
    return {
      bytes: docToMermaid(doc),
      fidelity: "structural",
      warnings: [{ key: "diagram.codec.warn.mermaidExport" }],
      ignoredFields: ["positions", "styles", "datasets"],
    };
  },
};

function makeRasterCodec(opts: {
  id: string;
  extension: string;
  mime: "image/png" | "image/jpeg";
  background: string | null;
}): DiagramCodec {
  return {
    id: opts.id,
    labelKey: `diagram.codec.label.${opts.id}`,
    extensions: [opts.extension],
    canImport: false,
    canExport: true,
    exportFidelity: "visual",
    dataKind: "visual",
    exportKind: opts.mime === "image/jpeg" ? "jpg" : "png",
    async serialize({ doc }) {
      return {
        bytes: await rasterizeDoc(doc, opts.mime, opts.background),
        fidelity: "visual" as const,
        warnings: [],
      };
    },
  };
}

const pngCodec = makeRasterCodec({
  id: "png",
  extension: ".png",
  mime: "image/png",
  background: "#ffffff",
});

const pngTransparentCodec = makeRasterCodec({
  id: "png-transparent",
  extension: ".png",
  mime: "image/png",
  background: null,
});

const jpgCodec = makeRasterCodec({
  id: "jpg",
  extension: ".jpg",
  mime: "image/jpeg",
  background: "#ffffff",
});

/**
 * PDF export goes through the platform print dialog (no byte sink), so the
 * codec declares the format but leaves `serialize`/`exportKind` undefined —
 * the dialog special-cases it.
 */
const pdfCodec: DiagramCodec = {
  id: "pdf",
  labelKey: "diagram.codec.label.pdf",
  extensions: [".pdf"],
  canImport: false,
  canExport: true,
  exportFidelity: "visual",
  dataKind: "visual",
};

export const CODEC_LIST: readonly DiagramCodec[] = [
  maruJsonCodec,
  maruSvgCodec,
  svgImageCodec,
  pngCodec,
  pngTransparentCodec,
  jpgCodec,
  pdfCodec,
  csvCodec,
  tsvCodec,
  markdownTableCodec,
  htmlTableCodec,
  mermaidCodec,
];

export function getCodec(id: string): DiagramCodec | undefined {
  return CODEC_LIST.find((codec) => codec.id === id);
}

/** Resolve an import-capable codec for a file name (`.cmd.json` before `.json`). */
export function codecForFilename(name: string): DiagramCodec | undefined {
  const lower = name.toLowerCase();
  if (lower.endsWith(".cmd.json")) return getCodec("maru-json");
  const dot = lower.lastIndexOf(".");
  if (dot < 0) return undefined;
  const ext = lower.slice(dot);
  return CODEC_LIST.find((codec) => codec.canImport && codec.extensions.includes(ext));
}

const CLIPBOARD_MIME_TO_CODEC: Record<string, string> = {
  "text/html": "html-table",
  "text/csv": "csv",
  "text/tab-separated-values": "tsv",
  "text/markdown": "markdown-table",
  "image/svg+xml": "maru-svg",
  "application/json": "maru-json",
  "text/plain": "tsv",
};

/** Resolve a codec for a clipboard MIME type (parameters like charset ignored). */
export function codecForClipboard(mimeType: string): DiagramCodec | undefined {
  const base = mimeType.toLowerCase().split(";")[0]?.trim() ?? "";
  const id = CLIPBOARD_MIME_TO_CODEC[base];
  return id ? getCodec(id) : undefined;
}

/** All extensions the import file picker should accept. */
export const IMPORT_ACCEPT: string = CODEC_LIST.filter((codec) => codec.canImport)
  .flatMap((codec) => codec.extensions)
  .join(",");
