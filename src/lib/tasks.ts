import type {
  MissionRecord,
  ProjectPickerEntry,
  TaskBucket,
  TaskNoteRow,
  TaskStatus,
} from "./types";
import type { TasksSettings } from "./settings";
import { resolveTaskProjects } from "./taskProjectLabels";

export type TaskPriority = "highest" | "high" | "medium" | "low" | "none";

export type TaskSyncStatus = "local" | "syncing" | "synced" | "retryNeeded" | "authBlocked";

export interface TaskEntry {
  absPath: string;
  relPath: string;
  fileName: string;
  bucket: TaskBucket;
  title: string;
  status: TaskStatus;
  priority: TaskPriority;
  project: string | null;
  projects: string[];
  projectKeys: string[];
  projectLabels: string[];
  topics: string[];
  due: string | null;
  calendarStart: string | null;
  calendarEnd: string | null;
  size: number;
  modifiedAt: string | null;
  frontmatter: Record<string, unknown>;
  taskId?: string;
  /** Canonical completion date (YYYY-MM-DD). */
  done?: string;
  /** RFC3339 completion timestamp (aliases normalized by the Rust scanner). */
  completedAt?: string;
  estimateMinutes?: number;
  progress?: number;
  deferDate?: string;
  googleTaskId?: string;
  googleTaskListId?: string;
  calendarEventId?: string;
  syncStatus?: TaskSyncStatus;
}

export interface TaskFilters {
  statuses?: readonly TaskStatus[];
  buckets?: readonly TaskBucket[];
  projects?: readonly string[];
  priorities?: readonly TaskPriority[];
  due?: "today" | "overdue" | "scheduled" | "unscheduled" | null;
  today?: string;
}

export type TaskScheduleFilterView =
  | "scheduled"
  | "today"
  | "overdue"
  | "unscheduled"
  | "backlog"
  | "done";

export interface TaskFilterCounts {
  scheduled: number;
  today: number;
  overdue: number;
  unscheduled: number;
  backlog: number;
  done: number;
}

export interface TaskCalendarEvent {
  id: string;
  title: string;
  start: Date;
  end: Date;
  allDay: boolean;
  resource: TaskEntry;
}

export function rowsToTaskEntries(rows: TaskNoteRow[]): TaskEntry[] {
  return rows.map(rowToTaskEntry).sort(compareTasks);
}

export function rowToTaskEntry(row: TaskNoteRow): TaskEntry {
  const fm = row.frontmatter ?? {};
  const projects = scalarString(fm.project)
    ? [scalarString(fm.project)!]
    : scalarStringList(fm.projects);
  const resolvedProjects = resolveTaskProjects(projects);
  const title =
    scalarString(row.displayTitle)
    ?? scalarString(fm.title)
    ?? scalarString(fm.name)
    ?? row.fileName.replace(/\.md$/i, "");
  return {
    absPath: row.path,
    relPath: row.relPath,
    fileName: row.fileName,
    bucket: row.bucket,
    title,
    status: normalizeTaskStatus(fm.status, row.bucket),
    priority: normalizeTaskPriority(fm.priority),
    project: projects[0] ?? null,
    projects,
    projectKeys: resolvedProjects.map((project) => project.key),
    projectLabels: resolvedProjects.map((project) => project.label),
    topics: scalarStringList(fm.topics).concat(scalarStringList(fm.tags)),
    due: normalizeDateLike(fm.due) ?? normalizeDateLike(fm.date),
    calendarStart:
      normalizeDateTimeLike(fm.calendarStart)
      ?? normalizeDateTimeLike(fm.calendar_start)
      ?? normalizeDateTimeLike(fm.start),
    calendarEnd:
      normalizeDateTimeLike(fm.calendarEnd)
      ?? normalizeDateTimeLike(fm.calendar_end)
      ?? normalizeDateTimeLike(fm.end),
    size: row.sizeBytes,
    modifiedAt: row.updatedAt,
    frontmatter: fm,
    ...todayTaskFields(fm),
  };
}

