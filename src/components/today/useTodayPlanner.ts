// Maru Today — auto-plan orchestration for the Prepare stage. Wraps
// createAutoPlanner (todayPlan.ts) with the deterministic fallback planner as
// the invokePlan implementation; the AI invoke path (todayBuildPlanRequest →
// AI runtime → todayApplyPlanResult) lands in a later commit group and swaps
// in behind the same seam.

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { scanTaskNotes } from "../../lib/api";
import { rowsToTaskEntries, type TaskEntry } from "../../lib/tasks";
import type {
  CaptureCandidate,
  DailyPlanV1,
  PlanItemRef,
  TodayMutation,
  TodaySnapshot,
} from "../../lib/today";
import {
  buildDeterministicPlan,
  computeCapacitySummary,
  createAutoPlanner,
  diffPlans,
  planItemRefKey,
  preserveProtected,
  type AutoPlanRunContext,
  type AutoPlanner,
} from "../../lib/todayPlan";
import { useToday } from "./todayContext";

export interface TodayPlanner {
  /** Most recently scanned task rows (title resolution + outcome picker). */
  tasks: TaskEntry[];
  /** True while a manual plan run is in flight. */
  planning: boolean;
  /** Item count adjusted by the last auto-applied plan (transient, for the
   *  subtle diff line near Undo). Null when nothing recent to report. */
  lastDiffCount: number | null;
  /** Debounced change notification (no-op when settings.autoPlan is off). */
  notifyChange: (kind: string) => void;
  /** Immediate plan run (the "자동 계획 만들기" button). */
  runPlanNow: () => Promise<void>;
  /** Mark refs as manually ordered so auto-planning keeps their position. */
  markManualOrder: (refs: PlanItemRef[]) => void;
}

interface UseTodayPlannerArgs {
  /** Live read of the session's capture candidates (for accepted captures). */
  getCaptureCandidates: () => CaptureCandidate[];
}

const DIFF_SUMMARY_MS = 6000;

