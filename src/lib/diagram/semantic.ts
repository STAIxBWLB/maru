import {
  architecture,
  dataflow,
  lifecycle,
  sequence,
  workflow,
} from "../../../sidecars/archify/renderers/shared/generated-validators.mjs";
/**
 * Typed semantic datasets: per-type descriptor, content validation, relation
 * id minting, canvas projection, member resolution, text write-through and
 * detach (issue #433 P2).
 *
 * The spec is canonical and the canvas is a projection of it:
 *
 * - **Descriptor.** {@link SEMANTIC_TYPES} names each type's entity,
 *   relation and container collections, the fields the pinned schema knows,
 *   and the fields the canvas does not project. Callers never branch on the
 *   diagram type for collection names.
 * - **Validation.** {@link validateSemanticContent} runs the generated schema
 *   validator plus reference checks JSON Schema cannot express (dangling
 *   endpoints, lanes, stages, wraps; self-messages; duplicate ids). It is the
 *   synchronous floor for every path that skips the engine.
 * - **Projection.** Entities become nodes (`meta.memberId =
 *   <datasetId>:m<index>`), relations become edges (id = relation id, or the
 *   legacy `<datasetId>-e<index>` for id-less P1 relations), and lanes,
 *   stages and boundaries become `section` containers whose id and memberId
 *   are `<datasetId>:<role>:<key>` (Archify ids forbid `:`, so they cannot
 *   collide). Grid types place entities deterministically; sequence messages
 *   are ordered `s→s` brackets whose `midOff` depth encodes their order.
 * - **Write-through.** {@link writeThroughText} maps canvas text edits on a
 *   member onto the spec (label/sublabel), refusing an empty required label.
 * - **Detach.** {@link detachSemanticDataset} drops the dataset and the
 *   member markers, keeps the canvas, and lists what the canvas cannot carry.
 *
 * Pure and never throws on malformed specs: unresolvable entries are skipped.
 */

import { LAYOUT_DEFAULT_ORIGIN, LAYOUT_STEP_X, LAYOUT_STEP_Y, layoutDoc } from "./layout";
import { isSemanticSpecDataset, type SemanticDiagramType, type SemanticSpecDataset } from "./reportTypes";
import {
  createDiagramId,
  createEmptyDoc,
  type DiagramDoc,
  type DiagramEdge,
  type DiagramNode,
  type NodeKind,
} from "./types";
import type { ValidationDiagnostic } from "./validation";

// ---------------------------------------------------------------------------
// Per-type descriptor
// ---------------------------------------------------------------------------

export type SemanticContainerRole = "lane" | "stage" | "boundary";

export interface SemanticTypeDescriptor {
  /** Entity collection (projected to member nodes). */
  entities: string;
  /** Relation collection (projected to edges). */
  relations: string;
  /** Prefix for relation ids minted at ingest. */
  relationPrefix: string;
  /** Empty relation labels are refused (schema `minLength: 1`) instead of dropped. */
  relationLabelRequired: boolean;
  /** Container collection; `index`-keyed collections have no ids in the schema. */
  container: { field: string; role: SemanticContainerRole; keyedBy: "id" | "index" } | null;
  /** Entities sit on a deterministic grid, so a slot change moves the member. */
  grid: boolean;
  /** Top-level fields the pinned schema defines. */
  knownFields: readonly string[];
  /** Collections whose `id` fields participate in the id map. */
  idFields: readonly string[];
  /** Fields kept in the spec but not drawn on the canvas. */
  notProjected: readonly string[];
}

export const SEMANTIC_TYPES: Record<SemanticDiagramType, SemanticTypeDescriptor> = {
  architecture: {
    entities: "components",
    relations: "connections",
    relationPrefix: "conn",
    relationLabelRequired: false,
    container: { field: "boundaries", role: "boundary", keyedBy: "index" },
    grid: false,
    knownFields: ["schema_version", "diagram_type", "meta", "components", "layout", "boundaries", "connections", "cards"],
    idFields: ["components", "connections", "boundaries"],
    notProjected: ["cards"],
  },
  workflow: {
    entities: "nodes",
    relations: "edges",
    relationPrefix: "edge",
    relationLabelRequired: false,
    container: { field: "lanes", role: "lane", keyedBy: "id" },
    grid: true,
    knownFields: ["schema_version", "diagram_type", "meta", "lanes", "nodes", "edges", "phases", "groups", "mainPath", "semanticChecks", "cards"],
    idFields: ["lanes", "nodes", "edges", "phases", "groups"],
    notProjected: ["phases", "groups", "mainPath", "semanticChecks", "cards"],
  },
  sequence: {
    entities: "participants",
    relations: "messages",
    relationPrefix: "msg",
    relationLabelRequired: true,
    container: null,
    grid: true,
    knownFields: ["schema_version", "diagram_type", "meta", "participants", "segments", "messages", "activations", "cards"],
    idFields: ["participants", "messages"],
    notProjected: ["segments", "activations", "cards"],
  },
  dataflow: {
    entities: "nodes",
    relations: "flows",
    relationPrefix: "flow",
    relationLabelRequired: true,
    container: { field: "stages", role: "stage", keyedBy: "index" },
    grid: true,
    knownFields: ["schema_version", "diagram_type", "meta", "stages", "nodes", "flows", "cards"],
    idFields: ["nodes", "flows"],
    notProjected: ["cards"],
  },
  lifecycle: {
    entities: "states",
    relations: "transitions",
    relationPrefix: "tr",
    relationLabelRequired: false,
    container: { field: "lanes", role: "lane", keyedBy: "id" },
    grid: true,
    knownFields: ["schema_version", "diagram_type", "meta", "lanes", "states", "transitions", "cards"],
    idFields: ["lanes", "states", "transitions"],
    notProjected: ["cards"],
  },
};

