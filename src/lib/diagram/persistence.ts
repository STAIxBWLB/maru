/**
 * Diagram document persistence — serialize / parse / migrate.
 *
 * The on-disk format continues the source standalone editor's `v:` numbering
 * (last shipped: `v:6`). `v:7` marked the post-`localhost:5500` boundary;
 * `v:8` adds report datasets + pattern views (Report Pattern Studio). Older
 * bodies are migrated forward on read; bodies newer than
 * {@link DIAGRAM_SCHEMA_VERSION} throw {@link UnsupportedDiagramVersionError}
 * and are never down-converted. The Tauri side is a dumb byte store — all
 * schema knowledge lives here.
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
import {
  TABLE_PATTERN_ID,
  computeProjectionHash,
  createDatasetId,
  createPatternViewId,
  matrixFromRowsCols,
  type PatternView,
  type ReportDataset,
  type TypedNodeMeta,
} from "./reportTypes";
import { ALL_KINDS } from "./nodeKinds";

/** Thrown when a document was written by a newer schema than this build knows. */
export class UnsupportedDiagramVersionError extends Error {
  readonly version: number;
  readonly supported: number;

  constructor(version: number, supported: number = DIAGRAM_SCHEMA_VERSION) {
    super(`Unsupported diagram schema version: v${version} (this build supports up to v${supported})`);
    this.name = "UnsupportedDiagramVersionError";
    this.version = version;
    this.supported = supported;
  }
}

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
 * Legacy `meta` keys that map onto {@link TypedNodeMeta} fields, with a
 * coercion for each. Unknown keys are preserved untouched.
 */
const LEGACY_META_COERCIONS: Record<string, (value: unknown) => unknown> = {
  src: (v) => (typeof v === "string" ? v : undefined),
  name: (v) => (typeof v === "string" ? v : undefined),
  memo: (v) => (typeof v === "string" ? v : undefined),
  status: (v) => (typeof v === "string" ? v : undefined),
  progress: (v) => (typeof v === "number" && Number.isFinite(v) ? v : undefined),
  number: (v) => (typeof v === "number" && Number.isFinite(v) ? v : undefined),
};

function ensureDatasets(raw: unknown): ReportDataset[] {
  // Shallow normalization only: dataset payloads pass through untouched so a
  // v8 round-trip is lossless. Deep validation is `validateMatrix`'s job.
  return Array.isArray(raw) ? (raw as ReportDataset[]) : [];
}

function ensureViews(raw: unknown): PatternView[] {
  return Array.isArray(raw) ? (raw as PatternView[]) : [];
}

interface V8Upgrade {
  nodes: DiagramNode[];
  datasets: ReportDataset[];
  views: PatternView[];
}

/**
 * v7 → v8 upgrade.
 *
 * - Table nodes carrying legacy numeric `meta.rows`/`meta.cols` get an empty
 *   `MatrixDataset` of that size plus a `PatternView` (pattern `"table"`)
 *   matching the node's bounds; the node keeps position/size/style and its
 *   `meta` gains typed `{ viewId, memberId }` pointers.
 * - Other legacy `meta` keys are coerced onto their `TypedNodeMeta`
 *   equivalents; unknown keys stay in `meta` untouched.
 */
function upgradeV7ToV8(nodes: DiagramNode[]): V8Upgrade {
  const datasets: ReportDataset[] = [];
  const views: PatternView[] = [];
  const upgraded = nodes.map((node) => {
    if (!node.meta || typeof node.meta !== "object") return node;
    const meta: Record<string, unknown> = { ...node.meta };
    const typed: TypedNodeMeta = {};

    if (node.kind === "table") {
      const rowCount = typeof meta.rows === "number" && Number.isInteger(meta.rows) && meta.rows > 0
        ? meta.rows
        : 0;
      const colCount = typeof meta.cols === "number" && Number.isInteger(meta.cols) && meta.cols > 0
        ? meta.cols
        : 0;
      if (rowCount > 0 && colCount > 0) {
        const dataset = matrixFromRowsCols(rowCount, colCount, {
          id: createDatasetId(),
          name: node.title ?? "",
        });
        const view: PatternView = {
          id: createPatternViewId(),
          datasetId: dataset.id,
          patternId: TABLE_PATTERN_ID,
          bounds: { x: node.x, y: node.y, w: node.w, h: node.h },
          nodeIds: [node.id],
          edgeIds: [],
          projectionHash: computeProjectionHash({
            patternId: TABLE_PATTERN_ID,
            dataset,
            bounds: { x: node.x, y: node.y, w: node.w, h: node.h },
          }),
        };
        datasets.push(dataset);
        views.push(view);
        typed.viewId = view.id;
        typed.memberId = dataset.id;
        delete meta.rows;
        delete meta.cols;
      }
    }

    for (const [key, coerce] of Object.entries(LEGACY_META_COERCIONS)) {
      if (!(key in meta)) continue;
      const value = coerce(meta[key]);
      if (value !== undefined) {
        (typed as Record<string, unknown>)[key] = value;
        delete meta[key];
      }
    }

    const merged = { ...meta, ...typed };
    return { ...node, meta: Object.keys(merged).length > 0 ? merged : undefined };
  });
  return { nodes: upgraded, datasets, views };
}

