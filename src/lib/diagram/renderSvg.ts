/**
 * Pure document→SVG renderer.
 *
 * The old export path deep-cloned the live `<svg class="maru-diagram-canvas">`,
 * which leaked interactive chrome (selection rects, ports, smart guides,
 * marquee, connect ghost) into exports and silently dropped every node the
 * viewport culler had skipped. `renderDocToSvg` builds the SVG straight from
 * the document model instead: every node kind from `NodeView.tsx` (`NodeBody`,
 * `SectionHeader`, `NodeLabel`), edges routed through
 * {@link routeEdge} with the shared arrow markers, plus the status/progress
 * decorators derived from `node.meta`.
 *
 * Model-driven visibility: `node.hidden` and nodes on a layer with
 * `visible: false` are excluded; edges missing either endpoint are dropped.
 *
 * The output is self-contained — all presentation is inline attributes and
 * inline `style` (the canvas label/header CSS classes are replicated inline
 * inside each `foreignObject`), so the string can be rasterised via an
 * Image+Canvas trip or saved as a standalone .svg with no external requests.
 *
 * Pure string building: no DOM, no React — safe to call from unit tests in a
 * node environment.
 */

import { ARROW_MARKER_ID, routeEdge } from "./edgeRouting";
import { bbox } from "./geometry";
import type { MatrixDataset } from "./reportTypes";
import { escapeHtml } from "./richText";
import {
  TABLE_GRID_BORDER,
  TABLE_ROLE_FILLS,
  TABLE_TEXT_COLOR,
  cellRect,
  computeTableLayout,
  matrixGrid,
  parseBorderShorthand,
} from "./tableEditing";
import type { DiagramDoc, DiagramEdge, DiagramNode, NodeStyle } from "./types";

const SVG_NS = "http://www.w3.org/2000/svg";
const XHTML_NS = "http://www.w3.org/1999/xhtml";

/** Generic system stack — the exported file must render without the app CSS. */
const FONT_FAMILY = "-apple-system, Segoe UI, Roboto, Helvetica Neue, Arial, sans-serif";

export interface RenderSvgOpts {
  /** Padding (canvas-space px) around the diagram's bounding box. */
  padding?: number;
}

export interface RenderedDiagramSvg {
  /** Full `<svg>…</svg>` markup (no XML prolog). */
  svg: string;
  viewBox: { x: number; y: number; w: number; h: number };
  width: number;
  height: number;
}

interface ShapeStyle {
  bg: string;
  border: string;
  fc: string;
  fs: number;
  fw: number;
  br: number;
  bw: number;
}

type NodeStatus = "todo" | "doing" | "done" | "blocked";

const STATUS_COLORS: Record<NodeStatus, { bg: string; fg: string; bar: string }> = {
  todo: { bg: "#e2e8f0", fg: "#1e293b", bar: "#94a3b8" },
  doing: { bg: "#dbeafe", fg: "#1e40af", bar: "#2563eb" },
  done: { bg: "#dcfce7", fg: "#14532d", bar: "#16a34a" },
  blocked: { bg: "#fee2e2", fg: "#7f1d1d", bar: "#dc2626" },
};

/** Keep coordinate strings short and stable for snapshot-ish tests. */
function num(value: number): string {
  const rounded = Math.round(value * 100) / 100;
  return String(Object.is(rounded, -0) ? 0 : rounded);
}

// Mirrors `shapeFor` in NodeView.tsx — keep the two in sync.
function shapeFor(node: DiagramNode): ShapeStyle {
  const style: NodeStyle = node.style ?? {};
  return {
    bg: style.bg ?? (node.kind === "text" ? "transparent" : "#ffffff"),
    border: style.border ?? (node.kind === "text" ? "transparent" : "#1f2937"),
    fc: style.fc ?? "#111827",
    fs: style.fs ?? (node.kind === "text" ? 13 : 12),
    fw: style.fw ?? (node.kind === "text" ? 500 : 600),
    br: style.br ?? 4,
    bw: style.bw ?? (node.kind === "text" ? 0 : 1.5),
  };
}

