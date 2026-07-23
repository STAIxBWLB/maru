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
  SlidersHorizontal,
  WandSparkles,
  X,
} from "lucide-react";
import { useCallback, useEffect, useMemo, useState, type CSSProperties } from "react";
import { format, parseISO } from "date-fns";
import {
  appendTasksLog,
  createTaskNote,
  readTaskMetadata,
  scanTaskNotes,
  searchCalendarNotes,
  updateTaskDetails,
  updateTaskStatus,
} from "../../lib/api";
import { useTranslation } from "../../lib/i18n";
import type { DocumentLabelMode, LayoutSettings, TasksSettings } from "../../lib/settings";
import { TODAY_LAYOUT_LIMITS } from "../../lib/todayLayout";
import { resolveDisplayLabel } from "../../lib/document";
import { listWorkspaceProjects } from "../../lib/maruDir";
import {
  skillsDispatchBackground,
  skillsRuntimeStatus,
  type SkillContextItem,
  type SkillDispatchRuntime,
  type SkillRecord,
} from "../../lib/skills";
import {
  activeTasksMissions,
  buildTaskManagementSchedulePrompt,
  buildTaskManagementSyncPrompt,
  filterTasksByQuery,
  groupTasksByStatus,
  rowsToTaskEntries,
  resolveTaskEntryProjects,
  selectVisibleTask,
  type TaskEntry,
  type TaskPriority,
} from "../../lib/tasks";
import type {
  CreateTaskDraft,
  TaskDetailsPatch,
  MissionRecord,
  ProjectPickerEntry,
  TaskMetadata,
  TaskNoteRow,
  TaskStatus,
} from "../../lib/types";
import { Button } from "../ui/Button";
import { NaturalScheduleDialog } from "./NaturalScheduleDialog";
import { NewTaskDialog } from "./NewTaskDialog";
import { TaskDetailDrawer } from "./TaskDetailDrawer";
import { TasksRunsPanel } from "./TasksRunsPanel";
import { TasksSidebar, type TasksFilterView } from "./TasksSidebar";
import { UnifiedCalendarView } from "../calendar/UnifiedCalendarView";
import { toUnifiedTaskEvents } from "../../lib/calendar/fromEntries";
import type { CalendarView } from "../../lib/calendar/types";
import { useDebouncedValue } from "../../lib/useDebouncedValue";
import { PaneResizeHandle } from "../ui/PaneResizeHandle";

export interface TasksPaneProps {
  workPath: string | null;
  effectiveSettings: TasksSettings;
  labelMode: DocumentLabelMode;
  skills: SkillRecord[];
  runtimeCommands: Partial<Record<SkillDispatchRuntime, string | null>>;
  permissionMode?: string | null;
  defaultRuntime?: SkillDispatchRuntime;
  processingMissions: MissionRecord[];
  processingLogLines: Record<string, string[]>;
  onRefreshMissions: () => void;
  onOpenSettings: () => void;
  onOpenSkillCompose: (
    skill: SkillRecord | null,
    context: SkillContextItem[],
    prompt?: string,
    cwd?: string | null,
    onDispatched?: () => void | Promise<void>,
  ) => void;
  onMissionStarted: (invocationId: string) => void;
  onStopMission: (id: string) => void;
  onConfirmApproval: (input: {
    kind: string;
    summary: string;
    target?: string | null;
    payloadPreview?: string | null;
  }) => Promise<string | null>;
  onRevealPath?: (path: string) => void;
  onError: (message: string | null) => void;
  layout?: Pick<
    LayoutSettings,
    "tasksSidebarWidth" | "calendarAgendaWidth" | "taskDetailsWidth"
  >;
  onLayoutChange?: (
    patch: Partial<
      Pick<LayoutSettings, "tasksSidebarWidth" | "calendarAgendaWidth" | "taskDetailsWidth">
    >,
  ) => void;
  logicalDay?: string | null;
}

type TasksDisplayView = "month" | "week" | "day" | "list";

const viewButtons: TasksDisplayView[] = ["month", "week", "day", "list"];

