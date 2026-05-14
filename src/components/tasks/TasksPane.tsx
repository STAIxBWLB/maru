import {
  CalendarPlus,
  Calendar,
  CheckCircle2,
  List,
  Loader2,
  Plus,
  RefreshCcw,
  Search,
  Settings,
  WandSparkles,
} from "lucide-react";
import { useCallback, useEffect, useMemo, useState } from "react";
import { format } from "date-fns";
import {
  appendTasksLog,
  createTaskNote,
  readTaskMetadata,
  scanTaskNotes,
  searchCalendarNotes,
  updateTaskScheduleFields,
  updateTaskStatus,
} from "../../lib/api";
import { useTranslation } from "../../lib/i18n";
import type { TasksSettings } from "../../lib/settings";
import type { SkillContextItem, SkillRecord } from "../../lib/skills";
import {
  activeTasksMissions,
  buildTaskManagementSchedulePrompt,
  filterTasksByQuery,
  groupTasksByStatus,
  rowsToTaskEntries,
  selectVisibleTask,
  type TaskEntry,
  type TaskPriority,
} from "../../lib/tasks";
import type {
  CreateTaskDraft,
  MissionRecord,
  TaskMetadata,
  TaskNoteRow,
  TaskSchedulePatch,
  TaskStatus,
} from "../../lib/types";
import { Button } from "../ui/Button";
import { NaturalScheduleDialog } from "./NaturalScheduleDialog";
import { NewTaskDialog } from "./NewTaskDialog";
import { TaskDetailDrawer } from "./TaskDetailDrawer";
import { TasksSidebar, type TasksFilterView } from "./TasksSidebar";
import { UnifiedCalendarView } from "../calendar/UnifiedCalendarView";
import { toUnifiedTaskEvents } from "../../lib/calendar/fromEntries";
import type { CalendarView } from "../../lib/calendar/types";
import { useDebouncedValue } from "../../lib/useDebouncedValue";

interface TasksPaneProps {
  workPath: string | null;
  effectiveSettings: TasksSettings;
  skills: SkillRecord[];
  processingMissions: MissionRecord[];
  processingLogLines: Record<string, string[]>;
  onRefreshMissions: () => void;
  onOpenSettings: () => void;
  onOpenSkillCompose: (
    skill: SkillRecord | null,
    context: SkillContextItem[],
    prompt?: string,
    cwd?: string | null,
  ) => void;
  onRevealPath?: (path: string) => void;
  onError: (message: string | null) => void;
}

type TasksDisplayView = "month" | "week" | "day" | "list";

const viewButtons: TasksDisplayView[] = ["month", "week", "day", "list"];