/**
 * Matrix table body — mirrors `TableView.tsx` (span-aware cells, role
 * shading, per-cell style, multiline text/bullets). Selection chrome and
 * resize handles are interactive-only and never exported.
 */
function tableMatrixSvg(node: DiagramNode, matrix: MatrixDataset, s: ShapeStyle): string {
  const layout = computeTableLayout(matrix, node.w, node.h);
  const grid = matrixGrid(matrix);
  const fontSize = 11;
  let out = rectSvg(node.w, node.h, s);

  const borderLine = (
    x1: number,
    y1: number,
    x2: number,
    y2: number,
    raw: string | undefined,
  ): string => {
    const parsed = parseBorderShorthand(raw) ?? { width: 1, color: TABLE_GRID_BORDER, dash: false };
    if (parsed.width <= 0) return "";
    return (
      `<line x1="${num(x1)}" y1="${num(y1)}" x2="${num(x2)}" y2="${num(y2)}"` +
      ` stroke="${escapeHtml(parsed.color)}" stroke-width="${num(parsed.width)}"` +
      (parsed.dash ? ` stroke-dasharray="4 3"` : "") +
      `/>`
    );
  };

  for (let r = 0; r < matrix.rows.length; r += 1) {
    for (let c = 0; c < matrix.columns.length; c += 1) {
      const cell = grid[r]?.[c];
      if (!cell) continue;
      if (cell.rowId !== matrix.rows[r]?.id || cell.colId !== matrix.columns[c]?.id) continue;
      const rect = cellRect(matrix, layout, cell, r, c);
      const role = matrix.rows[r]?.role ?? "data";
      out +=
        `<rect x="${num(rect.x)}" y="${num(rect.y)}" width="${num(rect.w)}" height="${num(rect.h)}"` +
        ` fill="${escapeHtml(cell.style?.bg ?? TABLE_ROLE_FILLS[role])}"/>`;
      out += borderLine(rect.x, rect.y, rect.x + rect.w, rect.y, cell.style?.borders?.top);
      out += borderLine(rect.x, rect.y + rect.h, rect.x + rect.w, rect.y + rect.h, cell.style?.borders?.bottom);
      out += borderLine(rect.x, rect.y, rect.x, rect.y + rect.h, cell.style?.borders?.left);
      out += borderLine(rect.x + rect.w, rect.y, rect.x + rect.w, rect.y + rect.h, cell.style?.borders?.right);

      const hasBullets = (cell.bullets?.length ?? 0) > 0;
      if (cell.text || hasBullets) {
        const align = cell.style?.align ?? "left";
        let inner = "";
        if (cell.text) inner += `<div>${escapeHtml(cell.text)}</div>`;
        if (hasBullets) {
          inner +=
            `<ul style="margin:0;padding-left:1.1em;align-self:stretch;text-align:left">` +
            (cell.bullets ?? [])
              .map((bullet) => `<li>${escapeHtml(bullet)}</li>`)
              .join("") +
            `</ul>`;
        }
        const style =
          "width:100%;height:100%;display:flex;flex-direction:column;" +
          `align-items:${align === "center" ? "center" : align === "right" ? "flex-end" : "flex-start"};` +
          "justify-content:center;padding:1px 6px;box-sizing:border-box;overflow:hidden;" +
          `font-family:${FONT_FAMILY};font-size:${fontSize}px;line-height:1.3;` +
          `font-weight:${cell.style?.bold ? 700 : 400};` +
          `color:${escapeHtml(cell.style?.color ?? TABLE_TEXT_COLOR)};` +
          `text-align:${align};white-space:pre-wrap;word-break:break-word;`;
        out +=
          `<foreignObject x="${num(rect.x)}" y="${num(rect.y)}" width="${num(rect.w)}" height="${num(rect.h)}">` +
          `<div xmlns="${XHTML_NS}" style="${style}">${inner}</div>` +
          `</foreignObject>`;
      }
    }
  }
  return `<g>${out}</g>`;
}

