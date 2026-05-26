/**
 * Selection ops — alignment, distribution, equalize.
 *
 * All helpers take the full nodes array + the set of ids to act on, and
 * return a *new* nodes array with the affected entries patched. Untouched
 * nodes are returned by reference so React.memo / shallow-compare in
 * `NodeView` keeps the un-aligned nodes from re-rendering.
 *
 * Mirrors the source `alignN`, `distN`, `equalizeW`, `equalizeH` functions
 * (concept-map-diagram.html lines 801–813) but is fully pure and
 * unit-testable.
 */

import type { DiagramNode, NodeId } from "./types";

export type AlignMode =
  | "left"
  | "right"
  | "center-h"
  | "top"
  | "bottom"
  | "center-v";

export type DistributeAxis = "h" | "v";
export type EqualizeAxis = "w" | "h";

function selectNodes(nodes: DiagramNode[], ids: Iterable<NodeId>): DiagramNode[] {
  const set = new Set(ids);
  return nodes.filter((n) => set.has(n.id));
}

function applyPatches(
  nodes: DiagramNode[],
  patches: Map<NodeId, Partial<DiagramNode>>,
): DiagramNode[] {
  if (patches.size === 0) return nodes;
  return nodes.map((n) => {
    const patch = patches.get(n.id);
    return patch ? { ...n, ...patch } : n;
  });
}

export function alignNodes(
  nodes: DiagramNode[],
  ids: Iterable<NodeId>,
  mode: AlignMode,
): DiagramNode[] {
  const selected = selectNodes(nodes, ids);
  if (selected.length < 2) return nodes;
  const patches = new Map<NodeId, Partial<DiagramNode>>();

  if (mode === "left") {
    const x = Math.min(...selected.map((n) => n.x));
    for (const n of selected) if (n.x !== x) patches.set(n.id, { x });
  } else if (mode === "right") {
    const right = Math.max(...selected.map((n) => n.x + n.w));
    for (const n of selected) {
      const x = right - n.w;
      if (n.x !== x) patches.set(n.id, { x });
    }
  } else if (mode === "center-h") {
    const min = Math.min(...selected.map((n) => n.x));
    const max = Math.max(...selected.map((n) => n.x + n.w));
    const centerX = (min + max) / 2;
    for (const n of selected) {
      const x = centerX - n.w / 2;
      if (n.x !== x) patches.set(n.id, { x });
    }
  } else if (mode === "top") {
    const y = Math.min(...selected.map((n) => n.y));
    for (const n of selected) if (n.y !== y) patches.set(n.id, { y });
  } else if (mode === "bottom") {
    const bottom = Math.max(...selected.map((n) => n.y + n.h));
    for (const n of selected) {
      const y = bottom - n.h;
      if (n.y !== y) patches.set(n.id, { y });
    }
  } else if (mode === "center-v") {
    const min = Math.min(...selected.map((n) => n.y));
    const max = Math.max(...selected.map((n) => n.y + n.h));
    const centerY = (min + max) / 2;
    for (const n of selected) {
      const y = centerY - n.h / 2;
      if (n.y !== y) patches.set(n.id, { y });
    }
  }
  return applyPatches(nodes, patches);
}

export function distributeNodes(
  nodes: DiagramNode[],
  ids: Iterable<NodeId>,
  axis: DistributeAxis,
): DiagramNode[] {
  const selected = selectNodes(nodes, ids);
  if (selected.length < 3) return nodes;
  const sorted = [...selected].sort((a, b) => (axis === "h" ? a.x - b.x : a.y - b.y));
  const first = sorted[0]!;
  const last = sorted[sorted.length - 1]!;
  const start = axis === "h" ? first.x + first.w / 2 : first.y + first.h / 2;
  const end = axis === "h" ? last.x + last.w / 2 : last.y + last.h / 2;
  const step = (end - start) / (sorted.length - 1);
  const patches = new Map<NodeId, Partial<DiagramNode>>();
  for (let i = 1; i < sorted.length - 1; i += 1) {
    const target = start + step * i;
    const n = sorted[i]!;
    if (axis === "h") {
      const x = target - n.w / 2;
      if (n.x !== x) patches.set(n.id, { x });
    } else {
      const y = target - n.h / 2;
      if (n.y !== y) patches.set(n.id, { y });
    }
  }
  return applyPatches(nodes, patches);
}

export function equalizeSize(
  nodes: DiagramNode[],
  ids: Iterable<NodeId>,
  axis: EqualizeAxis,
): DiagramNode[] {
  const selected = selectNodes(nodes, ids);
  if (selected.length < 2) return nodes;
  const value =
    axis === "w"
      ? Math.max(...selected.map((n) => n.w))
      : Math.max(...selected.map((n) => n.h));
  const patches = new Map<NodeId, Partial<DiagramNode>>();
  for (const n of selected) {
    if (axis === "w" && n.w !== value) patches.set(n.id, { w: value });
    if (axis === "h" && n.h !== value) patches.set(n.id, { h: value });
  }
  return applyPatches(nodes, patches);
}
