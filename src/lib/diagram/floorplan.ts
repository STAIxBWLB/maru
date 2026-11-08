/**
 * Floorplan (`floorplan/architecture@1`) as a semantic diagram type (issue #535).
 *
 * The dataset spec is the upstream JSON verbatim (haydenschmitty/floorplan
 * 0.6.3, `skills/floorplan/references/schema.md`). This module owns the
 * schema constants, the local validation floor and the nested layout; the
 * descriptor and projection live in `semantic.ts`, interchange in
 * `floorplanCodec.ts`.
 *
 * Until the pinned Floorplan engine lands (#536), local validation here is
 * the whole apply gate for floorplan datasets (see `docs/diagram.md`).
 *
 * Pure and never throws.
 */

import type { ValidationDiagnostic } from "./validation";

export const FLOORPLAN_SCHEMA_ID = "floorplan/architecture@1";
/** The upstream schema release the dataset is checked against. */
export const FLOORPLAN_ENGINE = { name: "floorplan", version: "0.6.3" } as const;

export const FLOORPLAN_NODE_KINDS = [
  "ui",
  "service",
  "worker",
  "library",
  "feature",
  "data",
  "config",
  "test",
  "script",
  "infra",
  "external",
] as const;

export const FLOORPLAN_EDGE_KINDS = ["import", "call", "http", "rpc", "event", "queue", "data", "config"] as const;

export const FLOORPLAN_AUDIENCES = ["everyone", "developers"] as const;

/** Top-level fields the schema defines. */
export const FLOORPLAN_TOP_FIELDS = [
  "$schema",
  "project",
  "nodes",
  "edges",
  "annotations",
  "flows",
  "tour",
  "audience",
  "include",
  "ignore",
] as const;

export const FLOORPLAN_NODE_FIELDS = [
  "id",
  "label",
  "kind",
  "parent",
  "summary",
  "details",
  "paths",
  "exclude",
  "packages",
  "hosts",
  "tags",
] as const;

export const FLOORPLAN_EDGE_FIELDS = ["from", "to", "kind", "label", "description"] as const;

/** Node fields kept in the spec but not drawn on the canvas. */
export const FLOORPLAN_NODE_NOT_PROJECTED = ["details", "paths", "exclude", "packages", "hosts", "tags"] as const;

const NODE_ID = /^[A-Za-z0-9_.-]+$/;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function records(spec: Record<string, unknown>, field: string): Record<string, unknown>[] {
  const value = spec[field];
  return Array.isArray(value) ? value.filter(isRecord) : [];
}

export function isFloorplanSchema(value: unknown): boolean {
  return isRecord(value) && value.$schema === FLOORPLAN_SCHEMA_ID;
}

/** Node ids in document order. */
export function floorplanNodeIds(spec: Record<string, unknown>): Set<string> {
  return new Set(records(spec, "nodes").flatMap((node) => typeof node.id === "string" ? [node.id] : []));
}

/**
 * Whether `ref` (an edge endpoint, flow step or tour stop) names something
 * on the map: a node id, or a file path. A file path contains `/`, or is a
 * dotted name whose part before the first dot is not a node id (`app.py`);
 * `api.ghost` under an existing `api` node reads as a dangling node id.
 */
export function isFloorplanRef(ref: unknown, nodeIds: ReadonlySet<string>): boolean {
  if (typeof ref !== "string" || ref.length === 0) return false;
  if (nodeIds.has(ref) || ref.includes("/")) return true;
  const dot = ref.indexOf(".");
  return dot > 0 && dot < ref.length - 1 && !nodeIds.has(ref.slice(0, dot));
}

/** Descendant ids of `id` (children first-order, cycle safe). */
export function floorplanDescendants(spec: Record<string, unknown>, ids: Iterable<string>): Set<string> {
  const nodes = records(spec, "nodes");
  const found = new Set<string>();
  const pending = [...ids];
  while (pending.length > 0) {
    const current = pending.shift()!;
    for (const node of nodes) {
      if (node.parent === current && typeof node.id === "string" && !found.has(node.id)) {
        found.add(node.id);
        pending.push(node.id);
      }
    }
  }
  return found;
}

const globCache = new Map<string, RegExp>();