function polygonPath(points: Array<[number, number]>): string {
  return points.map((p, i) => `${i === 0 ? "M" : "L"} ${num(p[0])} ${num(p[1])}`).join(" ") + " Z";
}

function rectSvg(w: number, h: number, s: ShapeStyle, extra = ""): string {
  return (
    `<rect width="${num(w)}" height="${num(h)}" rx="${num(s.br)}" ry="${num(s.br)}"` +
    ` fill="${s.bg}" stroke="${s.border}" stroke-width="${num(s.bw)}"${extra}/>`
  );
}

// Mirrors `NodeBody` in NodeView.tsx (numbered badge included). For
// view-linked tables `matrix` is the dataset resolved from the doc.
function nodeBodySvg(node: DiagramNode, matrix?: MatrixDataset | null): string {
  const s = shapeFor(node);
  const w = node.w;
  const h = node.h;
  const headerH = 26;

  switch (node.kind) {
    case "simple":
    case "numbered": {
      let out = rectSvg(w, h, s);
      if (node.kind === "numbered") {
        const number = (node.meta?.number as string | number | undefined) ?? "1";
        out +=
          `<g><circle cx="14" cy="14" r="9" fill="#1f2937"/>` +
          `<text x="14" y="18" text-anchor="middle" font-size="10" font-weight="700" fill="#ffffff">` +
          `${escapeHtml(String(number))}</text></g>`;
      }
      return out;
    }
    case "text":
      return "";
    case "diamond":
      return (
        `<path d="${polygonPath([[w / 2, 0], [w, h / 2], [w / 2, h], [0, h / 2]])}"` +
        ` fill="${s.bg}" stroke="${s.border}" stroke-width="${num(s.bw)}"/>`
      );
    case "oval":
      return (
        `<ellipse cx="${num(w / 2)}" cy="${num(h / 2)}" rx="${num(w / 2)}" ry="${num(h / 2)}"` +
        ` fill="${s.bg}" stroke="${s.border}" stroke-width="${num(s.bw)}"/>`
      );
    case "hexagon": {
      const off = Math.min(w * 0.18, h / 2);
      return (
        `<path d="${polygonPath([
          [off, 0],
          [w - off, 0],
          [w, h / 2],
          [w - off, h],
          [off, h],
          [0, h / 2],
        ])}" fill="${s.bg}" stroke="${s.border}" stroke-width="${num(s.bw)}"/>`
      );
    }
    case "cylinder": {
      const ear = Math.min(14, h * 0.18);
      return (
        `<g>` +
        `<path d="M 0 ${num(ear)} A ${num(w / 2)} ${num(ear)} 0 0 1 ${num(w)} ${num(ear)}` +
        ` L ${num(w)} ${num(h - ear)} A ${num(w / 2)} ${num(ear)} 0 0 1 0 ${num(h - ear)} Z"` +
        ` fill="${s.bg}" stroke="${s.border}" stroke-width="${num(s.bw)}"/>` +
        `<path d="M 0 ${num(ear)} A ${num(w / 2)} ${num(ear)} 0 0 0 ${num(w)} ${num(ear)}"` +
        ` fill="none" stroke="${s.border}" stroke-width="${num(s.bw)}"/>` +
        `</g>`
      );
    }
    case "callout": {
      const tailW = Math.min(20, w * 0.18);
      const tailH = Math.min(18, h * 0.25);
      return (
        `<path d="M ${num(s.br)} 0 H ${num(w - s.br)} Q ${num(w)} 0 ${num(w)} ${num(s.br)}` +
        ` V ${num(h - tailH - s.br)} Q ${num(w)} ${num(h - tailH)} ${num(w - s.br)} ${num(h - tailH)}` +
        ` H ${num(tailW + 16)} L ${num(tailW + 8)} ${num(h)} L ${num(tailW + 4)} ${num(h - tailH)}` +
        ` H ${num(s.br)} Q 0 ${num(h - tailH)} 0 ${num(h - tailH - s.br)} V ${num(s.br)} Q 0 0 ${num(s.br)} 0 Z"` +
        ` fill="${s.bg}" stroke="${s.border}" stroke-width="${num(s.bw)}"/>`
      );
    }
    case "section":
    case "titled-box":
      return (
        `<g>` +
        rectSvg(w, h, s) +
        `<rect width="${num(w)}" height="${headerH}" rx="${num(s.br)}" ry="${num(s.br)}"` +
        ` fill="#1f2937" stroke="${s.border}" stroke-width="${num(s.bw)}"/>` +
        `<rect width="${num(w)}" height="${num(headerH - s.br)}" fill="#1f2937"/>` +
        `</g>`
      );
    case "split-box": {
      const mid = w / 2;
      return (
        `<g>` +
        rectSvg(w, h, s) +
        `<line x1="${num(mid)}" y1="0" x2="${num(mid)}" y2="${num(h)}"` +
        ` stroke="${s.border}" stroke-width="${num(s.bw)}"/>` +
        `</g>`
      );
    }
    case "table": {
      // View-linked tables render the matrix dataset (mirrors the canvas).
      if (matrix) return tableMatrixSvg(node, matrix, s);
      const rows = Math.max(1, Number(node.meta?.rows) || 3);
      const cols = Math.max(1, Number(node.meta?.cols) || 3);
      const cellW = w / cols;
      const cellH = h / rows;
      let lines = "";
      for (let i = 1; i < cols; i += 1) {
        lines +=
          `<line x1="${num(i * cellW)}" y1="0" x2="${num(i * cellW)}" y2="${num(h)}"` +
          ` stroke="${s.border}" stroke-width="1"/>`;
      }
      for (let j = 1; j < rows; j += 1) {
        lines +=
          `<line x1="0" y1="${num(j * cellH)}" x2="${num(w)}" y2="${num(j * cellH)}"` +
          ` stroke="${s.border}" stroke-width="1"/>`;
      }
      return `<g>${rectSvg(w, h, s)}${lines}</g>`;
    }
    case "image": {
      const src = typeof node.meta?.src === "string" ? node.meta.src : null;
      return (
        `<g>` +
        rectSvg(w, h, s) +
        (src
          ? `<image href="${escapeHtml(src)}" x="0" y="0" width="${num(w)}" height="${num(h)}"` +
            ` preserveAspectRatio="xMidYMid meet"/>`
          : "") +
        `</g>`
      );
    }
    default:
      return rectSvg(w, h, s);
  }
}