export function resolveTaskEntryProjects(
  entries: readonly TaskEntry[],
  projects: readonly ProjectPickerEntry[],
): TaskEntry[] {
  return entries.map((entry) => {
    const resolved = resolveTaskProjects(entry.projects, projects);
    return {
      ...entry,
      projectKeys: resolved.map((project) => project.key),
      projectLabels: resolved.map((project) => project.label),
    };
  });
}

/** Optional Today-integration fields carried on task frontmatter. Only set
 *  when the data is present — completion dates are never invented. */
function todayTaskFields(fm: Record<string, unknown>): Pick<
  TaskEntry,
  | "taskId"
  | "done"
  | "completedAt"
  | "estimateMinutes"
  | "progress"
  | "deferDate"
  | "googleTaskId"
  | "googleTaskListId"
  | "calendarEventId"
  | "syncStatus"
> {
  const fields: ReturnType<typeof todayTaskFields> = {};
  const taskId = scalarString(fm.taskId);
  if (taskId) fields.taskId = taskId;
  const done = normalizeDateLike(fm.done);
  if (done) fields.done = done;
  const completedAt = scalarString(fm.completedAt);
  if (completedAt) fields.completedAt = completedAt;
  const estimateMinutes = positiveInteger(fm.estimateMinutes);
  if (estimateMinutes !== null) fields.estimateMinutes = estimateMinutes;
  const progress = positiveInteger(fm.progress);
  if (progress !== null && progress <= 100) fields.progress = progress;
  const deferDate = normalizeDateLike(fm.deferDate);
  if (deferDate) fields.deferDate = deferDate;
  const googleTaskId = scalarString(fm.googleTaskId);
  if (googleTaskId) fields.googleTaskId = googleTaskId;
  const googleTaskListId = scalarString(fm.googleTaskListId);
  if (googleTaskListId) fields.googleTaskListId = googleTaskListId;
  const calendarEventId = scalarString(fm.calendarEventId);
  if (calendarEventId) fields.calendarEventId = calendarEventId;
  const syncStatus = normalizeTaskSyncStatus(fm.syncStatus);
  if (syncStatus) fields.syncStatus = syncStatus;
  return fields;
}

function positiveInteger(value: unknown): number | null {
  const number = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(number) || number < 0) return null;
  return Math.floor(number);
}

function normalizeTaskSyncStatus(value: unknown): TaskSyncStatus | null {
  const text = scalarString(value);
  return text === "local"
      || text === "syncing"
      || text === "synced"
      || text === "retryNeeded"
      || text === "authBlocked"
    ? text
    : null;
}

export function filterTasksByQuery(
  entries: TaskEntry[],
  query: string,
  filters: TaskFilters = {},
): TaskEntry[] {
  const q = query.trim().toLowerCase();
  const statuses = setOrNull(filters.statuses);
  const buckets = setOrNull(filters.buckets);
  const projects = setOrNull(filters.projects?.map((item) => item.toLowerCase()));
  const priorities = setOrNull(filters.priorities);
  const today = filters.today ?? todayIso();
  return entries.filter((entry) => {
    if (statuses && !statuses.has(entry.status)) return false;
    if (buckets && !buckets.has(entry.bucket)) return false;
    if (
      projects
      && !entry.projects.some((project) => projects.has(project.toLowerCase()))
      && !entry.projectKeys.some((project) => projects.has(project.toLowerCase()))
    ) {
      return false;
    }
    if (priorities && !priorities.has(entry.priority)) return false;
    if (filters.due === "today" && scheduledDate(entry) !== today) return false;
    if (filters.due === "overdue" && !isOverdue(entry, today)) return false;
    if (filters.due === "scheduled" && !entry.due && !entry.calendarStart) return false;
    if (filters.due === "unscheduled" && (entry.due || entry.calendarStart)) return false;
    if (!q) return true;
    return [
      entry.title,
      entry.status,
      entry.priority,
      entry.project,
      entry.projects.join(" "),
      entry.projectLabels.join(" "),
      entry.topics.join(" "),
      entry.due,
      entry.relPath,
      entry.fileName,
    ]
      .filter(Boolean)
      .join(" ")
      .toLowerCase()
      .includes(q);
  });
}

