// Maru Today — Prepare stage. Composes the real panels: brain dump editor,
// captured items, Top 3, capacity/constraints/sleep cards, and the tinted
// yesterday-review band. Owns the auto-planner + capture session state and
// wires change notifications between them.

import { useEffect, useMemo, useRef, useState } from "react";
import { createTaskNote } from "../../lib/api";
import { useTranslation } from "../../lib/i18n";
import type {
  CaptureCandidate,
  DailyPlanItem,
  DailyPlanV1,
  TodayRoute,
} from "../../lib/today";
import { TaskSheet } from "./TaskSheet";
import { useToday } from "./todayContext";
import { TodayBrainDump } from "./TodayBrainDump";
import { TodayCapacityCards } from "./TodayCapacityCards";
import { TodayCapture } from "./TodayCapture";
import { TodayStageScaffold } from "./TodayStageScaffold";
import { TodayTop3 } from "./TodayTop3";
import { TodayYesterday } from "./TodayYesterday";
import { taskKeyOf } from "./todayPrepareUtils";
import { useActiveSection } from "./useActiveSection";
import { useCalendarCommitments } from "./useCalendarCommitments";
import { useTodayCaptures } from "./useTodayCaptures";
import { useTodayPlanner, type TodayPlanner } from "./useTodayPlanner";

interface TodayPrepareProps {
  onNavigate: (route: TodayRoute) => void;
}

export function TodayPrepare({ onNavigate }: TodayPrepareProps) {
  const { t } = useTranslation();
  const { workPath, snapshot, mutate } = useToday();
  const contentRef = useRef<HTMLDivElement | null>(null);
  const [finishing, setFinishing] = useState(false);

  // Planner first (its getCaptureCandidates reads a ref), captures second
  // (its onChanged notifies the planner via a ref) — breaks the cycle.
  const candidatesRef = useRef<CaptureCandidate[]>([]);
  const plannerRef = useRef<TodayPlanner | null>(null);
  const { commitments } = useCalendarCommitments();
  const planner = useTodayPlanner({
    getCaptureCandidates: () => candidatesRef.current,
    commitments,
  });
  plannerRef.current = planner;
  const captures = useTodayCaptures({
    onChanged: (kind) => plannerRef.current?.notifyChange(kind),
  });
  candidatesRef.current = captures.visible;

  // A fresh commitments set changes the capacity budget — let the planner
  // know (debounced; no-op when autoPlan is off).
  const commitmentsRef = useRef(commitments);
  useEffect(() => {
    if (commitmentsRef.current === commitments) return;
    commitmentsRef.current = commitments;
    plannerRef.current?.notifyChange("calendar");
  }, [commitments]);

  const [sheetTaskId, setSheetTaskId] = useState<string | null>(null);
  const sheetEntry = sheetTaskId
    ? (planner.tasks.find((task) => taskKeyOf(task) === sheetTaskId) ?? null)
    : null;

  const steps = useMemo(
    () => [
      { id: "yesterday", label: t("today.steps.yesterday") },
      { id: "braindump", label: t("today.steps.braindump") },
      { id: "confirm", label: t("today.steps.confirm") },
    ],
    [t],
  );
  const { activeId, select } = useActiveSection(
    steps.map((step) => step.id),
    contentRef,
  );

  const quickSkip = () => {
    // Best-effort: persist the skip when a snapshot is loaded, then move on
    // either way (degraded mode still navigates).
    void mutate({ type: "quickSkip" }).finally(() => onNavigate("execute"));
  };

  // Finish setup: materialize accepted capture items as local task notes,
  // rewrite their plan refs to the new tasks, confirm the day, land on
  // Execute. Local notes only — Google Task creation stays a separate opt-in.
  const finishSetup = async () => {
    if (!workPath || !snapshot || finishing) return;
    setFinishing(true);
    try {
      let plan = snapshot.plan;
      if (plan) {
        const captureRefs = [...plan.top, ...plan.flexible, ...plan.overflow]
          .map((item) => item.itemRef)
          .filter((ref): ref is Extract<typeof ref, { kind: "capture" }> => ref.kind === "capture");
        if (captureRefs.length > 0) {
          const refToTaskId = new Map<string, string>();
          for (const ref of captureRefs) {
            const candidate = captures.visible.find(
              (entry) => entry.captureId === ref.captureId,
            );
            if (!candidate) {
              console.warn("today finish setup: capture candidate missing", ref.captureId);
              return; // abort — do not confirm a plan we cannot materialize
            }
            const row = await createTaskNote(workPath, {
              slug: candidate.title,
              title: candidate.title,
              bucket: "active",
              frontmatter: {
                title: candidate.title,
                status: "active",
                priority: "medium",
                ...(candidate.project ? { project: candidate.project } : {}),
                ...(candidate.dueDate ? { due: candidate.dueDate } : {}),
                ...(candidate.estimateMinutes
                  ? { estimateMinutes: candidate.estimateMinutes }
                  : {}),
              },
              body: `# ${candidate.title}\n\n${candidate.summary}\n`,
            });
            const taskId =
              (typeof row.frontmatter.taskId === "string" && row.frontmatter.taskId) ||
              row.relPath;
            refToTaskId.set(ref.captureId, taskId);
          }
          const rewriteLane = (items: DailyPlanItem[]): DailyPlanItem[] =>
            items.map((item) =>
              item.itemRef.kind === "capture" && refToTaskId.has(item.itemRef.captureId)
                ? {
                    ...item,
                    itemRef: {
                      kind: "task",
                      taskId: refToTaskId.get(item.itemRef.captureId) as string,
                    },
                  }
                : item,
            );
          const rewritten: DailyPlanV1 = {
            ...plan,
            top: rewriteLane(plan.top),
            flexible: rewriteLane(plan.flexible),
            overflow: rewriteLane(plan.overflow),
          };
          const applied = await mutate({ type: "setPlan", plan: rewritten });
          if (!applied) {
            console.warn("today finish setup: plan rewrite failed");
            return;
          }
          plan = applied.plan;
        }
      }
      const confirmed = await mutate({ type: "confirmSetup" });
      if (!confirmed) {
        console.warn("today finish setup: confirmSetup failed");
        return;
      }
      onNavigate("execute");
    } finally {
      setFinishing(false);
    }
  };

  return (
    <TodayStageScaffold
      steps={steps}
      activeStepId={activeId}
      onSelectStep={select}
      onQuickSkip={quickSkip}
      onFinishSetup={() => void finishSetup()}
      finishSetupBusy={finishing}
    >
      <div className="today-content" ref={contentRef}>
        <div className="today-grid">
          <TodayBrainDump
            planning={planner.planning}
            lastDiffCount={planner.lastDiffCount}
            onAutoPlan={() => void planner.runPlanNow()}
            onSaved={() => planner.notifyChange("brainDump")}
          />
          <TodayCapture captures={captures} onNavigate={onNavigate} />
          <TodayTop3
            tasks={planner.tasks}
            captures={captures.visible}
            markManualOrder={planner.markManualOrder}
            onChanged={planner.notifyChange}
            onOpenTaskSheet={setSheetTaskId}
          />
          <TodayCapacityCards onNavigate={onNavigate} commitments={commitments} />
          <TodayYesterday onChanged={planner.notifyChange} onNavigate={onNavigate} />
        </div>
      </div>
      <TaskSheet
        entry={sheetEntry}
        open={sheetTaskId !== null && sheetEntry !== null}
        onClose={() => setSheetTaskId(null)}
        onSaved={() => planner.notifyChange("tasks")}
      />
    </TodayStageScaffold>
  );
}
