// KG reference highlight surfaces (kg_refs Phase 4, Feature B).
//
// - KgSourceBackdrop: a mirrored text layer behind the (backgroundless)
//   source textarea. The textarea itself is untouched — decorations are pure
//   DOM, synced on scroll, and never modify the document.
// - applyKgPreviewHighlights / clearKgPreviewHighlights: wrap rendered
//   preview text ranges in <mark> elements (and unwrap them again).

import { useEffect, useMemo, useRef, type RefObject } from "react";
import {
  segmentsFromSpans,
  type KgCharSpan,
  type KgRenderedSpan,
} from "../lib/kgRefs";

interface KgSourceBackdropProps {
  content: string;
  spans: KgCharSpan[];
  textareaRef: RefObject<HTMLTextAreaElement | null>;
  titleFor: (span: KgCharSpan) => string;
}

export function KgSourceBackdrop({
  content,
  spans,
  textareaRef,
  titleFor,
}: KgSourceBackdropProps) {
  const backdropRef = useRef<HTMLDivElement | null>(null);
  const segments = useMemo(() => segmentsFromSpans(content, spans), [content, spans]);

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
      {segments.map((segment, index) =>
        segment.span ? (
          <mark
            key={index}
            className={`kg-ref-mark kg-ref-${segment.span.matchKind}`}
            title={titleFor(segment.span)}
          >
            {segment.text}
          </mark>
        ) : (
          <span key={index}>{segment.text}</span>
        ),
      )}
    </div>
  );
}

export const KG_PREVIEW_MARK_SELECTOR = "mark.kg-ref-mark";

/**
 * Wrap each rendered span's text range in a <mark>. Spans are in
 * container.textContent coordinates (see mapSpansToRenderedText). A span
 * crossing inline element boundaries becomes several adjacent marks — the
 * visual result is the same. Purely additive: no document text is altered.
 */
export function applyKgPreviewHighlights(
  container: HTMLElement,
  spans: KgRenderedSpan[],
  titleFor: (span: KgRenderedSpan) => string,
): number {
  if (spans.length === 0) return 0;
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
export function clearKgPreviewHighlights(container: HTMLElement): void {
  const marks = container.querySelectorAll(KG_PREVIEW_MARK_SELECTOR);
  for (const mark of marks) {
    mark.replaceWith(document.createTextNode(mark.textContent ?? ""));
  }
  container.normalize();
}
