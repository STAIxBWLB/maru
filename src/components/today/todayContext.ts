// Maru Today — shared context for the Today pane.
// TodayPane loads the day snapshot (best-effort) and exposes it, together
// with the mutate/reload helpers, to the stage screens and side panels.

import { createContext, useContext } from "react";
import type { TasksTodaySettings } from "../../lib/settings";
import type { TodayMutation, TodaySnapshot } from "../../lib/today";

export interface TodayContextValue {
  workPath: string | null;
  settings: TasksTodaySettings;
  timezone: string;
  /** TasksSettings.defaultCalendar — the target when
   *  `settings.calendarDestination === "defaultCalendar"`. */
  defaultCalendar?: string | null;
  /** TasksSettings.gwsBinary override for the publish shell-out. */
  gwsBinary?: string | null;
  /** Loaded day snapshot. Null = degraded read-only mode (backend
   *  unavailable or `today.enabled` off); the shell still renders. */
  snapshot: TodaySnapshot | null;
  /** True while the first `todayOpen` is in flight. */
  loading: boolean;
  /** Apply a mutation against the current revision. Returns the new
   *  snapshot, or null in degraded mode / on failure (conflicts trigger a
   *  reload so the next call uses a fresh revision). */
  mutate: (mutation: TodayMutation) => Promise<TodaySnapshot | null>;
  /** Re-run `todayOpen` (e.g. after an optimistic-concurrency conflict). */
  reload: () => Promise<void>;
}

export const TodayContext = createContext<TodayContextValue | null>(null);

export function useToday(): TodayContextValue {
  const ctx = useContext(TodayContext);
  if (!ctx) {
    throw new Error("useToday must be used inside <TodayContext.Provider>");
  }
  return ctx;
}
