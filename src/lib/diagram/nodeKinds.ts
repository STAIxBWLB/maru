/**
 * Node-kind registry — defaults + factory.
 *
 * Phase 1 supports only `simple` (titled rectangle) and `text` (plain text,
 * no border). Phase 2 fills out the rest of the 13 kinds. The factory is the
 * single place that decides default size and starting `kind`-specific
 * properties, so adding a new kind later means adding one entry to `NSIZES`
 * and one branch (if needed) in `defaultFieldsFor`.
 */

import type { DiagramNode, NodeKind } from "./types";

export const NSIZES: Record<NodeKind, { w: number; h: number }> = {
  simple: { w: 140, h: 60 },
  section: { w: 200, h: 140 },
  numbered: { w: 160, h: 60 },
  text: { w: 160, h: 32 },
  diamond: { w: 120, h: 80 },
  oval: { w: 140, h: 60 },
  hexagon: { w: 140, h: 60 },
  cylinder: { w: 140, h: 80 },
  callout: { w: 160, h: 80 },
  "split-box": { w: 240, h: 120 },
  "titled-box": { w: 200, h: 140 },
  table: { w: 280, h: 160 },
  image: { w: 200, h: 140 },
};

export interface MkNodeOpts {
  w?: number;
  h?: number;
  title?: string;
  body?: string;
  bullets?: string[];
  layerId?: string;
  style?: DiagramNode["style"];
  id?: string;
  meta?: Record<string, unknown>;
}

let _autoId = 0;
function genId(): string {
  _autoId += 1;
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
    return crypto.randomUUID();
  }
  return `node-${Date.now().toString(36)}-${_autoId}`;
}

function defaultFieldsFor(opts: MkNodeOpts): Partial<DiagramNode> {
  return { title: opts.title ?? "" };
}

export function mkNode(kind: NodeKind, x: number, y: number, opts: MkNodeOpts = {}): DiagramNode {
  const size = NSIZES[kind] ?? NSIZES.simple;
  const defaults = defaultFieldsFor(opts);
  return {
    id: opts.id ?? genId(),
    kind,
    x,
    y,
    w: opts.w ?? size.w,
    h: opts.h ?? size.h,
    layerId: opts.layerId,
    style: opts.style,
    meta: opts.meta,
    ...defaults,
    body: opts.body,
    bullets: opts.bullets,
  };
}

/** Phase 1 supported kinds; gates the Add Node toolbar. */
export const PHASE_1_KINDS: NodeKind[] = ["simple", "text"];

/** All node kinds with a working renderer (Phase 2). */
export const ALL_KINDS: NodeKind[] = [
  "simple",
  "text",
  "section",
  "numbered",
  "titled-box",
  "split-box",
  "diamond",
  "oval",
  "hexagon",
  "cylinder",
  "callout",
  "table",
  "image",
];
