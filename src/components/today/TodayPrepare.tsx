// Maru Today — Prepare stage. Composes the real panels: brain dump editor,
// captured items, Top 3, capacity/constraints/sleep cards, and the tinted
// yesterday-review band. Owns the auto-planner + capture session state and
// wires change notifications between them.

import { useMemo, useRef, useState } from "react";
import { useTranslation } from "../../lib/i18n";
import type { CaptureCandidate, TodayRoute } from "../../lib/today";
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
import { useTodayCaptures } from "./useTodayCaptures";
import { useTodayPlanner, type TodayPlanner } from "./useTodayPlanner";

interface TodayPrepareProps {
  onNavigate: (route: TodayRoute) => void;
}

export function TodayPrepare({ onNavigate }: TodayPrepareProps) {
  const { t } = useTranslation();
  const { mutate } = useToday();
  const contentRef = useRef<HTMLDivElement | null>(null);

  // Planner first (its getCaptureCandidates reads a ref), captures second
  // (its onChanged notifies the planner via a ref) — breaks the cycle.
  const candidatesRef = useRef<CaptureCandidate[]>([]);
  const plannerRef = useRef<TodayPlanner | null>(null);
  const planner = useTodayPlanner({
    getCaptureCandidates: () => candidatesRef.current,
  });
  plannerRef.current = planner;
  const captures = useTodayCaptures({
    onChanged: (kind) => plannerRef.current?.notifyChange(kind),
  });
  candidatesRef.current = captures.visible;

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

  return (
    <TodayStageScaffold
      steps={steps}
      activeStepId={activeId}
      onSelectStep={select}
      onQuickSkip={quickSkip}
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
          <TodayCapacityCards onNavigate={onNavigate} />
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
