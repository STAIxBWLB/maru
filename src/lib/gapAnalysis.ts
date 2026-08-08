// Pure helpers for the Gap Analysis pane: diff-row construction, hunk
// filtering, log aggregation, per-day grouping, and the gap-size trend.
// No locale/threading concerns here — components format labels via i18n.

import type {
  GapHunk,
  GapHunkType,
  GapLogEntry,
  GapTypeCounts,
} from "./types";

/** Convert stable backend error codes into localized, user-facing guidance.
 * Unknown errors remain visible to preserve diagnostics for newly introduced
 * or environment-specific failures. */
export function translateGapError(
  message: string,
  translate: (key: string) => string,
): string {
  const keys: Record<string, string> = {
    gap_promoted_doc_missing: "gap.error.promotedDocMissing",
    gap_baseline_missing: "gap.error.baselineMissing",
    gap_not_promoted: "gap.error.notPromoted",
    drafts_relink_not_promoted: "gap.error.relinkNotPromoted",
    drafts_relink_target_missing: "gap.error.relinkTargetMissing",
    drafts_promote_target_required: "gap.error.relinkTargetRequired",
    drafts_promote_target_must_be_relative: "gap.error.relinkTargetRelative",
    drafts_promote_target_managed: "gap.error.relinkTargetManaged",
    drafts_promote_target_must_be_markdown: "gap.error.relinkTargetMarkdown",
    drafts_not_found: "gap.error.draftNotFound",
  };
  const normalized = message.trim();
  const code = normalized.split(":", 1)[0];
  const key = keys[normalized] ?? keys[code];
  if (normalized.startsWith("Document path escapes")) {
    return translate("gap.error.relinkTargetContainment");
  }
  if (normalized.startsWith("Document belongs to registered workspace")) {
    return translate("gap.error.relinkTargetOwner");
  }
  return key ? translate(key) : message;
}

export const GAP_HUNK_TYPES: GapHunkType[] = [
  "external-info",
  "direct-edit",
  "cross-doc-reference",
  "formatting",
];

export function emptyGapTypeCounts(): GapTypeCounts {
  return { externalInfo: 0, directEdit: 0, crossDocReference: 0, formatting: 0 };
}

/** Map a hunk type onto its GapTypeCounts key. */
export function gapTypeCountKey(hunkType: GapHunkType): keyof GapTypeCounts {
  switch (hunkType) {
    case "external-info":
      return "externalInfo";
    case "direct-edit":
      return "directEdit";
    case "cross-doc-reference":
      return "crossDocReference";
    case "formatting":
      return "formatting";
  }
}

/** Non-equal hunks whose type is in the active set pass; equal hunks always
 *  pass (they render collapsed) so the diff keeps its context scaffolding. */
export function filterGapHunks(hunks: GapHunk[], activeTypes: Set<GapHunkType>): GapHunk[] {
  return hunks.filter((hunk) => hunk.op === "equal" || activeTypes.has(hunk.hunkType));
}

/** Unified-diff range label for a hunk, e.g. "@@ -3,4 +3,6 @@". */
export function gapHunkRangeLabel(hunk: GapHunk): string {
  return `@@ -${hunk.oldStart},${hunk.oldLines} +${hunk.newStart},${hunk.newLines} @@`;
}

export interface GapDiffRow {
  kind: " " | "-" | "+";
  /** 1-based line number on the baseline (AI draft) side; null for additions. */
  oldLineNo: number | null;
  /** 1-based line number on the promoted-document side; null for removals. */
  newLineNo: number | null;
  text: string;
}

/** Expand a hunk's diff lines into aligned two-column rows with per-side
 *  line numbers derived from the hunk's 1-based starts. */
export function buildGapDiffRows(hunk: GapHunk): GapDiffRow[] {
  const rows: GapDiffRow[] = [];
  let oldNo = hunk.oldStart;
  let newNo = hunk.newStart;
  for (const line of hunk.lines) {
    if (line.kind === " ") {
      rows.push({ kind: " ", oldLineNo: oldNo, newLineNo: newNo, text: line.text });
      oldNo += 1;
      newNo += 1;
    } else if (line.kind === "-") {
      rows.push({ kind: "-", oldLineNo: oldNo, newLineNo: null, text: line.text });
      oldNo += 1;
    } else {
      rows.push({ kind: "+", oldLineNo: null, newLineNo: newNo, text: line.text });
      newNo += 1;
    }
  }
  return rows;
}

/** Gap size proxy: total churn introduced by the human edit pass. */
export function gapEntrySize(entry: Pick<GapLogEntry, "addedLines" | "removedLines">): number {
  return entry.addedLines + entry.removedLines;
}

/** Sum per-type counts across log entries (for the distribution summary). */
export function aggregateGapTypeCounts(entries: GapLogEntry[]): GapTypeCounts {
  const totals = emptyGapTypeCounts();
  for (const entry of entries) {
    totals.externalInfo += entry.byType.externalInfo;
    totals.directEdit += entry.byType.directEdit;
    totals.crossDocReference += entry.byType.crossDocReference;
    totals.formatting += entry.byType.formatting;
  }
  return totals;
}

export interface GapLogDayGroup {
  /** Local date key, YYYY-MM-DD. */
  day: string;
  entries: GapLogEntry[];
}