export function TasksPane({
  workPath,
  effectiveSettings,
  skills,
  processingMissions,
  processingLogLines,
  onRefreshMissions,
  onOpenSettings,
  onOpenSkillCompose,
  onRevealPath,
  onError,
}: TasksPaneProps) {
  const { t, locale } = useTranslation();
  const [rows, setRows] = useState<TaskNoteRow[]>([]);
  const [loading, setLoading] = useState(false);
  const [query, setQuery] = useState("");
  const [view, setView] = useState<TasksFilterView>("scheduled");
  const [projectFilter, setProjectFilter] = useState("all");
  const [priorityFilter, setPriorityFilter] = useState<TaskPriority | "all">("all");
  const [displayView, setDisplayView] = useState<TasksDisplayView>(effectiveSettings.defaultView);
  const [selectedRelPath, setSelectedRelPath] = useState<string | null>(null);
  const [metadata, setMetadata] = useState<TaskMetadata | null>(null);
  const [metadataLoading, setMetadataLoading] = useState(false);
  const [newTaskOpen, setNewTaskOpen] = useState(false);
  const [naturalScheduleOpen, setNaturalScheduleOpen] = useState(false);
  const [detailsOpen, setDetailsOpen] = useState(false);
  const [viewDate, setViewDate] = useState<Date>(() => new Date());
  const [bodyHits, setBodyHits] = useState<Set<string>>(() => new Set());
  const debouncedQuery = useDebouncedValue(query, 250);
  const today = useMemo(() => format(new Date(), "yyyy-MM-dd"), []);
  const todayDate = useMemo(() => new Date(), []);
  const entries = useMemo(() => rowsToTaskEntries(rows), [rows]);
  const visibleEntries = useMemo(() => {
    const titleMatches = filterTasksByQuery(entries, query, {
      ...filtersForView(view),
      projects: projectFilter === "all" ? [] : [projectFilter],
      priorities: priorityFilter === "all" ? [] : [priorityFilter],
      today,
    });
    if (bodyHits.size === 0) return titleMatches;
    const bodyMatched = filterTasksByQuery(
      entries.filter((entry) => bodyHits.has(entry.relPath)),
      "",
      {
        ...filtersForView(view),
        projects: projectFilter === "all" ? [] : [projectFilter],
        priorities: priorityFilter === "all" ? [] : [priorityFilter],
        today,
      },
    );
    return mergeTaskEntries(titleMatches, bodyMatched);
  }, [entries, projectFilter, priorityFilter, query, today, view, bodyHits]);
  const unscheduledEntries = useMemo(() => {
    return filterTasksByQuery(entries, query, {
      statuses: ["active", "in-progress"],
      projects: projectFilter === "all" ? [] : [projectFilter],
      priorities: priorityFilter === "all" ? [] : [priorityFilter],
      due: "unscheduled",
      today,
    });
  }, [entries, projectFilter, priorityFilter, query, today]);
  const selectableEntries = useMemo(
    () =>
      displayView === "list"
        ? visibleEntries
        : mergeTaskEntries(visibleEntries, unscheduledEntries),
    [displayView, unscheduledEntries, visibleEntries],
  );
  const selectedEntry = useMemo(
    () => selectVisibleTask(selectableEntries, selectedRelPath),
    [selectableEntries, selectedRelPath],
  );
  const grouped = useMemo(() => groupTasksByStatus(visibleEntries), [visibleEntries]);
  const calendarEvents = useMemo(() => toUnifiedTaskEvents(visibleEntries), [visibleEntries]);
  const calendarView: CalendarView =
    displayView === "list" ? "month" : (displayView as CalendarView);
  const tasksMissions = useMemo(
    () => activeTasksMissions(processingMissions),
    [processingMissions],
  );

  useEffect(() => {
    if (!workPath) {
      setBodyHits(new Set());
      return;
    }
    const trimmed = debouncedQuery.trim();
    if (trimmed.length < 2) {
      setBodyHits(new Set());
      return;
    }
    let cancelled = false;
    void searchCalendarNotes(workPath, [effectiveSettings.root ?? "tasks"], trimmed)
      .then((paths) => {
        if (!cancelled) setBodyHits(new Set(paths));
      })
      .catch((err) => {
        if (!cancelled) onError(err instanceof Error ? err.message : String(err));
      });
    return () => {
      cancelled = true;
    };
  }, [debouncedQuery, workPath, effectiveSettings.root, onError]);

  const load = useCallback(async () => {
    if (!workPath || !effectiveSettings.enabled) {
      setRows([]);
      return;
    }
    setLoading(true);
    onError(null);
    try {
      setRows(await scanTaskNotes(workPath, effectiveSettings.root));
    } catch (err) {
      onError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  }, [effectiveSettings.enabled, effectiveSettings.root, onError, workPath]);

  useEffect(() => {
    void load();
  }, [load]);

  useEffect(() => {
    const nextRelPath = selectVisibleTask(selectableEntries, selectedRelPath)?.relPath ?? null;
    if (nextRelPath !== selectedRelPath) {
      setSelectedRelPath(nextRelPath);
    }
  }, [selectableEntries, selectedRelPath]);

  useEffect(() => {
    if (!selectedEntry) {
      setMetadata(null);
      return;
    }
    let cancelled = false;
    setMetadataLoading(true);
    if (workPath) {
      void readTaskMetadata(workPath, selectedEntry.relPath)
        .then((next) => {
          if (!cancelled) setMetadata(next);
        })
        .catch((err) => {
          if (!cancelled) onError(err instanceof Error ? err.message : String(err));
        })
        .finally(() => {
          if (!cancelled) setMetadataLoading(false);
        });
    }
    return () => {
      cancelled = true;
    };
  }, [onError, selectedEntry, workPath]);

  const createTask = async (draft: CreateTaskDraft) => {
    if (!workPath) return;
    await createTaskNote(workPath, draft, effectiveSettings.root);
    await load();
  };

  const setStatus = async (entry: TaskEntry, status: TaskStatus) => {
    if (!workPath) return;
    try {
      const updated = await updateTaskStatus(workPath, entry.relPath, status);
      setRows((current) => current.map((row) => (row.relPath === entry.relPath ? updated : row)));
      setSelectedRelPath(updated.relPath);
    } catch (err) {
      onError(err instanceof Error ? err.message : String(err));
    }
  };

  const updateSchedule = async (entry: TaskEntry, fields: TaskSchedulePatch) => {
    if (!workPath) return;
    try {
      const updated = await updateTaskScheduleFields(workPath, entry.relPath, fields);
      setRows((current) => current.map((row) => (row.relPath === entry.relPath ? updated : row)));
      setSelectedRelPath(updated.relPath);
    } catch (err) {
      onError(err instanceof Error ? err.message : String(err));
      throw err;
    }
  };

  const openSyncSkill = async () => {
    const skill = findSkill(skills, "task-management");
    const context = selectedEntry ? [{ path: selectedEntry.absPath, kind: "document" }] : [];
    const target = selectedEntry?.relPath ?? effectiveSettings.root ?? "tasks";
    if (workPath && effectiveSettings.hooks.appendVaultLog) {
      const payload = JSON.stringify({ skill: "task-management", target });
      await appendTasksLog(
        workPath,
        `- ${new Date().toISOString()} [sync] ${payload}`,
      ).catch((err) => onError(err instanceof Error ? err.message : String(err)));
    }
    onOpenSkillCompose(
      skill,
      context,
      `Sync local markdown tasks with the configured task-management workflow for ${target}.`,
      workPath,
    );
  };

  const openNaturalScheduleSkill = async (rawText: string) => {
    const skill = findSkill(skills, "task-management");
    const root = effectiveSettings.root ?? "tasks";
    if (workPath && effectiveSettings.hooks.appendVaultLog) {
      const payload = JSON.stringify({
        skill: "task-management",
        target: root,
        textLength: rawText.trim().length,
      });
      await appendTasksLog(
        workPath,
        `- ${new Date().toISOString()} [natural-schedule] ${payload}`,
      ).catch((err) => onError(err instanceof Error ? err.message : String(err)));
    }
    onOpenSkillCompose(
      skill,
      [],
      buildTaskManagementSchedulePrompt(rawText, effectiveSettings),
      workPath,
    );
  };

  if (!workPath) {
    return (
      <main className="tasks-pane tasks-empty">
        <div className="empty-document-plate">
          <h2>{t("tasks.title")}</h2>
          <p>{t("tasks.empty")}</p>
        </div>
      </main>
    );
  }

  return (
    <main className={detailsOpen ? "tasks-pane" : "tasks-pane details-collapsed"}>
      <TasksSidebar
        entries={entries}
        activeView={view}
        selectedProject={projectFilter}
        onViewChange={setView}
        onProjectChange={setProjectFilter}
        today={today}
      />
      <section className="tasks-main">
        <header className="tasks-header">
          <div>
            <h2>{t("tasks.title")}</h2>
            <p className="muted">{t("tasks.subtitle")}</p>
          </div>
          <div className="tasks-view-switcher" role="group" aria-label={t("tasks.display.view")}>
            {viewButtons.map((mode) => (
              <button
                type="button"
                key={mode}
                className={displayView === mode ? "active" : ""}
                onClick={() => setDisplayView(mode)}
              >
                {mode === "list" ? <List size={14} /> : <Calendar size={14} />}
                {t(displayViewLabel(mode))}
              </button>
            ))}
          </div>
          <div className="tasks-header-actions">
            <Button size="sm" variant="primary" icon={<Plus size={14} />} onClick={() => setNewTaskOpen(true)}>
              {t("tasks.actions.new")}
            </Button>
            <Button size="sm" variant="secondary" icon={<CalendarPlus size={14} />} onClick={() => setNaturalScheduleOpen(true)}>
              {t("tasks.actions.scheduleFromText")}
            </Button>
            <Button size="sm" variant="secondary" icon={<RefreshCcw size={14} />} onClick={() => void load()}>
              {t("tasks.actions.refresh")}
            </Button>
            <Button size="sm" variant="secondary" icon={<WandSparkles size={14} />} onClick={() => void openSyncSkill()}>
              {t("tasks.actions.sync")}
            </Button>
            <Button size="sm" variant="ghost" icon={<Settings size={14} />} onClick={onOpenSettings}>
              {t("tasks.actions.settings")}
            </Button>
          </div>
        </header>
        <div className="tasks-toolbar">
          <label className="tasks-search">
            <Search size={14} />
            <input
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              placeholder={t("tasks.search")}
            />
          </label>
          <select
            value={priorityFilter}
            onChange={(event) => setPriorityFilter(event.target.value as TaskPriority | "all")}
          >
            <option value="all">{t("tasks.priority.all")}</option>
            <option value="highest">{t("tasks.priority.highest")}</option>
            <option value="high">{t("tasks.priority.high")}</option>
            <option value="medium">{t("tasks.priority.medium")}</option>
            <option value="low">{t("tasks.priority.low")}</option>
          </select>
          <span className="tasks-result-count">
            {t("tasks.visibleCount", { count: visibleEntries.length })}
          </span>
        </div>
        {loading ? (
          <div className="tasks-loading"><Loader2 size={16} /> {t("tasks.loading")}</div>
        ) : displayView === "list" ? (
          <TaskList
            grouped={grouped}
            selectedRelPath={selectedEntry?.relPath ?? null}
            onSelect={setSelectedRelPath}
            onDone={(entry) => void setStatus(entry, "done")}
            t={t}
          />
        ) : (
          <UnifiedCalendarView<TaskEntry>
            events={calendarEvents}
            view={calendarView}
            viewDate={viewDate}
            weekStartsOn={effectiveSettings.weekStartsOn}
            locale={locale}
            today={todayDate}
            query={query}
            onQueryChange={setQuery}
            onViewChange={(next) => setDisplayView(next)}
            onViewDateChange={setViewDate}
            onSelectEvent={(event) => setSelectedRelPath(event.resource.relPath)}
            onSelectDate={(date) => {
              if (displayView === "month") setDisplayView("day");
              setViewDate(date);
            }}
            searchPlaceholder={t("tasks.search")}
            emptyLabel={t("tasks.calendar.empty")}
            startHour={effectiveSettings.calendarStartHour}
            loadingLabel={t("tasks.loading")}
          />
        )}
        {tasksMissions.length > 0 ? (
          <section className="tasks-runs">
            <header>
              <strong>{t("tasks.runs.title")}</strong>
              <button type="button" className="inline-action" onClick={onRefreshMissions}>
                {t("tasks.actions.refresh")}
              </button>
            </header>
            {tasksMissions.slice(0, 3).map((mission) => (
              <div key={mission.id} className="tasks-run-row">
                <span>{mission.status}</span>
                <code>{mission.id}</code>
                <small>{processingLogLines[mission.id]?.at(-1) ?? ""}</small>
              </div>
            ))}
          </section>
        ) : null}
      </section>
      <TaskDetailDrawer
        entry={selectedEntry}
        metadata={metadata}
        loading={metadataLoading}
        skills={skills}
        collapsed={!detailsOpen}
        onToggleCollapsed={() => setDetailsOpen((value) => !value)}
        onRevealPath={onRevealPath}
        onOpenSkillCompose={onOpenSkillCompose}
        onUpdateSchedule={updateSchedule}
      />
      <NewTaskDialog open={newTaskOpen} onClose={() => setNewTaskOpen(false)} onCreate={createTask} />
      <NaturalScheduleDialog
        open={naturalScheduleOpen}
        onClose={() => setNaturalScheduleOpen(false)}
        onSubmit={openNaturalScheduleSkill}
      />
    </main>
  );
}

function TaskList({
  grouped,
  selectedRelPath,
  onSelect,
  onDone,
  t,
}: {
  grouped: Map<TaskStatus, TaskEntry[]>;
  selectedRelPath: string | null;
  onSelect: (relPath: string) => void;
  onDone: (entry: TaskEntry) => void;
  t: (key: string, vars?: Record<string, string | number>) => string;
}) {
  const order: TaskStatus[] = ["in-progress", "active", "backlog", "done", "cancelled"];
  const visibleGroups = order
    .map((status) => [status, grouped.get(status) ?? []] as const)
    .filter(([, entries]) => entries.length > 0);
  if (visibleGroups.length === 0) {
    return <div className="tasks-list-empty">{t("tasks.list.empty")}</div>;
  }
  return (
    <div className="tasks-list">
      {visibleGroups.map(([status, entries]) => (
        <section className="tasks-group" key={status}>
          <header>
            <strong>{t(`tasks.status.${status === "in-progress" ? "inProgress" : status}`)}</strong>
            <span>{entries.length}</span>
          </header>
          {entries.map((entry) => (
            <button
              type="button"
              key={entry.relPath}
              className={selectedRelPath === entry.relPath ? "task-row selected" : "task-row"}
              onClick={() => onSelect(entry.relPath)}
            >
              <span
                className="task-check"
                role="checkbox"
                aria-checked={entry.status === "done"}
                onClick={(event) => {
                  event.stopPropagation();
                  if (entry.status !== "done") onDone(entry);
                }}
              >
                {entry.status === "done" ? <CheckCircle2 size={16} /> : null}
              </span>
              <span className="task-row-main">
                <strong>{entry.title}</strong>
                <span>{entry.relPath}</span>
              </span>
              <span className={`task-priority priority-${entry.priority}`}>
                {t(`tasks.priority.${entry.priority}`)}
              </span>
              {scheduleLabel(entry) ? <span className="task-chip">{scheduleLabel(entry)}</span> : null}
              {entry.project ? <span className="task-chip">{entry.project}</span> : null}
            </button>
          ))}
        </section>
      ))}
    </div>
  );
}

function filtersForView(view: TasksFilterView) {
  if (view === "scheduled") {
    return { statuses: ["active", "in-progress"] as const, due: "scheduled" as const };
  }
  if (view === "today" || view === "overdue" || view === "unscheduled") {
    return { statuses: ["active", "in-progress"] as const, due: view };
  }
  if (view === "backlog") {
    return { statuses: ["backlog"] as const, buckets: ["backlog"] as const };
  }
  return { statuses: ["done", "cancelled"] as const, buckets: ["archive"] as const };
}

function displayViewLabel(mode: TasksDisplayView): string {
  if (mode === "list") return "tasks.display.list";
  if (mode === "month") return "tasks.calendar.month";
  if (mode === "week") return "tasks.calendar.week";
  return "tasks.calendar.day";
}

function scheduleLabel(entry: TaskEntry): string | null {
  if (entry.calendarStart) return entry.calendarStart.replace("T", " ").slice(0, 16);
  return entry.due;
}

function mergeTaskEntries(primary: TaskEntry[], secondary: TaskEntry[]): TaskEntry[] {
  const seen = new Set<string>();
  const merged: TaskEntry[] = [];
  for (const entry of [...primary, ...secondary]) {
    if (seen.has(entry.relPath)) continue;
    seen.add(entry.relPath);
    merged.push(entry);
  }
  return merged;
}

function findSkill(skills: SkillRecord[], name: string): SkillRecord | null {
  const normalized = name.toLowerCase();
  return (
    skills.find((skill) => skill.id.toLowerCase() === normalized)
    ?? skills.find((skill) => skill.name.toLowerCase() === normalized)
    ?? null
  );
}
