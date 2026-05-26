/**
 * Diagram document persistence — serialize / parse / migrate.
 *
 * The on-disk format continues the source standalone editor's `v:` numbering
 * (last shipped: `v:6`). We bump to `v:7` here to mark the post-`localhost:5500`
 * boundary; older bodies are migrated forward on read. The Tauri side is a
 * dumb byte store — all schema knowledge lives here.
 */

import {
  diagramLoadDocument,
  diagramSaveDocument,
  type DiagramFile,
} from "../diagram";
import {
  DIAGRAM_SCHEMA_VERSION,
  createDiagramId,
  type DiagramDoc,
  type DiagramEdge,
  type DiagramLayer,
  type DiagramNode,
  type NodeKind,
} from "./types";
import { ALL_KINDS } from "./nodeKinds";

export function serializeDoc(doc: DiagramDoc): string {
  return JSON.stringify(doc, null, 2);
}

function defaultLayers(): DiagramLayer[] {
  return [{ id: "default", name: "default", visible: true, locked: false, order: 0 }];
}

function ensureId(value: unknown, prefix: string, index: number): string {
  if (typeof value === "string" && value.length > 0) return value;
  return `${prefix}-${index + 1}`;
}

function ensureLayers(raw: unknown): DiagramLayer[] {
  if (!Array.isArray(raw)) return defaultLayers();
  const out: DiagramLayer[] = [];
  for (let i = 0; i < raw.length; i += 1) {
    const layer = raw[i] as Partial<DiagramLayer> | undefined;
    if (!layer || typeof layer !== "object") continue;
    out.push({
      id: ensureId(layer.id, "layer", i),
      name: typeof layer.name === "string" ? layer.name : `Layer ${i + 1}`,
      visible: layer.visible !== false,
      locked: layer.locked === true,
      order: typeof layer.order === "number" ? layer.order : i,
    });
  }
  if (out.length === 0) return defaultLayers();
  return out;
}

function ensureNumber(value: unknown, fallback: number): number {
  if (typeof value !== "number") return fallback;
  return Number.isFinite(value) ? value : fallback;
}

const NODE_KIND_SET = new Set<NodeKind>(ALL_KINDS);

function ensureNodeKind(value: unknown): NodeKind {
  if (typeof value === "string" && NODE_KIND_SET.has(value as NodeKind)) {
    return value as NodeKind;
  }
  return "simple";
}

function ensureNode(raw: unknown, index: number): DiagramNode | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Partial<DiagramNode> & Record<string, unknown>;
  return {
    id: ensureId(r.id, "node", index),
    kind: ensureNodeKind(r.kind),
    x: ensureNumber(r.x, 0),
    y: ensureNumber(r.y, 0),
    w: ensureNumber(r.w, 140),
    h: ensureNumber(r.h, 60),
    title: typeof r.title === "string" ? r.title : undefined,
    body: typeof r.body === "string" ? r.body : undefined,
    bullets: Array.isArray(r.bullets) ? r.bullets.filter((b): b is string => typeof b === "string") : undefined,
    layerId: typeof r.layerId === "string" ? r.layerId : undefined,
    locked: r.locked === true,
    hidden: r.hidden === true,
    style: r.style && typeof r.style === "object" ? (r.style as DiagramNode["style"]) : undefined,
    meta: r.meta && typeof r.meta === "object" ? (r.meta as Record<string, unknown>) : undefined,
  };
}

function ensureEdge(raw: unknown, index: number): DiagramEdge | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Partial<DiagramEdge> & Record<string, unknown>;
  if (typeof r.fromNode !== "string" || typeof r.toNode !== "string") return null;
  const port = (p: unknown, fallback: "n" | "s" | "e" | "w"): "n" | "s" | "e" | "w" =>
    p === "n" || p === "s" || p === "e" || p === "w" ? p : fallback;
  return {
    id: ensureId(r.id, "edge", index),
    fromNode: r.fromNode,
    fromPort: port(r.fromPort, "e"),
    toNode: r.toNode,
    toPort: port(r.toPort, "w"),
    routeMode: r.routeMode === "straight" ? "straight" : "auto",
    arrowStart: r.arrowStart === "filled" || r.arrowStart === "open" ? r.arrowStart : "none",
    arrowEnd: r.arrowEnd === "open" || r.arrowEnd === "none" ? r.arrowEnd : "filled",
    arrowSize: ensureNumber(r.arrowSize, 1),
    dash: r.dash === "dashed" ? "dashed" : "solid",
    color: typeof r.color === "string" ? r.color : undefined,
    width: ensureNumber(r.width, 1.5),
    label: typeof r.label === "string" ? r.label : undefined,
    midOff: ensureNumber(r.midOff, 0),
  };
}

/**
 * Bring any-shape JSON into the current {@link DiagramDoc} envelope.
 *
 * Cases handled:
 * - `v:7` doc → identity check + field defaults.
 * - `v:6` doc (source editor's last format) → bump `v`, synthesize layers/timestamps if missing.
 * - Bare `{ nodes, edges }` JSON export → wrap in the envelope.
 * - Anything else → return an empty doc with a synthesized id.
 */
export function migrate(raw: unknown, now: () => number = Date.now): DiagramDoc {
  const obj = raw && typeof raw === "object" ? (raw as Record<string, unknown>) : {};
  const ts = now();
  const id = typeof obj.id === "string" && obj.id.length > 0 ? obj.id : createDiagramId();
  const docTitle = typeof obj.docTitle === "string" ? obj.docTitle
    : typeof obj.title === "string" ? obj.title
    : "";
  const createdAt = ensureNumber(obj.createdAt, ts);
  const updatedAt = ensureNumber(obj.updatedAt, ts);

  const nodesRaw = Array.isArray(obj.nodes) ? obj.nodes : [];
  const edgesRaw = Array.isArray(obj.edges) ? obj.edges : [];
  const nodes: DiagramNode[] = [];
  for (let i = 0; i < nodesRaw.length; i += 1) {
    const n = ensureNode(nodesRaw[i], i);
    if (n) nodes.push(n);
  }
  const edges: DiagramEdge[] = [];
  for (let i = 0; i < edgesRaw.length; i += 1) {
    const e = ensureEdge(edgesRaw[i], i);
    if (e) edges.push(e);
  }
  const layers = ensureLayers(obj.layers);

  return {
    v: DIAGRAM_SCHEMA_VERSION,
    id,
    docTitle,
    createdAt,
    updatedAt,
    nodes,
    edges,
    layers,
    meta: obj.meta && typeof obj.meta === "object" ? (obj.meta as DiagramDoc["meta"]) : undefined,
  };
}

export function deserializeDoc(text: string, now?: () => number): DiagramDoc {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch (err) {
    throw new Error(`Cannot parse diagram JSON: ${(err as Error).message}`);
  }
  return migrate(raw, now);
}

export async function readDiagram(workspace: string, name: string): Promise<DiagramDoc> {
  const body = await diagramLoadDocument(workspace, name);
  return deserializeDoc(body);
}

export async function writeDiagram(
  workspace: string,
  name: string,
  doc: DiagramDoc,
): Promise<DiagramDoc> {
  const stamped: DiagramDoc = { ...doc, updatedAt: Date.now() };
  await diagramSaveDocument(workspace, name, serializeDoc(stamped));
  return stamped;
}

/**
 * Re-export the listing helper so callers don't need to also import from
 * `../diagram`. Keeps `persistence.ts` as the single import surface for
 * documents in component code.
 */
export type { DiagramFile };
export { diagramListDocuments as listDiagrams, diagramDeleteDocument as deleteDiagram } from "../diagram";
