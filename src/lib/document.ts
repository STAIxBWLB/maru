import type { DocumentPayload, VaultEntry } from "./types";
import type { DocumentLabelMode } from "./settings";

/** Read a single scalar string from a frontmatter map regardless of whether
 *  the value is stored as string, number, boolean, or undefined. */
export function frontmatterScalar(
  frontmatter: Record<string, unknown> | null | undefined,
  key: string,
): string | null {
  if (!frontmatter) return null;
  const raw = frontmatter[key];
  if (raw == null) return null;
  if (typeof raw === "string") return raw;
  if (typeof raw === "number" || typeof raw === "boolean") return String(raw);
  return null;
}

/** Filter entries by free-text query against title, frontmatter values, body
 *  snippet, and rel path. Phase 0 keyword-only — Phase 1 swaps in proper
 *  cache-backed search. */
export function filterEntries(entries: VaultEntry[], query: string): VaultEntry[] {
  const trimmed = query.trim().toLowerCase();
  if (!trimmed) return entries;
  return entries.filter((entry) => {
    const haystack = [
      entry.title,
      entry.relPath,
      entry.snippet,
      ...Object.values(entry.frontmatter ?? {}).map((value) =>
        typeof value === "string" ? value : JSON.stringify(value),
      ),
    ]
      .join(" ")
      .toLowerCase();
    return haystack.includes(trimmed);
  });
}

const UNITS: { unit: Intl.RelativeTimeFormatUnit; ms: number }[] = [
  { unit: "year", ms: 1000 * 60 * 60 * 24 * 365 },
  { unit: "month", ms: 1000 * 60 * 60 * 24 * 30 },
  { unit: "week", ms: 1000 * 60 * 60 * 24 * 7 },
  { unit: "day", ms: 1000 * 60 * 60 * 24 },
  { unit: "hour", ms: 1000 * 60 * 60 },
  { unit: "minute", ms: 1000 * 60 },
];

/** Locale-aware relative date — "3 days ago", "3일 전" depending on `locale`. */
export function formatRelativeDate(value: string | null, locale: "ko" | "en"): string {
  if (!value) return "";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  const formatter = new Intl.RelativeTimeFormat(locale === "ko" ? "ko" : "en", {
    numeric: "auto",
  });
  const diff = date.getTime() - Date.now();
  const absDiff = Math.abs(diff);
  for (const { unit, ms } of UNITS) {
    if (absDiff >= ms || unit === "minute") {
      return formatter.format(Math.round(diff / ms), unit);
    }
  }
  return formatter.format(0, "second");
}

export function documentStats(
  document: DocumentPayload | null,
  contentOverride?: string,
): {
  lines: number;
  words: number;
  chars: number;
} {
  if (!document) return { lines: 0, words: 0, chars: 0 };
  const content = contentOverride ?? document.content;
  const body = content.replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n?/, "");
  const lines = content.split("\n").length;
  const words = body.split(/\s+/).filter(Boolean).length;
  const chars = content.length;
  return { lines, words, chars };
}

/** Last path segment with a trailing `.md` stripped (other extensions kept). */
export function labelFileStem(fileNameOrRelPath: string): string {
  const base = fileNameOrRelPath.split("/").filter(Boolean).pop() ?? fileNameOrRelPath;
  return base.replace(/\.md$/i, "");
}

export interface ResolvedLabel {
  /** Main text to render. */
  primary: string;
  /** Secondary (muted) text for the "both" mode; null when nothing to add. */
  secondary: string | null;
}

/** Resolve how an item should be labelled given the workspace-wide label mode.
 *  Shared by documents, tasks, calendar events, and meetings so the
 *  `title` / `filename` / `both` setting behaves consistently everywhere. */
export function resolveDisplayLabel(
  title: string,
  fileName: string,
  mode: DocumentLabelMode,
): ResolvedLabel {
  const stem = labelFileStem(fileName);
  const cleanTitle = title.trim();
  if (mode === "filename") {
    return { primary: stem || cleanTitle, secondary: null };
  }
  if (mode === "both") {
    const primary = cleanTitle || stem;
    return { primary, secondary: stem && stem !== primary ? stem : null };
  }
  return { primary: cleanTitle || stem, secondary: null };
}

export function documentDisplayName(
  item: Pick<DocumentPayload | VaultEntry, "title" | "relPath">,
  mode: DocumentLabelMode,
): string {
  return resolveDisplayLabel(item.title, item.relPath, mode).primary;
}

/** Minimal markdown-to-HTML preview. Phase 1 swaps in BlockNote so we don't
 *  bake a real renderer here. */
export function markdownPreview(markdown: string): string {
  const body = markdown.replace(/^---[\s\S]*?---\n/, "").trim();
  const escaped = body
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
  return escaped
    .replace(/^### (.+)$/gm, "<h3>$1</h3>")
    .replace(/^## (.+)$/gm, "<h2>$1</h2>")
    .replace(/^# (.+)$/gm, "<h1>$1</h1>")
    .replace(/^- \[ \] (.+)$/gm, '<p class="task-line"><span></span>$1</p>')
    .replace(/^- (.+)$/gm, '<p class="bullet-line">$1</p>')
    .replace(/^○ (.+)$/gm, '<p class="circle-line">$1</p>')
    .replace(/\*\*(.+?)\*\*/g, "<strong>$1</strong>")
    .replace(/\[\[([^\]]+)\]\]/g, '<a class="wikilink" href="#">$1</a>')
    .replace(/`([^`]+)`/g, "<code>$1</code>")
    .replace(/\n{2,}/g, "</p><p>")
    .replace(/^(?!<h|<p|<table)(.+)$/gm, "<p>$1</p>");
}
