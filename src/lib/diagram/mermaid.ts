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
 * Subgraphs, classDef, click handlers, and linkStyle/style overrides are not
 * supported — and since issue #433 they are no longer dropped silently:
 * `mermaidToDocDetailed` reports each as a structured diagnostic the import
 * dialog surfaces. A non-flowchart diagram type imports nothing (its lines
 * would only become junk nodes); sequence and state diagrams point at
 * generation instead ({@link mermaidSemanticType}).
 */

import { defaultEdge } from "./edgeRouting";
import { mkNode } from "./nodeKinds";
import type { SemanticDiagramType } from "./reportTypes";
import {
  DIAGRAM_SCHEMA_VERSION,
  type DiagramDoc,
  type DiagramEdge,
  type DiagramNode,
  type NodeKind,
} from "./types";

/** Structured import diagnostic; shape-compatible with `CodecWarning`. */
export interface MermaidDiagnostic {
  /** i18n key under `diagram.mermaid.*`. */
  key: string;
  params?: Record<string, string | number>;
}

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
  return mermaidToDocDetailed(text, now).doc;
}

/**
 * Diagram-type headers the flowchart subset does not support. Detected on the
 * first meaningful line; the import then stops with zero nodes and edges.
 */
const UNSUPPORTED_DIAGRAM_HEADERS = [
  "sequenceDiagram",
  "stateDiagram-v2",
  "stateDiagram",
  "classDiagram",
  "erDiagram",
  "gantt",
  "pie",
  "journey",
  "gitGraph",
  "mindmap",
  "timeline",
  "quadrantChart",
  "xychart-beta",
  "sankey-beta",
  "block-beta",
  "packet-beta",
  "architecture-beta",
  "C4Context",
  "C4Container",
  "C4Component",
  "C4Deployment",
  "requirementDiagram",
];

/** Line-level constructs skipped by the parser, now reported (issue #433). */
const UNSUPPORTED_CONSTRUCTS: Array<{ match: (line: string) => boolean; name: string }> = [
  { match: (line) => line.startsWith("subgraph"), name: "subgraph" },
  { match: (line) => line === "end", name: "end" },
  { match: (line) => line.startsWith("classDef"), name: "classDef" },
  { match: (line) => line.startsWith("class "), name: "class" },
  { match: (line) => line.startsWith("click "), name: "click" },
  { match: (line) => line.startsWith("style "), name: "style" },
  { match: (line) => line.startsWith("linkStyle"), name: "linkStyle" },
];

/** Mermaid headers whose meaning a semantic diagram type can carry via generation. */
const SEMANTIC_HEADERS: Record<string, SemanticDiagramType> = {
  sequenceDiagram: "sequence",
  stateDiagram: "lifecycle",
  "stateDiagram-v2": "lifecycle",
};

function firstMeaningfulLine(text: string): string | null {
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (line && !line.startsWith("%%")) return line;
  }
  return null;
}

function headerOf(line: string, headers: readonly string[]): string | undefined {
  return headers.find((header) => line === header || line.startsWith(`${header} `));
}

/**
 * The semantic diagram type a Mermaid text maps to (`sequenceDiagram` →
 * sequence, `stateDiagram[-v2]` → lifecycle), or null for anything else.
 */
export function mermaidSemanticType(text: string): SemanticDiagramType | null {
  const line = firstMeaningfulLine(text);
  const header = line ? headerOf(line, Object.keys(SEMANTIC_HEADERS)) : undefined;
  return header ? SEMANTIC_HEADERS[header]! : null;
}

const HEADER_DIRECTION = /^(?:flowchart|graph)\s+(TD|TB|BT|LR|RL)\b/;

export function mermaidToDocDetailed(
  text: string,
  now: () => number = Date.now,
): { doc: DiagramDoc; diagnostics: MermaidDiagnostic[] } {
  const nodes = new Map<string, ImportedNode>();
  const edges: Array<{ from: string; to: string; arrowEnd: DiagramEdge["arrowEnd"]; dash: DiagramEdge["dash"]; label?: string }> = [];
  const diagnostics: MermaidDiagnostic[] = [];
  const reported = new Set<string>();
  const report = (diagnostic: MermaidDiagnostic) => {
    const dedupe = `${diagnostic.key}:${JSON.stringify(diagnostic.params ?? {})}`;
    if (reported.has(dedupe)) return;
    reported.add(dedupe);
    diagnostics.push(diagnostic);
  };

  const first = firstMeaningfulLine(text);
  const unsupported = first ? headerOf(first, UNSUPPORTED_DIAGRAM_HEADERS) : undefined;
  if (unsupported) {
    report({ key: "diagram.mermaid.unsupportedDiagramType", params: { type: unsupported } });
    const semantic = SEMANTIC_HEADERS[unsupported];
    if (semantic) report({ key: "diagram.mermaid.useGeneration", params: { type: semantic } });
  }
  const lines = unsupported ? [] : text.split(/\r?\n/);
  for (let raw of lines) {
    let line = raw.trim();
    if (!line || line.startsWith("%%")) continue;
    const direction = line.match(HEADER_DIRECTION);
    if (direction) {
      const dir = direction[1]!;
      if (dir !== "TD" && dir !== "TB") {
        report({ key: "diagram.mermaid.directionIgnored", params: { direction: dir } });
      }
      continue;
    }
    if (line.startsWith("flowchart") || line.startsWith("graph")) continue;
    const construct = UNSUPPORTED_CONSTRUCTS.find((entry) => entry.match(line));
    if (construct) {
      report({ key: "diagram.mermaid.unsupportedConstruct", params: { construct: construct.name } });
      continue;
    }

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
  const doc: DiagramDoc = {
    v: DIAGRAM_SCHEMA_VERSION,
    id: typeof crypto !== "undefined" && crypto.randomUUID ? crypto.randomUUID() : `doc-${ts}`,
    docTitle: "",
    createdAt: ts,
    updatedAt: ts,
    nodes: docNodes,
    edges: docEdges,
    layers: [{ id: "default", name: "default", visible: true, locked: false, order: 0 }],
  };
  return { doc, diagnostics };
}
