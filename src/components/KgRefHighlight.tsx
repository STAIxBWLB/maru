// KG reference highlight surfaces (kg_refs Phase 4, Feature B).
//
// - KgSourceBackdrop: a mirrored text layer behind the (backgroundless)
//   source textarea. The textarea itself is untouched — decorations are pure
//   DOM, synced on scroll, and never modify the document.
// - applyKgPreviewHighlights: wrap rendered preview text ranges in <mark>
//   elements. Called by decoratePreviewHtml against a detached document, never
//   against a container React owns.

import { useEffect, useMemo, useRef, useState, type RefObject } from "react";
import { kgDocumentRefs } from "../lib/api";
import {
  buildByteToCharTable,
  byteOffsetToCharIndex,
  segmentsFromSpans,
  type KgCharSpan,
  type KgRenderedSpan,
  type KgSegment,
} from "../lib/kgRefs";
import type { KgNodeRef } from "../lib/types";
import { useGraphModeSlice } from "../lib/visualModeStore";

interface KgSourceBackdropProps {
  content: string;
  spans: KgCharSpan[];
  /** Char range of the reference walk's active paragraph, or null. */
  walkRange?: { start: number; end: number } | null;
  textareaRef: RefObject<HTMLTextAreaElement | null>;
  titleFor: (span: KgCharSpan) => string;
}

/** A backdrop segment annotated with walk membership. */
interface KgWalkSegment {
  text: string;
  span: KgCharSpan | null;
  walk: boolean;
}

/** Split the plain/span segments at the walk range's boundaries so the
 *  paragraph highlight composes with (and around) the reference marks. */
function overlayWalkRange(
  segments: KgSegment[],
  range: { start: number; end: number } | null | undefined,
): KgWalkSegment[] {
  const out: KgWalkSegment[] = [];
  let offset = 0;
  for (const segment of segments) {
    const segStart = offset;
    offset += segment.text.length;
    const segEnd = offset;
    if (!range || range.end <= segStart || range.start >= segEnd) {
      out.push({ text: segment.text, span: segment.span, walk: false });
      continue;
    }
    const from = Math.max(0, range.start - segStart);
    const to = Math.min(segment.text.length, range.end - segStart);
    if (from > 0) out.push({ text: segment.text.slice(0, from), span: segment.span, walk: false });
    if (to > from) out.push({ text: segment.text.slice(from, to), span: segment.span, walk: true });
    if (to < segment.text.length) {
      out.push({ text: segment.text.slice(to), span: segment.span, walk: false });
    }
  }
  return out;
}

export function KgSourceBackdrop({
  content,
  spans,
  walkRange,
  textareaRef,
  titleFor,
}: KgSourceBackdropProps) {
  const backdropRef = useRef<HTMLDivElement | null>(null);
  const segments = useMemo(() => segmentsFromSpans(content, spans), [content, spans]);
  const pieces = useMemo(() => overlayWalkRange(segments, walkRange), [segments, walkRange]);

  useEffect(() => {
    const textarea = textareaRef.current;
    const backdrop = backdropRef.current;
    if (!textarea || !backdrop) return;
    const sync = () => {
      backdrop.scrollTop = textarea.scrollTop;
      backdrop.scrollLeft = textarea.scrollLeft;
    };
    sync();
    textarea.addEventListener("scroll", sync);
    return () => textarea.removeEventListener("scroll", sync);
  }, [textareaRef, content]);

  return (
    <div
      ref={backdropRef}
      className="kg-source-backdrop"
      aria-hidden="true"
      data-testid="kg-source-backdrop"
    >
      {pieces.map((piece, index) =>
        piece.span ? (
          <mark
            key={index}
            className={`kg-ref-mark kg-ref-${piece.span.matchKind}${piece.walk ? " kg-ref-walk-paragraph" : ""}`}
            title={titleFor(piece.span)}
          >
            {piece.text}
          </mark>
        ) : (
          <span key={index} className={piece.walk ? "kg-ref-walk-paragraph" : undefined}>
            {piece.text}
          </span>
        ),
      )}
    </div>
  );
}


/**
 * Wrap each rendered span's text range in a <mark>. Spans are in
 * container.textContent coordinates (see mapSpansToRenderedText). A span
 * crossing inline element boundaries becomes several adjacent marks — the
 * visual result is the same. Purely additive: no document text is altered.
 *
 * `walkRange` (same coordinates) additionally marks the reference walk's
 * active paragraph. It is applied FIRST, so the reference marks nest inside
 * the paragraph mark where they overlap — the same ordering as the
 * reference-before-find pass in decoratePreviewHtml.
 */