export function tasksToCalendarEvents(entries: TaskEntry[]): TaskCalendarEvent[] {
  return entries
    .filter((entry) => entry.due || entry.calendarStart)
    .flatMap((entry) => {
      if (entry.calendarStart) {
        const start = new Date(entry.calendarStart);
        if (Number.isNaN(start.getTime())) return [];
        const end = entry.calendarEnd ? new Date(entry.calendarEnd) : addHours(start, 1);
        const safeEnd = Number.isNaN(end.getTime()) || end <= start ? addHours(start, 1) : end;
        return {
          id: entry.relPath,
          title: entry.title,
          start,
          end: safeEnd,
          allDay: false,
          resource: entry,
        };
      }
      const due = entry.due ?? entry.calendarStart?.slice(0, 10) ?? "1970-01-01";
      const start = new Date(`${due}T00:00:00`);
      if (Number.isNaN(start.getTime())) return [];
      const end = new Date(start);
      end.setDate(start.getDate() + 1);
      return {
        id: entry.relPath,
        title: entry.title,
        start,
        end,
        allDay: true,
        resource: entry,
      };
    });
}

export function taskFilterCounts(
  entries: TaskEntry[],
  today: string = todayIso(),
): TaskFilterCounts {
  return entries.reduce<TaskFilterCounts>(
    (counts, entry) => {
      if (entry.bucket === "backlog" || entry.status === "backlog") {
        counts.backlog += 1;
        return counts;
      }
      if (entry.bucket === "archive" || entry.status === "done" || entry.status === "cancelled") {
        counts.done += 1;
        return counts;
      }
      if (!isActionableTask(entry)) return counts;

      if (entry.due || entry.calendarStart) {
        counts.scheduled += 1;
      } else {
        counts.unscheduled += 1;
      }
      if (scheduledDate(entry) === today) counts.today += 1;
      if (isOverdue(entry, today)) counts.overdue += 1;
      return counts;
    },
    {
      scheduled: 0,
      today: 0,
      overdue: 0,
      unscheduled: 0,
      backlog: 0,
      done: 0,
    },
  );
}

export function selectVisibleTask(
  entries: TaskEntry[],
  selectedRelPath: string | null,
): TaskEntry | null {
  return entries.find((entry) => entry.relPath === selectedRelPath) ?? entries[0] ?? null;
}

export function groupTasksByStatus(entries: TaskEntry[]): Map<TaskStatus, TaskEntry[]> {
  return groupBy(entries, (entry) => entry.status);
}

export function groupTasksByProject(entries: TaskEntry[]): Map<string, TaskEntry[]> {
  return groupBy(entries, (entry) => entry.projectLabels[0] ?? "No project");
}

export function isOverdue(entry: TaskEntry, today: string = todayIso()): boolean {
  const date = scheduledDate(entry);
  if (!date) return false;
  if (entry.status === "done" || entry.status === "cancelled") return false;
  return date < today;
}

export function activeTasksMissions(missions: MissionRecord[]): MissionRecord[] {
  return missions.filter(isTasksMission).sort(compareMissions);
}

export function isTasksMission(mission: MissionRecord): boolean {
  const metadata = mission.metadata;
  if (!metadata || typeof metadata !== "object" || Array.isArray(metadata)) return false;
  const record = metadata as Record<string, unknown>;
  const origin = record.origin;
  if (typeof origin === "string" && origin.startsWith("taskManagement")) return true;
  const skillName = record.skillName;
  return origin === "skillCompose" && typeof skillName === "string" && skillName === "task-management";
}

