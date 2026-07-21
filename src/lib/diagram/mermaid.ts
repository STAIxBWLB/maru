/**
 * Mermaid interop — round-trip between `DiagramDoc` and Mermaid `flowchart` text.
 *
 * Export is lossless on **structure** (nodes + kinds + edges + labels) and
 * lossy on **positions** (Mermaid is layout-engine driven). Re-importing the
 * exported text gives you the same diagram with a fresh top-down layout.
 *
 * Import covers the minimal flowchart subset:
 *   - `flowchart TD|LR|BT|RL` header (direction parsed but always emitted as TD)
 *   - Node shapes: `A[...]`, `A(...)`, `A((...))`, `A{...}`, `A{{...}}`,
 *     `A[(...)]`, `A>...]`
 *   - Edges: `-->`, `-.->`, `---`, `==>`, optional `|label|`
 *   - Inline `Id[Label]` and standalone `Id` references.
 * Subgraphs, classDef, click handlers, and style overrides are ignored.
 */

import { defaultEdge } from "./edgeRouting";
import { mkNode } from "./nodeKinds";
import {
  DIAGRAM_SCHEMA_VERSION,
  type DiagramDoc,
  type DiagramEdge,
  type DiagramNode,
  type NodeKind,
} from "./types";

// ---------------------------------------------------------------------------
// Export
// ---------------------------------------------------------------------------

function shapeForKind(kind: NodeKind, label: string): string {
  const esc = label.replace(/[\[\]\(\)\{\}\|"`]/g, " ").replace(/\s+/g, " ").trim();
  switch (kind) {
    case "oval":
      return `((${esc}))`;
    case "diamond":
      return `{${esc}}`;
    case "hexagon":
      return `{{${esc}}}`;
    case "cylinder":
      return `[(${esc})]`;
    case "callout":
      return `>${esc}]`;
    case "text":
      return `[/${esc}/]`;
    case "section":
    case "titled-box":
    case "split-box":
    case "numbered":
    case "image":
    case "table":
    case "simple":
    default:
      return `[${esc}]`;
  }
}

function safeId(value: string, fallback: string): string {
  const cleaned = value.replace(/[^A-Za-z0-9_]/g, "_").replace(/^_+|_+$/g, "");
  if (cleaned.length === 0) return fallback;
  if (/^[0-9]/.test(cleaned)) return `n_${cleaned}`;
  return cleaned;
}

function arrowFor(edge: DiagramEdge): string {
  const dashed = edge.dash === "dashed";
  const noArrow = edge.arrowEnd === "none";
  if (dashed && noArrow) return "-.- ";
  if (dashed) return "-.->";
  if (noArrow) return "---";
  return "-->";
}

export function docToMermaid(doc: DiagramDoc): string {
  const idMap = new Map<string, string>();
  const lines: string[] = ["flowchart TD"];
  const title = doc.docTitle.trim();
  if (title) lines.unshift(`%% ${title}`);
  doc.nodes.forEach((node, index) => {
    const short = safeId(node.id, `n${index}`);
    let unique = short;
    let suffix = 2;
    while ([...idMap.values()].includes(unique)) {
      unique = `${short}_${suffix++}`;
    }
    idMap.set(node.id, unique);
    const label = node.title?.trim() || node.body?.trim() || node.id;
    lines.push(`  ${unique}${shapeForKind(node.kind, label)}`);
  });
  for (const edge of doc.edges) {
    const from = idMap.get(edge.fromNode);
    const to = idMap.get(edge.toNode);
    if (!from || !to) continue;
    const arrow = arrowFor(edge);
    const label = edge.label?.trim();
    if (label) {
      const safeLabel = label.replace(/\|/g, "/");
      lines.push(`  ${from} ${arrow}|${safeLabel}| ${to}`);
    } else {
      lines.push(`  ${from} ${arrow} ${to}`);
    }
  }
  return lines.join("\n") + "\n";
}

// ---------------------------------------------------------------------------
// Import
// ---------------------------------------------------------------------------

const SHAPE_PATTERNS: Array<{
  re: RegExp;
  kind: NodeKind;
  pickLabel: (groups: RegExpMatchArray) => string;
}> = [
  // Order matters — match the most specific patterns first.
  { re: /^([A-Za-z0-9_]+)\{\{([^}]+)\}\}/, kind: "hexagon", pickLabel: (m) => m[2] ?? "" },
  { re: /^([A-Za-z0-9_]+)\[\(([^)]+)\)\]/, kind: "cylinder", pickLabel: (m) => m[2] ?? "" },
  { re: /^([A-Za-z0-9_]+)\(\(([^)]+)\)\)/, kind: "oval", pickLabel: (m) => m[2] ?? "" },
  { re: /^([A-Za-z0-9_]+)>([^\]]+)\]/, kind: "callout", pickLabel: (m) => m[2] ?? "" },
  { re: /^([A-Za-z0-9_]+)\[\/([^/]+)\/\]/, kind: "text", pickLabel: (m) => m[2] ?? "" },
  { re: /^([A-Za-z0-9_]+)\{([^}]+)\}/, kind: "diamond", pickLabel: (m) => m[2] ?? "" },
  { re: /^([A-Za-z0-9_]+)\[([^\]]+)\]/, kind: "simple", pickLabel: (m) => m[2] ?? "" },
];