export function TasksPane({
  workPath,
  effectiveSettings,
  labelMode,
  skills,
  runtimeCommands,
  permissionMode,
  defaultRuntime,
  processingMissions,
  processingLogLines,
  onRefreshMissions,
  onOpenSettings,
  onOpenSkillCompose,
  onMissionStarted,
  onStopMission,
  onConfirmApproval,
  onRevealPath,
  onError,
  layout,
  onLayoutChange,
  logicalDay,
}: TasksPaneProps) {
  const { t, locale } = useTranslation();
  const [rows, setRows] = useState<TaskNoteRow[]>([]);
  const [projectCatalog, setProjectCatalog] = useState<ProjectPickerEntry[]>([]);
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
  const [filtersOpen, setFiltersOpen] = useState(false);
  const [detailDirty, setDetailDirty] = useState(false);
  const [viewDate, setViewDate] = useState<Date>(() =>
    logicalDay ? parseISO(`${logicalDay}T12:00:00`) : new Date(),
  );
  const [bodyHits, setBodyHits] = useState<Set<string>>(() => new Set());
  const [tasksSidebarWidth, setTasksSidebarWidth] = useState(
    layout?.tasksSidebarWidth ?? TODAY_LAYOUT_LIMITS.tasksSidebarWidth.defaultValue,
  );
  const [calendarAgendaWidth, setCalendarAgendaWidth] = useState(
    layout?.calendarAgendaWidth ?? TODAY_LAYOUT_LIMITS.calendarAgendaWidth.defaultValue,
  );
  const [taskDetailsWidth, setTaskDetailsWidth] = useState(
    layout?.taskDetailsWidth ?? TODAY_LAYOUT_LIMITS.taskDetailsWidth.defaultValue,
  );
  const debouncedQuery = useDebouncedValue(query, 250);
  const today = logicalDay ?? format(new Date(), "yyyy-MM-dd");
  const todayDate = useMemo(() => parseISO(`${today}T12:00:00`), [today]);
  const entries = useMemo(
    () => resolveTaskEntryProjects(rowsToTaskEntries(rows), projectCatalog),
    [projectCatalog, rows],
  );
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
  const [localRuns, setLocalRuns] = useState<MissionRecord[]>([]);
  const [section, setSection] = useState<"tasks" | "progress">("tasks");
  const mergedMissions = useMemo(
    () => mergeTaskMissions(tasksMissions, localRuns),
    [tasksMissions, localRuns],
  );
  const progressCount = useMemo(
    () => mergedMissions.filter((mission) => mission.status === "running" || mission.status === "idle").length,
    [mergedMissions],
  );

  useEffect(() => {
    setViewDate(todayDate);
  }, [today, todayDate]);

  useEffect(() => {
    if (layout?.tasksSidebarWidth !== undefined) {
      setTasksSidebarWidth(layout.tasksSidebarWidth);
    }
  }, [layout?.tasksSidebarWidth]);

  useEffect(() => {
    if (layout?.calendarAgendaWidth !== undefined) {
      setCalendarAgendaWidth(layout.calendarAgendaWidth);
    }
  }, [layout?.calendarAgendaWidth]);

  useEffect(() => {
    if (layout?.taskDetailsWidth !== undefined) {
      setTaskDetailsWidth(layout.taskDetailsWidth);
    }
  }, [layout?.taskDetailsWidth]);

  useEffect(() => {
    if (!workPath) {
      setProjectCatalog([]);
      return;
    }
    let cancelled = false;
    void listWorkspaceProjects(workPath, true)
      .then((projects) => {
        if (!cancelled) setProjectCatalog(projects);
      })
      .catch(() => {
        if (!cancelled) setProjectCatalog([]);
      });
    return () => {
      cancelled = true;
    };
  }, [workPath]);

  useEffect(() => {
    if (tasksMissions.length === 0) return;
    const ids = new Set(tasksMissions.map((mission) => mission.id));
    setLocalRuns((current) => current.filter((mission) => !ids.has(mission.id)));
  }, [tasksMissions]);

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
    setDisplayView(effectiveSettings.defaultView);
  }, [effectiveSettings.defaultView]);

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
    setMetadata(null);
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
      const updated = await updateTaskStatus(
        workPath,
        entry.relPath,
        status,
        effectiveSettings.root,
      );
      setRows((current) => current.map((row) => (row.relPath === entry.relPath ? updated : row)));
      setSelectedRelPath(updated.relPath);
    } catch (err) {
      onError(err instanceof Error ? err.message : String(err));
    }
  };

  const updateDetails = async (entry: TaskEntry, fields: TaskDetailsPatch) => {
    if (!workPath) return;
    try {
      const updated = await updateTaskDetails(
        workPath,
        entry.relPath,
        fields,
        effectiveSettings.root,
      );
      setRows((current) => replaceTaskRow(current, entry.relPath, updated));
      setSelectedRelPath(updated.relPath);
      setMetadata(null);
      setDetailDirty(false);
    } catch (err) {
      onError(err instanceof Error ? err.message : String(err));
      throw err;
    }
  };

  const selectTask = useCallback(
    (relPath: string) => {
      if (
        relPath !== selectedRelPath
        && !canSwitchTaskDetails(detailDirty, () => window.confirm(t("tasks.detail.discardConfirm")))
      ) {
        return;
      }
      setSelectedRelPath(relPath);
      setDetailsOpen(true);
      setDetailDirty(false);
    },
    [detailDirty, selectedRelPath, t],
  );

  const resolveRuntime = useCallback(async (): Promise<SkillDispatchRuntime | null> => {
    const preferred: SkillDispatchRuntime = defaultRuntime ?? "claude";
    const order: SkillDispatchRuntime[] = preferred === "codex" ? ["codex", "claude"] : ["claude", "codex"];
    for (const runtime of order) {
      try {
        const status = await skillsRuntimeStatus({ runtime, commandOverride: runtimeCommands[runtime] ?? null });
        if (status.available) return runtime;
      } catch {
        // Try the next runtime.
      }
    }
    return null;
  }, [defaultRuntime, runtimeCommands]);

  // Schedule-from-text and Sync now run as tracked, reviewable missions (mirror
  // of meeting-notes): a proposal-first background run that surfaces in the
  // tasks runs panel with diff review + confirm checks + followups.
  const dispatchTaskSkill = useCallback(
    async (mode: "schedule" | "sync", prompt: string, contextPaths: string[]) => {
      if (!workPath) return;
      const skill = findSkill(skills, "task-management");
      if (!skill) {
        onError(t("tasks.error.skillMissing", { skill: "task-management" }));
        return;
      }
      const runtime = await resolveRuntime();
      if (!runtime) {
        onError(t("tasks.error.runtimeUnavailable"));
        return;
      }
      onError(null);
      try {
        const origin = mode === "sync" ? "taskManagementSync" : "taskManagementSchedule";
        const invocationId = await skillsDispatchBackground({
          skillId: skill.id,
          runtime,
          cwd: workPath,
          prompt,
          context: contextPaths.map((path) => ({ path, kind: "file" as const })),
          commandOverride: runtimeCommands[runtime] ?? null,
          permissionMode: permissionMode ?? null,
          metadata: {
            origin,
            runtime,
            reviewFlow: true,
            inputPaths: contextPaths,
            workspacePath: workPath,
            skillName: "task-management",
          },
        });
        setLocalRuns((current) => [
          createOptimisticTaskMission({ id: invocationId, runtime, origin, inputPaths: contextPaths }),
          ...current.filter((mission) => mission.id !== invocationId),
        ]);
        onMissionStarted(invocationId);
        onRefreshMissions();
        if (effectiveSettings.hooks.appendVaultLog) {
          await appendTasksLog(
            workPath,
            `- ${new Date().toISOString()} [${mode === "sync" ? "sync" : "natural-schedule"}] ${JSON.stringify({
              skill: "task-management",
              runId: invocationId,
            })}`,
          ).catch(() => {});
        }
      } catch (err) {
        onError(err instanceof Error ? err.message : String(err));
      }
    },
    [
      workPath,
      skills,
      resolveRuntime,
      runtimeCommands,
      permissionMode,
      onMissionStarted,
      onRefreshMissions,
      effectiveSettings.hooks.appendVaultLog,
      onError,
      t,
    ],
  );

  const openSyncSkill = useCallback(async () => {
    const target = selectedEntry?.relPath ?? effectiveSettings.root ?? "tasks";
    await dispatchTaskSkill(
      "sync",
      buildTaskManagementSyncPrompt(target, effectiveSettings),
      selectedEntry ? [selectedEntry.absPath] : [],
    );
  }, [dispatchTaskSkill, effectiveSettings, selectedEntry]);

  const openNaturalScheduleSkill = useCallback(
    async (rawText: string, parsedStart: string | null) => {
      await dispatchTaskSkill(
        "schedule",
        buildTaskManagementSchedulePrompt(rawText, effectiveSettings, parsedStart),
        [],
      );
    },
    [dispatchTaskSkill, effectiveSettings],
  );

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
    <main
      className={
        section === "progress"
          ? "tasks-pane tasks-pane-progress"
          : detailsOpen
            ? "tasks-pane"
            : "tasks-pane details-collapsed"
      }
      style={
        {
          "--tasks-sidebar-width": `${tasksSidebarWidth}px`,
          "--task-details-width": `${taskDetailsWidth}px`,
        } as CSSProperties
      }
    >
      <div className={filtersOpen ? "tasks-sidebar-shell open" : "tasks-sidebar-shell"}>
        <button
          type="button"
          className="tasks-sidebar-close"
          aria-label={t("tasks.layout.closeFilters")}
          onClick={() => setFiltersOpen(false)}
        >
          <X size={15} />
        </button>
        <TasksSidebar
          entries={entries}
          activeView={view}
          selectedProject={projectFilter}
          activeSection={section}
          progressCount={progressCount}
          onViewChange={(next) => {
            setView(next);
            setSection("tasks");
            setFiltersOpen(false);
          }}
          onProjectChange={(next) => {
            setProjectFilter(next);
            setSection("tasks");
            setFiltersOpen(false);
          }}
          onSectionChange={(next) => {
            setSection(next);
            setFiltersOpen(false);
          }}
          today={today}
        />
      </div>
      <PaneResizeHandle
        label={t("tasks.layout.resizeFilters")}
        value={tasksSidebarWidth}
        min={TODAY_LAYOUT_LIMITS.tasksSidebarWidth.min}
        max={TODAY_LAYOUT_LIMITS.tasksSidebarWidth.max}
        defaultValue={TODAY_LAYOUT_LIMITS.tasksSidebarWidth.defaultValue}
        onChange={setTasksSidebarWidth}
        onCommit={(value) => onLayoutChange?.({ tasksSidebarWidth: value })}
      />
      <section className={section === "progress" ? "tasks-main tasks-main-progress" : "tasks-main"}>
        <header className="tasks-header">
          <div>
            <div className="tasks-title-row">
              <button
                type="button"
                className="tasks-filter-toggle"
                aria-label={t("tasks.layout.openFilters")}
                aria-expanded={filtersOpen}
                onClick={() => setFiltersOpen(true)}
              >
                <SlidersHorizontal size={15} />
              </button>
              <h2>{t("tasks.title")}</h2>
            </div>
            <p className="muted">{t("tasks.subtitle")}</p>
          </div>
          {section === "tasks" ? (
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
          ) : null}
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
        {section === "progress" ? (
          <div className="tasks-progress-view">
            <TasksRunsPanel
              workPath={workPath}
              skills={skills}
              runtimeCommands={runtimeCommands}
              permissionMode={permissionMode}
              appendAuditLog={effectiveSettings.hooks.appendVaultLog}
              missions={mergedMissions}
              logLines={processingLogLines}
              onMissionStarted={onMissionStarted}
              onStopMission={onStopMission}
              onRefreshMissions={onRefreshMissions}
              onConfirmApproval={onConfirmApproval}
              onApplied={() => void load()}
              onError={onError}
            />
          </div>
        ) : (
          <>
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
                labelMode={labelMode}
                onSelect={selectTask}
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
                labelMode={labelMode}
                today={todayDate}
                query={query}
                onQueryChange={setQuery}
                onViewChange={(next) => setDisplayView(next)}
                onViewDateChange={setViewDate}
                onSelectEvent={(event) => selectTask(event.resource.relPath)}
                onSelectDate={(date) => {
                  if (displayView === "month") setDisplayView("day");
                  setViewDate(date);
                }}
                searchPlaceholder={t("tasks.search")}
                emptyLabel={t("tasks.calendar.empty")}
                startHour={effectiveSettings.calendarStartHour}
                loadingLabel={t("tasks.loading")}
                agendaWidth={calendarAgendaWidth}
                onAgendaWidthChange={setCalendarAgendaWidth}
                onAgendaWidthCommit={(value) =>
                  onLayoutChange?.({ calendarAgendaWidth: value })
                }
              />
            )}
          </>
        )}
      </section>
      {section === "tasks" ? (
        <>
          <div className="task-details-resizer">
            <PaneResizeHandle
              label={t("tasks.layout.resizeDetails")}
              value={taskDetailsWidth}
              min={TODAY_LAYOUT_LIMITS.taskDetailsWidth.min}
              max={TODAY_LAYOUT_LIMITS.taskDetailsWidth.max}
              defaultValue={TODAY_LAYOUT_LIMITS.taskDetailsWidth.defaultValue}
              direction={-1}
              disabled={!detailsOpen}
              onChange={setTaskDetailsWidth}
              onCommit={(value) => onLayoutChange?.({ taskDetailsWidth: value })}
            />
          </div>
          <TaskDetailDrawer
            entry={selectedEntry}
            metadata={metadata}
            loading={metadataLoading}
            labelMode={labelMode}
            skills={skills}
            collapsed={!detailsOpen}
            onToggleCollapsed={() => setDetailsOpen((value) => !value)}
            onRevealPath={onRevealPath}
            onOpenSkillCompose={onOpenSkillCompose}
            onSaveDetails={updateDetails}
            onDirtyChange={setDetailDirty}
          />
        </>
      ) : null}
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
  labelMode,
  onSelect,
  onDone,
  t,
}: {
  grouped: Map<TaskStatus, TaskEntry[]>;
  selectedRelPath: string | null;
  labelMode: DocumentLabelMode;
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
                <strong>{resolveDisplayLabel(entry.title, entry.fileName, labelMode).primary}</strong>
                <span>{entry.relPath}</span>
              </span>
              <span className={`task-priority priority-${entry.priority}`}>
                {t(`tasks.priority.${entry.priority}`)}
              </span>
              {scheduleLabel(entry) ? <span className="task-chip">{scheduleLabel(entry)}</span> : null}
              {entry.projectLabels[0] ? (
                <span className="task-chip">{entry.projectLabels[0]}</span>
              ) : null}
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

function replaceTaskRow(rows: TaskNoteRow[], relPath: string, updated: TaskNoteRow): TaskNoteRow[] {
  let replaced = false;
  const next = rows.map((row) => {
    if (row.relPath !== relPath) return row;
    replaced = true;
    return updated;
  });
  return replaced ? next : [updated, ...rows];
}

export function canSwitchTaskDetails(
  dirty: boolean,
  confirmDiscard: () => boolean,
): boolean {
  return !dirty || confirmDiscard();
}

function findSkill(skills: SkillRecord[], name: string): SkillRecord | null {
  const normalized = name.toLowerCase();
  return (
    skills.find((skill) => skill.id.toLowerCase() === normalized)
    ?? skills.find((skill) => skill.name.toLowerCase() === normalized)
    ?? null
  );
}

function mergeTaskMissions(missions: MissionRecord[], localRuns: MissionRecord[]): MissionRecord[] {
  const byId = new Map<string, MissionRecord>();
  for (const mission of localRuns) byId.set(mission.id, mission);
  for (const mission of missions) byId.set(mission.id, mission);
  return Array.from(byId.values()).sort(
    (a, b) => b.lastOutputAt.localeCompare(a.lastOutputAt) || b.startedAt.localeCompare(a.startedAt),
  );
}

function createOptimisticTaskMission({
  id,
  runtime,
  origin,
  inputPaths,
}: {
  id: string;
  runtime: SkillDispatchRuntime;
  origin: string;
  inputPaths: string[];
}): MissionRecord {
  const now = new Date().toISOString();
  return {
    id,
    kind: "skill",
    startedAt: now,
    lastOutputAt: now,
    status: "idle",
    exitCode: null,
    outputLogPath: null,
    metadata: {
      origin,
      runtime,
      reviewFlow: true,
      inputPaths,
      skillName: "task-management",
    },
  };
}
