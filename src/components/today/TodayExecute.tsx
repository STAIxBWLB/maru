// Maru Today — Execute stage. Real working view of the confirmed plan:
// Top 3 with complete/pin/open actions, the flexible queue, the fixed-event
// agenda strip, and the always-visible Done Today list with undo (reopen).
// Completions are explicit user actions through `task_transition` with
// expected-hash optimistic concurrency; local completion shows immediately
// and is never rolled back. Sync badges reconcile against the integration
// outbox so states survive reloads.

import { format } from "date-fns";
import {
  ArrowUpToLine,
  CalendarPlus,
  Check,
  Loader2,
  Pin,
  PinOff,
  TriangleAlert,
  Undo2,
} from "lucide-react";
import { useCallback, useEffect, useMemo, useState } from "react";
import { readDocument } from "../../lib/api";
import { useTranslation } from "../../lib/i18n";
import type { TaskEntry, TaskSyncStatus } from "../../lib/tasks";
import type {
  DailyPlanItem,
  OutboxRecord,
  TaskEvent,
  TaskTransitionKind,
  TodayRoute,
} from "../../lib/today";
import {
  isTaskConflict,
  readTaskEvents,
  readTaskIntegrations,
  sha256Hex,
  taskTransition,
} from "../../lib/today";
import { planItemRefKey, TOP_LANE_SIZE } from "../../lib/todayPlan";
import { TaskSheet } from "./TaskSheet";
import { TodayStageScaffold } from "./TodayStageScaffold";
import { TodaySyncStatus } from "./TodaySyncStatus";
import { useToday } from "./todayContext";
import { resolveRefTitle, taskKeyOf } from "./todayPrepareUtils";
import { useTodayTasks } from "./useTodayTasks";
import { useTodayCalendarSync } from "./useTodayCalendarSync";

interface TodayExecuteProps {
  onNavigate: (route: TodayRoute) => void;
}

/** One row in the Done Today list (optimistic, event-sourced, or scan-based). */
interface DoneRow {
  taskId: string;
  title: string;
  completedAt: string | null;
  /** Current note path (null when the task vanished from the scan). */
  relPath: string | null;
  syncStatus: TaskSyncStatus | null;
}

/** Outbox status folded into the row-level sync badge vocabulary. */
function outboxToSyncStatus(record: OutboxRecord): TaskSyncStatus {
  switch (record.status) {
    case "synced":
      return "synced";
    case "retryNeeded":
      return "retryNeeded";
    case "authBlocked":
      return "authBlocked";
    default:
      return "syncing";
  }
}

