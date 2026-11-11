import type { Diagnostic } from "../../../src-tauri/crates/maru-diagram-engine/bindings/engine";
import { canvasLabelsFor, type CanvasGeometry, type CanvasGeometryLabel } from "./engineCanvasGeometry";
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

function labelTarget(label: CanvasGeometryLabel, dx = 0, dy = 0): CanvasDiagnosticTarget {
  return { kind: "label", id: label.id, x: label.x + label.w + dx + 8, y: label.y + dy };
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
  const place = (diagnostic: Diagnostic): CanvasDiagnosticTarget | null => {
    if (!dataset || !descriptor) return null;
    const parts = pointerParts(diagnostic.path);
    if (!parts) return null;
    if (parts[0] === "meta" && (parts[1] === "title" || parts[1] === "subtitle")) {
      const label = geometry?.pageLabels.find((item) => item.id === parts[1] || item.id.endsWith(`:${parts[1]}`));
      return label ? labelTarget(label) : null;
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
      if (label) return labelTarget(label);
      const points = geometry?.routes.get(id)?.points;
      const point = points?.[Math.floor(points.length / 2)];
      if (point) return { kind: "edge", id, x: point.x + 8, y: point.y };
      const from = shown.get(edge.fromNode) ?? sourceNodes.get(edge.fromNode);
      const to = shown.get(edge.toNode) ?? sourceNodes.get(edge.toNode);
      return from && to ? { kind: "edge", id, x: (from.x + from.w / 2 + to.x + to.w / 2) / 2 + 8, y: (from.y + from.h / 2 + to.y + to.h / 2) / 2 } : null;
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
    if (label) return labelTarget(label, box ? node.x - box.x : 0, box ? node.y - box.y : 0);
    return { kind: member.kind === "container" ? "container" : "node", id, x: node.x + node.w + 8, y: node.y };
  };
  return diagnostics.map((diagnostic) => {
    const target = place(diagnostic);
    return { diagnostic, category: canvasDiagnosticCategory(diagnostic), target: target && Number.isFinite(target.x) && Number.isFinite(target.y) ? target : null };
  });
}
