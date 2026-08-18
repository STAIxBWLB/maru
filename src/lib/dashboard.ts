// Maru Dashboard — pure view-model helpers for the dashboard pane. Everything
// here is sync and unit-testable; Tauri calls live in
// src/components/dashboard/useDashboardData.ts.

import type { AgentBoard } from "./agents";
import type { CatalogItemKind, CatalogScanReport } from "./catalog";
import type { DailyPlanV1 } from "./today";
import {
  filterTasksByQuery,
  tasksToCalendarEvents,
  type TaskCalendarEvent,
  type TaskEntry,
  type TaskFilters,
} from "./tasks";
import type {
  DraftEntry,
  DraftStatus,
  GitStatus,
  InboxDropItem,
  InboxEntry,
  VaultEntry,
} from "./types";

/** Only the views something can actually navigate to. "schedule" and "inbox"
 *  were declared and rendered but nothing ever set them: both widgets deep-link
 *  into their owning mode instead, so those two drilldowns were unreachable. */
export type DashboardView = "overview" | "tasks" | "catalog" | "recents";

export type DashboardTaskFilter =
  | "today"
  | "overdue"
  | "scheduled"
  | "backlog"
  | "done";

export const DASHBOARD_TASK_FILTERS: readonly DashboardTaskFilter[] = [
  "today",
  "overdue",
  "scheduled",
  "backlog",
  "done",
];

export interface DashboardCountChip<T extends string> {
  key: T;
  count: number;
}

const TASK_FILTER_TO_QUERY: Record<DashboardTaskFilter, (today: string) => TaskFilters> = {
  today: (today) => ({ due: "today", today }),
  overdue: (today) => ({ due: "overdue", today }),
  scheduled: () => ({ due: "scheduled" }),
  backlog: () => ({ buckets: ["backlog"] }),
  done: () => ({ statuses: ["done", "cancelled"] }),
};

/** Task rows for a dashboard chip/drilldown filter, reusing the shared
 *  task query pipeline instead of re-implementing the predicates. */
export function filterTasksForDashboard(
  entries: TaskEntry[],
  filter: DashboardTaskFilter,
  today: string,
): TaskEntry[] {
  return filterTasksByQuery(entries, "", TASK_FILTER_TO_QUERY[filter](today));
}

// === Today plan ===

export interface PlanLaneCounts {
  top: number;
  flexible: number;
  overflow: number;
}

export function planLaneCounts(plan: DailyPlanV1 | null | undefined): PlanLaneCounts {
  return {
    top: plan?.top.length ?? 0,
    flexible: plan?.flexible.length ?? 0,
    overflow: plan?.overflow.length ?? 0,
  };
}

/** Titles of the Top lane, in plan order. Task refs resolve against the
 *  scanned task entries (taskId or relPath); everything falls back to the
 *  item outcome and then the raw ref id. */
export function planTopTitles(
  plan: DailyPlanV1 | null | undefined,
  entries: TaskEntry[],
  limit = 3,
): string[] {
  if (!plan) return [];
  const titlesByRef = new Map<string, string>();
  for (const entry of entries) {
    if (entry.taskId) titlesByRef.set(entry.taskId, entry.title);
    titlesByRef.set(entry.relPath, entry.title);
  }
  return [...plan.top]
    .sort((a, b) => a.order - b.order)
    .slice(0, limit)
    .map((item) => {
      const refId = item.itemRef.kind === "task" ? item.itemRef.taskId : item.itemRef.captureId;
      return titlesByRef.get(refId) ?? item.outcome ?? refId;
    });
}

/** Local logical day (YYYY-MM-DD) for the dashboard schedule widget: before
 *  `dayStart` (HH:MM) the day still belongs to the previous calendar date. */
export function dashboardLogicalDay(now: Date, dayStart: string): string {
  const [startHour, startMinute] = dayStart.split(":").map((part) => Number.parseInt(part, 10));
  const date = new Date(now);
  const beforeStart =
    Number.isFinite(startHour)
    && (date.getHours() < startHour
      || (date.getHours() === startHour && date.getMinutes() < (startMinute || 0)));
  if (beforeStart) date.setDate(date.getDate() - 1);
  const month = `${date.getMonth() + 1}`.padStart(2, "0");
  const day = `${date.getDate()}`.padStart(2, "0");
  return `${date.getFullYear()}-${month}-${day}`;
}