/** Upstream glob subset: `**`, `*`, `?`, `{a,b}`; a wildcard-free pattern also matches as a directory. */
export function floorplanGlobMatches(pattern: string, path: string): boolean {
  let regex = globCache.get(pattern);
  if (!regex) {
    const wildcard = /[*?{]/.test(pattern);
    let source = "";
    for (let i = 0; i < pattern.length; i += 1) {
      const ch = pattern[i]!;
      if (ch === "*" && pattern[i + 1] === "*") {
        source += pattern[i + 2] === "/" ? "(?:.*/)?" : ".*";
        i += pattern[i + 2] === "/" ? 2 : 1;
      } else if (ch === "*") source += "[^/]*";
      else if (ch === "?") source += "[^/]";
      else if (ch === "{") {
        const end = pattern.indexOf("}", i);
        if (end < 0) source += "\\{";
        else {
          source += `(?:${pattern.slice(i + 1, end).split(",").map((part) => part.replace(/[.+^$()|[\]\\]/g, "\\$&").replace(/\*/g, "[^/]*")).join("|")})`;
          i = end;
        }
      } else source += ch.replace(/[.+^$()|[\]\\]/g, "\\$&");
    }
    regex = new RegExp(`^${source}${wildcard ? "" : "(?:/.*)?"}$`);
    globCache.set(pattern, regex);
  }
  return regex.test(path);
}

/** Whether node `node` claims file `path` through its own `paths`/`exclude`. */
export function floorplanClaims(node: Record<string, unknown>, path: string): boolean {
  const strings = (value: unknown) => Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
  return strings(node.paths).some((glob) => floorplanGlobMatches(glob, path)) &&
    !strings(node.exclude).some((glob) => floorplanGlobMatches(glob, path));
}

// ---------------------------------------------------------------------------
// Local validation
// ---------------------------------------------------------------------------

/**
 * The floorplan validation floor: shape and enums of the upstream schema,
 * unique node ids, parents that exist and do not cycle, edge endpoints,
 * flows with at least two resolvable steps, and resolvable tour stops.
 * Every problem names its field.
 */
export function validateFloorplanSpec(spec: Record<string, unknown>): ValidationDiagnostic[] {
  const diagnostics: ValidationDiagnostic[] = [];
  const meta = (field: string) => diagnostics.push({ key: "diagram.validation.specMeta", params: { field } });
  const stringArray = (value: unknown, field: string) => {
    if (value !== undefined && (!Array.isArray(value) || value.some((item) => typeof item !== "string"))) meta(field);
  };
  const optionalString = (value: unknown, field: string) => {
    if (value !== undefined && typeof value !== "string") meta(field);
  };

  if (spec.$schema !== undefined && spec.$schema !== FLOORPLAN_SCHEMA_ID) meta("$schema");
  const project = spec.project;
  if (!isRecord(project) || typeof project.name !== "string" || project.name.length === 0) meta("project.name");
  if (isRecord(project)) {
    optionalString(project.summary, "project.summary");
    stringArray(project.entrypoints, "project.entrypoints");
  }
  if (spec.audience !== undefined && !(FLOORPLAN_AUDIENCES as readonly unknown[]).includes(spec.audience)) meta("audience");
  stringArray(spec.include, "include");
  stringArray(spec.ignore, "ignore");

  if (!Array.isArray(spec.nodes)) {
    meta("nodes");
    return diagnostics;
  }
  const seen = new Set<string>();
  const nodes = spec.nodes as unknown[];
  nodes.forEach((node, index) => {
    const at = `nodes[${index}]`;
    if (!isRecord(node)) return meta(at);
    if (typeof node.id !== "string" || !NODE_ID.test(node.id)) meta(`${at}.id`);
    else if (seen.has(node.id)) diagnostics.push({ key: "diagram.semantic.duplicateId", params: { field: at, id: node.id } });
    else seen.add(node.id);
    if (typeof node.label !== "string" || node.label.length === 0) meta(`${at}.label`);
    if (!(FLOORPLAN_NODE_KINDS as readonly unknown[]).includes(node.kind)) meta(`${at}.kind`);
    optionalString(node.parent, `${at}.parent`);
    optionalString(node.summary, `${at}.summary`);
    optionalString(node.details, `${at}.details`);
    for (const field of ["paths", "exclude", "packages", "hosts", "tags"]) stringArray(node[field], `${at}.${field}`);
  });

  const parents = new Map<string, string>();
  records(spec, "nodes").forEach((node, index) => {
    if (typeof node.parent !== "string" || typeof node.id !== "string") return;
    if (!seen.has(node.parent)) {
      diagnostics.push({ key: "diagram.semantic.danglingReference", params: { field: `nodes[${index}].parent`, id: node.parent } });
    } else parents.set(node.id, node.parent);
  });
  records(spec, "nodes").forEach((node, index) => {
    if (typeof node.id !== "string" || !parents.has(node.id)) return;
    const visited = new Set([node.id]);
    let current = parents.get(node.id);
    while (current !== undefined) {
      if (visited.has(current)) {
        diagnostics.push({ key: "diagram.semantic.parentCycle", params: { field: `nodes[${index}].parent` } });
        return;
      }
      visited.add(current);
      current = parents.get(current);
    }
  });

  if (spec.edges !== undefined && !Array.isArray(spec.edges)) meta("edges");
  (Array.isArray(spec.edges) ? spec.edges as unknown[] : []).forEach((edge, index) => {
    const at = `edges[${index}]`;
    if (!isRecord(edge)) return meta(at);
    for (const end of ["from", "to"] as const) {
      if (typeof edge[end] !== "string" || edge[end] === "") meta(`${at}.${end}`);
      else if (!isFloorplanRef(edge[end], seen)) {
        diagnostics.push({ key: "diagram.semantic.danglingReference", params: { field: `${at}.${end}`, id: String(edge[end]) } });
      }
    }
    if (edge.kind !== undefined && !(FLOORPLAN_EDGE_KINDS as readonly unknown[]).includes(edge.kind)) meta(`${at}.kind`);
    optionalString(edge.label, `${at}.label`);
    optionalString(edge.description, `${at}.description`);
  });

  if (spec.annotations !== undefined && !Array.isArray(spec.annotations)) meta("annotations");
  (Array.isArray(spec.annotations) ? spec.annotations as unknown[] : []).forEach((annotation, index) => {
    const at = `annotations[${index}]`;
    if (!isRecord(annotation) || typeof annotation.path !== "string" || annotation.path.length === 0) return meta(`${at}.path`);
    optionalString(annotation.note, `${at}.note`);
    stringArray(annotation.tags, `${at}.tags`);
  });

  if (spec.flows !== undefined && !Array.isArray(spec.flows)) meta("flows");
  const flowIds = new Set<string>();
  (Array.isArray(spec.flows) ? spec.flows as unknown[] : []).forEach((flow, index) => {
    const at = `flows[${index}]`;
    if (!isRecord(flow)) return meta(at);
    if (typeof flow.id !== "string" || flow.id.length === 0) meta(`${at}.id`);
    else if (flowIds.has(flow.id)) diagnostics.push({ key: "diagram.semantic.duplicateId", params: { field: at, id: flow.id } });
    else flowIds.add(flow.id);
    if (typeof flow.title !== "string" || flow.title.length === 0) meta(`${at}.title`);
    const steps = Array.isArray(flow.steps) ? flow.steps : null;
    if (!steps) return meta(`${at}.steps`);
    if (steps.length < 2) diagnostics.push({ key: "diagram.semantic.flowTooShort", params: { field: `${at}.steps` } });
    steps.forEach((step, stepIndex) => {
      const stepAt = `${at}.steps[${stepIndex}].node`;
      if (!isRecord(step) || typeof step.node !== "string") meta(stepAt);
      else if (!isFloorplanRef(step.node, seen)) {
        diagnostics.push({ key: "diagram.semantic.danglingReference", params: { field: stepAt, id: step.node } });
      }
    });
  });

  if (spec.tour !== undefined && !Array.isArray(spec.tour)) meta("tour");
  (Array.isArray(spec.tour) ? spec.tour as unknown[] : []).forEach((stop, index) => {
    const at = `tour[${index}].node`;
    if (!isRecord(stop) || typeof stop.node !== "string") meta(at);
    else if (!isFloorplanRef(stop.node, seen)) {
      diagnostics.push({ key: "diagram.semantic.danglingReference", params: { field: at, id: stop.node } });
    }
  });
  return diagnostics;
}

/** Fields the schema does not define (top level, nodes, edges), as `field` paths. */
export function floorplanUnknownFields(spec: Record<string, unknown>): string[] {
  const fields: string[] = Object.keys(spec).filter((key) => !(FLOORPLAN_TOP_FIELDS as readonly string[]).includes(key));
  records(spec, "nodes").forEach((node, index) => {
    for (const key of Object.keys(node)) {
      if (!(FLOORPLAN_NODE_FIELDS as readonly string[]).includes(key)) fields.push(`nodes[${index}].${key}`);
    }
  });
  records(spec, "edges").forEach((edge, index) => {
    for (const key of Object.keys(edge)) {
      if (!(FLOORPLAN_EDGE_FIELDS as readonly string[]).includes(key)) fields.push(`edges[${index}].${key}`);
    }
  });
  return fields;
}

// ---------------------------------------------------------------------------
// Nested layout
// ---------------------------------------------------------------------------

export interface FloorplanRect {
  x: number;
  y: number;
  w: number;
  h: number;
  /** Has children: drawn as a container section. */
  container: boolean;
  /** Nesting depth (0 = top level). */
  depth: number;
}

export interface FloorplanLayoutMetrics {
  originX: number;
  originY: number;
  nodeW: number;
  nodeH: number;
  gap: number;
  header: number;
  inset: number;
}

const TOP_COLUMNS = 3;
const CHILD_COLUMNS = 3;

/**
 * Deterministic nested layout: children sit in rows of three inside their
 * parent (header band on top), top-level nodes in rows of three. Rects are
 * keyed by node index; entries with a bad id, a dangling or cyclic parent
 * fall back to the top level so the layout never loops.
 */
export function layoutFloorplan(spec: Record<string, unknown>, m: FloorplanLayoutMetrics): Map<number, FloorplanRect> {
  const nodes = records(spec, "nodes");
  const indexById = new Map<string, number>();
  nodes.forEach((node, index) => {
    if (typeof node.id === "string" && !indexById.has(node.id)) indexById.set(node.id, index);
  });
  const parentOf = (index: number): number | null => {
    const parent = nodes[index]!.parent;
    const parentIndex = typeof parent === "string" ? indexById.get(parent) : undefined;
    if (parentIndex === undefined || parentIndex === index) return null;
    // Cycle guard: walk up; a revisit puts the node at the top level.
    const visited = new Set([index]);
    let current: number | undefined = parentIndex;
    while (current !== undefined) {
      if (visited.has(current)) return null;
      visited.add(current);
      const up: unknown = nodes[current]!.parent;
      current = typeof up === "string" ? indexById.get(up) : undefined;
    }
    return parentIndex;
  };
  const children = new Map<number | null, number[]>();
  nodes.forEach((node, index) => {
    if (indexById.get(String(node.id)) !== index) return;
    const parent = parentOf(index);
    children.set(parent, [...(children.get(parent) ?? []), index]);
  });

  const sizes = new Map<number, { w: number; h: number }>();
  const grid = (items: readonly number[], columns: number) => {
    const rows: number[][] = [];
    items.forEach((item, i) => {
      if (i % columns === 0) rows.push([]);
      rows[rows.length - 1]!.push(item);
    });
    return rows;
  };
  const measure = (index: number): { w: number; h: number } => {
    const cached = sizes.get(index);
    if (cached) return cached;
    const kids = children.get(index) ?? [];
    let size = { w: m.nodeW, h: m.nodeH };
    if (kids.length > 0) {
      const rows = grid(kids, CHILD_COLUMNS);
      const widths = rows.map((row) => row.reduce((sum, kid) => sum + measure(kid).w, 0) + (row.length - 1) * m.gap);
      const heights = rows.map((row) => Math.max(...row.map((kid) => measure(kid).h)));
      size = {
        w: Math.max(m.nodeW, ...widths) + 2 * m.inset,
        h: m.header + heights.reduce((sum, h) => sum + h, 0) + (rows.length - 1) * m.gap + m.inset,
      };
    }
    sizes.set(index, size);
    return size;
  };

  const rects = new Map<number, FloorplanRect>();
  const place = (items: readonly number[], x0: number, y0: number, columns: number, depth: number) => {
    let y = y0;
    for (const row of grid(items, columns)) {
      let x = x0;
      for (const item of row) {
        const size = measure(item);
        const kids = children.get(item) ?? [];
        rects.set(item, { x, y, ...size, container: kids.length > 0, depth });
        if (kids.length > 0) place(kids, x + m.inset, y + m.header, CHILD_COLUMNS, depth + 1);
        x += size.w + m.gap;
      }
      y += Math.max(...row.map((item) => measure(item).h)) + m.gap;
    }
  };
  place(children.get(null) ?? [], m.originX, m.originY, TOP_COLUMNS, 0);
  return rects;
}