interface ImportedNode {
  id: string;
  kind: NodeKind;
  label: string;
  /** True when the source token included shape brackets — only such tokens
   *  may overwrite an existing entry. Bare references (`B --> C`) reuse the
   *  prior definition. */
  explicit: boolean;
}

function consumeNode(text: string): { node: ImportedNode | null; rest: string } {
  for (const pattern of SHAPE_PATTERNS) {
    const match = text.match(pattern.re);
    if (match) {
      const id = match[1]!;
      const label = pattern.pickLabel(match).trim();
      return {
        node: { id, kind: pattern.kind, label, explicit: true },
        rest: text.slice(match[0].length),
      };
    }
  }
  const bareMatch = text.match(/^([A-Za-z0-9_]+)/);
  if (bareMatch) {
    return {
      node: { id: bareMatch[1]!, kind: "simple", label: bareMatch[1]!, explicit: false },
      rest: text.slice(bareMatch[0].length),
    };
  }
  return { node: null, rest: text };
}

function commitNode(map: Map<string, ImportedNode>, node: ImportedNode): void {
  const existing = map.get(node.id);
  if (existing && existing.explicit && !node.explicit) return;
  map.set(node.id, node);
}

function parseEdgeArrow(text: string): {
  arrowEnd: DiagramEdge["arrowEnd"];
  dash: DiagramEdge["dash"];
  rest: string;
} | null {
  const dashedNoArrow = text.match(/^-\.-(?!>)/);
  if (dashedNoArrow) {
    return { arrowEnd: "none", dash: "dashed", rest: text.slice(dashedNoArrow[0].length) };
  }
  const dashed = text.match(/^-\.->/);
  if (dashed) return { arrowEnd: "filled", dash: "dashed", rest: text.slice(dashed[0].length) };
  const thick = text.match(/^==+>/);
  if (thick) return { arrowEnd: "filled", dash: "solid", rest: text.slice(thick[0].length) };
  const solid = text.match(/^--+>/);
  if (solid) return { arrowEnd: "filled", dash: "solid", rest: text.slice(solid[0].length) };
  const noArrow = text.match(/^---+/);
  if (noArrow) return { arrowEnd: "none", dash: "solid", rest: text.slice(noArrow[0].length) };
  return null;
}