/** Inline replica of `.maru-diagram-node-label` (+ per-node style overrides). */
function labelContainerStyle(s: ShapeStyle, align: NodeStyle["align"]): string {
  return (
    "width:100%;height:100%;display:flex;flex-direction:column;align-items:center;" +
    "justify-content:center;padding:4px 8px;line-height:1.35;word-break:break-word;" +
    `white-space:pre-wrap;box-sizing:border-box;font-family:${FONT_FAMILY};` +
    `color:${s.fc};font-size:${s.fs}px;font-weight:${s.fw};text-align:${align ?? "center"};`
  );
}

// Mirrors `NodeLabel` in NodeView.tsx — title/body/bullets inside foreignObject.
function nodeLabelSvg(node: DiagramNode): string {
  const headered = node.kind === "section" || node.kind === "titled-box";
  const title = headered ? null : (node.title ?? null);
  const body = node.body ?? null;
  const bullets = node.bullets ?? [];
  if (!title && !body && bullets.length === 0) return "";
  const s = shapeFor(node);
  const headerH = headered ? 26 : 0;
  const padTop = node.kind === "numbered" ? 24 : 0;
  const x = node.kind === "numbered" ? padTop : 0;
  const width = Math.max(0, node.w - (node.kind === "numbered" ? padTop : 0));
  const height = Math.max(0, node.h - headerH);

  let inner = "";
  if (title) inner += `<div>${escapeHtml(title)}</div>`;
  if (body) inner += `<div style="font-weight:400">${escapeHtml(body)}</div>`;
  if (bullets.length > 0) {
    const items = bullets
      .map((bullet) => `<li style="margin:1px 0">${escapeHtml(bullet)}</li>`)
      .join("");
    inner +=
      `<ul style="margin:2px 0 0;padding-left:1.2em;font-weight:400;text-align:left;` +
      `align-self:stretch">${items}</ul>`;
  }

  return (
    `<foreignObject x="${num(x)}" y="${num(headerH)}" width="${num(width)}" height="${num(height)}">` +
    `<div xmlns="${XHTML_NS}" style="${labelContainerStyle(s, node.style?.align)}">${inner}</div>` +
    `</foreignObject>`
  );
}

