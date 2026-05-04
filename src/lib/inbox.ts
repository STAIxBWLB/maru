import type { InboxClassification, InboxDropItem } from "./types";

export type InboxDecision = "pending" | "accepted" | "rejected";

export interface InboxItemState {
  item: InboxDropItem;
  decision: InboxDecision;
  classification: InboxClassification | null;
  classifying: boolean;
  classifyError: string | null;
}

export function buildInboxItemStates(
  items: InboxDropItem[],
  byId: Map<string, Omit<InboxItemState, "item">>,
): InboxItemState[] {
  return items.map((item) => {
    const carry = byId.get(item.id);
    return {
      item,
      decision: carry?.decision ?? "pending",
      classification: carry?.classification ?? null,
      classifying: carry?.classifying ?? false,
      classifyError: carry?.classifyError ?? null,
    };
  });
}

/** Return only items whose `source` matches `source`. `null` means
 *  "no filter" — pass through. Source comparison is case-sensitive
 *  to match the Rust scanner. */
export function filterItemsBySource<T extends { item: { source: string } }>(
  items: T[],
  source: string | null,
): T[] {
  if (source === null) return items;
  return items.filter((entry) => entry.item.source === source);
}

/** Distinct, alphabetically-stable list of sources observed in the
 *  current inbox snapshot. Used to populate the filter chip row. */
export function uniqueSources<T extends { item: { source: string } }>(items: T[]): string[] {
  const seen = new Set<string>();
  for (const entry of items) seen.add(entry.item.source);
  return [...seen].sort();
}

export function categoryLabel(category: string): string {
  switch (category) {
    case "task":
      return "할일";
    case "reference":
      return "참고";
    case "meeting":
      return "회의";
    case "admin":
      return "행정";
    default:
      return "분류 없음";
  }
}