export function useTodayPlanner({ getCaptureCandidates }: UseTodayPlannerArgs): TodayPlanner {
  const { workPath, settings, snapshot, mutate } = useToday();
  const [tasks, setTasks] = useState<TaskEntry[]>([]);
  const [planning, setPlanning] = useState(false);
  const [lastDiffCount, setLastDiffCount] = useState<number | null>(null);

  const snapshotRef = useRef<TodaySnapshot | null>(snapshot);
  snapshotRef.current = snapshot;
  const manualOrderRef = useRef<Set<string>>(new Set());
  const diffTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const refreshTasks = useCallback(async (): Promise<TaskEntry[]> => {
    if (!workPath) return [];
    try {
      const entries = rowsToTaskEntries(await scanTaskNotes(workPath));
      setTasks(entries);
      return entries;
    } catch {
      return [];
    }
  }, [workPath]);

  useEffect(() => {
    void refreshTasks();
  }, [refreshTasks]);

  const announceDiff = useCallback((prev: DailyPlanV1 | null, next: DailyPlanV1 | null) => {
    const diff = diffPlans(prev, next);
    const count = diff.added.length + diff.removed.length + diff.moved.length + diff.changed.length;
    if (count === 0) return;
    setLastDiffCount(count);
    if (diffTimerRef.current !== null) clearTimeout(diffTimerRef.current);
    diffTimerRef.current = setTimeout(() => setLastDiffCount(null), DIFF_SUMMARY_MS);
  }, []);

  useEffect(
    () => () => {
      if (diffTimerRef.current !== null) clearTimeout(diffTimerRef.current);
    },
    [],
  );

  /** One plan run. Deterministic fallback for now; the AI path replaces the
   *  body of this callback behind the same AutoPlanner seam. Returns null
   *  when the run would be a no-op (plan unchanged). */
  const invokePlan = useCallback(
    async (ctx: AutoPlanRunContext): Promise<DailyPlanV1 | null> => {
      const snap = snapshotRef.current;
      if (!snap) return null;
      const scanned = await refreshTasks();
      const existing = snap.plan ?? null;
      const plannedCaptureIds = new Set(
        [...(existing?.top ?? []), ...(existing?.flexible ?? []), ...(existing?.overflow ?? [])]
          .map((item) => item.itemRef)
          .filter((ref) => ref.kind === "capture")
          .map((ref) => planItemRefKey(ref)),
      );
      const acceptedCaptures = getCaptureCandidates().filter((candidate) =>
        plannedCaptureIds.has(planItemRefKey({ kind: "capture", captureId: candidate.captureId })),
      );
      // TODO(calendar): pass real busy commitments once the calendar lane
      // (Group 3) exposes them; availability math already supports them.
      const capacity = computeCapacitySummary({
        dayStart: snap.dayStart,
        sleepStart: snap.sleepStart,
        busy: [],
        focusCapMinutes: settings.dailyFocusCapMinutes,
        plan: existing,
        provisionalEstimateMinutes: settings.provisionalEstimateMinutes,
        logicalDay: snap.logicalDay,
      });
      const proposed = buildDeterministicPlan({
        logicalDay: snap.logicalDay,
        inputRevision: ctx.inputRevision ?? snap.revision,
        tasks: scanned,
        acceptedCaptures,
        yesterday: snap.yesterday,
        pinned: existing,
        capacityMinutes: capacity.focusCapMinutes,
        provisionalEstimateMinutes: settings.provisionalEstimateMinutes,
      });
      const merged = preserveProtected(existing, proposed, {
        manualOrder: manualOrderRef.current,
      });
      if (!existing && merged.top.length === 0 && merged.flexible.length === 0) return null;
      const diff = diffPlans(existing, merged);
      const changed =
        diff.added.length + diff.removed.length + diff.moved.length + diff.changed.length;
      return changed > 0 ? merged : null;
    },
    [refreshTasks, getCaptureCandidates, settings],
  );

  const invokePlanRef = useRef(invokePlan);
  invokePlanRef.current = invokePlan;

  const plannerRef = useRef<AutoPlanner | null>(null);
  const logicalDay = snapshot?.logicalDay ?? "";
  useEffect(() => {
    if (!workPath || !logicalDay) {
      plannerRef.current = null;
      return;
    }
    const planner = createAutoPlanner({
      workPath,
      logicalDay,
      getSnapshot: () => snapshotRef.current,
      mutate: async (mutation: TodayMutation, _expectedRevision: string) => {
        const prevPlan = snapshotRef.current?.plan ?? null;
        const next = await mutate(mutation);
        if (!next) throw new Error("today planner: mutate failed");
        announceDiff(prevPlan, next.plan ?? null);
        return next;
      },
      invokePlan: (ctx) => invokePlanRef.current(ctx),
    });
    plannerRef.current = planner;
    return () => planner.cancel();
  }, [workPath, logicalDay, mutate, announceDiff]);

  const notifyChange = useCallback(
    (kind: string) => {
      if (!settings.autoPlan) return;
      plannerRef.current?.notifyChange(kind);
    },
    [settings.autoPlan],
  );

  const runPlanNow = useCallback(async () => {
    plannerRef.current?.cancel();
    const snap = snapshotRef.current;
    if (!snap) return;
    setPlanning(true);
    try {
      const plan = await invokePlanRef.current({
        workPath: workPath ?? "",
        logicalDay: snap.logicalDay,
        inputRevision: snap.revision,
        reason: "brainDump",
      });
      if (plan) {
        const next = await mutate({ type: "setPlan", plan });
        if (next) announceDiff(snap.plan ?? null, next.plan ?? null);
      }
    } finally {
      setPlanning(false);
    }
  }, [workPath, mutate, announceDiff]);

  const markManualOrder = useCallback((refs: PlanItemRef[]) => {
    for (const ref of refs) manualOrderRef.current.add(planItemRefKey(ref));
  }, []);

  return useMemo(
    () => ({
      tasks,
      planning,
      lastDiffCount,
      notifyChange,
      runPlanNow,
      markManualOrder,
    }),
    [tasks, planning, lastDiffCount, notifyChange, runPlanNow, markManualOrder],
  );
}
