/**
 * Pure geometry helpers — snap, port projection, bounding box, viewport fit.
 *
 * Phase 1 ships enough for click-select / drag-move on simple + text nodes.
 * Edge routing and best-port pairing land in Phase 2 (`edgeRouting.ts`).
 */

import type { DiagramNode, EdgePort, Viewport } from "./types";

export interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

export function snap(value: number, size: number): number {
  if (size <= 1) return value;
  return Math.round(value / size) * size;
}

export function clamp(value: number, lo: number, hi: number): number {
  if (lo > hi) return value;
  return Math.min(hi, Math.max(lo, value));
}

export function nodeRect(node: DiagramNode): Rect {
  return { x: node.x, y: node.y, w: node.w, h: node.h };
}

export function portPoint(node: DiagramNode, port: EdgePort): { x: number; y: number } {
  switch (port) {
    case "n":
      return { x: node.x + node.w / 2, y: node.y };
    case "s":
      return { x: node.x + node.w / 2, y: node.y + node.h };
    case "e":
      return { x: node.x + node.w, y: node.y + node.h / 2 };
    case "w":
      return { x: node.x, y: node.y + node.h / 2 };
  }
}

export function rectContains(rect: Rect, x: number, y: number): boolean {
  return x >= rect.x && y >= rect.y && x <= rect.x + rect.w && y <= rect.y + rect.h;
}

export function rectsIntersect(a: Rect, b: Rect): boolean {
  return !(a.x + a.w < b.x || a.x > b.x + b.w || a.y + a.h < b.y || a.y > b.y + b.h);
}

export function bbox(nodes: DiagramNode[]): Rect | null {
  if (nodes.length === 0) return null;
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const n of nodes) {
    if (n.x < minX) minX = n.x;
    if (n.y < minY) minY = n.y;
    if (n.x + n.w > maxX) maxX = n.x + n.w;
    if (n.y + n.h > maxY) maxY = n.y + n.h;
  }
  return { x: minX, y: minY, w: maxX - minX, h: maxY - minY };
}

export interface FitViewInput {
  nodes: DiagramNode[];
  viewportW: number;
  viewportH: number;
  padding?: number;
  minZoom?: number;
  maxZoom?: number;
}

export function fitView(input: FitViewInput): Viewport {
  const padding = input.padding ?? 40;
  const minZoom = input.minZoom ?? 0.2;
  const maxZoom = input.maxZoom ?? 2.5;
  const box = bbox(input.nodes);
  if (!box || box.w <= 0 || box.h <= 0) {
    return { zoom: 1, px: input.viewportW / 2, py: input.viewportH / 2 };
  }
  const availableW = Math.max(1, input.viewportW - padding * 2);
  const availableH = Math.max(1, input.viewportH - padding * 2);
  const zoom = clamp(Math.min(availableW / box.w, availableH / box.h), minZoom, maxZoom);
  const cx = box.x + box.w / 2;
  const cy = box.y + box.h / 2;
  return {
    zoom,
    px: input.viewportW / 2 - cx * zoom,
    py: input.viewportH / 2 - cy * zoom,
  };
}

/** Convert a screen-space (px) point to canvas-space coordinates. */
export function screenToCanvas(
  vx: number,
  vy: number,
  viewport: Viewport,
): { x: number; y: number } {
  return {
    x: (vx - viewport.px) / viewport.zoom,
    y: (vy - viewport.py) / viewport.zoom,
  };
}
