import type { Diagnostic } from "../../../src-tauri/crates/maru-diagram-engine/bindings/engine";
import { canvasLabelsFor, type CanvasGeometry, type CanvasGeometryLabel } from "./engineCanvasGeometry";
import type { Rect } from "./geometry";
import type { SemanticSpecDataset } from "./reportTypes";
import { descriptorFor, projectedRelationEdgeIds, resolveSemanticMember, semanticContainerId, semanticContainers, specEntries } from "./semantic";
import type { DiagramDoc, DiagramNode } from "./types";

export type CanvasDiagnosticCategory = "text" | "overlap" | "bounds" | "routing" | "layout" | "unknown";
export interface CanvasDiagnosticTarget {
  kind: "node" | "container" | "label" | "edge";
  id: string;
  x: number;
  y: number;
}
export interface CanvasDiagnosticPlacement {
  diagnostic: Diagnostic;
  category: CanvasDiagnosticCategory;
  target: CanvasDiagnosticTarget | null;
}

/**
 * The badge one anchored diagnostic is drawn as, in canvas pixels. The mapper
 * owns the size because the size is what decides where a badge can sit without
 * covering a member or a label that is already there; the renderers read the
 * same numbers so the drawn box and the placed box cannot diverge.
 */
export const CANVAS_DIAGNOSTIC_BADGE = { width: 300, height: 44, gap: 8, step: 48 } as const;

const CATEGORY_CODES: Record<Exclude<CanvasDiagnosticCategory, "unknown">, readonly string[]> = {
  text: ["geometry-label-fit", "geometry-boundary-title-fit", "geometry-segment-label-fit", "route-label-space"],
  overlap: ["geometry-node-overlap", "geometry-label-overlap"],
  bounds: ["geometry-node-viewbox", "geometry-label-viewbox", "geometry-route-viewbox", "geometry-container-containment", "geometry-node-lane", "geometry-state-column", "geometry-column-capacity", "geometry-viewbox-capacity", "fixed-row-slots", "stage-canvas-width", "reserved-main-lane", "geometry-phase-range", "geometry-group-containment", "geometry-participant-canvas-width", "geometry-segment-range", "geometry-message-time", "geometry-message-spacing", "geometry-legend-clearance"],
  routing: ["geometry-route-clearance", "geometry-route-quality", "geometry-route-quality-notice", "geometry-route-distance", "route-endpoint", "route-port-blocked", "route-blocked", "route-budget"],
  layout: ["layout-range"],
};

/** Categories summarize known codes; they never translate arbitrary engine prose. */
export function canvasDiagnosticCategory(diagnostic: Diagnostic): CanvasDiagnosticCategory {
  if (diagnostic.code === "canvas.geometry.unavailable") return "layout";
  const [family, suffix, extra] = diagnostic.code.split("/");
  if (extra !== undefined || !["architecture", "workflow", "sequence", "dataflow", "lifecycle", "document"].includes(family ?? "")) return "unknown";
  for (const [category, codes] of Object.entries(CATEGORY_CODES)) {
    if (suffix && codes.includes(suffix)) return category as Exclude<CanvasDiagnosticCategory, "unknown">;
  }
  return "unknown";
}

/** The route checker points label failures at the relation, without /label. */
function relationLabelDiagnostic(diagnostic: Diagnostic): boolean {
  return /\/(?:geometry-label-overlap|geometry-label-viewbox|route-label-space|geometry-label-fit)$/.test(diagnostic.code);
}

function pointerParts(path: string): string[] | null {
  if (!path.startsWith("/")) return null;
  const parts = path.slice(1).split("/");
  if (parts.some((part) => /~(?:[^01]|$)/.test(part))) return null;
  return parts.map((part) => part.replace(/~1/g, "/").replace(/~0/g, "~"));
}

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

/** Source pointers use raw array indexes; the canvas projection skips malformed entries. */
function sourceEntry(dataset: SemanticSpecDataset, field: string, index: number) {
  const raw = dataset.spec[field];
  if (!Array.isArray(raw) || !record(raw[index])) return null;
  return { entry: raw[index], index: raw.slice(0, index).filter(record).length };
}

function labelTarget(label: CanvasGeometryLabel, dx = 0, dy = 0): Rect {
  return { x: label.x + dx, y: label.y + dy, w: label.w, h: label.h };
}

/** Area two boxes share; touching edges share nothing. */
function overlapArea(a: Rect, b: Rect): number {
  const w = Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x);
  const h = Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y);
  return w > 0 && h > 0 ? w * h : 0;
}

