import DOMPurify from "dompurify";
import type {
  IdeationStage,
  ScratchpadCollection,
  ScratchpadDocument,
  ScratchpadEntry,
} from "./types";
import { renderMarkdown } from "./markdown";

export const SCRATCHPAD_COLLECTION_ORDER: readonly ScratchpadCollection[] = [
  "ideation",
  "memos",
  "temp",
];

export const IDEATION_STAGE_ORDER: readonly IdeationStage[] = [
  "seed",
  "developing",
  "proposal",
  "archive",
];

const SCRATCHPAD_DRAFT_PREFIX = "maru:scratchpad-draft:";

export interface ScratchpadDraft {
  workPath: string;
  document: ScratchpadDocument;
  content: string;
  savedAt: string;
}

export function scratchpadEntryKey(
  entry: Pick<ScratchpadEntry, "collection" | "relativePath">,
): string {
  return `${entry.collection}:${entry.relativePath}`;
}

export function filterScratchpadEntries(
  entries: ScratchpadEntry[],
  query: string,
): ScratchpadEntry[] {
  const needle = query.trim().toLocaleLowerCase();
  if (!needle) return entries;
  return entries.filter((entry) =>
    [
      entry.name,
      entry.relativePath,
      entry.preview,
      entry.source,
      entry.ideationStage ?? "",
      entry.collection,
    ]
      .join("\n")
      .toLocaleLowerCase()
      .includes(needle),
  );
}

export function groupScratchpadEntries(entries: ScratchpadEntry[]): Array<{
  collection: ScratchpadCollection;
  groups: Array<{ id: string; entries: ScratchpadEntry[] }>;
}> {
  return SCRATCHPAD_COLLECTION_ORDER.map((collection) => {
    const collectionEntries = entries.filter((entry) => entry.collection === collection);
    const ids =
      collection === "ideation"
        ? [...IDEATION_STAGE_ORDER, "ungrouped"]
        : collection === "temp"
          ? Array.from(new Set(collectionEntries.map((entry) => entry.source))).sort()
          : ["memos"];
    return {
      collection,
      groups: ids
        .map((id) => ({
          id,
          entries: collectionEntries
            .filter((entry) =>
              collection === "ideation"
                ? (entry.ideationStage ?? "ungrouped") === id
                : collection === "temp"
                  ? entry.source === id
                  : true,
            )
            .sort((left, right) => {
              const leftTime = left.updatedAt ? Date.parse(left.updatedAt) : 0;
              const rightTime = right.updatedAt ? Date.parse(right.updatedAt) : 0;
              return rightTime - leftTime || left.relativePath.localeCompare(right.relativePath);
            }),
        }))
        .filter((group) => group.entries.length > 0),
    };
  }).filter((section) => section.groups.length > 0);
}

export function scratchpadCopyPath(relativePath: string, now = new Date()): string {
  const slash = relativePath.lastIndexOf("/");
  const directory = slash >= 0 ? relativePath.slice(0, slash + 1) : "";
  const leaf = slash >= 0 ? relativePath.slice(slash + 1) : relativePath;
  const dot = leaf.lastIndexOf(".");
  const stem = dot > 0 ? leaf.slice(0, dot) : leaf;
  const extension = dot > 0 ? leaf.slice(dot) : "";
  const stamp = now.toISOString().slice(0, 19).replace(/[-:T]/g, "");
  return `${directory}${stem}-copy-${stamp}${extension}`;
}

export function scratchpadPathForFormat(relativePath: string, format: "plain" | "markdown"): string {
  const extension = format === "plain" ? ".txt" : ".md";
  return relativePath.replace(/\.(?:md|markdown|txt)$/i, "") + extension;
}

export function newMemoRelativePath(now = new Date(), suffix?: string): string {
  const stamp = now.toISOString().slice(0, 19).replace(/[-:T]/g, "");
  const token = (suffix ?? Math.random().toString(36).slice(2, 8)).replace(/[^a-z0-9]/gi, "").slice(0, 6);
  return `memo-${stamp}-${token || "draft"}.txt`;
}

export function scratchpadDraftKey(workPath: string): string {
  return `${SCRATCHPAD_DRAFT_PREFIX}${workPath}`;
}

export function writeScratchpadDraft(
  draft: ScratchpadDraft,
  storage: Pick<Storage, "setItem"> = window.localStorage,
): void {
  storage.setItem(scratchpadDraftKey(draft.workPath), JSON.stringify(draft));
}

export function readScratchpadDraft(
  workPath: string,
  storage: Pick<Storage, "getItem"> = window.localStorage,
): ScratchpadDraft | null {
  try {
    const raw = storage.getItem(scratchpadDraftKey(workPath));
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Partial<ScratchpadDraft>;
    if (
      parsed.workPath !== workPath ||
      !parsed.document ||
      typeof parsed.content !== "string" ||
      typeof parsed.savedAt !== "string"
    ) {
      return null;
    }
    return parsed as ScratchpadDraft;
  } catch {
    return null;
  }
}

export function clearScratchpadDraft(
  workPath: string,
  storage: Pick<Storage, "removeItem"> = window.localStorage,
): void {
  storage.removeItem(scratchpadDraftKey(workPath));
}

export function isRevisionConflict(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return /conflict|revision|changed|stale|modified/i.test(message);
}

export function renderScratchpadMarkdown(markdown: string): string {
  return DOMPurify.sanitize(renderMarkdown(markdown), {
    FORBID_TAGS: [
      "audio",
      "embed",
      "iframe",
      "img",
      "image",
      "link",
      "object",
      "source",
      "style",
      "svg",
      "use",
      "video",
    ],
    FORBID_ATTR: ["href", "xlink:href", "src", "srcset", "poster", "style"],
    ADD_ATTR: ["target", "data-wikilink"],
  });
}