const VALIDATORS = { architecture, workflow, sequence, dataflow, lifecycle };

export const LIFECYCLE_STATE_TYPES = [
  "start",
  "active",
  "waiting",
  "decision",
  "success",
  "failure",
  "neutral",
  "external",
] as const;

/** i18n key of a diagram type's display name (`diagram.generate.type<Type>`). */
export function semanticTypeLabelKey(type: SemanticDiagramType): string {
  return `diagram.generate.type${type[0]!.toUpperCase()}${type.slice(1)}`;
}

export function descriptorFor(dataset: SemanticSpecDataset): SemanticTypeDescriptor | null {
  return SEMANTIC_TYPES[dataset.diagramType] ?? null;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Record entries of a spec collection (non-records are skipped, as in P1). */
export function specEntries(spec: Record<string, unknown>, field: string): Record<string, unknown>[] {
  const value = spec[field];
  return Array.isArray(value) ? value.filter(isRecord) : [];
}

function idOf(entry: Record<string, unknown>): string | null {
  return typeof entry.id === "string" && entry.id.length > 0 ? entry.id : null;
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function isPoint(value: unknown): value is [number, number] {
  return Array.isArray(value) && value.length === 2 && isFiniteNumber(value[0]) && isFiniteNumber(value[1]);
}

function gridIndex(value: unknown): number {
  return isFiniteNumber(value) ? Math.max(0, Math.floor(value)) : 0;
}

/** Collect every declared id in a spec, in stable document order. */
export function collectSemanticIds(diagramType: SemanticDiagramType, spec: Record<string, unknown>): string[] {
  const ids: string[] = [];
  for (const field of SEMANTIC_TYPES[diagramType].idFields) {
    for (const entry of specEntries(spec, field)) {
      const id = idOf(entry);
      if (id !== null) ids.push(id);
    }
  }
  return ids;
}

/** Maru canvas id for a spec id, via the dataset's id map (identity fallback). */
function maruIdFor(dataset: SemanticSpecDataset, specId: string): string {
  return dataset.idMap[specId] ?? specId;
}

/** Spec id for a Maru canvas id: idMap reverse lookup, then identity. */
function specIdFor(dataset: SemanticSpecDataset, maruId: string): string {
  for (const [specId, mapped] of Object.entries(dataset.idMap)) {
    if (mapped === maruId) return specId;
  }
  return maruId;
}

/** Message indices in sequence order: by `y`, then array index. */
export function sequenceOrder(spec: Record<string, unknown>): number[] {
  const messages = specEntries(spec, "messages");
  return messages
    .map((entry, index) => ({ index, y: isFiniteNumber(entry.y) ? entry.y : 0 }))
    .sort((a, b) => a.y - b.y || a.index - b.index)
    .map((entry) => entry.index);
}

// ---------------------------------------------------------------------------
// Content validation
// ---------------------------------------------------------------------------

/**
 * Schema plus reference validation of a spec. Schema errors reuse
 * `diagram.validation.specMeta`; references, self-messages and duplicate ids
 * get `diagram.semantic.*` keys. Duplicate ids are checked across every
 * id-bearing collection because the id map must stay reversible.
 */
export function validateSemanticContent(
  diagramType: SemanticDiagramType,
  spec: Record<string, unknown>,
): ValidationDiagnostic[] {
  const descriptor = SEMANTIC_TYPES[diagramType];
  const diagnostics: ValidationDiagnostic[] = [];
  const validator = VALIDATORS[diagramType];
  if (!validator(spec)) {
    for (const error of validator.errors ?? []) {
      diagnostics.push({ key: "diagram.validation.specMeta", params: { field: error.instancePath || "spec" } });
    }
  }

  const seen = new Set<string>();
  for (const field of descriptor.idFields) {
    specEntries(spec, field).forEach((entry, index) => {
      const id = idOf(entry);
      if (id === null) return;
      if (seen.has(id)) {
        diagnostics.push({ key: "diagram.semantic.duplicateId", params: { field: `${field}[${index}]`, id } });
      }
      seen.add(id);
    });
  }

  const dangling = (field: string, value: unknown, known: ReadonlySet<string>) => {
    if (typeof value === "string" && !known.has(value)) {
      diagnostics.push({ key: "diagram.semantic.danglingReference", params: { field, id: value } });
    }
  };
  const idSet = (field: string) =>
    new Set(specEntries(spec, field).map(idOf).filter((id): id is string => id !== null));
  const entityIds = idSet(descriptor.entities);

  specEntries(spec, descriptor.relations).forEach((entry, index) => {
    const at = `${descriptor.relations}[${index}]`;
    dangling(`${at}.from`, entry.from, entityIds);
    dangling(`${at}.to`, entry.to, entityIds);
    if (diagramType === "sequence" && typeof entry.from === "string" && entry.from === entry.to) {
      diagnostics.push({ key: "diagram.semantic.selfMessage", params: { field: at } });
    }
  });

  if (diagramType === "workflow" || diagramType === "lifecycle") {
    const laneIds = idSet("lanes");
    specEntries(spec, descriptor.entities).forEach((entry, index) => {
      dangling(`${descriptor.entities}[${index}].lane`, entry.lane, laneIds);
    });
    if (diagramType === "workflow") {
      specEntries(spec, "groups").forEach((entry, index) => dangling(`groups[${index}].lane`, entry.lane, laneIds));
    }
  }
  if (diagramType === "workflow") {
    const mainPath = Array.isArray(spec.mainPath) ? spec.mainPath : [];
    mainPath.forEach((id, index) => dangling(`mainPath[${index}]`, id, entityIds));
    const checks = isRecord(spec.semanticChecks) ? spec.semanticChecks : {};
    for (const field of ["allowedRoots", "allowedTerminals"]) {
      const ids = Array.isArray(checks[field]) ? (checks[field] as unknown[]) : [];
      ids.forEach((id, index) => dangling(`semanticChecks.${field}[${index}]`, id, entityIds));
    }
    for (const field of ["requiredEdges", "requiredPaths"]) {
      const relations = Array.isArray(checks[field]) ? (checks[field] as unknown[]).filter(isRecord) : [];
      relations.forEach((relation, index) => {
        dangling(`semanticChecks.${field}[${index}].from`, relation.from, entityIds);
        dangling(`semanticChecks.${field}[${index}].to`, relation.to, entityIds);
      });
    }
  }
  if (diagramType === "dataflow") {
    const stageCount = specEntries(spec, "stages").length;
    specEntries(spec, "nodes").forEach((entry, index) => {
      if (isFiniteNumber(entry.stage) && entry.stage >= stageCount) {
        diagnostics.push({
          key: "diagram.semantic.danglingReference",
          params: { field: `nodes[${index}].stage`, id: String(entry.stage) },
        });
      }
    });
  }
  if (diagramType === "architecture") {
    specEntries(spec, "boundaries").forEach((entry, index) => {
      const wraps = Array.isArray(entry.wraps) ? entry.wraps : [];
      wraps.forEach((id, wrapIndex) => dangling(`boundaries[${index}].wraps[${wrapIndex}]`, id, entityIds));
    });
  }
  if (diagramType === "sequence") {
    specEntries(spec, "activations").forEach((entry, index) => {
      dangling(`activations[${index}].participant`, entry.participant, entityIds);
    });
  }
  return diagnostics;
}

// ---------------------------------------------------------------------------
// Relation id minting
// ---------------------------------------------------------------------------

/**
 * Give every id-less relation a stable `<prefix><n>` id that avoids every id
 * already declared in the spec, with `id` first in the minted object.
 * Idempotent: a spec whose relations all carry ids comes back unchanged (same
 * object, `minted: 0`).
 */
export function mintRelationIds(
  diagramType: SemanticDiagramType,
  spec: Record<string, unknown>,
): { spec: Record<string, unknown>; minted: number } {
  const descriptor = SEMANTIC_TYPES[diagramType];
  const relations = spec[descriptor.relations];
  if (!Array.isArray(relations) || !relations.some((entry) => isRecord(entry) && idOf(entry) === null)) {
    return { spec, minted: 0 };
  }
  const taken = new Set(collectSemanticIds(diagramType, spec));
  let counter = 0;
  let minted = 0;
  const next = relations.map((entry: unknown) => {
    if (!isRecord(entry) || idOf(entry) !== null) return entry;
    let id: string;
    do {
      counter += 1;
      id = `${descriptor.relationPrefix}${counter}`;
    } while (taken.has(id));
    taken.add(id);
    minted += 1;
    const rest = { ...entry };
    delete rest.id;
    return { id, ...rest };
  });
  return { spec: { ...spec, [descriptor.relations]: next }, minted };
}

// ---------------------------------------------------------------------------
// Projection
// ---------------------------------------------------------------------------

const ORIGIN = LAYOUT_DEFAULT_ORIGIN;
const NODE_W = 160;
const NODE_H = 64;
const GAP = 16;
const HEADER = 32;
const INSET = 24;
const ROW_STEP = NODE_H + GAP;
const STAGE_W = LAYOUT_STEP_X - GAP;
const ARCHITECTURE_GRID_COLS = 4;
const BOUNDARY_PAD = 24;

export interface ProjectedMembers {
  nodes: DiagramNode[];
  edges: DiagramEdge[];
  diagnostics: ValidationDiagnostic[];
}

export interface SemanticProjectionOptions {
  /** Also project lane/stage/boundary containers (placed first in `nodes`). */
  containers?: boolean;
  /** Boundary containers enclose this doc's member geometry when present. */
  doc?: DiagramDoc;
}

interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

interface ContainerRect extends Rect {
  key: string;
  label: string;
}

interface GridPlacement {
  /** Entity rect by (record-filtered) entity index. */
  entities: Map<number, Rect>;
  containers: ContainerRect[];
}

function labelOf(entry: Record<string, unknown>, fallback: string): string {
  return typeof entry.label === "string" ? entry.label : fallback;
}

function laneGrid(spec: Record<string, unknown>, descriptor: SemanticTypeDescriptor): GridPlacement {
  const lanes = specEntries(spec, "lanes");
  const entities = specEntries(spec, descriptor.entities);
  const laneIndex = new Map<string, number>();
  lanes.forEach((lane, index) => {
    const id = idOf(lane);
    if (id !== null && !laneIndex.has(id)) laneIndex.set(id, index);
  });
  // Entities with an unknown lane stack in a trailing band with no container.
  const bandOf = (entry: Record<string, unknown>) =>
    (typeof entry.lane === "string" ? laneIndex.get(entry.lane) : undefined) ?? lanes.length;
  const stacks: number[] = [];
  const cellCounts = new Map<string, number>();
  const bandDepth: number[] = [];
  entities.forEach((entry, index) => {
    const band = bandOf(entry);
    const cell = `${band}:${gridIndex(entry.col)}`;
    const stack = cellCounts.get(cell) ?? 0;
    cellCounts.set(cell, stack + 1);
    stacks[index] = stack;
    bandDepth[band] = Math.max(bandDepth[band] ?? 1, stack + 1);
  });
  const bandCount = Math.max(lanes.length, bandDepth.length);
  const tops: number[] = [];
  const heights: number[] = [];
  let top = ORIGIN.y;
  for (let band = 0; band < bandCount; band += 1) {
    tops[band] = top;
    heights[band] = HEADER + (bandDepth[band] ?? 1) * ROW_STEP + GAP;
    top += heights[band]!;
  }
  const maxCol = entities.reduce((max, entry) => Math.max(max, gridIndex(entry.col)), 0);
  const placed = new Map<number, Rect>();
  entities.forEach((entry, index) => {
    placed.set(index, {
      x: ORIGIN.x + INSET + gridIndex(entry.col) * LAYOUT_STEP_X,
      y: tops[bandOf(entry)]! + HEADER + stacks[index]! * ROW_STEP,
      w: NODE_W,
      h: NODE_H,
    });
  });
  const containers: ContainerRect[] = [];
  lanes.forEach((lane, index) => {
    const id = idOf(lane);
    if (id === null || laneIndex.get(id) !== index) return;
    containers.push({
      key: id,
      label: labelOf(lane, id),
      x: ORIGIN.x,
      y: tops[index]!,
      w: 2 * INSET + maxCol * LAYOUT_STEP_X + NODE_W,
      h: heights[index]!,
    });
  });
  return { entities: placed, containers };
}

function stageColumns(spec: Record<string, unknown>): GridPlacement {
  const stages = specEntries(spec, "stages");
  const entities = specEntries(spec, "nodes");
  const byStage = new Map<number, number[]>();
  entities.forEach((entry, index) => {
    const stage = gridIndex(entry.stage);
    const list = byStage.get(stage);
    if (list) list.push(index);
    else byStage.set(stage, [index]);
  });
  const placed = new Map<number, Rect>();
  for (const [stage, indices] of byStage) {
    indices
      .sort((a, b) => gridIndex(entities[a]!.row) - gridIndex(entities[b]!.row) || a - b)
      .forEach((index, slot) => {
        placed.set(index, {
          x: ORIGIN.x + stage * LAYOUT_STEP_X + (STAGE_W - NODE_W) / 2,
          y: ORIGIN.y + HEADER + slot * ROW_STEP,
          w: NODE_W,
          h: NODE_H,
        });
      });
  }
  const containers = stages.map((stage, index) => ({
    key: String(index),
    label: labelOf(stage, String(index + 1)),
    x: ORIGIN.x + index * LAYOUT_STEP_X,
    y: ORIGIN.y,
    w: STAGE_W,
    h: HEADER + Math.max(1, byStage.get(index)?.length ?? 0) * ROW_STEP + GAP,
  }));
  return { entities: placed, containers };
}

function rowPlacement(count: number): GridPlacement {
  const placed = new Map<number, Rect>();
  for (let index = 0; index < count; index += 1) {
    placed.set(index, { x: ORIGIN.x + index * LAYOUT_STEP_X, y: ORIGIN.y, w: NODE_W, h: NODE_H });
  }
  return { entities: placed, containers: [] };
}

function architecturePlacement(entities: Record<string, unknown>[]): GridPlacement {
  const placed = new Map<number, Rect>();
  entities.forEach((entry, index) => {
    const pos = isPoint(entry.pos) ? entry.pos : null;
    const size = isPoint(entry.size) && entry.size[0] > 0 && entry.size[1] > 0 ? entry.size : null;
    placed.set(index, {
      x: pos ? pos[0] : ORIGIN.x + (index % ARCHITECTURE_GRID_COLS) * LAYOUT_STEP_X,
      y: pos ? pos[1] : ORIGIN.y + Math.floor(index / ARCHITECTURE_GRID_COLS) * LAYOUT_STEP_Y,
      w: size ? size[0] : NODE_W,
      h: size ? size[1] : NODE_H,
    });
  });
  return { entities: placed, containers: [] };
}

function entityKind(diagramType: SemanticDiagramType, entry: Record<string, unknown>): NodeKind {
  if (diagramType !== "lifecycle") return "simple";
  if (entry.type === "start" || entry.type === "success" || entry.type === "failure") return "oval";
  if (entry.type === "decision") return "diamond";
  return "simple";
}

export function semanticContainerId(datasetId: string, role: SemanticContainerRole, key: string): string {
  return `${datasetId}:${role}:${key}`;
}

export function isSemanticContainerNode(node: DiagramNode): boolean {
  return typeof node.meta?.semanticContainer === "string";
}

function containerNode(
  dataset: SemanticSpecDataset,
  role: SemanticContainerRole,
  rect: ContainerRect,
): DiagramNode {
  const id = semanticContainerId(dataset.id, role, rect.key);
  return {
    id,
    kind: "section",
    x: rect.x,
    y: rect.y,
    w: rect.w,
    h: rect.h,
    title: rect.label,
    meta: { memberId: id, semanticContainer: role },
  };
}

function boundaryRects(
  dataset: SemanticSpecDataset,
  members: readonly DiagramNode[],
  doc: DiagramDoc | undefined,
): ContainerRect[] {
  const docNodes = new Map((doc?.nodes ?? []).map((node) => [node.id, node]));
  const projected = new Map(members.map((node) => [node.id, node]));
  const rects: ContainerRect[] = [];
  specEntries(dataset.spec, "boundaries").forEach((boundary, index) => {
    const wraps = Array.isArray(boundary.wraps) ? boundary.wraps : [];
    const boxes = wraps
      .filter((id): id is string => typeof id === "string")
      .map((specId) => {
        const id = maruIdFor(dataset, specId);
        return docNodes.get(id) ?? projected.get(id);
      })
      .filter((node): node is DiagramNode => node !== undefined);
    if (boxes.length === 0) return;
    const pad = isFiniteNumber(boundary.pad) ? boundary.pad : BOUNDARY_PAD;
    const minX = Math.min(...boxes.map((box) => box.x));
    const minY = Math.min(...boxes.map((box) => box.y));
    const maxX = Math.max(...boxes.map((box) => box.x + box.w));
    const maxY = Math.max(...boxes.map((box) => box.y + box.h));
    rects.push({
      key: String(index),
      label: labelOf(boundary, String(index + 1)),
      x: minX - pad,
      y: minY - pad - HEADER,
      w: maxX - minX + 2 * pad,
      h: maxY - minY + 2 * pad + HEADER,
    });
  });
  return rects;
}

/**
 * Project a semantic dataset to canvas members, and optionally its
 * containers. Pure and deterministic; not-projected fields that are present
 * produce informational `diagram.semantic.notProjected` diagnostics.
 */
export function projectSemanticDataset(
  dataset: SemanticSpecDataset,
  opts: SemanticProjectionOptions = {},
): ProjectedMembers {
  const descriptor = descriptorFor(dataset);
  if (!descriptor) return { nodes: [], edges: [], diagnostics: [] };
  const spec = dataset.spec;
  const diagnostics: ValidationDiagnostic[] = descriptor.notProjected
    .filter((field) => spec[field] !== undefined)
    .map((field) => ({ key: "diagram.semantic.notProjected", params: { field } }));

  const entities = specEntries(spec, descriptor.entities);
  const placement =
    dataset.diagramType === "workflow" || dataset.diagramType === "lifecycle"
      ? laneGrid(spec, descriptor)
      : dataset.diagramType === "dataflow"
        ? stageColumns(spec)
        : dataset.diagramType === "sequence"
          ? rowPlacement(entities.length)
          : architecturePlacement(entities);

  const nodes: DiagramNode[] = [];
  const nodeIds = new Set<string>();
  entities.forEach((entry, index) => {
    const specId = idOf(entry);
    const rect = placement.entities.get(index);
    if (specId === null || !rect) return;
    const id = maruIdFor(dataset, specId);
    if (nodeIds.has(id)) return;
    nodeIds.add(id);
    nodes.push({
      id,
      kind: entityKind(dataset.diagramType, entry),
      ...rect,
      title: labelOf(entry, specId),
      body: typeof entry.sublabel === "string" ? entry.sublabel : undefined,
      meta: { memberId: `${dataset.id}:m${index}` },
    });
  });

  const rank = new Map<number, number>();
  if (dataset.diagramType === "sequence") {
    sequenceOrder(spec).forEach((index, order) => rank.set(index, order));
  }
  const edges: DiagramEdge[] = [];
  const edgeIds = new Set<string>();
  specEntries(spec, descriptor.relations).forEach((entry, index) => {
    if (typeof entry.from !== "string" || typeof entry.to !== "string") return;
    const specId = idOf(entry);
    let id = specId !== null ? maruIdFor(dataset, specId) : `${dataset.id}-e${index}`;
    while (edgeIds.has(id)) id = `${id}-2`;
    edgeIds.add(id);
    const label = typeof entry.label === "string" ? entry.label : undefined;
    if (dataset.diagramType === "sequence") {
      edges.push({
        id,
        fromNode: maruIdFor(dataset, entry.from),
        fromPort: "s",
        toNode: maruIdFor(dataset, entry.to),
        toPort: "s",
        arrowEnd: "filled",
        midOff: ORIGIN.y + HEADER * (rank.get(index) ?? 0),
        dash: entry.variant === "return" || entry.variant === "dashed" ? "dashed" : "solid",
        label,
      });
      return;
    }
    edges.push({
      id,
      fromNode: maruIdFor(dataset, entry.from),
      fromPort: "e",
      toNode: maruIdFor(dataset, entry.to),
      toPort: "w",
      arrowEnd: "filled",
      label,
    });
  });

  if (!opts.containers || !descriptor.container) return { nodes, edges, diagnostics };
  const role = descriptor.container.role;
  const rects =
    role === "boundary" ? boundaryRects(dataset, nodes, opts.doc) : placement.containers;
  return { nodes: [...rects.map((rect) => containerNode(dataset, role, rect)), ...nodes], edges, diagnostics };
}

/**
 * A fresh document projecting `dataset`: members (architecture reflowed with
 * `layoutDoc`, grid types at their projected slots) plus containers first in
 * `nodes`. Used by apply-new, the gallery copy and archify-json import.
 */
export function projectSemanticDocument(
  dataset: SemanticSpecDataset,
): { doc: DiagramDoc; diagnostics: ValidationDiagnostic[] } {
  const members = projectSemanticDataset(dataset);
  let doc: DiagramDoc = {
    ...createEmptyDoc(createDiagramId()),
    docTitle: dataset.name,
    nodes: members.nodes,
    edges: members.edges,
    datasets: [dataset],
  };
  if (dataset.diagramType === "architecture") doc = layoutDoc(doc).doc;
  const containers = projectSemanticDataset(dataset, { containers: true, doc }).nodes.filter(
    isSemanticContainerNode,
  );
  return { doc: { ...doc, nodes: [...containers, ...doc.nodes] }, diagnostics: members.diagnostics };
}

// ---------------------------------------------------------------------------
// Membership and resolution
// ---------------------------------------------------------------------------

export function semanticDatasetsOf(doc: DiagramDoc): SemanticSpecDataset[] {
  return (doc.datasets ?? []).filter(isSemanticSpecDataset);
}

function memberIdOf(node: DiagramNode): string | null {
  const memberId = node.meta?.memberId;
  return typeof memberId === "string" ? memberId : null;
}

function isMemberOf(node: DiagramNode, datasetId: string): boolean {
  return memberIdOf(node)?.startsWith(`${datasetId}:`) === true;
}

/** Node ids (entities and containers) projected from dataset `datasetId`. */
export function semanticMemberNodeIds(doc: DiagramDoc, datasetId: string): string[] {
  return doc.nodes.filter((node) => isMemberOf(node, datasetId)).map((node) => node.id);
}

export function datasetHasContainers(doc: DiagramDoc, datasetId: string): boolean {
  return doc.nodes.some((node) => isSemanticContainerNode(node) && isMemberOf(node, datasetId));
}

export type SemanticMember =
  | {
      kind: "entity";
      dataset: SemanticSpecDataset;
      field: string;
      index: number;
      entry: Record<string, unknown>;
      specId: string;
    }
  | {
      kind: "container";
      dataset: SemanticSpecDataset;
      field: string;
      index: number;
      entry: Record<string, unknown>;
      role: SemanticContainerRole;
      key: string;
    }
  | {
      kind: "relation";
      dataset: SemanticSpecDataset;
      field: string;
      index: number;
      entry: Record<string, unknown>;
    };

/**
 * Resolve a canvas node or edge to the spec entry it projects. Nodes resolve
 * through `meta.memberId` (`<datasetId>:` prefix): containers by their role
 * key, entities by idMap reverse lookup, then id. Edges resolve by relation
 * id or the legacy `<datasetId>-e<index>`. Anything else is freeform (null).
 */
export function resolveSemanticMember(
  doc: DiagramDoc,
  target: { nodeId: string } | { edgeId: string },
): SemanticMember | null {
  const datasets = semanticDatasetsOf(doc);
  if ("nodeId" in target) {
    const node = doc.nodes.find((candidate) => candidate.id === target.nodeId);
    const memberId = node ? memberIdOf(node) : null;
    if (!node || memberId === null) return null;
    const dataset = datasets.find((candidate) => memberId.startsWith(`${candidate.id}:`));
    const descriptor = dataset ? descriptorFor(dataset) : null;
    if (!dataset || !descriptor) return null;
    const role = node.meta?.semanticContainer;
    if (role !== undefined) {
      const container = descriptor.container;
      if (!container || container.role !== role) return null;
      const prefix = `${dataset.id}:${role}:`;
      if (!memberId.startsWith(prefix)) return null;
      const key = memberId.slice(prefix.length);
      const entries = specEntries(dataset.spec, container.field);
      const index =
        container.keyedBy === "id"
          ? entries.findIndex((entry) => idOf(entry) === key)
          : /^\d+$/.test(key)
            ? Number(key)
            : -1;
      const entry = entries[index];
      if (!entry) return null;
      return { kind: "container", dataset, field: container.field, index, entry, role: container.role, key };
    }
    const specId = specIdFor(dataset, node.id);
    const entries = specEntries(dataset.spec, descriptor.entities);
    const index = entries.findIndex((entry) => idOf(entry) === specId);
    if (index < 0) return null;
    return { kind: "entity", dataset, field: descriptor.entities, index, entry: entries[index]!, specId };
  }
  for (const dataset of datasets) {
    const descriptor = descriptorFor(dataset);
    if (!descriptor) continue;
    const entries = specEntries(dataset.spec, descriptor.relations);
    const index = entries.findIndex((entry, i) => {
      const specId = idOf(entry);
      return specId !== null ? maruIdFor(dataset, specId) === target.edgeId : `${dataset.id}-e${i}` === target.edgeId;
    });
    if (index >= 0) {
      return { kind: "relation", dataset, field: descriptor.relations, index, entry: entries[index]! };
    }
  }
  return null;
}

/** Semantic datasets touched by a selection (doc order, no duplicates). */
export function semanticDatasetsIn(
  doc: DiagramDoc,
  nodeIds: Iterable<string>,
  edgeIds: Iterable<string> = [],
): SemanticSpecDataset[] {
  const touched = new Set<string>();
  const nodeSet = new Set(nodeIds);
  for (const dataset of semanticDatasetsOf(doc)) {
    if (doc.nodes.some((node) => nodeSet.has(node.id) && isMemberOf(node, dataset.id))) touched.add(dataset.id);
  }
  for (const edgeId of edgeIds) {
    const member = resolveSemanticMember(doc, { edgeId });
    if (member) touched.add(member.dataset.id);
  }
  return semanticDatasetsOf(doc).filter((dataset) => touched.has(dataset.id));
}

/** Replace one spec entry (by identity) and return the doc with the new dataset. */
export function replaceSpecEntry(
  doc: DiagramDoc,
  dataset: SemanticSpecDataset,
  field: string,
  previous: Record<string, unknown>,
  next: Record<string, unknown>,
): DiagramDoc {
  const raw = dataset.spec[field];
  const entries = Array.isArray(raw) ? raw.map((entry: unknown) => (entry === previous ? next : entry)) : raw;
  const updated: SemanticSpecDataset = { ...dataset, spec: { ...dataset.spec, [field]: entries } };
  return {
    ...doc,
    datasets: (doc.datasets ?? []).map((entry) => (entry.id === dataset.id ? updated : entry)),
  };
}

// ---------------------------------------------------------------------------
// Text write-through
// ---------------------------------------------------------------------------

/**
 * Write canvas text edits on a semantic member through to its spec entry:
 * node title → `label`, body → `sublabel` (empty deletes it), container title
 * → `label` (body refused), edge label → `label` (empty refused for messages
 * and flows, deleted otherwise). Returns the doc with the updated dataset,
 * `null` when the edit is refused, or `undefined` when the patch carries no
 * text or the target is freeform.
 */
export function writeThroughText(
  doc: DiagramDoc,
  target: { nodeId: string } | { edgeId: string },
  patch: Partial<DiagramNode> | Partial<DiagramEdge>,
): DiagramDoc | null | undefined {
  const textKeys = "nodeId" in target ? ["title", "body"] : ["label"];
  if (!textKeys.some((key) => key in patch)) return undefined;
  const member = resolveSemanticMember(doc, target);
  if (!member) return undefined;
  const values = patch as Record<string, unknown>;
  const nonEmpty = (value: unknown): value is string => typeof value === "string" && value.length > 0;
  const next: Record<string, unknown> = { ...member.entry };
  if (member.kind === "relation") {
    if (nonEmpty(values.label)) next.label = values.label;
    else if (descriptorFor(member.dataset)?.relationLabelRequired) return null;
    else delete next.label;
  } else {
    if ("title" in values) {
      if (!nonEmpty(values.title)) return null;
      next.label = values.title;
    }
    if ("body" in values) {
      if (member.kind === "container") return null;
      if (nonEmpty(values.body)) next.sublabel = values.body;
      else delete next.sublabel;
    }
  }
  return replaceSpecEntry(doc, member.dataset, member.field, member.entry, next);
}

// ---------------------------------------------------------------------------
// Detach
// ---------------------------------------------------------------------------

/**
 * What a canvas-only copy of `dataset` cannot carry, as `diagram.semantic.
 * loss.*` diagnostics (only categories present in the spec are listed).
 */
export function semanticLosses(dataset: SemanticSpecDataset): ValidationDiagnostic[] {
  const descriptor = descriptorFor(dataset);
  if (!descriptor) return [];
  const spec = dataset.spec;
  const entities = specEntries(spec, descriptor.entities);
  const relations = specEntries(spec, descriptor.relations);
  const losses: ValidationDiagnostic[] = [];
  const count = (key: string, n: number) => {
    if (n > 0) losses.push({ key: `diagram.semantic.loss.${key}`, params: { count: n } });
  };
  count("entityTypes", entities.filter((entry) => typeof entry.type === "string").length);
  if (dataset.diagramType === "sequence") count("messageOrder", relations.length);
  count("relationStyles", relations.filter((entry) => entry.variant !== undefined || entry.role !== undefined).length);
  count("classifications", relations.filter((entry) => typeof entry.classification === "string").length);
  count("notes", relations.filter((entry) => typeof entry.note === "string").length);
  if (descriptor.container) count(descriptor.container.field, specEntries(spec, descriptor.container.field).length);
  count("sources", entities.filter((entry) => entry.sources !== undefined).length);
  const notProjected = descriptor.notProjected.filter((field) => spec[field] !== undefined);
  if (notProjected.length > 0) {
    losses.push({ key: "diagram.semantic.loss.notProjected", params: { fields: notProjected.join(", ") } });
  }
  const extensions = Object.keys(dataset.preservedExtensions ?? {});
  if (extensions.length > 0) {
    losses.push({ key: "diagram.semantic.loss.extensions", params: { fields: extensions.join(", ") } });
  }
  if (dataset.provenance) {
    losses.push({ key: "diagram.semantic.loss.provenance", params: { origin: dataset.provenance.origin } });
  }
  return losses;
}

/**
 * Detach dataset `datasetId` to freeform: drop the dataset and strip
 * `memberId` / `semanticContainer` from its nodes. Canvas content is kept.
 * Returns the unchanged doc (and no losses) when the dataset is absent.
 */
export function detachSemanticDataset(
  doc: DiagramDoc,
  datasetId: string,
): { doc: DiagramDoc; losses: ValidationDiagnostic[] } {
  const dataset = semanticDatasetsOf(doc).find((entry) => entry.id === datasetId);
  if (!dataset) return { doc, losses: [] };
  const nodes = doc.nodes.map((node) => {
    if (!isMemberOf(node, datasetId)) return node;
    const meta = { ...node.meta };
    delete meta.memberId;
    delete meta.semanticContainer;
    const next: DiagramNode = { ...node, meta };
    if (Object.keys(meta).length === 0) delete next.meta;
    return next;
  });
  return {
    doc: { ...doc, nodes, datasets: (doc.datasets ?? []).filter((entry) => entry.id !== datasetId) },
    losses: semanticLosses(dataset),
  };
}
