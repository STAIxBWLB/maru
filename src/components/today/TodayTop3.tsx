// Maru Today — Prepare panel: the suggested Top 3. Pointer drag reorder AND
// keyboard reorder (buttons + Alt+Arrow keys) with polite live rank
// announcements; reorders are persisted via setPlan and protected from
// auto-planning through the manualOrder set.

import {
  ArrowDown,
  ArrowUp,
  Check,
  GripVertical,
  Pencil,
  Plus,
  TriangleAlert,
  X,
} from "lucide-react";
import { useMemo, useRef, useState } from "react";
import { useTranslation } from "../../lib/i18n";
import type { TaskEntry } from "../../lib/tasks";
import type {
  CaptureCandidate,
  DailyPlanItem,
  PlanItemRef,
  TodayMutation,
} from "../../lib/today";
import { TOP_LANE_SIZE } from "../../lib/todayPlan";
import { useToday } from "./todayContext";
import { usePointerReorder } from "../ui/usePointerReorder";
import { emptyPlanShell, resolveRefTitle, taskKeyOf } from "./todayPrepareUtils";

interface TodayTop3Props {
  tasks: TaskEntry[];
  captures: CaptureCandidate[];
  /** Mark refs as manually ordered (auto-plan keeps their position). */
  markManualOrder: (refs: PlanItemRef[]) => void;
  /** Auto-plan trigger after a structural change (e.g. outcome add). */
  onChanged: (kind: string) => void;
  /** Open the task sheet for a task-backed row (falls back to inline
   *  outcome editing when absent or the row is capture-backed). */
  onOpenTaskSheet?: (taskId: string) => void;
}

function planItemKey(item: DailyPlanItem): string {
  return `${item.itemRef.kind}:${
    item.itemRef.kind === "task" ? item.itemRef.taskId : item.itemRef.captureId
  }`;
}