export function TodayExecute({ onNavigate }: TodayExecuteProps) {
  const { t } = useTranslation();
  const { workPath, snapshot, mutate, reload } = useToday();
  const { tasks, refresh } = useTodayTasks();
  const {
    notice: calendarNotice,
    publishing,
    publishSelected,
    retryItem: retryCalendarItem,
    setSelected: setCalendarSelected,
  } = useTodayCalendarSync();

  const [events, setEvents] = useState<TaskEvent[]>([]);
  const [outbox, setOutbox] = useState<OutboxRecord[]>([]);
  /** Optimistic completions/reopens keyed by the plan ref task id. */
  const [optimistic, setOptimistic] = useState<Record<string, DoneRow | null>>({});
  const [taskNotice, setTaskNotice] = useState<"conflict" | "error" | null>(null);
  const [sheetTaskId, setSheetTaskId] = useState<string | null>(null);

  const logicalDay = snapshot?.logicalDay ?? "";

  useEffect(() => {
    if (!workPath || !logicalDay) return;
    let cancelled = false;
    readTaskEvents(workPath, null, logicalDay)
      .then((rows) => {
        if (!cancelled) setEvents(rows);
      })
      .catch(() => {});
    readTaskIntegrations(workPath)
      .then((records) => {
        if (!cancelled) setOutbox(records);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [workPath, logicalDay]);

  const steps = useMemo(
    () => [
      { id: "prepare", label: t("today.nav.prepare") },
      { id: "execute", label: t("today.nav.execute") },
      { id: "review", label: t("today.nav.review") },
    ],
    [t],
  );

  const plan = snapshot?.plan ?? null;
  const top = useMemo(() => [...(plan?.top ?? [])].sort((a, b) => a.order - b.order), [plan]);
  const flexible = useMemo(
    () => [...(plan?.flexible ?? [])].sort((a, b) => a.order - b.order),
    [plan],
  );
  const fixedItems = useMemo(
    () =>
      [...(plan?.top ?? []), ...(plan?.flexible ?? []), ...(plan?.overflow ?? [])]
        .filter((item) => item.proposedBlock)
        .sort((a, b) =>
          (a.proposedBlock?.startIso ?? "").localeCompare(b.proposedBlock?.startIso ?? ""),
        ),
    [plan],
  );

  /** Latest outbox status per task path (records are append-only updates). */
  const outboxByPath = useMemo(() => {
    const map = new Map<string, OutboxRecord>();
    for (const record of outbox) {
      const current = map.get(record.taskPath);
      if (!current || current.updatedAt <= record.updatedAt) map.set(record.taskPath, record);
    }
    return map;
  }, [outbox]);

  const syncStatusFor = useCallback(
    (relPath: string | null, fallback: TaskSyncStatus | null): TaskSyncStatus | null => {
      if (relPath) {
        const record = outboxByPath.get(relPath);
        if (record) return outboxToSyncStatus(record);
      }
      return fallback;
    },
    [outboxByPath],
  );

  const doneRows = useMemo<DoneRow[]>(() => {
    const rows = new Map<string, DoneRow>();
    // Event fold: completed adds, reopened removes (same-day undo).
    for (const event of events) {
      if (!event.taskId) continue;
      if (event.kind === "task_completed") {
        const payload = (event.payload ?? {}) as { taskPath?: string };
        const entry = tasks.find((task) => taskKeyOf(task) === event.taskId);
        rows.set(event.taskId, {
          taskId: event.taskId,
          title: entry?.title ?? event.taskId,
          completedAt: event.ts,
          relPath: entry?.relPath ?? payload.taskPath ?? null,
          syncStatus: null,
        });
      } else if (event.kind === "task_reopened") {
        rows.delete(event.taskId);
      }
    }
    // Scan-based completions (done === today) the event log may predate.
    for (const entry of tasks) {
      if (entry.done !== logicalDay) continue;
      const taskId = taskKeyOf(entry);
      if (rows.has(taskId)) continue;
      rows.set(taskId, {
        taskId,
        title: entry.title,
        completedAt: entry.completedAt ?? null,
        relPath: entry.relPath,
        syncStatus: entry.syncStatus ?? null,
      });
    }
    // Optimistic overrides (null = optimistically reopened).
    for (const [taskId, row] of Object.entries(optimistic)) {
      if (row === null) rows.delete(taskId);
      else rows.set(taskId, row);
    }
    return [...rows.values()].map((row) => ({
      ...row,
      syncStatus: syncStatusFor(row.relPath, row.syncStatus),
    }));
  }, [events, tasks, logicalDay, optimistic, syncStatusFor]);

  const doneIds = useMemo(() => new Set(doneRows.map((row) => row.taskId)), [doneRows]);

  const runTransition = async (entry: TaskEntry, kind: TaskTransitionKind, refTaskId: string) => {
    if (!workPath || !snapshot) return;
    const nowIso = new Date().toISOString();
    try {
      const doc = await readDocument(workPath, entry.relPath);
      const expectedTaskHash = await sha256Hex(doc.content);
      const outcome = await taskTransition(workPath, {
        taskId: entry.taskId ?? refTaskId,
        taskPath: entry.relPath,
        kind,
        expectedTaskHash,
        date: snapshot.logicalDay,
        nowIso,
      });
      setTaskNotice(null);
      if (kind === "complete") {
        // Optimistic: local completion shows immediately, never rolls back.
        setOptimistic((prev) => ({
          ...prev,
          [refTaskId]: {
            taskId: refTaskId,
            title: entry.title,
            completedAt: nowIso,
            relPath: entry.relPath,
            syncStatus: outcome.syncStatus,
          },
        }));
      } else {
        setOptimistic((prev) => ({ ...prev, [refTaskId]: null }));
      }
      void refresh();
      readTaskEvents(workPath, null, snapshot.logicalDay)
        .then(setEvents)
        .catch(() => {});
    } catch (err) {
      if (isTaskConflict(err)) {
        setTaskNotice("conflict");
        void reload();
      } else {
        setTaskNotice("error");
      }
    }
  };

  const completeItem = (item: DailyPlanItem) => {
    const ref = item.itemRef;
    if (ref.kind !== "task") return;
    const entry = tasks.find((task) => taskKeyOf(task) === ref.taskId);
    if (entry) void runTransition(entry, "complete", ref.taskId);
  };

  const reopenRow = (row: DoneRow) => {
    const entry = tasks.find((task) => taskKeyOf(task) === row.taskId);
    if (entry) void runTransition(entry, "reopen", row.taskId);
  };

  const togglePin = (item: DailyPlanItem) => {
    if (!plan) return;
    const flip = (items: DailyPlanItem[]) =>
      items.map((entry) =>
        planItemRefKey(entry.itemRef) === planItemRefKey(item.itemRef)
          ? { ...entry, pinned: !entry.pinned }
          : entry,
      );
    void mutate({
      type: "setPlan",
      plan: { ...plan, top: flip(plan.top), flexible: flip(plan.flexible) },
    });
  };

  const promote = (item: DailyPlanItem) => {
    if (!plan || top.length >= TOP_LANE_SIZE) return;
    const nextTop = [...top, { ...item, lane: "top" as const, order: top.length }];
    const nextFlexible = plan.flexible
      .filter((entry) => planItemRefKey(entry.itemRef) !== planItemRefKey(item.itemRef))
      .map((entry, index) => ({ ...entry, order: index }));
    void mutate({ type: "setPlan", plan: { ...plan, top: nextTop, flexible: nextFlexible } });
  };

  const openSheet = (item: DailyPlanItem) => {
    if (item.itemRef.kind === "task") setSheetTaskId(item.itemRef.taskId);
  };

  const renderCalendarControl = (item: DailyPlanItem) => {
    const sync = item.calendarSync;
    switch (sync.status) {
      case "selected":
        return (
          <>
            <span className="today-sync-badge">{t("today.calendar.selected")}</span>
            <button
              type="button"
              className="today-panel-link"
              disabled={publishing}
              onClick={() => void publishSelected()}
            >
              {t("today.calendar.publishNow")}
            </button>
          </>
        );
      case "syncing":
        return (
          <span className="today-sync-badge">
            <Loader2 size={12} strokeWidth={1.9} className="today-spin" aria-hidden="true" />
            {t("today.execute.sync.syncing")}
          </span>
        );
      case "synced":
        return (
          <span className="today-sync-badge">
            <Check size={12} strokeWidth={2.2} aria-hidden="true" />
            {t("today.calendar.synced")}
          </span>
        );
      case "error":
        return (
          <>
            <span
              className="today-sync-badge warn"
              title={sync.message ?? undefined}
            >
              <TriangleAlert size={12} strokeWidth={1.9} aria-hidden="true" />
              {t("today.calendar.error")}
            </span>
            <button
              type="button"
              className="today-panel-link"
              disabled={publishing}
              onClick={() => void retryCalendarItem(item)}
            >
              {t("today.calendar.retry")}
            </button>
          </>
        );
      default:
        return (
          <button
            type="button"
            className="today-panel-link today-calendar-add"
            onClick={() => void setCalendarSelected(item, true)}
          >
            <CalendarPlus size={12} strokeWidth={1.9} aria-hidden="true" />
            {t("today.calendar.add")}
          </button>
        );
    }
  };

  const sheetEntry = sheetTaskId
    ? (tasks.find((task) => taskKeyOf(task) === sheetTaskId) ?? null)
    : null;

  /** Rows open the sheet on click; mirror that for keyboard users. */
  const handleRowKeyDown = (event: React.KeyboardEvent, item: DailyPlanItem) => {
    if (event.target !== event.currentTarget) return; // inner buttons handle themselves
    if (event.key === "Enter" || event.key === " ") {
      event.preventDefault();
      openSheet(item);
    }
  };

  const renderPlanRow = (item: DailyPlanItem, rank: number | null) => {
    const ref = item.itemRef;
    const isTask = ref.kind === "task";
    const refId = isTask ? ref.taskId : null;
    const done = refId !== null && doneIds.has(refId);
    const doneRow = refId !== null ? doneRows.find((row) => row.taskId === refId) : undefined;
    return (
      <li
        key={planItemRefKey(item.itemRef)}
        className={done ? "today-exec-row done" : "today-exec-row"}
        tabIndex={0}
        onClick={() => openSheet(item)}
        onKeyDown={(event) => handleRowKeyDown(event, item)}
      >
        {rank !== null ? <span className="today-exec-rank">{rank}</span> : null}
        <span className="today-exec-title">
          {item.outcome || resolveRefTitle(item.itemRef, tasks, [])}
          {item.outcome ? (
            <span className="today-exec-subtitle">{resolveRefTitle(item.itemRef, tasks, [])}</span>
          ) : null}
        </span>
        {item.estimateMinutes ? (
          <span className="today-exec-estimate">
            {t("today.execute.estimate", { minutes: item.estimateMinutes })}
            {item.estimateProvisional ? (
              <span className="today-exec-provisional">{t("today.execute.provisional")}</span>
            ) : null}
          </span>
        ) : null}
        {doneRow ? <SyncBadge status={doneRow.syncStatus} /> : null}
        <span className="today-exec-actions" onClick={(event) => event.stopPropagation()}>
          {isTask && !done ? (
            <button
              type="button"
              className="today-icon-button today-icon-button-sm today-exec-complete"
              aria-label={t("today.execute.complete")}
              title={t("today.execute.complete")}
              onClick={() => completeItem(item)}
            >
              <Check size={14} strokeWidth={2.2} aria-hidden="true" />
            </button>
          ) : null}
          <button
            type="button"
            className="today-icon-button today-icon-button-sm"
            aria-label={item.pinned ? t("today.execute.unpin") : t("today.execute.pin")}
            title={item.pinned ? t("today.execute.unpin") : t("today.execute.pin")}
            aria-pressed={item.pinned}
            onClick={() => togglePin(item)}
          >
            {item.pinned ? (
              <PinOff size={14} strokeWidth={1.9} aria-hidden="true" />
            ) : (
              <Pin size={14} strokeWidth={1.9} aria-hidden="true" />
            )}
          </button>
        </span>
      </li>
    );
  };

  return (
    <TodayStageScaffold
      steps={steps}
      activeStepId="execute"
      onSelectStep={(id) => onNavigate(id as TodayRoute)}
    >
      <div className="today-content">
        {taskNotice || calendarNotice ? (
          <p className="today-notice" role="alert">
            <TriangleAlert size={13} strokeWidth={1.9} aria-hidden="true" />
            {(taskNotice ?? calendarNotice) === "conflict"
              ? t("today.execute.conflict")
              : calendarNotice === "calendarBlocked"
                ? t("today.calendar.blocked")
                : t("today.execute.error")}
          </p>
        ) : null}
        <div className="today-grid today-grid-execute">
          <section className="today-panel today-panel-top3">
            <header className="today-panel-header">
              <h3 className="today-panel-title">{t("today.execute.top3.title")}</h3>
            </header>
            <div className="today-panel-body">
              {top.length === 0 ? (
                <p className="today-panel-empty">{t("today.execute.top3.empty")}</p>
              ) : (
                <ol className="today-exec-list">
                  {top.map((item, index) => renderPlanRow(item, index + 1))}
                </ol>
              )}
            </div>
          </section>

          <section className="today-panel today-panel-fixed">
            <header className="today-panel-header">
              <h3 className="today-panel-title">{t("today.execute.fixed.title")}</h3>
            </header>
            <div className="today-panel-body">
              {fixedItems.length === 0 ? (
                <p className="today-panel-empty">{t("today.execute.fixed.empty")}</p>
              ) : (
                <ol className="today-exec-agenda">
                  {fixedItems.map((item) => (
                    <li key={planItemRefKey(item.itemRef)} className="today-exec-agenda-row">
                      <span className="today-exec-agenda-time">
                        {formatBlockRange(item.proposedBlock!.startIso, item.proposedBlock!.endIso)}
                      </span>
                      <span className="today-exec-title">
                        {item.outcome || resolveRefTitle(item.itemRef, tasks, [])}
                      </span>
                      <span className="today-exec-agenda-calendar">
                        {renderCalendarControl(item)}
                      </span>
                    </li>
                  ))}
                </ol>
              )}
            </div>
          </section>

          <section className="today-panel today-panel-flexible">
            <header className="today-panel-header">
              <h3 className="today-panel-title">{t("today.execute.flexible.title")}</h3>
            </header>
            <div className="today-panel-body">
              {flexible.length === 0 ? (
                <p className="today-panel-empty">{t("today.execute.flexible.empty")}</p>
              ) : (
                <ol className="today-exec-list">
                  {flexible.map((item) => (
                    <li
                      key={planItemRefKey(item.itemRef)}
                      className="today-exec-row"
                      tabIndex={0}
                      onClick={() => openSheet(item)}
                      onKeyDown={(event) => handleRowKeyDown(event, item)}
                    >
                      <span className="today-exec-title">
                        {item.outcome || resolveRefTitle(item.itemRef, tasks, [])}
                      </span>
                      {item.estimateMinutes ? (
                        <span className="today-exec-estimate">
                          {t("today.execute.estimate", { minutes: item.estimateMinutes })}
                        </span>
                      ) : null}
                      <span
                        className="today-exec-actions"
                        onClick={(event) => event.stopPropagation()}
                      >
                        {top.length < TOP_LANE_SIZE ? (
                          <button
                            type="button"
                            className="today-icon-button today-icon-button-sm"
                            aria-label={t("today.execute.flexible.promote")}
                            title={t("today.execute.flexible.promote")}
                            onClick={() => promote(item)}
                          >
                            <ArrowUpToLine size={14} strokeWidth={1.9} aria-hidden="true" />
                          </button>
                        ) : null}
                        {item.itemRef.kind === "task" ? (
                          <button
                            type="button"
                            className="today-icon-button today-icon-button-sm today-exec-complete"
                            aria-label={t("today.execute.complete")}
                            title={t("today.execute.complete")}
                            onClick={() => completeItem(item)}
                          >
                            <Check size={14} strokeWidth={2.2} aria-hidden="true" />
                          </button>
                        ) : null}
                      </span>
                    </li>
                  ))}
                </ol>
              )}
            </div>
          </section>

          <section className="today-panel today-panel-done">
            <header className="today-panel-header">
              <h3 className="today-panel-title">{t("today.execute.done.title")}</h3>
            </header>
            <div className="today-panel-body">
              {doneRows.length === 0 ? (
                <p className="today-panel-empty">{t("today.execute.done.empty")}</p>
              ) : (
                <ol className="today-exec-list">
                  {doneRows.map((row) => (
                    <li key={row.taskId} className="today-exec-row done">
                      <span className="today-exec-title">{row.title}</span>
                      {row.completedAt ? (
                        <span className="today-exec-time">{formatTime(row.completedAt)}</span>
                      ) : null}
                      <SyncBadge status={row.syncStatus} />
                      <span className="today-exec-actions">
                        <button
                          type="button"
                          className="today-icon-button today-icon-button-sm"
                          aria-label={t("today.execute.done.undo")}
                          title={t("today.execute.done.undo")}
                          onClick={() => reopenRow(row)}
                          disabled={!row.relPath}
                        >
                          <Undo2 size={14} strokeWidth={1.9} aria-hidden="true" />
                        </button>
                      </span>
                    </li>
                  ))}
                </ol>
              )}
              <TodaySyncStatus />
            </div>
          </section>
        </div>
      </div>
      <TaskSheet
        entry={sheetEntry}
        open={sheetTaskId !== null && sheetEntry !== null}
        onClose={() => setSheetTaskId(null)}
        onSaved={() => void refresh()}
      />
    </TodayStageScaffold>
  );
}

function SyncBadge({ status }: { status: TaskSyncStatus | null }) {
  const { t } = useTranslation();
  if (!status || status === "local") return null;
  if (status === "syncing") {
    return (
      <span className="today-sync-badge" role="status">
        <Loader2 size={12} strokeWidth={1.9} className="today-spin" aria-hidden="true" />
        {t("today.execute.sync.syncing")}
      </span>
    );
  }
  if (status === "synced") {
    return (
      <span className="today-sync-badge" role="status">
        <Check size={12} strokeWidth={2.2} aria-hidden="true" />
        {t("today.execute.sync.synced")}
      </span>
    );
  }
  return (
    <span className="today-sync-badge warn" role="status">
      <TriangleAlert size={12} strokeWidth={1.9} aria-hidden="true" />
      {status === "authBlocked"
        ? t("today.execute.sync.authBlocked")
        : t("today.execute.sync.retryNeeded")}
    </span>
  );
}

function formatTime(iso: string): string {
  const date = new Date(iso);
  return Number.isNaN(date.getTime()) ? iso : format(date, "HH:mm");
}

function formatBlockRange(startIso: string, endIso: string): string {
  return `${formatTime(startIso)}–${formatTime(endIso)}`;
}