/**
 * Where the badge for one anchor goes. Right of the anchor first, then above,
 * below, and right-and-under the box; each side slides a step away from the
 * anchor until it covers nothing. Opposite the anchor comes last, because a
 * badge that jumps across the member reads as belonging to what is on its other
 * side. When even that is crowded the least covered position wins.
 *
 * Placement matters because a badge is 300 px wide and takes the pointer: on
 * top of the neighbouring label it hides the text and swallows that member's
 * click, which is what the anchored diagnostic exists to explain.
 */
function placeBadge(anchor: Rect, slot: number, obstacles: readonly Rect[]): { x: number; y: number } {
  const { width, height, gap, step } = CANVAS_DIAGNOSTIC_BADGE;
  const offset = slot * step;
  const beside = [
    { x: anchor.x + anchor.w + gap, y: anchor.y + offset, dy: 1 },
    { x: anchor.x, y: anchor.y - gap - height - offset, dy: -1 },
    { x: anchor.x, y: anchor.y + anchor.h + gap + offset, dy: 1 },
    { x: anchor.x + anchor.w + gap, y: anchor.y + anchor.h + gap + offset, dy: 1 },
  ];
  const across = [{ x: anchor.x - gap - width, y: anchor.y + offset, dy: 1 }];
  let best: { x: number; y: number } = beside[0]!;
  let bestScore = Number.POSITIVE_INFINITY;
  for (const group of [beside, across]) {
    for (let attempt = 0; attempt < 8; attempt += 1) {
      for (const side of group) {
        const candidate = { x: side.x, y: side.y + side.dy * attempt * step };
        const box = { ...candidate, w: width, h: height };
        const overlap = obstacles.reduce((total, obstacle) => total + overlapArea(box, obstacle), 0);
        // Off the page is covered too: a badge nobody can see explains nothing.
        const score = overlap + (candidate.x < 0 || candidate.y < 0 ? Number.MAX_SAFE_INTEGER : 0);
        if (score === 0) return candidate;
        if (score < bestScore) {
          bestScore = score;
          best = candidate;
        }
      }
    }
  }
  return best;
}

/** The box a diagnostic's badge sits beside, before the badge's own placement. */
interface CanvasDiagnosticAnchor {
  kind: CanvasDiagnosticTarget["kind"];
  id: string;
  box: Rect;
  /**
   * The member the badge explains. Its own box and labels may be covered — the
   * badge belongs to them — but no other member's may be.
   */
  owner: string | null;
}