/** Group log entries (already newest-first) by local calendar day, keeping
 *  the newest day first and the newest entry first within each day. */
/** Local day key for a log timestamp. Grouping and date filtering must agree
 *  on this, or a filter range silently drops the rows it should keep. */
export function gapLogDayKey(at: string): string {
  const date = new Date(at);
  if (Number.isNaN(date.getTime())) return at.slice(0, 10);
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(
    date.getDate(),
  ).padStart(2, "0")}`;
}

export function groupGapLogByDay(entries: GapLogEntry[]): GapLogDayGroup[] {
  const groups: GapLogDayGroup[] = [];
  const indexByDay = new Map<string, number>();
  for (const entry of entries) {
    const day = gapLogDayKey(entry.at);
    const existing = indexByDay.get(day);
    if (existing === undefined) {
      indexByDay.set(day, groups.length);
      groups.push({ day, entries: [entry] });
    } else {
      groups[existing].entries.push(entry);
    }
  }
  return groups;
}

export type GapTrendDirection = "down" | "up" | "flat";

export interface GapTrendPoint {
  entry: GapLogEntry;
  size: number;
  /** Direction vs. the previous (older) point; null for the oldest point. */
  direction: GapTrendDirection | null;
}

/** Gap-size trend for one document, oldest → newest. Input entries may be in
 *  any order; they are sorted by `at` ascending before comparison. */
export function gapTrend(entries: GapLogEntry[]): GapTrendPoint[] {
  const sorted = [...entries].sort((a, b) => a.at.localeCompare(b.at));
  return sorted.map((entry, index) => {
    const size = gapEntrySize(entry);
    if (index === 0) return { entry, size, direction: null };
    const previous = gapEntrySize(sorted[index - 1]);
    return {
      entry,
      size,
      direction: size < previous ? "down" : size > previous ? "up" : "flat",
    };
  });
}

// === Feedback digest (gap → scheduler prompt loop) ===

export const GAP_FEEDBACK_DEFAULT_MAX_ENTRIES = 20;

const GAP_TYPE_LABELS: Record<keyof GapTypeCounts, string> = {
  externalInfo: "외부 정보 추가",
  directEdit: "직접 수정",
  crossDocReference: "교차 문서 참조",
  formatting: "서식 정리",
};

const GAP_TYPE_HINTS: Record<keyof GapTypeCounts, string> = {
  externalInfo: "초안에 출처·수치·날짜 등 근거 정보를 더 포함할 것",
  directEdit: "초안 문장을 최종 문서 톤에 맞춰 더 다듬어 작성할 것",
  crossDocReference: "관련 문서의 [[위키링크]]를 초안에 미리 포함할 것",
  formatting: "초안의 서식·공백·프론트매터를 최종 문서 형식에 맞출 것",
};

/** Short Korean digest of recent user edit tendencies, appended to extract-
 *  tasks schedule prompts so future drafts need fewer manual edits. Entries
 *  may arrive in any order; the most recent `maxEntries` (by `at`) are used.
 *  Returns an empty string when there is nothing to say. */
export function buildGapFeedbackDigest(
  entries: GapLogEntry[],
  maxEntries: number = GAP_FEEDBACK_DEFAULT_MAX_ENTRIES,
): string {
  if (entries.length === 0) return "";
  const recent = [...entries]
    .sort((a, b) => b.at.localeCompare(a.at))
    .slice(0, Math.max(1, maxEntries));
  const totals = aggregateGapTypeCounts(recent);
  const addedLines = recent.reduce((sum, entry) => sum + entry.addedLines, 0);
  const removedLines = recent.reduce((sum, entry) => sum + entry.removedLines, 0);
  const lines = [
    `최근 초안 ${recent.length}건의 수정 분석: 추가 ${addedLines}줄, 삭제 ${removedLines}줄 `
      + `(외부 정보 ${totals.externalInfo}건, 직접 수정 ${totals.directEdit}건, `
      + `교차 참조 ${totals.crossDocReference}건, 서식 ${totals.formatting}건)`,
  ];
  const keys = Object.keys(totals) as Array<keyof GapTypeCounts>;
  // Stable sort: ties keep the declaration order above.
  const dominant = [...keys].sort((a, b) => totals[b] - totals[a])[0];
  if (totals[dominant] > 0) {
    lines.push(`가장 잦은 수정 유형은 ${GAP_TYPE_LABELS[dominant]}: ${GAP_TYPE_HINTS[dominant]}`);
  }
  return lines.join("\n");
}

/** Delimited prompt section header marking the auto-attached digest. The
 *  extract-tasks skill honors this section when present. The Rust scheduler
 *  attaches the digest at dispatch time via a port of this module in
 *  `src-tauri/src/gap.rs` — the two implementations (header string, Korean
 *  copy, entry cap) must stay in sync; this frontend copy still feeds the
 *  read-only preview in the schedule dialog. */
export const GAP_FEEDBACK_SECTION_HEADER = "## 최근 수정 경향 (자동 첨부)";

/** Append the digest to a schedule prompt under the section header. A prompt
 *  is returned unchanged when the digest is empty. */
export function appendGapFeedbackDigest(prompt: string, digest: string): string {
  if (!digest) return prompt;
  const section = `${GAP_FEEDBACK_SECTION_HEADER}\n\n${digest}`;
  return prompt ? `${prompt}\n\n${section}` : section;
}
