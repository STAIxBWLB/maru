// Maru Today — capture lane state for the Prepare stage. Loads capture
// candidates from local pending inbox items (read-only; no provider fan-out)
// and tracks optimistic session state. Defer/dismiss decisions persist in the
// day snapshot; accepted captures stay reversible plan items until the atomic
// Finish setup command materializes them.

import { useCallback, useEffect, useMemo, useState } from "react";
import {
  applyCaptureDecision,
  buildCaptureCandidates,
  partitionCandidates,
} from "../../lib/todayCapture";
import type { CaptureCandidate, CaptureDecision } from "../../lib/today";
import { useToday } from "./todayContext";
import { addDaysIso, emptyPlanShell } from "./todayPrepareUtils";

export interface CaptureSessionEntry {
  decision: CaptureDecision;
  deferDate: string | null;
}

export interface TodayCaptures {
  /** All candidates minus session-dismissed ones. */
  visible: CaptureCandidate[];
  /** High-confidence rows (the main list). */
  capture: CaptureCandidate[];
  /** Medium/low-confidence rows (behind the "제안" toggle). */
  suggestions: CaptureCandidate[];
  loading: boolean;
  /** Session decision per captureId (absent = keep, the default state). */
  session: ReadonlyMap<string, CaptureSessionEntry>;
  decide: (candidate: CaptureCandidate, decision: CaptureDecision) => Promise<void>;
}

interface UseTodayCapturesArgs {
  /** Called after a persisted decision lands (auto-plan trigger). */
  onChanged: (kind: string) => void;
}

export function useTodayCaptures({ onChanged }: UseTodayCapturesArgs): TodayCaptures {
  const { workPath, snapshot, mutate, refreshEpoch } = useToday();
  const [candidates, setCandidates] = useState<CaptureCandidate[]>([]);
  const [loading, setLoading] = useState(false);
  const [session, setSession] = useState<Map<string, CaptureSessionEntry>>(new Map());

  useEffect(() => {
    let cancelled = false;
    if (!workPath) {
      setCandidates([]);
      return;
    }
    setLoading(true);
    buildCaptureCandidates({ workPath })
      .then((list) => {
        if (!cancelled) setCandidates(list);
      })
      .catch(() => {
        if (!cancelled) setCandidates([]);
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [workPath, refreshEpoch]);

  const visible = useMemo(() => {
    const decisions = snapshot?.captureDecisions ?? {};
    return candidates.filter((candidate) => {
      const local = session.get(candidate.captureId);
      if (local?.decision === "dismiss") return false;
      const persisted = decisions[candidate.captureId];
      if (!persisted) return true;
      if (persisted.decision === "dismissed" || persisted.decision === "materialized") {
        return false;
      }
      if (persisted.decision === "deferred") {
        return Boolean(
          persisted.deferDate &&
            snapshot?.logicalDay &&
            persisted.deferDate <= snapshot.logicalDay,
        );
      }
      return true;
    });
  }, [candidates, session, snapshot]);
  const { capture, suggestions } = useMemo(() => partitionCandidates(visible), [visible]);

  const decide = useCallback(
    async (candidate: CaptureCandidate, decision: CaptureDecision) => {
      if (decision === "addToToday") {
        // Plan edit only — this must NOT create task notes or external
        // calendar events (those stay behind Finish setup / explicit opt-in).
        if (!snapshot) return;
        const plan = snapshot.plan ?? emptyPlanShell(snapshot);
        const outcome = applyCaptureDecision({ plan, candidate, decision });
        if (!outcome.mutation) return;
        const next = await mutate(outcome.mutation);
        if (next) {
          setSession((prev) =>
            new Map(prev).set(candidate.captureId, { decision, deferDate: null }),
          );
          onChanged("capture");
        }
        return;
      }
      if (decision === "defer") {
        const deferDate = snapshot ? addDaysIso(snapshot.logicalDay, 1) : null;
        if (!deferDate) return;
        const next = await mutate({
          type: "setCaptureDecision",
          captureId: candidate.captureId,
          decision: "deferred",
          deferDate,
        });
        if (next) {
          setSession((prev) =>
            new Map(prev).set(candidate.captureId, { decision, deferDate }),
          );
          onChanged("capture");
        }
        return;
      }
      if (decision === "dismiss") {
        const next = await mutate({
          type: "setCaptureDecision",
          captureId: candidate.captureId,
          decision: "dismissed",
        });
        if (next) {
          setSession((prev) =>
            new Map(prev).set(candidate.captureId, { decision, deferDate: null }),
          );
          onChanged("capture");
        }
      }
      // keep / edit: keep is the default state; edits happen after the task is
      // materialized, so no separate capture editor is advertised here.
    },
    [snapshot, mutate, onChanged],
  );

  return useMemo(
    () => ({ visible, capture, suggestions, loading, session, decide }),
    [visible, capture, suggestions, loading, session, decide],
  );
}