// Mirrors `SectionHeader` in NodeView.tsx.
function sectionHeaderSvg(node: DiagramNode): string {
  if (node.kind !== "section" && node.kind !== "titled-box") return "";
  const style =
    "width:100%;height:100%;display:flex;align-items:center;justify-content:center;" +
    "padding:4px 8px;line-height:1.2;word-break:break-word;white-space:pre-wrap;" +
    `box-sizing:border-box;font-family:${FONT_FAMILY};` +
    `color:${node.style?.fc ?? "#ffffff"};font-size:${(node.style?.fs ?? 12) + 1}px;` +
    "font-weight:700;text-align:center;";
  return (
    `<foreignObject x="0" y="0" width="${num(node.w)}" height="26">` +
    `<div xmlns="${XHTML_NS}" style="${style}">${escapeHtml(node.title ?? "")}</div>` +
    `</foreignObject>`
  );
}

// Status pill + progress bar from `NodeViewBase` — pure functions of node.meta.
function metaDecorationsSvg(node: DiagramNode): string {
  const statusRaw = typeof node.meta?.status === "string" ? node.meta.status : null;
  const status: NodeStatus | null =
    statusRaw === "todo" || statusRaw === "doing" || statusRaw === "done" || statusRaw === "blocked"
      ? statusRaw
      : null;
  const progressRaw = typeof node.meta?.progress === "number" ? node.meta.progress : null;
  const progress = progressRaw === null ? null : Math.max(0, Math.min(100, progressRaw));
  const palette = status ? STATUS_COLORS[status] : null;
  let out = "";
  if (palette && status) {
    const pillW = Math.max(38, status.length * 8 + 12);
    out +=
      `<g transform="translate(8, -10)">` +
      `<rect x="0" y="0" rx="9" ry="9" width="${num(pillW)}" height="18"` +
      ` fill="${palette.bg}" stroke="${palette.bar}" stroke-width="1"/>` +
      `<text x="${num(pillW / 2)}" y="12" text-anchor="middle" font-size="10" font-weight="700"` +
      ` fill="${palette.fg}">${status}</text>` +
      `</g>`;
  }
  if (progress !== null) {
    const barW = node.w - 8;
    out +=
      `<g transform="translate(4, ${num(node.h - 6 - 4)})">` +
      `<rect x="0" y="0" width="${num(barW)}" height="6" rx="3" ry="3" fill="rgba(0,0,0,0.08)"/>` +
      `<rect x="0" y="0" width="${num((barW * progress) / 100)}" height="6" rx="3" ry="3"` +
      ` fill="${palette?.bar ?? "#16a34a"}"/>` +
      `</g>`;
  }
  return out;
}