export function applyKgPreviewHighlights(
  container: HTMLElement,
  spans: KgRenderedSpan[],
  titleFor: (span: KgRenderedSpan) => string,
  walkRange?: { start: number; end: number } | null,
): number {
  if (spans.length === 0 && !walkRange) return 0;
  if (walkRange) {
    const range = walkRange;
    const walkWalker = document.createTreeWalker(container, NodeFilter.SHOW_TEXT);
    const walkNodes: Text[] = [];
    while (walkWalker.nextNode()) walkNodes.push(walkWalker.currentNode as Text);
    let walkOffset = 0;
    for (const node of walkNodes) {
      const text = node.data;
      const nodeStart = walkOffset;
      walkOffset += text.length;
      const nodeEnd = walkOffset;
      const from = Math.max(range.start, nodeStart);
      const to = Math.min(range.end, nodeEnd);
      if (to <= from) continue;
      const localFrom = from - nodeStart;
      const localTo = to - nodeStart;
      const fragment = document.createDocumentFragment();
      if (localFrom > 0) fragment.append(document.createTextNode(text.slice(0, localFrom)));
      const mark = document.createElement("mark");
      mark.className = "kg-ref-walk-paragraph";
      mark.textContent = text.slice(localFrom, localTo);
      fragment.append(mark);
      if (localTo < text.length) fragment.append(document.createTextNode(text.slice(localTo)));
      node.replaceWith(fragment);
    }
  }
  // The walk pass replaced text nodes without altering the text, so the span
  // walker below is built over the current tree and still reads textContent
  // coordinates.
  const walker = document.createTreeWalker(container, NodeFilter.SHOW_TEXT);
  const textNodes: Text[] = [];
  while (walker.nextNode()) textNodes.push(walker.currentNode as Text);
  let applied = 0;
  let offset = 0;
  for (const node of textNodes) {
    const text = node.data;
    const nodeStart = offset;
    offset += text.length;
    const nodeEnd = offset;
    const hits = spans.filter((span) => span.end > nodeStart && span.start < nodeEnd);
    if (hits.length === 0) continue;
    const fragment = document.createDocumentFragment();
    let cursor = 0;
    for (const span of hits) {
      const localStart = Math.max(0, span.start - nodeStart);
      const localEnd = Math.min(text.length, span.end - nodeStart);
      if (localEnd <= localStart) continue;
      if (localStart > cursor) {
        fragment.append(document.createTextNode(text.slice(cursor, localStart)));
      }
      const mark = document.createElement("mark");
      mark.className = `kg-ref-mark kg-ref-${span.matchKind}`;
      mark.dataset.kgNode = span.nodePath;
      mark.title = titleFor(span);
      mark.textContent = text.slice(localStart, localEnd);
      fragment.append(mark);
      applied += 1;
      cursor = localEnd;
    }
    if (cursor < text.length) {
      fragment.append(document.createTextNode(text.slice(cursor)));
    }
    node.replaceWith(fragment);
  }
  return applied;
}

/** Remove every KG highlight mark, restoring plain text nodes. */

/** The walk's active paragraph resolved against the open document: a char
 *  range covering that paragraph's citing spans, plus the spans themselves
 *  (preview mode re-locates them in the rendered text). */
export interface KgRefWalkTarget {
  paragraph: number;
  /** JS string index of the first citing span's start. */
  start: number;
  /** JS string index one past the last citing span's end. */
  end: number;
  spans: KgCharSpan[];
}

/**
 * Sync the document with the graph reference walk: while the walk runs, the
 * paragraph the active leg belongs to is highlighted, and pause/prev/next
 * hold it. Only the walk's focus document participates; the single-leg
 * fallback (paragraph -1) highlights nothing.
 *
 * The paragraph range is derived from the document's own reference map —
 * min start / max end over the spans whose KgRefSpan.paragraph matches the
 * active leg — converted from the backend's UTF-8 byte offsets to JS string
 * indices. The backend caches the map (the Feature B toggle relies on that),
 * so this repeat fetch is cheap.
 */
export function useKgRefWalkTarget(
  docPath: string | null,
  content: string,
): KgRefWalkTarget | null {
  const { referenceWalk, referenceFocus } = useGraphModeSlice();
  const paragraph = referenceWalk?.paragraph ?? -1;
  const focusDocRoot = referenceFocus?.docRoot ?? null;
  const active = Boolean(
    referenceWalk && focusDocRoot && docPath &&
    referenceFocus?.docPath === docPath && paragraph >= 0,
  );
  const [refs, setRefs] = useState<KgNodeRef[] | null>(null);
  useEffect(() => {
    if (!active || !docPath || !focusDocRoot) {
      setRefs(null);
      return;
    }
    let cancelled = false;
    kgDocumentRefs(focusDocRoot, docPath)
      .then((map) => {
        if (!cancelled) setRefs(map.refs);
      })
      .catch(() => {
        if (!cancelled) setRefs(null);
      });
    return () => {
      cancelled = true;
    };
  }, [active, docPath, focusDocRoot]);

  return useMemo(() => {
    if (!active || !refs) return null;
    const table = buildByteToCharTable(content);
    const spans: KgCharSpan[] = [];
    let start = Number.POSITIVE_INFINITY;
    let end = Number.NEGATIVE_INFINITY;
    for (const ref of refs) {
      for (const span of ref.spans) {
        if (span.paragraph !== paragraph) continue;
        const spanStart = byteOffsetToCharIndex(table, span.start);
        const spanEnd = byteOffsetToCharIndex(table, span.end);
        if (spanEnd <= spanStart) continue;
        spans.push({
          start: spanStart,
          end: spanEnd,
          paragraph,
          nodePath: ref.nodePath,
          nodeTitle: ref.nodeTitle,
          matchKind: ref.matchKind,
        });
        start = Math.min(start, spanStart);
        end = Math.max(end, spanEnd);
      }
    }
    if (spans.length === 0) return null;
    return { paragraph, start, end, spans };
  }, [active, refs, content, paragraph]);
}
