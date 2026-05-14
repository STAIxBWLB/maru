import type {
  MissionRecord,
  TaskBucket,
  TaskNoteRow,
  TaskStatus,
} from "./types";

export type TaskPriority = "highest" | "high" | "medium" | "low" | "none";

export interface TaskEntry {
  absPath: string;
  relPath: string;
  fileName: string;
  bucket: TaskBucket;
  title: string;
  status: TaskStatus;
  priority: TaskPriority;
  project: string | null;
  topics: string[];
  due: string | null;
  calendarStart: string | null;
  calendarEnd: string | null;
  size: number;
  modifiedAt: string | null;
  frontmatter: Record<string, unknown>;
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
  const title =
    scalarString(fm.title)
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
    project: scalarString(fm.project),
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
  };
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
    if (projects && !projects.has((entry.project ?? "").toLowerCase())) return false;
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
  return groupBy(entries, (entry) => entry.project ?? "No project");
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
  const origin = (metadata as Record<string, unknown>).origin;
  return typeof origin === "string" && origin.startsWith("taskManagement");
}

export function normalizeTaskStatus(value: unknown, bucket: TaskBucket = "active"): TaskStatus {
  const text = scalarString(value)?.toLowerCase().replace(/_/g, "-");
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