/** Read-only anchors in displayed pixels; no layout, selection or document writes. */
export function mapCanvasDiagnostics(
  doc: DiagramDoc,
  datasetId: string,
  geometry: CanvasGeometry | null,
  diagnostics: readonly Diagnostic[],
  displayedNodes?: readonly DiagramNode[],
): CanvasDiagnosticPlacement[] {
  const dataset = doc.datasets?.find((item): item is SemanticSpecDataset => item.kind === "semanticSpec" && item.id === datasetId);
  const descriptor = dataset ? descriptorFor(dataset) : null;
  const shown = new Map((displayedNodes ?? []).map((node) => [node.id, node]));
  const sourceNodes = new Map(doc.nodes.map((node) => [node.id, node]));
  const projectedIds = dataset ? projectedRelationEdgeIds(dataset) : [];
  // Everything already painted that a badge must not cover: the displayed
  // members, their engine labels (moved with them while dragging), the engine's
  // route labels and the page title. Each box carries the member it belongs to,
  // because a badge may sit over its own member and never over another one. A
  // lane is a translucent frame around the scene and is left out: a badge inside
  // one covers nothing.
  const obstacles: Array<{ member: string | null; rect: Rect }> = [];
  const labelled = new Set<string>();
  if (geometry) {
    for (const [id, box] of geometry.boxes) {
      if (box.role === "container") continue;
      labelled.add(id);
      const node = shown.get(id);
      const dx = node ? node.x - box.x : 0;
      const dy = node ? node.y - box.y : 0;
      obstacles.push({ member: id, rect: { x: box.x + dx, y: box.y + dy, w: box.w, h: box.h } });
      for (const label of canvasLabelsFor(geometry, id, "node")) {
        obstacles.push({ member: id, rect: { x: label.x + dx, y: label.y + dy, w: label.w, h: label.h } });
      }
    }
    for (const [id, labels] of geometry.labels) {
      if (labelled.has(id)) continue;
      for (const label of labels) obstacles.push({ member: id, rect: { x: label.x, y: label.y, w: label.w, h: label.h } });
    }
    for (const label of geometry.pageLabels) {
      obstacles.push({ member: null, rect: { x: label.x, y: label.y, w: label.w, h: label.h } });
    }
  }
  for (const node of shown.values()) {
    if (labelled.has(node.id)) continue;
    if (resolveSemanticMember(doc, { nodeId: node.id })?.kind === "container") continue;
    obstacles.push({ member: node.id, rect: { x: node.x, y: node.y, w: node.w, h: node.h } });
  }
  const anchorOf = (diagnostic: Diagnostic): CanvasDiagnosticAnchor | null => {
    if (!dataset || !descriptor) return null;
    const parts = pointerParts(diagnostic.path);
    if (!parts) return null;
    if (parts[0] === "meta" && (parts[1] === "title" || parts[1] === "subtitle")) {
      const label = geometry?.pageLabels.find((item) => item.id === parts[1] || item.id.endsWith(`:${parts[1]}`));
      return label ? { kind: "label", id: label.id, box: labelTarget(label), owner: null } : null;
    }
    const [field, rawIndex, property] = parts;
    if (!field || !rawIndex || !/^(0|[1-9][0-9]*)$/.test(rawIndex)) return null;
    const index = Number(rawIndex);
    if (!Number.isSafeInteger(index)) return null;
    const source = sourceEntry(dataset, field, index);
    if (!source || specEntries(dataset.spec, field)[source.index] !== source.entry) return null;
    const labelRole = property === "label" || property === "sublabel" || property === "tag" ? property
      : property && property === descriptor.bodyField ? "sublabel" : null;
    if (field === descriptor.relations) {
      const id = projectedIds[source.index];
      if (!id) return null;
      const edge = doc.edges.find((item) => item.id === id);
      const member = edge ? resolveSemanticMember(doc, { edgeId: id }) : null;
      if (!edge || member?.dataset.id !== datasetId || member.field !== field || member.index !== source.index) return null;
      const role = labelRole ?? (relationLabelDiagnostic(diagnostic) ? "label" : null);
      const label = role && geometry ? canvasLabelsFor(geometry, id, "edge").find((item) => item.role === role) : null;
      if (label) return { kind: "label", id: label.id, box: labelTarget(label), owner: label.targetId };
      const points = geometry?.routes.get(id)?.points;
      const point = points?.[Math.floor(points.length / 2)];
      if (point) return { kind: "edge", id, box: { x: point.x, y: point.y, w: 0, h: 0 }, owner: id };
      const from = shown.get(edge.fromNode) ?? sourceNodes.get(edge.fromNode);
      const to = shown.get(edge.toNode) ?? sourceNodes.get(edge.toNode);
      return from && to
        ? {
          kind: "edge",
          id,
          box: {
            x: (from.x + from.w / 2 + to.x + to.w / 2) / 2,
            y: (from.y + from.h / 2 + to.y + to.h / 2) / 2,
            w: 0,
            h: 0,
          },
          owner: id,
        }
        : null;
    }
    const container = semanticContainers(descriptor).find((item) => item.field === field);
    const sourceId = typeof source.entry.id === "string" ? source.entry.id : null;
    const id = field === descriptor.entities && sourceId !== null
      ? Object.hasOwn(dataset.idMap, sourceId) ? dataset.idMap[sourceId]! : sourceId
      : container ? semanticContainerId(dataset.id, container.role, container.keyedBy === "id" ? sourceId ?? "" : String(source.index)) : null;
    if (!id) return null;
    const member = resolveSemanticMember(doc, { nodeId: id });
    if (!member || member.dataset.id !== datasetId || member.field !== field || member.index !== source.index) return null;
    const box = geometry?.boxes.get(id);
    const node = shown.get(id) ?? box ?? sourceNodes.get(id);
    if (!node) return null;
    const label = labelRole && geometry ? canvasLabelsFor(geometry, id, "node").find((item) => item.role === labelRole) : null;
    if (label) return { kind: "label", id: label.id, box: labelTarget(label, box ? node.x - box.x : 0, box ? node.y - box.y : 0), owner: id };
    return {
      kind: member.kind === "container" ? "container" : "node",
      id,
      box: { x: node.x, y: node.y, w: node.w, h: node.h },
      owner: id,
    };
  };
  // Two diagnostics on one element stack downward from the same side, so the
  // second is placed as though the first were already there.
  const slots = new Map<string, number>();
  return diagnostics.map((diagnostic) => {
    const category = canvasDiagnosticCategory(diagnostic);
    const anchor = anchorOf(diagnostic);
    if (!anchor) return { diagnostic, category, target: null };
    const key = `${anchor.kind}:${anchor.id}`;
    const slot = slots.get(key) ?? 0;
    slots.set(key, slot + 1);
    const point = placeBadge(anchor.box, slot, obstacles
      .filter((obstacle) => obstacle.member === null || obstacle.member !== anchor.owner)
      .map((obstacle) => obstacle.rect));
    if (!Number.isFinite(point.x) || !Number.isFinite(point.y)) return { diagnostic, category, target: null };
    return { diagnostic, category, target: { kind: anchor.kind, id: anchor.id, x: point.x, y: point.y } };
  });
}