// === Catalog ===

/** `inbox-pending` and `task-due` are deliberately absent: the inbox widget and
 *  the task chips next to these already carry those counts, from the sources
 *  that own them. The catalog scan is a snapshot, so keeping them here meant two
 *  numbers for one thing that could disagree on screen. */
export const DASHBOARD_CATALOG_KINDS: readonly CatalogItemKind[] = [
  "deadline-due",
  "approval-in-flight",
  "evidence-unlinked",
];

/** Ordered chip view-models for the catalog widget; kinds with zero hits are
 *  kept so the chip row has a stable shape. */
export function catalogKindChips(
  report: CatalogScanReport | null | undefined,
): DashboardCountChip<CatalogItemKind>[] {
  return DASHBOARD_CATALOG_KINDS.map((kind) => ({
    key: kind,
    count: report?.by_kind[kind] ?? 0,
  }));
}

// === Drafts ===

export const DASHBOARD_DRAFT_STATUSES: readonly DraftStatus[] = [
  "new",
  "in-review",
  "accepted",
  "discarded",
];

export function draftStatusCounts(
  drafts: DraftEntry[] | null | undefined,
): DashboardCountChip<DraftStatus>[] {
  const counts = new Map<DraftStatus, number>();
  for (const draft of drafts ?? []) {
    counts.set(draft.status, (counts.get(draft.status) ?? 0) + 1);
  }
  return DASHBOARD_DRAFT_STATUSES.map((status) => ({
    key: status,
    count: counts.get(status) ?? 0,
  }));
}

// === Inbox ===

export interface InboxSummaryItem {
  id: string;
  title: string;
  receivedAt: string | null;
}

export interface InboxSummary {
  pendingCount: number;
  latest: InboxSummaryItem[];
}

export function inboxSummary(
  dropItems: InboxDropItem[] | null | undefined,
  entries: InboxEntry[] | null | undefined,
  limit = 5,
): InboxSummary {
  const pendingEntries = (entries ?? []).filter(
    (entry) => entry.kind === "pendingItem" || entry.status === "pending",
  );
  const latest: InboxSummaryItem[] = [
    ...(dropItems ?? []).map((item) => ({
      id: item.id,
      title: item.title,
      receivedAt: item.receivedAt,
    })),
    ...pendingEntries.map((entry) => ({
      id: entry.id,
      title: entry.title,
      receivedAt: entry.receivedAt,
    })),
  ]
    .sort((a, b) => (b.receivedAt ?? "").localeCompare(a.receivedAt ?? ""))
    .slice(0, limit);
  return {
    pendingCount: (dropItems ?? []).length + pendingEntries.length,
    latest,
  };
}

// === Agents ===

export interface AgentBoardSummary {
  agents: number;
  running: number;
  scheduled: number;
  nextRunAt: string | null;
}

export function agentBoardSummary(board: AgentBoard): AgentBoardSummary {
  const allSchedules = [
    ...board.rows.flatMap((row) => row.schedules),
    ...board.orphans,
  ];
  const enabled = allSchedules.filter((schedule) => schedule.enabled);
  const nextRunAt = enabled
    .map((schedule) => schedule.nextRunAt)
    .filter((value): value is string => Boolean(value))
    .sort((a, b) => Date.parse(a) - Date.parse(b))[0] ?? null;
  return {
    agents: board.rows.length,
    running: board.rows.filter((row) => row.status === "running").length,
    scheduled: enabled.length,
    nextRunAt,
  };
}

// === Git ===

export interface GitSummary {
  isRepo: boolean;
  branch: string | null;
  modified: number;
  staged: number;
  untracked: number;
  clean: boolean;
  total: number;
}

export function gitSummary(status: GitStatus | null | undefined): GitSummary {
  const modified = status?.modified ?? 0;
  const staged = status?.staged ?? 0;
  const untracked = status?.untracked ?? 0;
  return {
    isRepo: status?.isRepo ?? false,
    branch: status?.branch ?? null,
    modified,
    staged,
    untracked,
    clean: status?.clean ?? true,
    total: modified + staged + untracked,
  };
}

// === Recents ===

export function topRecentEntries(entries: VaultEntry[], limit = 5): VaultEntry[] {
  return entries.slice(0, limit);
}
