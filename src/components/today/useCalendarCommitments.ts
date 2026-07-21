// Maru Today — loads the logical day's calendar commitments (busy intervals)
// from local calendar notes via `today_calendar_commitments`. Used by the
// capacity cards and the auto-planner; failures degrade to an empty list so
// the Prepare stage keeps working offline/degraded.

import { useEffect, useState } from "react";
import type { CalendarCommitment } from "../../lib/today";
import { todayCalendarCommitments } from "../../lib/today";
import { useToday } from "./todayContext";

export interface CalendarCommitmentsState {
  commitments: CalendarCommitment[];
  loading: boolean;
}

export function useCalendarCommitments(): CalendarCommitmentsState {
  const { workPath, settings, timezone, snapshot } = useToday();
  const [state, setState] = useState<CalendarCommitmentsState>({
    commitments: [],
    loading: false,
  });

  const logicalDay = snapshot?.logicalDay ?? "";
  const dayStart = snapshot?.dayStart ?? settings.dayStart;
  const sleepStart = snapshot?.sleepStart ?? settings.sleepStart;
  const calendarsKey = settings.availabilityCalendars.join("\n");

  useEffect(() => {
    if (!workPath || !logicalDay) {
      setState({ commitments: [], loading: false });
      return;
    }
    let cancelled = false;
    setState((prev) => ({ ...prev, loading: true }));
    todayCalendarCommitments(
      workPath,
      logicalDay,
      timezone,
      dayStart,
      sleepStart,
      settings.availabilityCalendars,
    )
      .then((commitments) => {
        if (!cancelled) setState({ commitments, loading: false });
      })
      .catch(() => {
        if (!cancelled) setState({ commitments: [], loading: false });
      });
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [workPath, logicalDay, timezone, dayStart, sleepStart, calendarsKey]);

  return state;
}
