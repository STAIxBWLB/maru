// Maru Today — shared context for the Today pane.
// TodayPane loads the day snapshot (best-effort) and exposes it, together
// with the mutate/reload helpers, to the stage screens and side panels.

import { createContext, useContext } from "react";
import type { TasksTodaySettings } from "../../lib/settings";
import type {
  TodayFinalizeSetupOutcome,
  TodayFinalizeSetupRequest,
  TodayMutation,
  TodaySnapshot,
} from "../../lib/today";

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
  /** True while a manual/background coordinated refresh is in flight. */
  refreshing?: boolean;
  /** Last refresh failure; the last good snapshot stays rendered. */
  refreshError?: string | null;
  /** Increments only after a successful coordinated refresh. Child data
   *  loaders use this generation to refresh against the same snapshot. */
  refreshEpoch?: number;
  /** Apply a mutation against the current revision. Returns the new
   *  snapshot, or null in degraded mode / on failure (a conflict reloads
   *  the snapshot and retries the serialized mutation once). */
  mutate: (mutation: TodayMutation) => Promise<TodaySnapshot | null>;
  /** Atomic Finish setup / Quick skip command. */
  finalizeSetup?: (
    request: TodayFinalizeSetupRequest,
  ) => Promise<TodayFinalizeSetupOutcome | null>;
  /** Re-run `todayOpen` (e.g. after an optimistic-concurrency conflict). */
  reload: () => Promise<TodaySnapshot | null | void>;
}

export const TodayContext = createContext<TodayContextValue | null>(null);

export function useToday(): TodayContextValue {
  const ctx = useContext(TodayContext);
  if (!ctx) {
    throw new Error("useToday must be used inside <TodayContext.Provider>");
  }
  return ctx;
}
