// Knowledge-graph reference highlighting helpers (kg_refs Phase 4).
//
// The backend (`kg_document_refs`) reports spans as UTF-8 BYTE offsets into
// the raw markdown string. Everything here converts those into JS string
// (UTF-16 code unit) indices, flattens per-node refs into one non-overlapping
// decoration list, and re-locates spans inside rendered preview text.

import type {
  DocumentRefMap,
  KgNodeRef,
  KgRefMatchKind,
} from "./types";

/** A span converted to JS string indices, carrying its owning node. */
export interface KgCharSpan {
  /** JS string index (UTF-16 code units) of the span start. */
  start: number;
  /** JS string index one past the span end. */
  end: number;
  paragraph: number;
  nodePath: string;
  nodeTitle: string;
  matchKind: KgRefMatchKind;
}

/**
 * Byte-offset → char-index lookup table for `content`.
 *
 * `table[b]` = the JS string index at which UTF-8 byte offset `b` falls.
 * Multibyte interior bytes map to the index of their lead character, so any
 * backend offset (which always lands on a character boundary) converts
 * exactly. Length is `utf8ByteLength + 1`; the last entry maps the
 * end-of-string byte offset to `content.length`.
 */
export function buildByteToCharTable(content: string): Uint32Array {
  const byteLength = new TextEncoder().encode(content).length;
  const table = new Uint32Array(byteLength + 1);
  const encoder = new TextEncoder();
  let byte = 0;
  let units = 0;
  // for…of iterates code points; each char is 1 BMP unit or a 2-unit surrogate
  // pair, and both `.length` and the encoder see exactly that.
  for (const char of content) {
    const charBytes = encoder.encode(char).length;
    for (let i = 0; i < charBytes; i += 1) {
      table[byte + i] = units;
    }
    byte += charBytes;
    units += char.length;
  }
  table[byte] = units;
  return table;
}

/** Convert one UTF-8 byte offset using a table from buildByteToCharTable. */
export function byteOffsetToCharIndex(table: Uint32Array, byteOffset: number): number {
  if (byteOffset <= 0) return 0;
  if (byteOffset >= table.length - 1) return table[table.length - 1];
  return table[byteOffset];
}

const KIND_PRIORITY: Record<KgRefMatchKind, number> = { wikilink: 0, entity: 1 };

/**
 * Flatten a DocumentRefMap into one sorted, non-overlapping span list with
 * JS string indices. Overlaps resolve deterministically: wikilink beats
 * entity, then the longer span, then the earlier start.
 */
export function refMapToCharSpans(content: string, refMap: DocumentRefMap): KgCharSpan[] {
  const table = buildByteToCharTable(content);
  const all: KgCharSpan[] = [];
  for (const ref of refMap.refs) {
    for (const span of ref.spans) {
      const start = byteOffsetToCharIndex(table, span.start);
      const end = byteOffsetToCharIndex(table, span.end);
      if (end <= start) continue;
      all.push({
        start,
        end,
        paragraph: span.paragraph,
        nodePath: ref.nodePath,
        nodeTitle: ref.nodeTitle,
        matchKind: ref.matchKind,
      });
    }
  }
  all.sort((a, b) =>
    a.start - b.start
    || KIND_PRIORITY[a.matchKind] - KIND_PRIORITY[b.matchKind]
    || (b.end - b.start) - (a.end - a.start),
  );
  const accepted: KgCharSpan[] = [];
  let lastEnd = -1;
  for (const span of all) {
    if (span.start < lastEnd) continue;
    accepted.push(span);
    lastEnd = span.end;
  }
  return accepted;
}

/** Group a ref map's unique node paths (one entry per referenced KG node). */
export function uniqueRefNodePaths(refs: KgNodeRef[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const ref of refs) {
    if (seen.has(ref.nodePath)) continue;
    seen.add(ref.nodePath);
    out.push(ref.nodePath);
  }
  return out;
}

function joinRoot(root: string, relative: string): string {
  return `${root.replace(/[\\/]+$/, "")}/${relative.replace(/\\/g, "/").replace(/^\/+/, "")}`;
}

