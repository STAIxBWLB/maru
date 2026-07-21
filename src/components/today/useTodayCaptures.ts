// Maru Today — capture lane state for the Prepare stage. Loads capture
// candidates from local pending inbox items (read-only; no provider fan-out)
// and tracks session-local decisions. Persistence follows the mapping
// documented in todayCapture.ts: only addToToday is persisted (as a
// reversible capture plan item via setPlan); defer/dismiss stay session-local
// until the snapshot schema grows a capture-decision field.

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
  const { workPath, snapshot, mutate } = useToday();
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
  }, [workPath]);

  const visible = useMemo(
    () => candidates.filter((candidate) => session.get(candidate.captureId)?.decision !== "dismiss"),
    [candidates, session],
  );
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
        // UI-local for now per the lib's documented mapping: the snapshot
        // schema has no capture-defer field yet, so this only marks the row.
        const deferDate = snapshot ? addDaysIso(snapshot.logicalDay, 1) : null;
        applyCaptureDecision({
          plan: snapshot?.plan ?? null,
          candidate,
          decision,
          deferDate,
        });
        setSession((prev) => new Map(prev).set(candidate.captureId, { decision, deferDate }));
        return;
      }
      if (decision === "dismiss") {
        applyCaptureDecision({ plan: snapshot?.plan ?? null, candidate, decision });
        setSession((prev) =>
          new Map(prev).set(candidate.captureId, { decision, deferDate: null }),
        );
      }
      // keep / edit: keep is the default state; edit is surfaced as disabled
      // in the UI (no capture edit surface exists yet) — nothing to record.
    },
    [snapshot, mutate, onChanged],
  );

  return useMemo(
    () => ({ visible, capture, suggestions, loading, session, decide }),
    [visible, capture, suggestions, loading, session, decide],
  );
}