function nodeSvg(node: DiagramNode, matrix?: MatrixDataset | null): string {
  const matrixTable = node.kind === "table" && matrix != null;
  return (
    `<g transform="translate(${num(node.x)},${num(node.y)})" data-node-id="${escapeHtml(node.id)}">` +
    nodeBodySvg(node, matrix) +
    sectionHeaderSvg(node) +
    (matrixTable ? "" : nodeLabelSvg(node)) +
    metaDecorationsSvg(node) +
    `</g>`
  );
}

function arrowMarkerAttr(kind: DiagramEdge["arrowStart"] | DiagramEdge["arrowEnd"]): string {
  if (kind === "filled") return `url(#${ARROW_MARKER_ID.filled})`;
  if (kind === "open") return `url(#${ARROW_MARKER_ID.open})`;
  return "";
}

// Mirrors `EdgeView` (visible path only — the transparent hit-area path is
// interactive chrome and stays out of exports).
function edgeSvg(edge: DiagramEdge, fromNode: DiagramNode, toNode: DiagramNode): string {
  const routed = routeEdge(edge, fromNode, toNode);
  if (!routed) return "";
  const color = edge.color ?? "#1f2937";
  const strokeWidth = edge.width ?? 1.5;
  const dash = edge.dash === "dashed" ? ` stroke-dasharray="6 4"` : "";
  const markerStart = arrowMarkerAttr(edge.arrowStart);
  const markerEnd = arrowMarkerAttr(edge.arrowEnd);
  let out =
    `<path d="${routed.path}" fill="none" stroke="${color}" stroke-width="${num(strokeWidth)}"` +
    `${dash} stroke-linecap="round" stroke-linejoin="round"` +
    (markerStart ? ` marker-start="${markerStart}"` : "") +
    (markerEnd ? ` marker-end="${markerEnd}"` : "") +
    `/>`;
  if (edge.label) {
    const halfW = Math.max(edge.label.length * 3.5, 16);
    const w = Math.max(edge.label.length * 7, 32);
    out +=
      `<g transform="translate(${num(routed.label.x)}, ${num(routed.label.y)})">` +
      `<rect x="${num(-halfW)}" y="-9" width="${num(w)}" height="18" rx="3" ry="3"` +
      ` fill="#ffffff" stroke="${color}" stroke-width="1"/>` +
      `<text x="0" y="4" text-anchor="middle" font-size="11" font-weight="500" fill="${color}">` +
      `${escapeHtml(edge.label)}</text>` +
      `</g>`;
  }
  return `<g data-edge-id="${escapeHtml(edge.id)}">${out}</g>`;
}

// Same `<defs>` as EdgeMarkers.tsx so exported arrowheads match the canvas.
function markerDefsSvg(): string {
  return (
    `<defs>` +
    `<marker id="${ARROW_MARKER_ID.filled}" viewBox="0 0 10 10" refX="9" refY="5"` +
    ` markerUnits="strokeWidth" markerWidth="6" markerHeight="6" orient="auto-start-reverse">` +
    `<path d="M 0 0 L 10 5 L 0 10 z" fill="context-stroke"/></marker>` +
    `<marker id="${ARROW_MARKER_ID.open}" viewBox="0 0 10 10" refX="9" refY="5"` +
    ` markerUnits="strokeWidth" markerWidth="6" markerHeight="6" orient="auto-start-reverse">` +
    `<path d="M 0 0 L 10 5 L 0 10" fill="none" stroke="context-stroke" stroke-width="1.2"/></marker>` +
    `</defs>`
  );
}

