// Maru Today — Prepare stage. Composes the real panels: brain dump editor,
// captured items, Top 3, capacity/constraints/sleep cards, and the tinted
// yesterday-review band. Owns the auto-planner + capture session state and
// wires change notifications between them.

import { AlertTriangle } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "../../lib/i18n";
import type {
  CaptureCandidate,
  CaptureMaterializationInput,
  TodayRoute,
} from "../../lib/today";
import { todayFinalizeIdempotencyKey } from "../../lib/today";
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
  const { workPath, snapshot, finalizeSetup, reload } = useToday();
  const contentRef = useRef<HTMLDivElement | null>(null);
  const [finishing, setFinishing] = useState(false);
  const [pendingFinalize, setPendingFinalize] = useState<"confirm" | "skip" | null>(
    null,
  );
  const brainDumpFlushRef = useRef<() => Promise<void>>(async () => {});

  // Planner first (its getCaptureCandidates reads a ref), captures second
  // (its onChanged notifies the planner via a ref) — breaks the cycle.
  const candidatesRef = useRef<CaptureCandidate[]>([]);
  const plannerRef = useRef<TodayPlanner | null>(null);
  const {
    commitments,
    loading: calendarLoading,
    error: calendarError,
  } = useCalendarCommitments();
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
      { id: "capture", label: t("today.steps.capture") },
      { id: "confirm", label: t("today.steps.confirm") },
    ],
    [t],
  );
  const { activeId, select } = useActiveSection(
    steps.map((step) => step.id),
    contentRef,
  );

  const unresolvedCount = useMemo(
    () => (snapshot?.yesterday ?? []).filter((item) => item.resolution == null).length,
    [snapshot],
  );

  const finalize = async (action: "confirm" | "skip") => {
    if (!workPath || !snapshot || !finalizeSetup || finishing) return;
    setFinishing(true);
    try {
      await brainDumpFlushRef.current();
      // The flush can advance the revision. Refresh once so the finalize
      // request is based on the exact persisted snapshot.
      const refreshed = await reload();
      const base =
        refreshed && typeof refreshed === "object" ? refreshed : snapshot;
      const plan = action === "confirm" ? (base.plan ?? null) : null;
      const captureIds = new Set(
        plan
          ? [...plan.top, ...plan.flexible, ...plan.overflow]
              .filter((item) => item.itemRef.kind === "capture")
              .map((item) =>
                item.itemRef.kind === "capture" ? item.itemRef.captureId : "",
              )
          : [],
      );
      const materializations: CaptureMaterializationInput[] = captures.visible
        .filter((candidate) => captureIds.has(candidate.captureId))
        .map((candidate) => ({
          captureId: candidate.captureId,
          title: candidate.title,
          summary: candidate.summary,
          project: candidate.project ?? null,
          dueDate: candidate.dueDate ?? null,
          estimateMinutes: candidate.estimateMinutes ?? null,
        }));
      const outcome = await finalizeSetup({
        logicalDay: base.logicalDay,
        expectedRevision: base.revision,
        idempotencyKey: todayFinalizeIdempotencyKey(
          base,
          action,
          plan,
          materializations,
        ),
        action,
        plan,
        captures: materializations,
        unresolvedPolicy: "keepLater",
      });
      if (!outcome) return;
      setPendingFinalize(null);
      onNavigate("execute");
    } finally {
      setFinishing(false);
    }
  };

  const requestFinalize = (action: "confirm" | "skip") => {
    if (unresolvedCount > 0) {
      setPendingFinalize(action);
      return;
    }
    void finalize(action);
  };

  const registerBrainDumpFlush = useCallback((flush: () => Promise<void>) => {
    brainDumpFlushRef.current = flush;
    return () => {
      brainDumpFlushRef.current = async () => {};
    };
  }, []);

  return (
    <TodayStageScaffold
      steps={steps}
      activeStepId={activeId}
      onSelectStep={select}
      onQuickSkip={() => requestFinalize("skip")}
      onFinishSetup={() => requestFinalize("confirm")}
      finishSetupBusy={finishing}
    >
      <div className="today-content" ref={contentRef}>
        <div className="today-grid">
          <TodayBrainDump
            planning={planner.planning}
            lastDiffCount={planner.lastDiffCount}
            onAutoPlan={() => void planner.runPlanNow()}
            onSaved={() => planner.notifyChange("brainDump")}
            onRegisterFlush={registerBrainDumpFlush}
          />
          <TodayCapture captures={captures} />
          <TodayTop3
            tasks={planner.tasks}
            captures={captures.visible}
            markManualOrder={planner.markManualOrder}
            onChanged={planner.notifyChange}
            onOpenTaskSheet={setSheetTaskId}
          />
          <TodayCapacityCards
            onNavigate={onNavigate}
            commitments={commitments}
            calendarLoading={calendarLoading}
            calendarError={calendarError}
          />
          <TodayYesterday
            onChanged={planner.notifyChange}
            tasks={planner.tasks}
          />
        </div>
      </div>
      <TaskSheet
        entry={sheetEntry}
        open={sheetTaskId !== null && sheetEntry !== null}
        onClose={() => setSheetTaskId(null)}
        onSaved={() => planner.notifyChange("tasks")}
      />
      {pendingFinalize ? (
        <div
          className="today-preflight-backdrop"
          role="presentation"
          onMouseDown={(event) => {
            if (event.target === event.currentTarget && !finishing) {
              setPendingFinalize(null);
            }
          }}
        >
          <section
            className="today-preflight-dialog"
            role="dialog"
            aria-modal="true"
            aria-labelledby="today-preflight-title"
            aria-describedby="today-preflight-description"
            onKeyDown={(event) => {
              if (event.key === "Escape" && !finishing) setPendingFinalize(null);
            }}
          >
            <AlertTriangle size={20} aria-hidden="true" />
            <div>
              <h2 id="today-preflight-title">{t("today.preflight.title")}</h2>
              <p id="today-preflight-description">
                {t("today.preflight.description", { count: unresolvedCount })}
              </p>
            </div>
            <div className="today-preflight-actions">
              <button
                type="button"
                className="secondary-button"
                disabled={finishing}
                onClick={() => setPendingFinalize(null)}
              >
                {t("common.cancel")}
              </button>
              <button
                type="button"
                className="secondary-button"
                disabled={finishing}
                onClick={() => {
                  setPendingFinalize(null);
                  select("yesterday");
                }}
              >
                {t("today.preflight.resolve")}
              </button>
              <button
                type="button"
                className="button button-primary"
                disabled={finishing}
                autoFocus
                onClick={() => void finalize(pendingFinalize)}
              >
                {t("today.preflight.continue", { count: unresolvedCount })}
              </button>
            </div>
          </section>
        </div>
      ) : null}
    </TodayStageScaffold>
  );
}
