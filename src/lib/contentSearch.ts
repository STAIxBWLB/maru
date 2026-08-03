export interface MatchSegment {
  text: string;
  hit: boolean;
}

export const MIN_CONTENT_QUERY_LENGTH = 2;

/**
 * Split a match line into plain and highlighted spans. Backend offsets are
 * already UTF-16 units, so they can be used directly with `String.slice`.
 */
export function splitMatchSegments(
  text: string,
  ranges: [number, number][],
): MatchSegment[] {
  if (!text) return [];

  const normalized = ranges
    .map(([rawStart, rawEnd]) => {
      const start = Math.max(0, Math.min(text.length, Math.trunc(rawStart)));
      const end = Math.max(0, Math.min(text.length, Math.trunc(rawEnd)));
      return [start, end] as const;
    })
    .filter(([start, end]) => end > start)
    .sort(([leftStart, leftEnd], [rightStart, rightEnd]) =>
      leftStart === rightStart ? leftEnd - rightEnd : leftStart - rightStart,
    );

  const merged: [number, number][] = [];
  for (const [start, end] of normalized) {
    const previous = merged[merged.length - 1];
    if (previous && start <= previous[1]) {
      previous[1] = Math.max(previous[1], end);
    } else {
      merged.push([start, end]);
    }
  }

  if (merged.length === 0) return [{ text, hit: false }];

  const segments: MatchSegment[] = [];
  let cursor = 0;
  for (const [start, end] of merged) {
    if (start > cursor) segments.push({ text: text.slice(cursor, start), hit: false });
    segments.push({ text: text.slice(start, end), hit: true });
    cursor = end;
  }
  if (cursor < text.length) segments.push({ text: text.slice(cursor), hit: false });
  return segments;
}

/** Parse the Explorer's comma-separated include/exclude inputs. */
export function parseGlobList(value: string): string[] {
  return value
    .split(",")
    .map((part) => part.trim())
    .filter(Boolean);
}

export function shouldRunContentSearch(input: {
  mode: "names" | "contents";
  query: string;
  workspacePath: string | null;
}): boolean {
  return (
    input.mode === "contents" &&
    input.workspacePath !== null &&
    input.query.trim().length >= MIN_CONTENT_QUERY_LENGTH
  );
}
