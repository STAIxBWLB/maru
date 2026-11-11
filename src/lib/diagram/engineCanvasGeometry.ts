/**
 * Product canvas geometry store (issue #552 E4 T3).
 *
 * The canvas draws the engine's own scene: node and container boxes, the
 * wrapped label lines the engine measured, and route points. Fixed-point
 * coordinates become pixels here and nowhere else (`fixedToPixels`), so no
 * consumer re-measures text or re-derives a path from node boxes, and Korean
 * label lines are never sliced with backend offsets — the engine's `\n`
 * delimiter splits them.
 *
 * Safety contract: the store reads the doc and never writes it. A layout runs
 * once per distinct source/pin key and off the keystroke path; a refused or
 * failed layout keeps the last good geometry (``stale``) or, on the first run,
 * leaves the canvas on its projected source positions, so opening, editing,
 * history and saving never wait for the engine.
 */
import type { Diagnostic, GeometryReport } from "../../../src-tauri/crates/maru-diagram-engine/bindings/engine";
import { fixedToPixels, isPinnableCanvasMember, layoutCanvasRequest, type ContentOffset } from "./engineGeometryCanvas";
import type { GeometryEngine } from "./engineGeometry";
import { ENGINE_DIAGRAM_TYPES, type SemanticSpecDataset } from "./reportTypes";
import { descriptorFor, projectedRelationEdgeIds, semanticMemberNodeIds, specEntries } from "./semantic";
import type { DiagramDoc, DiagramNode, NodeId } from "./types";

export interface CanvasGeometryPoint {
  x: number;
  y: number;
}

export interface CanvasGeometryBox {
  /** Canvas node id the box belongs to. */
  id: string;
  /** Engine source id the box was emitted for. */
  sourceId: string;
  role: "node" | "container";
  x: number;
  y: number;
  w: number;
  h: number;
}

export type CanvasGeometryLabelRole = "label" | "sublabel" | "tag";

export interface CanvasGeometryLabel {
  /** Engine label id, e.g. `node:api:label`. */
  id: string;
  /** Canvas id of the labelled node, container or edge. */
  targetId: string;
  role: CanvasGeometryLabelRole;
  /** Engine line breaks, never re-wrapped here. */
  lines: readonly string[];
  x: number;
  y: number;
  w: number;
  h: number;
  fontSize: number;
  weight: 400 | 700;
}

export interface CanvasGeometryRoute {
  /** Canvas edge id the route belongs to. */
  id: string;
  sourceId: string;
  points: readonly CanvasGeometryPoint[];
}