export function TodayTop3({ tasks, captures, markManualOrder, onChanged, onOpenTaskSheet }: TodayTop3Props) {
  const { t } = useTranslation();
  const { snapshot, mutate } = useToday();

  const [announcement, setAnnouncement] = useState("");
  const [editingIndex, setEditingIndex] = useState<number | null>(null);
  const [editValue, setEditValue] = useState("");
  const [adding, setAdding] = useState(false);
  const [addOutcome, setAddOutcome] = useState("");
  const [addTaskId, setAddTaskId] = useState("");
  const [showMaxWarning, setShowMaxWarning] = useState(false);
  const [optimisticTop, setOptimisticTop] = useState<DailyPlanItem[] | null>(null);
  const orderMutationRef = useRef(0);

  const snapshotTop = useMemo(() => {
    const items = [...(snapshot?.plan?.top ?? [])];
    items.sort((a, b) => a.order - b.order);
    return items;
  }, [snapshot]);
  const top = optimisticTop ?? snapshotTop;

  const displayTitle = (item: DailyPlanItem) =>
    item.outcome || resolveRefTitle(item.itemRef, tasks, captures);

  const pickerTasks = useMemo(() => {
    // Already-planned tasks (any lane) are excluded — adding one again would
    // duplicate its plan ref (React key collision, double-counted capacity).
    const plan = snapshot?.plan;
    const planned = new Set(
      [...(plan?.top ?? []), ...(plan?.flexible ?? []), ...(plan?.overflow ?? [])]
        .map((item) => item.itemRef)
        .filter((ref): ref is Extract<PlanItemRef, { kind: "task" }> => ref.kind === "task")
        .map((ref) => ref.taskId),
    );
    return tasks.filter(
      (task) =>
        task.bucket !== "archive" &&
        task.bucket !== "backlog" &&
        task.status !== "done" &&
        task.status !== "cancelled" &&
        task.status !== "backlog" &&
        !planned.has(taskKeyOf(task)),
    );
  }, [tasks, snapshot]);

  const applyMutation = async (mutation: TodayMutation) => {
    await mutate(mutation);
  };

  const persistOrder = (
    ordered: DailyPlanItem[],
    moved: DailyPlanItem,
    to: number,
  ) => {
    if (!snapshot) return;
    const reindexed = ordered.map((item, index) => ({ ...item, order: index }));
    setOptimisticTop(reindexed);
    markManualOrder(reindexed.map((item) => item.itemRef));
    setAnnouncement(t("today.top3.moved", { title: displayTitle(moved), rank: to + 1 }));
    const plan = { ...(snapshot.plan ?? emptyPlanShell(snapshot)), top: reindexed };
    const mutationId = ++orderMutationRef.current;
    void applyMutation({ type: "setPlan", plan }).finally(() => {
      if (orderMutationRef.current === mutationId) setOptimisticTop(null);
    });
  };

  const move = (from: number, to: number) => {
    if (!snapshot) return;
    if (to < 0 || to >= top.length || from === to) return;
    const next = [...top];
    const [moved] = next.splice(from, 1);
    next.splice(to, 0, moved);
    persistOrder(next, moved, to);
  };

  const pointerReorder = usePointerReorder({
    items: top,
    getId: planItemKey,
    onCommit: ({ items, draggedId, toIndex }) => {
      const moved = items.find((item) => planItemKey(item) === draggedId);
      if (moved) persistOrder(items, moved, toIndex);
    },
  });

  const handleRowKeyDown = (event: React.KeyboardEvent, index: number) => {
    if (!event.altKey) return;
    if (event.key === "ArrowUp") {
      event.preventDefault();
      move(index, index - 1);
    } else if (event.key === "ArrowDown") {
      event.preventDefault();
      move(index, index + 1);
    }
  };

  const startEdit = (index: number) => {
    const item = top[index];
    if (item && item.itemRef.kind === "task" && onOpenTaskSheet) {
      onOpenTaskSheet(item.itemRef.taskId);
      return;
    }
    setEditingIndex(index);
    setEditValue(item?.outcome ?? "");
  };

  const commitEdit = () => {
    if (editingIndex === null || !snapshot) return;
    const next = top.map((item, index) =>
      index === editingIndex ? { ...item, outcome: editValue.trim() || null } : item,
    );
    const plan = { ...(snapshot.plan ?? emptyPlanShell(snapshot)), top: next };
    void applyMutation({ type: "setPlan", plan });
    setEditingIndex(null);
  };

  const openAdd = () => {
    if (top.length >= TOP_LANE_SIZE) {
      // Top 3 max enforced: warn instead of adding.
      setShowMaxWarning(true);
      return;
    }
    setAdding(true);
    setAddOutcome("");
    setAddTaskId(pickerTasks[0] ? taskKeyOf(pickerTasks[0]) : "");
  };

  const confirmAdd = () => {
    if (!snapshot || !addTaskId || top.length >= TOP_LANE_SIZE) return;
    // Stale picker selection guard: never add a ref already in the plan.
    if (!pickerTasks.some((task) => taskKeyOf(task) === addTaskId)) return;
    const item: DailyPlanItem = {
      itemRef: { kind: "task", taskId: addTaskId },
      lane: "top",
      order: top.length,
      outcome: addOutcome.trim() || null,
      estimateMinutes: null,
      estimateProvisional: true,
      pinned: false,
      proposedBlock: null,
      calendarSync: { status: "none" },
    };
    const next = [...top, item];
    markManualOrder(next.map((entry) => entry.itemRef));
    const plan = { ...(snapshot.plan ?? emptyPlanShell(snapshot)), top: next };
    void applyMutation({ type: "setPlan", plan }).then(() => onChanged("tasks"));
    setAdding(false);
  };

  return (
    <section className="today-panel today-panel-top3" data-today-section="confirm">
      <header className="today-panel-header">
        <h3 className="today-panel-title">{t("today.panel.top3.title")}</h3>
      </header>
      <div className="today-panel-body">
        <div aria-live="polite" className="today-sr-only">
          {announcement}
        </div>
        {top.length === 0 ? (
          <p className="today-panel-empty">{t("today.top3.empty")}</p>
        ) : (
          <ol className="today-top3-list">
            {top.map((item, index) => {
              const id = planItemKey(item);
              const reorderState = pointerReorder.rowState(id);
              return (
                <li
                  key={id}
                  data-reorder-id={id}
                  className={[
                    "today-top3-row",
                    reorderState.dragging ? "is-dragging" : "",
                    reorderState.indicator ?? "",
                  ].filter(Boolean).join(" ")}
                  style={reorderState.style}
                  tabIndex={0}
                  onKeyDown={(event) => handleRowKeyDown(event, index)}
                >
                <button
                  type="button"
                  className="today-top3-grip"
                  aria-label={t("today.top3.reorder")}
                  title={t("today.top3.reorder")}
                  onPointerDown={(event) => pointerReorder.begin(event, id)}
                >
                  <GripVertical
                    size={14}
                    strokeWidth={1.9}
                    aria-hidden="true"
                  />
                </button>
                <span className="today-top3-rank">{index + 1}</span>
                {editingIndex === index ? (
                  <input
                    className="today-top3-edit-input"
                    value={editValue}
                    onChange={(event) => setEditValue(event.target.value)}
                    onKeyDown={(event) => {
                      if (event.key === "Enter") commitEdit();
                      if (event.key === "Escape") setEditingIndex(null);
                    }}
                    placeholder={t("today.top3.outcomePlaceholder")}
                    aria-label={t("today.top3.editOutcome")}
                  />
                ) : (
                  <span className="today-top3-title">{displayTitle(item)}</span>
                )}
                <span className="today-top3-actions">
                  <button
                    type="button"
                    className="today-icon-button today-icon-button-sm"
                    aria-label={t("today.top3.moveUp")}
                    title={t("today.top3.moveUp")}
                    onClick={() => move(index, index - 1)}
                    disabled={index === 0}
                  >
                    <ArrowUp size={14} strokeWidth={1.9} aria-hidden="true" />
                  </button>
                  <button
                    type="button"
                    className="today-icon-button today-icon-button-sm"
                    aria-label={t("today.top3.moveDown")}
                    title={t("today.top3.moveDown")}
                    onClick={() => move(index, index + 1)}
                    disabled={index === top.length - 1}
                  >
                    <ArrowDown size={14} strokeWidth={1.9} aria-hidden="true" />
                  </button>
                  {editingIndex === index ? (
                    <button
                      type="button"
                      className="today-icon-button today-icon-button-sm"
                      aria-label={t("today.top3.saveEdit")}
                      title={t("today.top3.saveEdit")}
                      onClick={commitEdit}
                    >
                      <Check size={14} strokeWidth={1.9} aria-hidden="true" />
                    </button>
                  ) : (
                    <button
                      type="button"
                      className="today-icon-button today-icon-button-sm"
                      aria-label={t("today.top3.editOutcome")}
                      title={t("today.top3.editOutcome")}
                      onClick={() => startEdit(index)}
                    >
                      <Pencil size={14} strokeWidth={1.9} aria-hidden="true" />
                    </button>
                  )}
                </span>
                </li>
              );
            })}
          </ol>
        )}
        {showMaxWarning && top.length >= TOP_LANE_SIZE ? (
          <p className="today-top3-warning" role="alert">
            <TriangleAlert size={13} strokeWidth={1.9} aria-hidden="true" />
            {t("today.top3.maxWarning")}
          </p>
        ) : null}
        {adding ? (
          <div className="today-top3-addform">
            <input
              className="today-top3-edit-input"
              value={addOutcome}
              onChange={(event) => setAddOutcome(event.target.value)}
              placeholder={t("today.top3.outcomePlaceholder")}
              aria-label={t("today.top3.addOutcome")}
            />
            <select
              className="today-top3-select"
              value={addTaskId}
              onChange={(event) => setAddTaskId(event.target.value)}
              aria-label={t("today.top3.pickTask")}
            >
              {pickerTasks.map((task) => (
                <option key={taskKeyOf(task)} value={taskKeyOf(task)}>
                  {task.title}
                </option>
              ))}
            </select>
            <button
              type="button"
              className="today-icon-button today-icon-button-sm"
              aria-label={t("today.top3.confirmAdd")}
              title={t("today.top3.confirmAdd")}
              onClick={confirmAdd}
              disabled={!addTaskId}
            >
              <Check size={14} strokeWidth={1.9} aria-hidden="true" />
            </button>
            <button
              type="button"
              className="today-icon-button today-icon-button-sm"
              aria-label={t("today.top3.cancelAdd")}
              title={t("today.top3.cancelAdd")}
              onClick={() => setAdding(false)}
            >
              <X size={14} strokeWidth={1.9} aria-hidden="true" />
            </button>
          </div>
        ) : (
          <button type="button" className="today-top3-add" onClick={openAdd} disabled={!snapshot}>
            <Plus size={14} strokeWidth={1.9} aria-hidden="true" />
            {t("today.top3.addOutcome")}
          </button>
        )}
      </div>
    </section>
  );
}