/**
 * Bring any-shape JSON into the current {@link DiagramDoc} envelope.
 *
 * Cases handled:
 * - `v:8` doc → identity check + field defaults (datasets/views default to []).
 * - `v:7` doc → field defaults, then the v7→v8 upgrade (table `meta.rows/cols`
 *   become datasets + views, legacy meta keys map onto `TypedNodeMeta`).
 * - `v:6` doc (source editor's last format) → same path as v7.
 * - Bare `{ nodes, edges }` JSON export → wrap in the envelope.
 * - `v` greater than {@link DIAGRAM_SCHEMA_VERSION} →
 *   {@link UnsupportedDiagramVersionError} (never down-convert).
 * - Anything else → return an empty doc with a synthesized id.
 */
export function migrate(raw: unknown, now: () => number = Date.now): DiagramDoc {
  const obj = raw && typeof raw === "object" ? (raw as Record<string, unknown>) : {};
  if (typeof obj.v === "number" && obj.v > DIAGRAM_SCHEMA_VERSION) {
    throw new UnsupportedDiagramVersionError(obj.v);
  }
  const ts = now();
  const id = typeof obj.id === "string" && obj.id.length > 0 ? obj.id : createDiagramId();
  const docTitle = typeof obj.docTitle === "string" ? obj.docTitle
    : typeof obj.title === "string" ? obj.title
    : "";
  const createdAt = ensureNumber(obj.createdAt, ts);
  const updatedAt = ensureNumber(obj.updatedAt, ts);

  const nodesRaw = Array.isArray(obj.nodes) ? obj.nodes : [];
  const edgesRaw = Array.isArray(obj.edges) ? obj.edges : [];
  let nodes: DiagramNode[] = [];
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

  let datasets = ensureDatasets(obj.datasets);
  let views = ensureViews(obj.views);
  if (typeof obj.v === "number" && obj.v < DIAGRAM_SCHEMA_VERSION) {
    const upgrade = upgradeV7ToV8(nodes);
    nodes = upgrade.nodes;
    datasets = [...datasets, ...upgrade.datasets];
    views = [...views, ...upgrade.views];
  }

  return {
    v: DIAGRAM_SCHEMA_VERSION,
    id,
    docTitle,
    createdAt,
    updatedAt,
    nodes,
    edges,
    layers,
    datasets,
    views,
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

export interface ReadDiagramResult {
  doc: DiagramDoc;
  /** Schema version found on disk, or null for bare/unversioned JSON. */
  sourceVersion: number | null;
  /** True when the on-disk body predates v8 (first v8 save triggers a backup). */
  migratedFromLegacy: boolean;
}

export async function readDiagramDetailed(
  workspace: string,
  name: string,
): Promise<ReadDiagramResult> {
  const body = await diagramLoadDocument(workspace, name);
  let sourceVersion: number | null = null;
  try {
    const parsed = JSON.parse(body) as { v?: unknown };
    sourceVersion = typeof parsed.v === "number" ? parsed.v : null;
  } catch {
    /* deserializeDoc below reports the real parse error */
  }
  const doc = deserializeDoc(body);
  return {
    doc,
    sourceVersion,
    migratedFromLegacy: sourceVersion !== null && sourceVersion < DIAGRAM_SCHEMA_VERSION,
  };
}

export async function readDiagram(workspace: string, name: string): Promise<DiagramDoc> {
  const { doc } = await readDiagramDetailed(workspace, name);
  return doc;
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