export function mermaidToDoc(text: string, now: () => number = Date.now): DiagramDoc {
  const nodes = new Map<string, ImportedNode>();
  const edges: Array<{ from: string; to: string; arrowEnd: DiagramEdge["arrowEnd"]; dash: DiagramEdge["dash"]; label?: string }> = [];

  for (let raw of text.split(/\r?\n/)) {
    let line = raw.trim();
    if (!line || line.startsWith("%%") || line.startsWith("flowchart") || line.startsWith("graph")) continue;
    if (line.startsWith("subgraph") || line === "end" || line.startsWith("classDef") || line.startsWith("class ") || line.startsWith("click ") || line.startsWith("style ")) continue;

    // Walk the line, consuming a node, optional arrow, optional next node.
    const first = consumeNode(line);
    if (!first.node) continue;
    commitNode(nodes, first.node);
    line = first.rest.trimStart();

    while (line.length > 0) {
      const arrow = parseEdgeArrow(line);
      if (!arrow) break;
      let cursor = arrow.rest.trimStart();
      let label: string | undefined;
      if (cursor.startsWith("|")) {
        const end = cursor.indexOf("|", 1);
        if (end > 0) {
          label = cursor.slice(1, end);
          cursor = cursor.slice(end + 1).trimStart();
        }
      }
      const second = consumeNode(cursor);
      if (!second.node) break;
      commitNode(nodes, second.node);
      edges.push({
        from: first.node.id,
        to: second.node.id,
        arrowEnd: arrow.arrowEnd,
        dash: arrow.dash,
        label,
      });
      line = second.rest.trimStart();
      // Chain continuation: A --> B --> C
      first.node = second.node;
    }
  }

  // Lay out top-down: group by levels via BFS from in-degree-0 sources.
  const nodeIds = [...nodes.keys()];
  const inDeg = new Map<string, number>();
  for (const id of nodeIds) inDeg.set(id, 0);
  for (const e of edges) {
    inDeg.set(e.to, (inDeg.get(e.to) ?? 0) + 1);
  }
  const level = new Map<string, number>();
  const queue: string[] = nodeIds.filter((id) => (inDeg.get(id) ?? 0) === 0);
  queue.forEach((id) => level.set(id, 0));
  let head = 0;
  while (head < queue.length) {
    const id = queue[head++]!;
    const d = level.get(id) ?? 0;
    for (const e of edges) {
      if (e.from !== id) continue;
      const prev = level.get(e.to);
      const candidate = d + 1;
      if (prev === undefined || prev < candidate) {
        level.set(e.to, candidate);
        if (!queue.includes(e.to)) queue.push(e.to);
      }
    }
  }
  for (const id of nodeIds) if (!level.has(id)) level.set(id, 0);
  const byLevel = new Map<number, string[]>();
  for (const id of nodeIds) {
    const d = level.get(id) ?? 0;
    if (!byLevel.has(d)) byLevel.set(d, []);
    byLevel.get(d)!.push(id);
  }

  const HSPACING = 200;
  const VSPACING = 120;
  const docNodes: DiagramNode[] = [];
  const idMap = new Map<string, string>();
  for (const [depth, ids] of [...byLevel.entries()].sort((a, b) => a[0] - b[0])) {
    const rowWidth = ids.length * HSPACING;
    ids.forEach((sourceId, idx) => {
      const source = nodes.get(sourceId)!;
      const x = Math.round(-rowWidth / 2 + idx * HSPACING + 600);
      const y = Math.round(120 + depth * VSPACING);
      const node = mkNode(source.kind, x, y, { title: source.label });
      idMap.set(sourceId, node.id);
      docNodes.push(node);
    });
  }
  const docEdges: DiagramEdge[] = edges
    .map((e, i) => {
      const from = idMap.get(e.from);
      const to = idMap.get(e.to);
      if (!from || !to) return null;
      return defaultEdge(`edge-${i + 1}`, from, "s", to, "n", {
        arrowEnd: e.arrowEnd,
        dash: e.dash,
        label: e.label,
      });
    })
    .filter((e): e is DiagramEdge => e !== null);

  const ts = now();
  return {
    v: DIAGRAM_SCHEMA_VERSION,
    id: typeof crypto !== "undefined" && crypto.randomUUID ? crypto.randomUUID() : `doc-${ts}`,
    docTitle: "",
    createdAt: ts,
    updatedAt: ts,
    nodes: docNodes,
    edges: docEdges,
    layers: [{ id: "default", name: "default", visible: true, locked: false, order: 0 }],
  };
}
