import type {
  DraftEntry,
  DraftKind,
  DraftStatus,
  ScratchpadEntry,
} from "./types";

/** One row in the Drafts pane list: a real draft from the drafts index, or a
 *  scratchpad ideation entry surfaced as an "idea" in the Ideation hub. */
export type DraftListItem =
  | { itemKind: "draft"; draft: DraftEntry }
  | { itemKind: "idea"; entry: ScratchpadEntry };

export type DraftKindFilter = DraftKind | "all";
/** "open" (the default) hides discarded drafts; "all" shows everything. */
export type DraftStatusFilter = DraftStatus | "all" | "open";

export function mergeDraftItems(
  drafts: DraftEntry[],
  ideationEntries: ScratchpadEntry[],
): DraftListItem[] {
  return [
    ...drafts.map((draft): DraftListItem => ({ itemKind: "draft", draft })),
    ...ideationEntries.map((entry): DraftListItem => ({ itemKind: "idea", entry })),
  ];
}

export function draftItemId(item: DraftListItem): string {
  return item.itemKind === "draft" ? `draft:${item.draft.id}` : `idea:${item.entry.relativePath}`;
}

export function draftItemTitle(item: DraftListItem): string {
  return item.itemKind === "draft" ? item.draft.title : item.entry.name;
}

export function draftItemKind(item: DraftListItem): DraftKind {
  return item.itemKind === "draft" ? item.draft.kind : "idea";
}

export function draftItemUpdatedAt(item: DraftListItem): string | null {
  return item.itemKind === "draft" ? item.draft.updatedAt : item.entry.updatedAt ?? null;
}

export function filterDraftItems(
  items: DraftListItem[],
  kindFilter: DraftKindFilter,
  statusFilter: DraftStatusFilter,
): DraftListItem[] {
  return items.filter((item) => {
    if (kindFilter !== "all" && draftItemKind(item) !== kindFilter) return false;
    if (item.itemKind === "idea") {
      // Ideation entries have no draft lifecycle; only a specific status
      // filter hides them.
      return statusFilter === "all" || statusFilter === "open";
    }
    if (statusFilter === "all") return true;
    if (statusFilter === "open") return item.draft.status !== "discarded";
    return item.draft.status === statusFilter;
  });
}

/** Newest first; items without a timestamp sink to the bottom. */
export function sortDraftItemsNewestFirst(items: DraftListItem[]): DraftListItem[] {
  return [...items].sort((left, right) => {
    const leftTime = draftItemUpdatedAt(left);
    const rightTime = draftItemUpdatedAt(right);
    const leftMs = leftTime ? Date.parse(leftTime) : 0;
    const rightMs = rightTime ? Date.parse(rightTime) : 0;
    return rightMs - leftMs || draftItemTitle(left).localeCompare(draftItemTitle(right));
  });
}

export function slugifyDraftTitle(title: string): string {
  const slug = title
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9가-힣]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return slug || "draft";
}

/** Default workspace-relative target when promoting a draft to a document. */
export function defaultPromoteDocumentPath(title: string): string {
  return `notes/${slugifyDraftTitle(title)}.md`;
}

/** Schedule fire time as "HH:MM" (24h, zero-padded). */
export function formatScheduleTime(hour: number, minute: number): string {
  const h = Number.isFinite(hour) ? Math.min(Math.max(Math.trunc(hour), 0), 23) : 0;
  const m = Number.isFinite(minute) ? Math.min(Math.max(Math.trunc(minute), 0), 59) : 0;
  return `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}`;
}

/** Confidence as a percentage string. Accepts both 0..1 fractions and 0..100
 *  values since the backend stores a bare number. */
export function formatConfidence(confidence?: number | null): string {
  if (confidence == null || !Number.isFinite(confidence)) return "";
  const percent = confidence <= 1 ? confidence * 100 : confidence;
  return `${Math.round(percent)}%`;
}
