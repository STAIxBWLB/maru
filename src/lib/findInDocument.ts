// In-document find (Cmd+F) helpers.
//
// The find bar searches the document body only. In Source mode it drives the
// textarea selection; in Preview mode it wraps matches in <mark> elements,
// mirroring the KG highlight approach (KgRefHighlight.tsx): purely additive
// DOM, own CSS class, cleanup restores plain text nodes and never touches
// `mark.kg-ref-mark`.

export interface FindMatch {
  start: number;
  end: number;
}

/** Case-insensitive, non-overlapping matches. Empty query matches nothing. */
export function findMatches(text: string, query: string): FindMatch[] {
  const needle = query.trim().toLowerCase();
  if (!needle) return [];
  const haystack = text.toLowerCase();
  const matches: FindMatch[] = [];
  let cursor = 0;
  while (cursor <= haystack.length - needle.length) {
    const found = haystack.indexOf(needle, cursor);
    if (found === -1) break;
    matches.push({ start: found, end: found + needle.length });
    cursor = found + needle.length;
  }
  return matches;
}

/** Wrap-around next/previous over `total` matches. */
export function cycleMatchIndex(current: number, total: number, dir: 1 | -1): number {
  if (total <= 0) return 0;
  return (current + dir + total) % total;
}

export const FIND_MARK_SELECTOR = "mark.find-mark";
const FIND_MARK_CURRENT_CLASS = "find-mark-current";

/**
 * Wrap every case-insensitive occurrence of `query` in the container's text
 * in a <mark class="find-mark">; the `currentIndex`-th match also gets
 * `find-mark-current`. A match crossing inline element boundaries becomes
 * several adjacent marks; only the first segment of the current match carries
 * the current class. Returns the match count. Purely additive: no document
 * text is altered.
 */
export function applyFindHighlights(
  container: HTMLElement,
  query: string,
  currentIndex: number,
): number {
  const matches = findMatches(container.textContent ?? "", query);
  if (matches.length === 0) return 0;
  const walker = document.createTreeWalker(container, NodeFilter.SHOW_TEXT);
  const textNodes: Text[] = [];
  while (walker.nextNode()) textNodes.push(walker.currentNode as Text);
  let offset = 0;
  for (const node of textNodes) {
    const text = node.data;
    const nodeStart = offset;
    offset += text.length;
    const nodeEnd = offset;
    const hits = matches
      .map((match, index) => ({ match, index }))
      .filter(({ match }) => match.end > nodeStart && match.start < nodeEnd);
    if (hits.length === 0) continue;
    const fragment = document.createDocumentFragment();
    let cursor = 0;
    for (const { match, index } of hits) {
      const localStart = Math.max(0, match.start - nodeStart);
      const localEnd = Math.min(text.length, match.end - nodeStart);
      if (localEnd <= localStart) continue;
      if (localStart > cursor) {
        fragment.append(document.createTextNode(text.slice(cursor, localStart)));
      }
      const mark = document.createElement("mark");
      // Only the segment holding the match start carries the current class.
      mark.className =
        index === currentIndex && match.start >= nodeStart
          ? `find-mark ${FIND_MARK_CURRENT_CLASS}`
          : "find-mark";
      mark.textContent = text.slice(localStart, localEnd);
      fragment.append(mark);
      cursor = localEnd;
    }
    if (cursor < text.length) {
      fragment.append(document.createTextNode(text.slice(cursor)));
    }
    node.replaceWith(fragment);
  }
  return matches.length;
}

/** Remove every find mark, restoring plain text nodes. */
export function clearFindHighlights(container: HTMLElement): void {
  const marks = container.querySelectorAll(FIND_MARK_SELECTOR);
  for (const mark of marks) {
    mark.replaceWith(document.createTextNode(mark.textContent ?? ""));
  }
  container.normalize();
}