export function buildTaskManagementSchedulePrompt(
  rawText: string,
  settings: Pick<
    TasksSettings,
    "root" | "timezone" | "defaultTaskList" | "defaultCalendar"
  >,
  parsedStart?: string | null,
): string {
  const root = settings.root?.trim() || "tasks";
  const timezone = settings.timezone?.trim() || "Asia/Seoul";
  const defaultTaskList = settings.defaultTaskList?.trim() || "(workspace default)";
  const defaultCalendar = settings.defaultCalendar?.trim() || "(workspace default)";
  return [
    "Use the task-management skill to register the following unstructured schedule text.",
    "",
    "Runtime and source-of-truth rules:",
    "- Load workspace.config.yaml and its task_management section before writing.",
    `- Keep markdown task files as the local source of truth under ${root}.`,
    "- Create an actionable task note under active/ when there is follow-up work.",
    "- Create a calendar-only markdown receipt under calendar/ when this is only a schedule item.",
    "- Normalize title, status, priority, due, calendarStart, calendarEnd, timezone, project, tags, and body.",
    `- Use timezone ${timezone} unless the text states another timezone.`,
    ...(parsedStart
      ? [
          `- Maru's Korean date parser already resolved the schedule to ${parsedStart} (RFC3339). Treat it as authoritative for due/calendarStart unless the raw text clearly contradicts it.`,
        ]
      : []),
    `- Use default Google Tasks list ${defaultTaskList} for read-only conflict lookup during review; create/update/delete only after user approval through task-management's execution path.`,
    `- Use default calendar ${defaultCalendar} for read-only availability/conflict lookup during review; create/update/delete only after user approval through task-management's execution path.`,
    "- Maru itself must not call Google APIs; the skill may perform read-only Google Tasks/Calendar lookup in review mode.",
    "- Do not write directly to any vault; create only a local vault-promotion proposal if needed.",
    "- Before dispatching writes, show the proposed markdown path and frontmatter.",
    "",
    ...taskManagementRunContract(),
    "",
    "Raw schedule text:",
    '"""',
    rawText.trim(),
    '"""',
  ].join("\n");
}

/**
 * Shared Maru run contract injected into tracked task-management prompts so a
 * run reliably emits the `maru_skill_proposal_v1` + `maru_task_review_v1`
 * blocks the review panel parses (mirrors meeting-notes' run contract).
 */
export function taskManagementRunContract(): string[] {
  return [
    "Maru run contract (background/review mode — proposals only):",
    "- Do not write files or mutate Google Tasks/Calendar during this run; emit proposals only.",
    "- Read-only Google Tasks/Calendar lookup is allowed for conflict checks, existing ID reconciliation, and sync preview quality.",
    "- All Google create/update/delete operations happen only after user approval through task-management's approved execution path.",
    "- Prefix progress logs with phase markers: [phase:source], [phase:normalize], [phase:draft], [phase:proposal], [phase:review].",
    "- Final output must include exactly one JSON object with schemaVersion \"maru_skill_proposal_v1\" (the local markdown file writes).",
    "- Final output must include exactly one JSON object with schemaVersion \"maru_task_review_v1\".",
    "- The review JSON must include summary, taskDetails, fields, schedule, conflicts, uncertainties, and followups.",
    "- Followups may include only vault-extract, vault-connect, and meeting-notes.",
  ];
}

export function buildTaskManagementSyncPrompt(
  target: string,
  settings: Pick<TasksSettings, "root" | "timezone" | "defaultTaskList" | "defaultCalendar">,
): string {
  const root = settings.root?.trim() || "tasks";
  const timezone = settings.timezone?.trim() || "Asia/Seoul";
  const defaultTaskList = settings.defaultTaskList?.trim() || "(workspace default)";
  const defaultCalendar = settings.defaultCalendar?.trim() || "(workspace default)";
  return [
    `Sync local markdown tasks under ${root} with the configured task-management workflow for ${target}.`,
    "",
    "Runtime and source-of-truth rules:",
    "- Load workspace.config.yaml and its task_management section before proposing changes.",
    `- Keep markdown task files as the local source of truth under ${root}.`,
    "- In review mode, propose ONLY local frontmatter ID/schedule updates (googleTaskId, googleTaskListId, calendarId, calendarEventId, calendarStart, calendarEnd, timezone) as replace operations on existing task files.",
    "- Do not add create-only backref fields in a sync proposal.",
    `- Use timezone ${timezone} unless a task states another timezone.`,
    `- Reconcile against Google Tasks list ${defaultTaskList} and calendar ${defaultCalendar} with read-only lookup during review.`,
    "- Maru itself must not call Google APIs; in the review summary, name which Google Tasks/Calendar mutations will run only after approval.",
    "",
    ...taskManagementRunContract(),
  ].join("\n");
}