export interface CanvasGeometryPage {
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface CanvasGeometry {
  /** Canvas node id → engine box, entity nodes and containers alike. */
  boxes: ReadonlyMap<string, CanvasGeometryBox>;
  /** Canvas node or edge id → the engine labels drawn on it. */
  labels: ReadonlyMap<string, readonly CanvasGeometryLabel[]>;
  /** Canvas edge id → engine route points. */
  routes: ReadonlyMap<string, CanvasGeometryRoute>;
  /** Document title and subtitle in page coordinates: no member owns them. */
  pageLabels: readonly CanvasGeometryLabel[];
  page: CanvasGeometryPage | null;
  diagnostics: readonly Diagnostic[];
}

/** Node/container and relation ids belong to separate label namespaces. */
export function canvasLabelsFor(
  geometry: CanvasGeometry,
  id: string,
  kind: "node" | "edge",
): readonly CanvasGeometryLabel[] {
  return (geometry.labels.get(id) ?? []).filter((label) => label.id.startsWith("edge:") === (kind === "edge"));
}

export type CanvasGeometryStatus = "idle" | "pending" | "ready" | "stale" | "refused";

export interface CanvasGeometryState {
  /** The dataset the canvas is drawing, or null when it keeps canvas placement. */
  datasetId: string | null;
  status: CanvasGeometryStatus;
  geometry: CanvasGeometry | null;
  /** Diagnostics of the last attempt, kept while a stale scene is displayed. */
  diagnostics: readonly Diagnostic[];
  /** Hash of the exact source spec the displayed geometry was emitted for. */
  sourceSpecSha256: string | null;
}

export type CanvasEngineLoader = () => Promise<Pick<GeometryEngine, "layout">>;

const IDLE: CanvasGeometryState = Object.freeze({
  datasetId: null,
  status: "idle",
  geometry: null,
  diagnostics: [],
  sourceSpecSha256: null,
});

/**
 * Route id prefix the engine allocates per family for a relation that carries
 * no id (`allocate_route_ids` in the layout crate). Only id-less relations use
 * it; an authored id is reported verbatim.
 */
const RELATION_ROUTE_PREFIX: Readonly<Record<string, string>> = {
  architecture: "connection",
  workflow: "edge",
  sequence: "message",
  dataflow: "flow",
  lifecycle: "transition",
};

/** Suffix the engine appends when an authored id already owns `<prefix>:<n>`. */
const GENERATED_ROUTE_SUFFIX = ":generated";

/**
 * The semantic dataset this canvas draws, or null. The five engine families
 * are drawn; Floorplan stays local-only and an ambiguous document (no
 * semantic dataset, or several) keeps canvas placement rather than guessing.
 */
export function canvasGeometryDatasetId(doc: DiagramDoc): string | null {
  const datasets = (doc.datasets ?? []).filter(
    (dataset): dataset is SemanticSpecDataset => dataset.kind === "semanticSpec",
  );
  if (datasets.length !== 1) return null;
  const only = datasets[0]!;
  return ENGINE_DIAGRAM_TYPES.some((type) => type === only.diagramType) ? only.id : null;
}

function labelRole(id: string): CanvasGeometryLabelRole {
  if (id.endsWith(":sublabel")) return "sublabel";
  if (id.endsWith(":tag")) return "tag";
  return "label";
}

/**
 * Map one engine report onto canvas ids. Entity ids come from the dataset's
 * recorded id map; a container id (`lane:main`, `segment:0`) becomes the doc's
 * projected container id. Returns null when the engine refused the document.
 */
export function canvasGeometryOf(
  report: GeometryReport,
  doc: DiagramDoc,
  dataset: SemanticSpecDataset,
): CanvasGeometry | null {
  const scene = report.ok ? report.geometry : null;
  if (!scene) return null;
  const canvasId = (sourceId: string, role: "node" | "container"): string => {
    if (Object.hasOwn(dataset.idMap, sourceId)) return dataset.idMap[sourceId]!;
    if (role === "node") return sourceId;
    const memberId = `${dataset.id}:${sourceId}`;
    return doc.nodes.find((node) => node.meta?.memberId === memberId)?.id ?? memberId;
  };
  // The engine names a relation route `<role>:<index>` when the source relation
  // carries no id, while the projection mints `<datasetId>-e<index>` for it (a
  // legacy document). Without this mapping the route and its label miss the
  // canvas edge and the canvas silently falls back to the legacy router. The
  // name is only the engine's own when no authored relation claims it: the same
  // shape is a legal authored id, and then the id-less route is the one the
  // engine renamed `:generated`.
  const relationPrefix = RELATION_ROUTE_PREFIX[dataset.diagramType] ?? null;
  const descriptor = descriptorFor(dataset);
  const relations = descriptor ? specEntries(dataset.spec, descriptor.relations) : [];
  const projectedIds = projectedRelationEdgeIds(dataset);
  const authoredCanvasIds = new Map<string, string | null>();
  relations.forEach((relation, index) => {
    if (typeof relation.id === "string" && relation.id.length > 0 && !authoredCanvasIds.has(relation.id)) {
      authoredCanvasIds.set(relation.id, projectedIds[index] ?? null);
    }
  });
  const relationCanvasId = (sourceId: string): string | null => {
    if (authoredCanvasIds.has(sourceId)) return authoredCanvasIds.get(sourceId) ?? null;
    if (!relationPrefix || !sourceId.startsWith(`${relationPrefix}:`)) return null;
    let index = sourceId.slice(relationPrefix.length + 1);
    while (index.endsWith(GENERATED_ROUTE_SUFFIX)) index = index.slice(0, -GENERATED_ROUTE_SUFFIX.length);
    if (!/^(0|[1-9][0-9]*)$/.test(index)) return null;
    const relation = relations[Number(index)];
    const idLess = relation !== undefined && (typeof relation.id !== "string" || relation.id.length === 0);
    if (!idLess) return null;
    const projected = projectedIds[Number(index)];
    if (projected === null || projected === undefined) return null;
    return doc.edges.some((edge) => edge.id === projected) ? projected : null;
  };
  const labelTarget = (id: string, targetId: string): string | null => {
    if (id.startsWith("container:")) return canvasId(targetId, "container");
    if (id.startsWith("edge:")) return relationCanvasId(targetId) ?? canvasId(targetId, "node");
    // A member named document is not the document header: its label still
    // belongs to the node namespace.
    if (targetId === "document" && !id.startsWith("node:")) return null;
    return canvasId(targetId, "node");
  };
  const boxes = new Map<string, CanvasGeometryBox>();
  const box = (role: "node" | "container", sourceId: string, bounds: { x: number; y: number; width: number; height: number }) => {
    const id = canvasId(sourceId, role);
    return {
      id,
      sourceId,
      role,
      x: fixedToPixels(bounds.x, `the ${role} ${sourceId} x`),
      y: fixedToPixels(bounds.y, `the ${role} ${sourceId} y`),
      w: fixedToPixels(bounds.width, `the ${role} ${sourceId} width`),
      h: fixedToPixels(bounds.height, `the ${role} ${sourceId} height`),
    };
  };
  for (const node of scene.nodes) {
    const entry = box("node", node.id, node.bounds);
    boxes.set(entry.id, entry);
  }
  for (const container of scene.containers) {
    const entry = box("container", container.id, container.bounds);
    // An entity id wins a theoretical collision: it is the editable member.
    if (!boxes.has(entry.id)) boxes.set(entry.id, entry);
  }
  const labels = new Map<string, CanvasGeometryLabel[]>();
  const pageLabels: CanvasGeometryLabel[] = [];
  scene.labels.forEach((label, index) => {
    const id = label.id ?? `label:${index}`;
    const targetId = labelTarget(id, label.targetId);
    const entry: CanvasGeometryLabel = {
      id,
      targetId: targetId ?? label.targetId,
      role: labelRole(id),
      lines: label.text.split("\n"),
      x: fixedToPixels(label.bounds.x, `the label ${id} x`),
      y: fixedToPixels(label.bounds.y, `the label ${id} y`),
      w: fixedToPixels(label.bounds.width, `the label ${id} width`),
      h: fixedToPixels(label.bounds.height, `the label ${id} height`),
      fontSize: fixedToPixels(label.fontSize, `the label ${id} size`),
      weight: label.font.weight === 700 ? 700 : 400,
    };
    if (targetId === null) {
      pageLabels.push(entry);
      return;
    }
    const list = labels.get(targetId);
    if (list) list.push(entry);
    else labels.set(targetId, [entry]);
  });
  const routes = new Map<string, CanvasGeometryRoute>();
  scene.routes.forEach((route, index) => {
    const sourceId = route.id ?? `route:${index}`;
    const id = relationCanvasId(sourceId) ?? canvasId(sourceId, "node");
    routes.set(id, {
      id,
      sourceId,
      points: route.points.map((point) => ({
        x: fixedToPixels(point.x, `route ${sourceId} x`),
        y: fixedToPixels(point.y, `route ${sourceId} y`),
      })),
    });
  });
  return {
    boxes,
    labels,
    routes,
    pageLabels,
    page: {
      x: fixedToPixels(scene.page.bounds.x, "the page x"),
      y: fixedToPixels(scene.page.bounds.y, "the page y"),
      w: fixedToPixels(scene.page.bounds.width, "the page width"),
      h: fixedToPixels(scene.page.bounds.height, "the page height"),
    },
    diagnostics: report.diagnostics,
  };
}

/** The SVG path through engine route points; the render boundary already divided. */
export function routePathOf(route: CanvasGeometryRoute): string {
  return route.points
    .map((point, index) => `${index === 0 ? "M" : "L"} ${point.x} ${point.y}`)
    .join(" ");
}

export interface CanvasDisplayOffset {
  ids: ReadonlySet<string>;
  dx: number;
  dy: number;
  /** Per-member painted positions, including earlier drops awaiting a scene. */
  positions?: ReadonlyMap<NodeId, CanvasGeometryPoint>;
}

/**
 * The box the canvas paints for one node: the engine's box when the scene owns
 * the node, plus the live drag offset while a gesture is moving it. A node the
 * engine did not emit keeps its own placement, so free-form, template, pattern
 * and mermaid canvases are unchanged.
 */
export function canvasDisplayNode(
  node: DiagramNode,
  geometry: CanvasGeometry | null,
  offset: CanvasDisplayOffset | null = null,
): DiagramNode {
  const moved = offset?.ids.has(node.id) === true;
  const dx = moved && offset ? offset.dx : 0;
  const dy = moved && offset ? offset.dy : 0;
  const box = geometry?.boxes.get(node.id) ?? null;
  const position = offset?.positions?.get(node.id);
  const x = position?.x ?? (box?.x ?? node.x) + dx;
  const y = position?.y ?? (box?.y ?? node.y) + dy;
  const w = box?.w ?? node.w;
  const h = box?.h ?? node.h;
  return node.x === x && node.y === y && node.w === w && node.h === h ? node : { ...node, x, y, w, h };
}

/**
 * Where an authored move of `node` starts from: the box the canvas paints, or
 * the member's own position once it is pinned. That stored position is where
 * the last layout put it, so a second nudge arriving before the box behind it
 * has been replaced still moves the member on by one step.
 */
export function canvasMoveBase(node: DiagramNode, geometry: CanvasGeometry | null): CanvasGeometryPoint {
  if (node.meta?.pinned === true) return { x: node.x, y: node.y };
  const box = geometry?.boxes.get(node.id) ?? null;
  return box ? { x: box.x, y: box.y } : { x: node.x, y: node.y };
}

/** All members whose placement belongs to the drawn engine dataset. */
export function canvasEngineDrawnIds(doc: DiagramDoc, datasetId: string | null, geometry: CanvasGeometry | null): ReadonlySet<NodeId> {
  return new Set([
    ...(geometry?.boxes.keys() ?? []),
    ...(datasetId ? semanticMemberNodeIds(doc, datasetId) : []),
  ]);
}

/**
 * The pins a keyboard nudge of `ids` authors: a member the engine draws is
 * moved by pinning the box the canvas shows it at, exactly as a drop does,
 * because its doc position is a slot the next layout overwrites. Members the
 * canvas places itself return nothing and keep the live doc move.
 */
export function canvasNudgePins(
  doc: DiagramDoc,
  datasetId: string | null,
  geometry: CanvasGeometry | null,
  ids: Iterable<NodeId>,
  dx: number,
  dy: number,
): Array<{ id: NodeId; x: number; y: number }> {
  if (datasetId === null) return [];
  const pins: Array<{ id: NodeId; x: number; y: number }> = [];
  for (const id of ids) {
    const node = doc.nodes.find((candidate) => candidate.id === id);
    if (!node || !isPinnableCanvasMember(doc, datasetId, node)) continue;
    const base = canvasMoveBase(node, geometry);
    pins.push({ id, x: base.x + dx, y: base.y + dy });
  }
  return pins;
}

/** One engine label in the labelled node's own coordinate space. */
export interface CanvasLabelLines {
  id: string;
  role: CanvasGeometryLabelRole;
  lines: readonly string[];
  x: number;
  y: number;
  w: number;
  h: number;
  fontSize: number;
  weight: 400 | 700;
}

export function canvasLabelLines(label: CanvasGeometryLabel, origin: { x: number; y: number }): CanvasLabelLines {
  return {
    id: label.id,
    role: label.role,
    lines: label.lines,
    x: label.x - origin.x,
    y: label.y - origin.y,
    w: label.w,
    h: label.h,
    fontSize: label.fontSize,
    weight: label.weight,
  };
}

interface Entry {
  documentId: string | null;
  generation: number;
  state: CanvasGeometryState;
  listeners: Set<() => void>;
  /** Source/pin key of the geometry currently displayed. */
  cacheKey: string | null;
  /** Source/pin key of the layout in flight, and the layout itself. */
  pendingKey: string | null;
  pending: Promise<void> | null;
  /** Page offset measured for one exact source spec, so a drop needs one layout. */
  offset: { specJson: string; value: ContentOffset } | null;
}

const entries = new Map<string, Entry>();

function defaultEngineLoader(): Promise<Pick<GeometryEngine, "layout">> {
  // Lazy so importing this store never pulls the geometry WASM asset into a
  // consumer that does not draw a semantic canvas.
  return import("./engineGeometry").then((module) => module.loadGeometryEngine());
}

let engineLoader: CanvasEngineLoader = defaultEngineLoader;

/** Test seam: replace the lazy geometry engine, or pass null to restore it. */
export function _setCanvasEngineLoaderForTests(loader: CanvasEngineLoader | null): void {
  engineLoader = loader ?? defaultEngineLoader;
}

function entryFor(datasetId: string): Entry {
  let entry = entries.get(datasetId);
  if (!entry) {
    entry = {
      documentId: null,
      generation: 0,
      state: { datasetId, status: "idle", geometry: null, diagnostics: [], sourceSpecSha256: null },
      listeners: new Set(),
      cacheKey: null,
      pendingKey: null,
      pending: null,
      offset: null,
    };
    entries.set(datasetId, entry);
  }
  return entry;
}

function publish(entry: Entry, next: CanvasGeometryState): void {
  entry.state = Object.freeze(next);
  for (const listener of [...entry.listeners]) listener();
}

/** Current geometry state for a dataset; a stable object until it changes. */
export function canvasGeometryState(datasetId: string | null): CanvasGeometryState {
  return datasetId === null ? IDLE : entryFor(datasetId).state;
}

export function subscribeCanvasGeometry(datasetId: string, listener: () => void): () => void {
  const entry = entryFor(datasetId);
  entry.listeners.add(listener);
  return () => {
    entry.listeners.delete(listener);
  };
}

function resetEntry(entry: Entry): void {
  entry.documentId = null;
  entry.generation += 1;
  entry.cacheKey = null;
  entry.pendingKey = null;
  entry.pending = null;
  entry.offset = null;
  publish(entry, { ...IDLE, datasetId: entry.state.datasetId });
}

/** Invalidate displayed scenes and in-flight work when opening/replacing a document. */
export function resetCanvasGeometry(): void {
  for (const entry of entries.values()) resetEntry(entry);
}

/** Only a ready scene for these exact source and pin bytes may feed visual exports. */
export function matchingCanvasGeometry(doc: DiagramDoc): CanvasGeometry | null {
  const datasetId = canvasGeometryDatasetId(doc);
  if (!datasetId) return null;
  const entry = entries.get(datasetId);
  const dataset = doc.datasets?.find((item) => item.id === datasetId);
  if (!entry || dataset?.kind !== "semanticSpec" || entry.documentId !== doc.id
    || entry.pendingKey !== null || entry.state.status !== "ready") return null;
  try {
    return entry.cacheKey === canvasLayoutKey(JSON.stringify(dataset.spec), doc) ? entry.state.geometry : null;
  } catch {
    return null;
  }
}

/** Drop every cached layout — tests start here so keys never leak across cases. */
export function _resetCanvasGeometryForTests(): void {
  entries.clear();
  engineLoader = defaultEngineLoader;
}

/**
 * The doc field signature that changes the pin set: every explicitly pinned or
 * locked member's authored canvas position. Unrelated doc edits keep the key.
 */
function pinSignature(doc: DiagramDoc): string {
  const parts: string[] = [];
  for (const node of doc.nodes) {
    if (node.locked !== true && node.meta?.pinned !== true) continue;
    parts.push(`${node.id}\u0000${node.x}\u0000${node.y}`);
  }
  return parts.sort().join("\u0001");
}

function canvasLayoutKey(specJson: string, doc: DiagramDoc): string {
  return `${specJson}\u0000${pinSignature(doc)}`;
}

function adapterDiagnostic(error: unknown): Diagnostic {
  return {
    code: "canvas.geometry.unavailable",
    path: "",
    rule: "canvas-geometry",
    message: error instanceof Error ? error.message : String(error),
    fix: "repair the reported document problem, or regenerate the semantic dataset, and the canvas redraws",
  };
}

async function runLayout(
  entry: Entry,
  doc: DiagramDoc,
  dataset: SemanticSpecDataset,
  key: string,
  specJson: string,
  generation: number,
): Promise<void> {
  try {
    const engine = await engineLoader();
    // The page offset is a function of the source spec alone, so a drop reuses
    // the one an earlier layout measured instead of probing again.
    const known = entry.offset?.specJson === specJson ? entry.offset.value : undefined;
    const { request, report } = await layoutCanvasRequest(
      engine,
      doc,
      dataset.id,
      known ? { contentOffset: known } : {},
    );
    // The doc has already moved on: a newer key owns the canvas, and publishing
    // this scene would replace it with an older one that nothing re-syncs.
    if (entry.pendingKey !== key || entry.generation !== generation) return;
    entry.cacheKey = key;
    if (report.ok && report.geometry?.page.contentOffset) {
      entry.offset = { specJson, value: report.geometry.page.contentOffset };
    }
    const geometry = canvasGeometryOf(report, doc, dataset);
    // A retained scene keeps the hash it was emitted for: the refused request's
    // bytes drew none of what is on screen.
    const retained = geometry === null && entry.state.geometry !== null;
    publish(entry, {
      datasetId: dataset.id,
      status: geometry ? "ready" : entry.state.geometry ? "stale" : "refused",
      geometry: geometry ?? entry.state.geometry,
      diagnostics: report.diagnostics,
      sourceSpecSha256: retained ? entry.state.sourceSpecSha256 : (request.pinSet?.sourceSpecSha256 ?? null),
    });
  } catch (error) {
    // A refused or unreadable layout must never block the canvas: keep the last
    // good scene (or the projected source positions) and report why.
    if (entry.pendingKey !== key || entry.generation !== generation) return;
    entry.cacheKey = key;
    publish(entry, {
      datasetId: dataset.id,
      status: entry.state.geometry ? "stale" : "refused",
      geometry: entry.state.geometry,
      diagnostics: [adapterDiagnostic(error)],
      sourceSpecSha256: entry.state.sourceSpecSha256,
    });
  } finally {
    // Only the layout that still owns the pending slot clears it: a superseded
    // one must leave the newer layout's key and promise intact.
    if (entry.pendingKey === key && entry.generation === generation) {
      entry.pendingKey = null;
      entry.pending = null;
    }
  }
}

/**
 * Lay out the canvas once per distinct source/pin key. A refusal of the same
 * bytes is deterministic, so it is not retried until the doc changes. The
 * promise is the layout itself, which tests await; the canvas drops it.
 */
export function syncCanvasGeometry(
  doc: DiagramDoc,
  datasetId: string,
  load?: CanvasEngineLoader,
): Promise<void> {
  const entry = entryFor(datasetId);
  if (entry.documentId !== doc.id) {
    if (entry.documentId !== null) resetEntry(entry);
    entry.documentId = doc.id;
  }
  if (load && load !== engineLoader) engineLoader = load;
  const dataset = (doc.datasets ?? []).find(
    (item): item is SemanticSpecDataset => item.kind === "semanticSpec" && item.id === datasetId,
  );
  if (!dataset) {
    entry.generation += 1;
    entry.pendingKey = null;
    entry.pending = null;
    entry.cacheKey = null;
    if (entry.state.status !== "idle") publish(entry, { ...IDLE, datasetId });
    return Promise.resolve();
  }
  let specJson: string;
  try {
    specJson = JSON.stringify(dataset.spec);
  } catch (error) {
    entry.generation += 1;
    entry.pendingKey = null;
    entry.pending = null;
    entry.cacheKey = null;
    publish(entry, {
      datasetId,
      status: entry.state.geometry ? "stale" : "refused",
      geometry: entry.state.geometry,
      diagnostics: [adapterDiagnostic(error)],
      sourceSpecSha256: entry.state.sourceSpecSha256,
    });
    return Promise.resolve();
  }
  const key = canvasLayoutKey(specJson, doc);
  if (entry.cacheKey === key) {
    entry.generation += 1;
    entry.pendingKey = null;
    entry.pending = null;
    return Promise.resolve();
  }
  if (entry.pendingKey === key && entry.pending) return entry.pending;
  entry.pendingKey = key;
  const generation = ++entry.generation;
  if (!entry.state.geometry && entry.state.status !== "pending") {
    publish(entry, { datasetId, status: "pending", geometry: null, diagnostics: [], sourceSpecSha256: null });
  }
  entry.pending = runLayout(entry, doc, dataset, key, specJson, generation);
  return entry.pending;
}
