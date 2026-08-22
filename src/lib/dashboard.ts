// Maru Dashboard — pure view-model helpers for the dashboard pane. Everything
// here is sync and unit-testable; Tauri calls live in
// src/components/dashboard/useDashboardData.ts.

import type { AgentBoard, AgentRunStatus } from "./agents";
import type { CatalogItemKind, CatalogScanReport } from "./catalog";
import { countInboxEntryIntakeModes } from "./inbox";
import { resolveTaskProjects } from "./taskProjectLabels";
import type { DailyPlanV1, TodaySnapshot } from "./today";
import {
  filterTasksByQuery,
  isOverdue,
  type TaskEntry,
  type TaskFilters,
} from "./tasks";
import type {
  DraftEntry,
  DraftStatus,
  GitStatus,
  InboxDropItem,
  InboxEntry,
  ProjectActivityRow,
  ProjectPickerEntry,
  VaultEntry,
} from "./types";

/** Only the views something can actually navigate to. "schedule" and "inbox"
 *  were declared and rendered but nothing ever set them: both widgets deep-link
 *  into their owning mode instead, so those two drilldowns were unreachable. */
export type DashboardView = "overview" | "tasks" | "catalog" | "recents" | "projects";

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

/** The pressure signals the snapshot already carries and the lanes line does
 *  not answer: how much was pushed forward, whether the day is over budget, and
 *  whether the plan is still unconfirmed. The live workspace runs three-digit
 *  carryover counts, so this is a number the card can show, never a list it
 *  could render. */
export interface TodayPressure {
  carryovers: number;
  freeMinutes: number | null;
  busyMinutes: number | null;
  overCapacity: boolean;
  unconfirmed: boolean;
  staleSources: number;
}