/** Resolve referenced node paths to graph node ids.
 *
 *  The two sides are rooted differently: `kg_document_refs` returns paths
 *  relative to the document's workspace, while graph nodes carry `relPath`
 *  relative to the graph's own data path — and those differ by a `vault/`
 *  segment whenever the graph reads a nested vault submodule. Comparing the
 *  relative strings directly resolved nothing on exactly that layout, so rebase
 *  both to absolute before matching. */
export function resolveReferenceNodeIds(
  nodes: readonly { id: string; relPath: string | null }[],
  nodePaths: readonly string[],
  docRoot: string,
  graphRoot: string | null,
): Set<string> {
  const ids = new Set<string>();
  if (!graphRoot) return ids;
  const referenced = new Set(nodePaths.map((relative) => joinRoot(docRoot, relative)));
  for (const node of nodes) {
    if (node.relPath && referenced.has(joinRoot(graphRoot, node.relPath))) ids.add(node.id);
  }
  return ids;
}

/** Plain segments for a highlighter: text outside spans + the spans. */
export interface KgSegment {
  text: string;
  span: KgCharSpan | null;
}

/** Split `content` into alternating plain/highlighted segments. */
export function segmentsFromSpans(content: string, spans: KgCharSpan[]): KgSegment[] {
  const segments: KgSegment[] = [];
  let cursor = 0;
  for (const span of spans) {
    const start = Math.max(cursor, Math.min(span.start, content.length));
    const end = Math.max(start, Math.min(span.end, content.length));
    if (start > cursor) segments.push({ text: content.slice(cursor, start), span: null });
    if (end > start) segments.push({ text: content.slice(start, end), span });
    cursor = end;
  }
  if (cursor < content.length) segments.push({ text: content.slice(cursor), span: null });
  return segments;
}

/**
 * Candidate search texts for locating a source span inside rendered preview
 * text. Wikilink spans include the `[[...]]` brackets, but the renderer emits
 * only the alias (or the bare target) — so try the raw text first, then the
 * alias, then the target. Entity spans match their raw text directly.
 */
export function spanSearchTexts(sourceText: string, matchKind: KgRefMatchKind): string[] {
  if (matchKind !== "wikilink") return [sourceText];
  const match = /^\[\[([^\]|]+)(?:\|([^\]]+))?\]\]$/.exec(sourceText.trim());
  if (!match) return [sourceText];
  const target = match[1].trim();
  const alias = match[2]?.trim();
  const candidates = [sourceText];
  if (alias && alias !== sourceText) candidates.push(alias);
  if (target && target !== alias) candidates.push(target);
  return candidates;
}

/** A span re-located inside rendered (preview) text. */
export interface KgRenderedSpan {
  start: number;
  end: number;
  nodePath: string;
  nodeTitle: string;
  matchKind: KgRefMatchKind;
}

/**
 * Map source spans onto a rendered text string by searching each span's
 * candidate text in source order from a moving cursor. Spans that cannot be
 * found (e.g. frontmatter content the renderer stripped) are skipped; the
 * cursor only advances on a hit so one miss never desyncs the rest.
 */
export function mapSpansToRenderedText(
  renderedText: string,
  spans: KgCharSpan[],
  sourceTextFor: (span: KgCharSpan) => string,
): KgRenderedSpan[] {
  const mapped: KgRenderedSpan[] = [];
  let cursor = 0;
  for (const span of spans) {
    const candidates = spanSearchTexts(sourceTextFor(span), span.matchKind);
    let hit = -1;
    let hitLength = 0;
    for (const candidate of candidates) {
      if (!candidate) continue;
      const index = renderedText.indexOf(candidate, cursor);
      if (index >= 0) {
        hit = index;
        hitLength = candidate.length;
        break;
      }
    }
    if (hit < 0) continue;
    mapped.push({
      start: hit,
      end: hit + hitLength,
      nodePath: span.nodePath,
      nodeTitle: span.nodeTitle,
      matchKind: span.matchKind,
    });
    cursor = hit + hitLength;
  }
  return mapped;
}