/** Union of the node bbox, every routed edge path, and edge-label extents. */
function docBounds(
  nodes: DiagramNode[],
  edges: DiagramEdge[],
  nodeById: Map<string, DiagramNode>,
): { x: number; y: number; w: number; h: number } | null {
  const box = bbox(nodes);
  let minX = box ? box.x : Infinity;
  let minY = box ? box.y : Infinity;
  let maxX = box ? box.x + box.w : -Infinity;
  let maxY = box ? box.y + box.h : -Infinity;
  for (const edge of edges) {
    const from = nodeById.get(edge.fromNode);
    const to = nodeById.get(edge.toNode);
    if (!from || !to) continue;
    const routed = routeEdge(edge, from, to);
    if (!routed) continue;
    const coords = routed.path.match(/-?\d+(?:\.\d+)?/g) ?? [];
    for (let i = 0; i + 1 < coords.length; i += 2) {
      const px = Number(coords[i]);
      const py = Number(coords[i + 1]);
      if (px < minX) minX = px;
      if (py < minY) minY = py;
      if (px > maxX) maxX = px;
      if (py > maxY) maxY = py;
    }
    if (edge.label) {
      const halfW = Math.max(edge.label.length * 3.5, 16);
      minX = Math.min(minX, routed.label.x - halfW);
      maxX = Math.max(maxX, routed.label.x + halfW);
      minY = Math.min(minY, routed.label.y - 9);
      maxY = Math.max(maxY, routed.label.y + 9);
    }
  }
  if (!Number.isFinite(minX) || !Number.isFinite(minY)) return null;
  return { x: minX, y: minY, w: maxX - minX, h: maxY - minY };
}

/**
 * Render the full document to a standalone SVG. All nodes are included
 * regardless of the live viewport (no culling); hidden nodes and nodes on
 * invisible layers are excluded by the model.
 */
export function renderDocToSvg(doc: DiagramDoc, opts: RenderSvgOpts = {}): RenderedDiagramSvg {
  const padding = opts.padding ?? 40;

  const hiddenLayers = new Set(doc.layers.filter((layer) => !layer.visible).map((l) => l.id));
  const nodes = doc.nodes.filter(
    (node) => !node.hidden && !(node.layerId && hiddenLayers.has(node.layerId)),
  );
  const nodeById = new Map(nodes.map((node) => [node.id, node]));
  const edges = doc.edges.filter(
    (edge) => nodeById.has(edge.fromNode) && nodeById.has(edge.toNode),
  );

  const bounds = docBounds(nodes, edges, nodeById) ?? { x: 0, y: 0, w: 800, h: 600 };
  const viewBox = {
    x: bounds.x - padding,
    y: bounds.y - padding,
    w: Math.max(1, bounds.w + padding * 2),
    h: Math.max(1, bounds.h + padding * 2),
  };

  // Resolve view-linked matrix tables (node.meta.memberId → matrix dataset),
  // the same link the migration and `addTableNode` stamp.
  const datasetsById = new Map((doc.datasets ?? []).map((ds) => [ds.id, ds]));
  const matrixByNodeId = new Map<string, MatrixDataset>();
  for (const node of nodes) {
    if (node.kind !== "table" || !node.meta) continue;
    const memberId = (node.meta as Record<string, unknown>).memberId;
    if (typeof memberId !== "string") continue;
    const ds = datasetsById.get(memberId);
    if (ds && ds.kind === "matrix") matrixByNodeId.set(node.id, ds as MatrixDataset);
  }

  const content =
    edges.map((edge) => edgeSvg(edge, nodeById.get(edge.fromNode)!, nodeById.get(edge.toNode)!)).join("") +
    nodes.map((node) => nodeSvg(node, matrixByNodeId.get(node.id) ?? null)).join("");

  const svg =
    `<svg xmlns="${SVG_NS}" xmlns:xlink="http://www.w3.org/1999/xlink"` +
    ` viewBox="${num(viewBox.x)} ${num(viewBox.y)} ${num(viewBox.w)} ${num(viewBox.h)}"` +
    ` width="${num(viewBox.w)}" height="${num(viewBox.h)}">` +
    markerDefsSvg() +
    content +
    `</svg>`;

  return { svg, viewBox, width: viewBox.w, height: viewBox.h };
}