export function todayPressure(snapshot: TodaySnapshot | null | undefined): TodayPressure {
  const capacity = snapshot?.capacity ?? null;
  return {
    carryovers: snapshot?.carryovers?.length ?? 0,
    freeMinutes: capacity?.freeMinutes ?? null,
    busyMinutes: capacity?.busyMinutes ?? null,
    overCapacity: capacity?.overCapacity ?? false,
    unconfirmed: snapshot?.unconfirmedContent ?? false,
    staleSources: (snapshot?.sources ?? []).filter((source) => source.stale).length,
  };
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

/** Non-zero status counts for the agents tile, in attention order. "Running N"
 *  alone hid failures behind an otherwise-quiet tile. Statuses with no agents
 *  are dropped so the tile does not grow a row of zeros. */
const AGENT_STATUS_ORDER: readonly AgentRunStatus[] = [
  "running",
  "failed",
  "idle",
  "stopped",
  "done",
  "never",
];

export function agentStatusTiers(
  board: AgentBoard | null | undefined,
): DashboardCountChip<AgentRunStatus>[] {
  const counts = new Map<AgentRunStatus, number>();
  for (const row of board?.rows ?? []) {
    counts.set(row.status, (counts.get(row.status) ?? 0) + 1);
  }
  return AGENT_STATUS_ORDER.filter((status) => (counts.get(status) ?? 0) > 0).map((status) => ({
    key: status,
    count: counts.get(status) ?? 0,
  }));
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

/** Auto vs hand-staged split for the pending queue. The widget's own count
 *  merges drop files with pending entries, which is the right total but hides
 *  which half needs a human. Counted over the same entries the card lists. */
export interface InboxIntakeCounts {
  auto: number;
  manual: number;
}

export function inboxIntakeCounts(
  entries: InboxEntry[] | null | undefined,
): InboxIntakeCounts {
  const counts = countInboxEntryIntakeModes(entries ?? []);
  return { auto: counts.get("auto") ?? 0, manual: counts.get("manual") ?? 0 };
}

// === Projects ===

/** A project has gone quiet after this many days with no file touched under it. */
const PROJECT_STALE_DAYS = 14;

export interface ProjectPortfolioRow {
  id: string;
  name: string;
  /** Workspace-relative project path, as registered. */
  path: string;
  /** Derived from the path: the registry has no category field. */
  category: string;
  /** Registry id of the nearest ancestor project, or null for a top-level one. */
  parentId: string | null;
  openTasks: number;
  overdueTasks: number;
  lastMeetingDay: string | null;
  lastActivityAt: string | null;
  stale: boolean;
}

export interface ProjectPortfolio {
  /** Top-level rows with sub-project work folded in — the card and the badge. */
  rows: ProjectPortfolioRow[];
  /** Every registered project, unfolded — the drilldown, same unit as the picker. */
  allRows: ProjectPortfolioRow[];
  /** Rows that want a human, already sorted. */
  attention: ProjectPortfolioRow[];
  attentionCount: number;
  /** Open tasks that resolved to no registry project, so the totals stay honest. */
  unassignedOpenTasks: number;
  categories: DashboardCountChip<string>[];
}

/** `projects/oda/koica-tiu` → `oda`; `admin/depts/ai` → `admin`. The registry
 *  groups by path prefix and carries no category field, so this is a parse.
 *  Rendered as raw data (like a branch name), never translated. */
export function projectCategory(path: string): string {
  const segments = path.split("/").filter(Boolean);
  if (segments.length === 0) return "";
  if (segments[0] === "projects") return segments[1] ?? "projects";
  return segments[0];
}

function normalizedPath(path: string): string {
  return path.replace(/\\/g, "/").replace(/^\/+|\/+$/g, "");
}

/** Nearest registered ancestor by path, so sub-projects fold into the unit the
 *  user thinks in ("RISE") while the drilldown can still show them apart. */
function parentOf(
  project: ProjectPickerEntry,
  projects: readonly ProjectPickerEntry[],
): string | null {
  const own = normalizedPath(project.path);
  let best: { id: string; length: number } | null = null;
  for (const candidate of projects) {
    if (candidate.id === project.id) continue;
    const other = normalizedPath(candidate.path);
    if (!other || !own.startsWith(`${other}/`)) continue;
    if (!best || other.length > best.length) best = { id: candidate.id, length: other.length };
  }
  return best?.id ?? null;
}

function isOpenTask(entry: TaskEntry): boolean {
  if (entry.bucket !== "active" && entry.bucket !== "calendar") return false;
  return entry.status !== "done" && entry.status !== "cancelled";
}

function registryHits(
  raw: readonly string[],
  projects: readonly ProjectPickerEntry[],
): string[] {
  return resolveTaskProjects(raw, projects)
    .map((project) => project.key)
    .filter((key) => key.startsWith("registry:"));
}

/** Registry keys for a task, falling back to `contexts` when `projects` is
 *  empty — common in this workspace. Only registry hits count: free-text
 *  contexts must not invent a project.
 *
 *  Resolves from the raw frontmatter rather than reading `entry.projectKeys`:
 *  that field is only populated where something already ran the resolver, and
 *  the dashboard's task rows arrive unresolved. Resolving is idempotent, so
 *  pre-resolved entries land on the same keys. */
function registryKeysFor(
  entry: TaskEntry,
  projects: readonly ProjectPickerEntry[],
): string[] {
  const direct = registryHits(entry.projects, projects);
  if (direct.length > 0) return direct;
  const contexts = Array.isArray(entry.frontmatter.contexts)
    ? entry.frontmatter.contexts.filter((value): value is string => typeof value === "string")
    : [];
  if (contexts.length === 0) return [];
  return registryHits(contexts, projects);
}

function daysBetween(fromIso: string, todayIso: string): number | null {
  const from = Date.parse(fromIso);
  const to = Date.parse(`${todayIso}T00:00:00Z`);
  if (Number.isNaN(from) || Number.isNaN(to)) return null;
  return Math.floor((to - from) / 86_400_000);
}

function maxDay(a: string | null, b: string | null): string | null {
  if (!a) return b;
  if (!b) return a;
  return a >= b ? a : b;
}

function compareRows(a: ProjectPortfolioRow, b: ProjectPortfolioRow): number {
  if (a.overdueTasks !== b.overdueTasks) return b.overdueTasks - a.overdueTasks;
  if (a.openTasks !== b.openTasks) return b.openTasks - a.openTasks;
  // Deadest first among equals: never-touched sorts above long-untouched.
  if (a.lastActivityAt !== b.lastActivityAt) {
    if (!a.lastActivityAt) return -1;
    if (!b.lastActivityAt) return 1;
    return a.lastActivityAt < b.lastActivityAt ? -1 : 1;
  }
  return a.name.localeCompare(b.name);
}

function wantsAttention(row: ProjectPortfolioRow): boolean {
  return row.overdueTasks > 0 || (row.openTasks > 0 && row.stale);
}

/** Joins the registry, the activity scan, and the already-fetched task rows
 *  into one per-project view. Task matching reuses the Tasks-mode resolver on
 *  purpose: a second counting path here is how the numbers start disagreeing. */
export function projectPortfolio(
  projects: ProjectPickerEntry[] | null | undefined,
  activity: ProjectActivityRow[] | null | undefined,
  taskEntries: TaskEntry[] | null | undefined,
  today: string,
): ProjectPortfolio {
  const registry = projects ?? [];
  const activityById = new Map((activity ?? []).map((row) => [row.id, row]));

  const open = new Map<string, number>();
  const overdue = new Map<string, number>();
  let unassignedOpenTasks = 0;

  for (const entry of taskEntries ?? []) {
    if (!isOpenTask(entry)) continue;
    const keys = registryKeysFor(entry, registry);
    if (keys.length === 0) {
      unassignedOpenTasks += 1;
      continue;
    }
    const late = isOverdue(entry, today);
    for (const key of keys) {
      const id = key.slice("registry:".length);
      open.set(id, (open.get(id) ?? 0) + 1);
      if (late) overdue.set(id, (overdue.get(id) ?? 0) + 1);
    }
  }

  const allRows: ProjectPortfolioRow[] = registry.map((project) => {
    const found = activityById.get(project.id);
    const lastActivityAt = found?.lastActivityAt ?? null;
    const age = lastActivityAt ? daysBetween(lastActivityAt, today) : null;
    return {
      id: project.id,
      name: project.name,
      path: project.path,
      category: projectCategory(normalizedPath(project.path)),
      parentId: parentOf(project, registry),
      openTasks: open.get(project.id) ?? 0,
      overdueTasks: overdue.get(project.id) ?? 0,
      lastMeetingDay: found?.lastMeetingDay ?? null,
      lastActivityAt,
      stale: age === null || age >= PROJECT_STALE_DAYS,
    };
  });

  // Fold sub-projects into their nearest registered ancestor for the card. The
  // activity scan already attributes nested files to both, so only the counts
  // and the meeting day need rolling up.
  const byId = new Map(allRows.map((row) => [row.id, row]));
  const folded = new Map(allRows.map((row) => [row.id, { ...row }]));
  for (const row of allRows) {
    let parentId = row.parentId;
    while (parentId) {
      const parent = folded.get(parentId);
      if (!parent) break;
      parent.openTasks += row.openTasks;
      parent.overdueTasks += row.overdueTasks;
      parent.lastMeetingDay = maxDay(parent.lastMeetingDay, row.lastMeetingDay);
      parentId = byId.get(parentId)?.parentId ?? null;
    }
  }

  const rows = [...folded.values()].filter((row) => !row.parentId).sort(compareRows);
  const attention = rows.filter(wantsAttention);

  const categoryCounts = new Map<string, number>();
  for (const row of allRows) {
    if (!row.category) continue;
    categoryCounts.set(row.category, (categoryCounts.get(row.category) ?? 0) + 1);
  }

  return {
    rows,
    allRows: [...allRows].sort(compareRows),
    attention,
    attentionCount: attention.length,
    unassignedOpenTasks,
    categories: [...categoryCounts.entries()]
      .map(([key, count]) => ({ key, count }))
      .sort((a, b) => b.count - a.count || a.key.localeCompare(b.key)),
  };
}

// === Recents ===

export function topRecentEntries(entries: VaultEntry[], limit = 5): VaultEntry[] {
  return entries.slice(0, limit);
}
