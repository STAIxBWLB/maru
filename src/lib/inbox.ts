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
