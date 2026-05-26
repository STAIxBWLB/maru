/**
 * Find / replace — searches node titles + bodies + edge labels.
 *
 * Pure logic returns a list of matches the UI walks through. Replacement
 * applies via store transformers so undo/redo behaves like a normal edit.
 */

import { updateEdge, updateNode } from "./actions";
import type { StateTransformer } from "./actions";
import type { DiagramDoc, NodeId, EdgeId } from "./types";

export interface FindOptions {
  caseSensitive?: boolean;
  /** Match memos (node.meta.memo) in addition to titles/bodies. */
  includeMemo?: boolean;
}

export interface FindMatch {
  kind: "node" | "edge";
  id: NodeId | EdgeId;
  field: "title" | "body" | "memo" | "label";
  index: number;
  length: number;
  /** A short context snippet around the match (max 80 chars). */
  preview: string;
}

const PREVIEW_PAD = 24;

function findInString(
  needle: string,
  haystack: string,
  caseSensitive: boolean,
): Array<{ index: number; length: number }> {
  if (!needle) return [];
  const matches: Array<{ index: number; length: number }> = [];
  const haystackCmp = caseSensitive ? haystack : haystack.toLowerCase();
  const needleCmp = caseSensitive ? needle : needle.toLowerCase();
  let from = 0;
  while (from <= haystackCmp.length - needleCmp.length) {
    const idx = haystackCmp.indexOf(needleCmp, from);
    if (idx < 0) break;
    matches.push({ index: idx, length: needle.length });
    from = idx + Math.max(1, needle.length);
  }
  return matches;
}

function preview(text: string, index: number, length: number): string {
  const start = Math.max(0, index - PREVIEW_PAD);
  const end = Math.min(text.length, index + length + PREVIEW_PAD);
  return (start > 0 ? "…" : "") + text.slice(start, end) + (end < text.length ? "…" : "");
}

export function findInDoc(
  doc: DiagramDoc,
  query: string,
  opts: FindOptions = {},
): FindMatch[] {
  const caseSensitive = opts.caseSensitive === true;
  const out: FindMatch[] = [];
  if (!query) return out;
  for (const node of doc.nodes) {
    if (node.title) {
      for (const m of findInString(query, node.title, caseSensitive)) {
        out.push({
          kind: "node",
          id: node.id,
          field: "title",
          index: m.index,
          length: m.length,
          preview: preview(node.title, m.index, m.length),
        });
      }
    }
    if (node.body) {
      for (const m of findInString(query, node.body, caseSensitive)) {
        out.push({
          kind: "node",
          id: node.id,
          field: "body",
          index: m.index,
          length: m.length,
          preview: preview(node.body, m.index, m.length),
        });
      }
    }
    if (opts.includeMemo && typeof node.meta?.memo === "string") {
      const memo = node.meta.memo as string;
      for (const m of findInString(query, memo, caseSensitive)) {
        out.push({
          kind: "node",
          id: node.id,
          field: "memo",
          index: m.index,
          length: m.length,
          preview: preview(memo, m.index, m.length),
        });
      }
    }
  }
  for (const edge of doc.edges) {
    if (edge.label) {
      for (const m of findInString(query, edge.label, caseSensitive)) {
        out.push({
          kind: "edge",
          id: edge.id,
          field: "label",
          index: m.index,
          length: m.length,
          preview: preview(edge.label, m.index, m.length),
        });
      }
    }
  }
  return out;
}

function replaceAtAll(text: string, search: string, replacement: string, caseSensitive: boolean): string {
  if (!search) return text;
  if (caseSensitive) return text.split(search).join(replacement);
  const escaped = search.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return text.replace(new RegExp(escaped, "gi"), replacement);
}

export function replaceAllInDoc(
  search: string,
  replacement: string,
  opts: FindOptions = {},
): StateTransformer {
  const caseSensitive = opts.caseSensitive === true;
  return (state) => {
    let next = state;
    let touched = false;
    for (const node of state.doc.nodes) {
      const patch: Partial<typeof node> = {};
      if (node.title) {
        const out = replaceAtAll(node.title, search, replacement, caseSensitive);
        if (out !== node.title) patch.title = out;
      }
      if (node.body) {
        const out = replaceAtAll(node.body, search, replacement, caseSensitive);
        if (out !== node.body) patch.body = out;
      }
      if (Object.keys(patch).length > 0) {
        next = updateNode(node.id, patch)(next);
        touched = true;
      }
    }
    for (const edge of state.doc.edges) {
      if (!edge.label) continue;
      const out = replaceAtAll(edge.label, search, replacement, caseSensitive);
      if (out !== edge.label) {
        next = updateEdge(edge.id, { label: out })(next);
        touched = true;
      }
    }
    return touched ? next : state;
  };
}
