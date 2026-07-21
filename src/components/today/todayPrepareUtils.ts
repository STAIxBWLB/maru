// Maru Today — Prepare-stage shared helpers: plan shell for the first
// mutation of the day, task/ref key helpers, and capture channel mapping.

import type { CaptureCandidate, DailyPlanV1, PlanItemRef, TodaySnapshot } from "../../lib/today";
import type { TaskEntry } from "../../lib/tasks";

/** Empty plan used as the base when the day's first plan edit (capture add /
 *  manual outcome) lands before any planner run produced one. */
export function emptyPlanShell(snapshot: TodaySnapshot): DailyPlanV1 {
  return {
    logicalDay: snapshot.logicalDay,
    inputRevision: snapshot.revision,
    top: [],
    flexible: [],
    overflow: [],
    reasons: [],
    warnings: [],
  };
}

/** Stable task key, mirroring todayPlan.ts `taskKey`. */
export function taskKeyOf(task: TaskEntry): string {
  return task.taskId ?? task.relPath;
}

/** Channel/provider key used for capture filter chips and brand icons. */
export function captureChannel(candidate: CaptureCandidate): string {
  return candidate.provider || "unknown";
}

/** Display title for a plan item ref: task title, capture title, else the
 *  raw id (honest fallback when the source row has not loaded yet). */
export function resolveRefTitle(
  ref: PlanItemRef,
  tasks: TaskEntry[],
  captures: CaptureCandidate[],
): string {
  if (ref.kind === "task") {
    return tasks.find((task) => taskKeyOf(task) === ref.taskId)?.title ?? ref.taskId;
  }
  return captures.find((capture) => capture.captureId === ref.captureId)?.title ?? ref.captureId;
}

/** YYYY-MM-DD `days` after the given logical day (plain date math, no tz). */
export function addDaysIso(logicalDay: string, days: number): string {
  const [year, month, day] = logicalDay.split("-").map(Number);
  const date = new Date(Date.UTC(year, (month || 1) - 1, day || 1));
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}
