// Maru Today — root pane for the "tasks" app mode. Owns the day snapshot
// (best-effort load; the shell renders in a degraded read-only mode when
// the backend is unavailable), persists route changes into the snapshot,
// and routes internally between the stage screens, the secondary panels,
// and the existing Tasks experience (route "all").

import { lazy, Suspense, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "../../lib/i18n";
import type { TasksSettings } from "../../lib/settings";
import {
  isTodayConflict,
  todayMutate,
  todayOpen,
  type TodayMutation,
  type TodayRoute,
  type TodaySnapshot,
} from "../../lib/today";
import type { TasksPaneProps } from "../tasks/TasksPane";
import { TodayContext, type TodayContextValue } from "./todayContext";
import { TodayExecute } from "./TodayExecute";
import { TodayPrepare } from "./TodayPrepare";
import { TodayReview } from "./TodayReview";
import { TodaySidebar } from "./TodaySidebar";
import { TodaySubPanel } from "./TodaySubPanel";

const LazyTasksPane = lazy(() =>
  import("../tasks/TasksPane").then((module) => ({ default: module.TasksPane })),
);

interface TodayPaneProps {
  route: TodayRoute;
  onRouteChange: (route: TodayRoute) => void;
  workPath: string | null;
  effectiveSettings: TasksSettings;
  /** Props bundle for the existing TasksPane (route "all"), computed by App. */
  tasksProps: TasksPaneProps;
  /** Optional sidebar counts — rendered only when provided. */
  calendarCount?: number;
  inboxCount?: number;
  upcomingCount?: number;
}

export function TodayPane({
  route,
  onRouteChange,
  workPath,
  effectiveSettings,
  tasksProps,
  calendarCount,
  inboxCount,
  upcomingCount,
}: TodayPaneProps) {
  const { t } = useTranslation();
  const timezone = effectiveSettings.timezone ?? "Asia/Seoul";
  const todaySettings = effectiveSettings.today;

  const [snapshot, setSnapshot] = useState<TodaySnapshot | null>(null);
  const [loading, setLoading] = useState(false);
  const [loadTick, setLoadTick] = useState(0);
  const snapshotRef = useRef<TodaySnapshot | null>(null);
  const applySnapshot = useCallback((next: TodaySnapshot | null) => {
    snapshotRef.current = next;
    setSnapshot(next);
  }, []);

  // Load (or reload) the day snapshot. Defensive: any failure leaves the
  // shell in degraded read-only mode instead of breaking the pane.
  useEffect(() => {
    let cancelled = false;
    if (!workPath || !todaySettings.enabled) {
      applySnapshot(null);
      return;
    }
    setLoading(true);
    todayOpen(
      workPath,
      new Date().toISOString(),
      timezone,
      todaySettings.dayStart,
      todaySettings.sleepStart,
    )
      .then((loaded) => {
        if (!cancelled) applySnapshot(loaded);
      })
      .catch((err) => {
        console.warn("today open failed", err);
        if (!cancelled) applySnapshot(null);
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [workPath, todaySettings, timezone, loadTick, applySnapshot]);

  const reload = useCallback(async () => {
    setLoadTick((tick) => tick + 1);
  }, []);

  const mutate = useCallback(
    async (mutation: TodayMutation): Promise<TodaySnapshot | null> => {
      const current = snapshotRef.current;
      if (!workPath || !current) return null; // degraded read-only mode
      try {
        const next = await todayMutate(workPath, current.logicalDay, current.revision, mutation);
        applySnapshot(next);
        return next;
      } catch (err) {
        if (isTodayConflict(err)) {
          // Stale revision — resync so the next mutation uses a fresh one.
          try {
            const fresh = await todayOpen(
              workPath,
              new Date().toISOString(),
              timezone,
              todaySettings.dayStart,
              todaySettings.sleepStart,
            );
            applySnapshot(fresh);
          } catch {
            // stay degraded
          }
        } else {
          console.warn("today mutate failed", err);
        }
        return null;
      }
    },
    [workPath, timezone, todaySettings, applySnapshot],
  );

  // Route changes navigate immediately; persisting the route into the day
  // snapshot is best-effort and skipped while no snapshot is loaded.
  const handleRouteChange = useCallback(
    (next: TodayRoute) => {
      onRouteChange(next);
      const current = snapshotRef.current;
      if (workPath && current) {
        todayMutate(workPath, current.logicalDay, current.revision, {
          type: "setRoute",
          route: next,
        })
          .then((updated) => applySnapshot(updated))
          .catch(() => {
            // best-effort — navigation already happened
          });
      }
    },
    [onRouteChange, workPath, applySnapshot],
  );

  const contextValue = useMemo<TodayContextValue>(
    () => ({
      workPath,
      settings: todaySettings,
      timezone,
      snapshot,
      loading,
      mutate,
      reload,
    }),
    [workPath, todaySettings, timezone, snapshot, loading, mutate, reload],
  );

  const content = (() => {
    switch (route) {
      case "all":
        return (
          <div className="today-main-all">
            <Suspense fallback={null}>
              <LazyTasksPane {...tasksProps} />
            </Suspense>
          </div>
        );
      case "prepare":
        return <TodayPrepare onNavigate={handleRouteChange} />;
      case "execute":
        return <TodayExecute onNavigate={handleRouteChange} />;
      case "review":
        return <TodayReview onNavigate={handleRouteChange} />;
      case "calendar":
        return (
          <TodaySubPanel
            title={t("today.nav.calendarLink")}
            countText={
              calendarCount !== undefined
                ? t("today.nav.connectedCount", { count: calendarCount })
                : undefined
            }
          />
        );
      case "capture":
        return <TodaySubPanel title={t("today.panel.capture.title")} count={inboxCount} />;
      case "upcoming":
        return <TodaySubPanel title={t("today.nav.upcoming")} count={upcomingCount} />;
      case "log":
        return <TodaySubPanel title={t("today.nav.log")} />;
    }
  })();

  return (
    <TodayContext.Provider value={contextValue}>
      <div className="today-pane">
        <TodaySidebar
          route={route}
          onRouteChange={handleRouteChange}
          calendarCount={calendarCount}
          inboxCount={inboxCount}
          upcomingCount={upcomingCount}
        />
        <div className="today-main">{content}</div>
      </div>
    </TodayContext.Provider>
  );
}