export function normalizeTaskStatus(value: unknown, bucket: TaskBucket = "active"): TaskStatus {
  const text = scalarString(value)?.toLowerCase().replace(/_/g, "-");
  // `open` is the legacy pre-canonical alias for active tasks.
  if (text === "open") return "active";
  if (
    text === "active"
    || text === "in-progress"
    || text === "done"
    || text === "cancelled"
    || text === "backlog"
  ) {
    return text;
  }
  return bucket === "backlog" ? "backlog" : bucket === "archive" ? "done" : "active";
}

export function normalizeTaskPriority(value: unknown): TaskPriority {
  const text = scalarString(value)?.toLowerCase().replace(/_/g, "-");
  if (text === "highest" || text === "urgent" || text === "p0") return "highest";
  if (text === "high" || text === "p1") return "high";
  if (text === "medium" || text === "normal" || text === "p2") return "medium";
  if (text === "low" || text === "p3") return "low";
  return "none";
}

function groupBy<K extends string>(entries: TaskEntry[], keyFn: (entry: TaskEntry) => K): Map<K, TaskEntry[]> {
  const grouped = new Map<K, TaskEntry[]>();
  for (const entry of entries) {
    const key = keyFn(entry);
    const group = grouped.get(key) ?? [];
    group.push(entry);
    grouped.set(key, group);
  }
  return grouped;
}

function scalarString(value: unknown): string | null {
  if (typeof value === "string" && value.trim()) return value.trim();
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  return null;
}

function scalarStringList(value: unknown): string[] {
  if (Array.isArray(value)) {
    return value
      .map(scalarString)
      .filter((item): item is string => item !== null);
  }
  const text = scalarString(value);
  return text ? text.split(",").map((item) => item.trim()).filter(Boolean) : [];
}

function normalizeDateLike(value: unknown): string | null {
  const text = scalarString(value);
  if (!text) return null;
  const match = text.match(/^(\d{4}-\d{2}-\d{2})/);
  return match ? match[1] : null;
}

function normalizeDateTimeLike(value: unknown): string | null {
  const text = scalarString(value);
  if (!text) return null;
  const date = new Date(text);
  return Number.isNaN(date.getTime()) ? null : text;
}

function scheduledDate(entry: TaskEntry): string | null {
  return entry.due ?? entry.calendarStart?.slice(0, 10) ?? null;
}

function isActionableTask(entry: TaskEntry): boolean {
  return (
    entry.bucket !== "archive"
    && entry.bucket !== "backlog"
    && entry.status !== "done"
    && entry.status !== "cancelled"
    && entry.status !== "backlog"
  );
}

function setOrNull<T>(values: readonly T[] | undefined): Set<T> | null {
  if (!values || values.length === 0) return null;
  return new Set(values);
}

function addHours(date: Date, hours: number): Date {
  const next = new Date(date);
  next.setHours(next.getHours() + hours);
  return next;
}

function compareTasks(a: TaskEntry, b: TaskEntry): number {
  const dueCompare = (a.due ?? "9999-99-99").localeCompare(b.due ?? "9999-99-99");
  return dueCompare || a.title.localeCompare(b.title) || a.relPath.localeCompare(b.relPath);
}

function compareMissions(a: MissionRecord, b: MissionRecord): number {
  return b.lastOutputAt.localeCompare(a.lastOutputAt) || b.startedAt.localeCompare(a.startedAt);
}

function todayIso(): string {
  return new Date().toISOString().slice(0, 10);
}
