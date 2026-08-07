// Maru Today — root pane for the "tasks" app mode. Owns the day snapshot
// (best-effort load; the shell renders in a degraded read-only mode when
// the backend is unavailable), persists route changes into the snapshot,
// and routes internally between the stage screens, the secondary panels,
// and the existing Tasks experience (route "all").

import {
  lazy,
  memo,
  Suspense,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
} from "react";
import { useTranslation } from "../../lib/i18n";
import type { LayoutSettings, TasksSettings } from "../../lib/settings";
import { TODAY_LAYOUT_LIMITS } from "../../lib/todayLayout";
import { resolveRouteForDayState } from "../../lib/todayRouting";
import {
  isTodayConflict,
  todayFinalizeSetup,
  todayMutate,
  todayOpen,
  type TodayFinalizeSetupRequest,
  type TodayMutation,
  type TodayRoute,
  type TodaySnapshot,
} from "../../lib/today";
import type { TasksPaneProps } from "../tasks/TasksPane";
import { PaneResizeHandle } from "../ui/PaneResizeHandle";
import { TodayContext, type TodayContextValue } from "./todayContext";
import { TodayCalendarSyncPanel } from "./TodayCalendarSyncPanel";
import { TodayExecute } from "./TodayExecute";
import { TodayPrepare } from "./TodayPrepare";
import { TodayReview } from "./TodayReview";
import { TodaySidebar } from "./TodaySidebar";

const LazyTasksPane = lazy(() =>
  import("../tasks/TasksPane").then((module) => ({ default: module.TasksPane })),
);

function availableTodayRoute(route: TodayRoute): TodayRoute {
  return route === "capture" || route === "upcoming" || route === "log" ? "all" : route;
}

interface TodayPaneProps {
  route: TodayRoute;
  onRouteChange: (route: TodayRoute) => void;
  workPath: string | null;
  effectiveSettings: TasksSettings;
  layout?: Pick<
    LayoutSettings,
    "todaySidebarWidth" | "tasksSidebarWidth" | "calendarAgendaWidth" | "taskDetailsWidth"
  >;
  onLayoutChange?: (
    patch: Partial<
      Pick<
        LayoutSettings,
        "todaySidebarWidth" | "tasksSidebarWidth" | "calendarAgendaWidth" | "taskDetailsWidth"
      >
    >,
  ) => void;
  rolloverEpoch?: number;
  refreshRequestEpoch?: number;
  /** Props bundle for the existing TasksPane (route "all"), computed by App. */
  tasksProps: TasksPaneProps;
  /** Optional sidebar counts — rendered only when provided. */
  calendarCount?: number;
  inboxCount?: number;
  upcomingCount?: number;
}

export const TodayPane = memo(function TodayPane({
  route,
  onRouteChange,
  workPath,
  effectiveSettings,
  layout,
  onLayoutChange,
  rolloverEpoch = 0,
  refreshRequestEpoch = 0,
  tasksProps,
  calendarCount,
  inboxCount,
  upcomingCount,
}: TodayPaneProps) {
  const { t } = useTranslation();
  const timezone = effectiveSettings.timezone ?? "Asia/Seoul";
  const todaySettings = effectiveSettings.today;
  const availableRoute = availableTodayRoute(route);
  const resolvedLayout = {
    todaySidebarWidth:
      layout?.todaySidebarWidth ?? TODAY_LAYOUT_LIMITS.todaySidebarWidth.defaultValue,
    tasksSidebarWidth:
      layout?.tasksSidebarWidth ?? TODAY_LAYOUT_LIMITS.tasksSidebarWidth.defaultValue,
    calendarAgendaWidth:
      layout?.calendarAgendaWidth ?? TODAY_LAYOUT_LIMITS.calendarAgendaWidth.defaultValue,
    taskDetailsWidth:
      layout?.taskDetailsWidth ?? TODAY_LAYOUT_LIMITS.taskDetailsWidth.defaultValue,
  };
  const [todaySidebarWidth, setTodaySidebarWidth] = useState(
    resolvedLayout.todaySidebarWidth,
  );

  useEffect(() => {
    setTodaySidebarWidth(resolvedLayout.todaySidebarWidth);
  }, [resolvedLayout.todaySidebarWidth]);

  const [snapshot, setSnapshot] = useState<TodaySnapshot | null>(null);
  const [loading, setLoading] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const [refreshError, setRefreshError] = useState<string | null>(null);
  const [refreshEpoch, setRefreshEpoch] = useState(0);
  const snapshotRef = useRef<TodaySnapshot | null>(null);
  const mutationQueueRef = useRef<Promise<void>>(Promise.resolve());
  const paneIdentityRef = useRef(0);
  const refreshGenerationRef = useRef(0);
  // Seeded with the mount-time epoch: only rollovers that happen while this
  // pane is mounted re-route; a remount after an earlier rollover keeps the
  // route the user was on (the fresh todayOpen already loads the new day).
  const appliedRolloverEpochRef = useRef(rolloverEpoch);
  const appliedRefreshRequestRef = useRef(refreshRequestEpoch);

  const applySnapshot = useCallback((next: TodaySnapshot | null) => {
    snapshotRef.current = next;
    setSnapshot(next);
  }, []);

  useEffect(() => {
    paneIdentityRef.current += 1;
    refreshGenerationRef.current += 1;
    mutationQueueRef.current = Promise.resolve();
    applySnapshot(null);
    setRefreshError(null);
    setRefreshEpoch(0);
  }, [applySnapshot, workPath]);

  const reload = useCallback(async () => {
    const identity = paneIdentityRef.current;
    const generation = ++refreshGenerationRef.current;
    if (!workPath || !todaySettings.enabled) {
      applySnapshot(null);
      setLoading(false);
      setRefreshing(false);
      return null;
    }
    const firstLoad = snapshotRef.current === null;
    if (firstLoad) setLoading(true);
    setRefreshing(true);
    setRefreshError(null);
    try {
      const loaded = await todayOpen(
        workPath,
        new Date().toISOString(),
        timezone,
        todaySettings.dayStart,
        todaySettings.sleepStart,
      );
      if (
        identity !== paneIdentityRef.current ||
        generation !== refreshGenerationRef.current
      ) {
        return null;
      }
      applySnapshot(loaded);
      setRefreshEpoch((epoch) => epoch + 1);
      if (rolloverEpoch > appliedRolloverEpochRef.current) {
        appliedRolloverEpochRef.current = rolloverEpoch;
        onRouteChange(resolveRouteForDayState(loaded.dayState));
      }
      return loaded;
    } catch (err) {
      if (
        identity !== paneIdentityRef.current ||
        generation !== refreshGenerationRef.current
      ) {
        return null;
      }
      console.warn("today open failed", err);
      setRefreshError(err instanceof Error ? err.message : String(err));
      // Preserve the last good snapshot. Only the first failed load enters
      // degraded mode.
      if (snapshotRef.current === null) applySnapshot(null);
      return null;
    } finally {
      if (
        identity === paneIdentityRef.current &&
        generation === refreshGenerationRef.current
      ) {
        setLoading(false);
        setRefreshing(false);
      }
    }
  }, [
    workPath,
    todaySettings,
    timezone,
    rolloverEpoch,
    applySnapshot,
    onRouteChange,
  ]);

  // Load on mount/workspace/settings changes. The generation guard ensures a
  // slower prior workspace cannot overwrite the active one.
  useEffect(() => {
    void reload();
  }, [reload]);

  useEffect(() => {
    if (refreshRequestEpoch <= appliedRefreshRequestRef.current) return;
    appliedRefreshRequestRef.current = refreshRequestEpoch;
    void reload();
  }, [refreshRequestEpoch, reload]);

  const mutate = useCallback(
    (mutation: TodayMutation): Promise<TodaySnapshot | null> => {
      const identity = paneIdentityRef.current;
      return new Promise<TodaySnapshot | null>((resolve) => {
        const run = async () => {
          const current = snapshotRef.current;
          if (!workPath || !current || identity !== paneIdentityRef.current) {
            resolve(null);
            return;
          }

          const prepareMutation = (
            source: TodayMutation,
            revision: string,
          ): TodayMutation =>
            source.type === "setPlan"
              ? {
                  ...source,
                  plan: { ...source.plan, inputRevision: revision },
                }
              : source;

          const execute = async (
            base: TodaySnapshot,
            retryOnConflict: boolean,
          ): Promise<TodaySnapshot | null> => {
            try {
              return await todayMutate(
                workPath,
                base.logicalDay,
                base.revision,
                prepareMutation(mutation, base.revision),
              );
            } catch (err) {
              if (!retryOnConflict || !isTodayConflict(err)) throw err;
              const fresh = await todayOpen(
                workPath,
                new Date().toISOString(),
                timezone,
                todaySettings.dayStart,
                todaySettings.sleepStart,
              );
              if (identity === paneIdentityRef.current) applySnapshot(fresh);
              return execute(fresh, false);
            }
          };

          try {
            const next = await execute(current, true);
            if (next && identity === paneIdentityRef.current) applySnapshot(next);
            resolve(next);
          } catch (err) {
            if (!isTodayConflict(err)) console.warn("today mutate failed", err);
            resolve(null);
          }
        };

        mutationQueueRef.current = mutationQueueRef.current.then(run, run);
      });
    },
    [workPath, timezone, todaySettings, applySnapshot],
  );

  const finalizeSetup = useCallback(
    async (request: TodayFinalizeSetupRequest) => {
      const identity = paneIdentityRef.current;
      if (!workPath || identity !== paneIdentityRef.current) return null;
      try {
        const outcome = await todayFinalizeSetup(workPath, request);
        if (identity === paneIdentityRef.current) {
          applySnapshot(outcome.snapshot);
          setRefreshError(null);
        }
        return outcome;
      } catch (err) {
        if (isTodayConflict(err)) await reload();
        else console.warn("today finalize setup failed", err);
        if (identity === paneIdentityRef.current) {
          setRefreshError(err instanceof Error ? err.message : String(err));
        }
        return null;
      }
    },
    [workPath, applySnapshot, reload],
  );

  // Navigation stays immediate, while persistence joins the same serialized
  // mutation queue as autosave and plan edits.
  const handleRouteChange = useCallback(
    (next: TodayRoute) => {
      const available = availableTodayRoute(next);
      onRouteChange(available);
      void mutate({ type: "setRoute", route: available });
    },
    [onRouteChange, mutate],
  );

  // Retired placeholder routes redirect immediately — even in degraded mode
  // (no snapshot), where the pane would otherwise render an empty main area.
  useEffect(() => {
    if (route !== availableRoute) {
      handleRouteChange(availableRoute);
    }
  }, [availableRoute, handleRouteChange, route]);

  const contextValue = useMemo<TodayContextValue>(
    () => ({
      workPath,
      settings: todaySettings,
      timezone,
      defaultCalendar: effectiveSettings.defaultCalendar,
      gwsBinary: effectiveSettings.gwsBinary,
      snapshot,
      loading,
      refreshing,
      refreshError,
      refreshEpoch,
      mutate,
      finalizeSetup,
      reload,
    }),
    [
      workPath,
      todaySettings,
      timezone,
      effectiveSettings,
      snapshot,
      loading,
      refreshing,
      refreshError,
      refreshEpoch,
      mutate,
      finalizeSetup,
      reload,
    ],
  );

  const content = (() => {
    switch (availableRoute) {
      case "all":
        return (
          <div className="today-main-all">
            <Suspense fallback={null}>
              <LazyTasksPane
                {...tasksProps}
                layout={resolvedLayout}
                onLayoutChange={onLayoutChange}
                logicalDay={snapshot?.logicalDay ?? null}
              />
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
        return <TodayCalendarSyncPanel />;
      case "capture":
      case "upcoming":
      case "log":
        return null;
    }
  })();

  return (
    <TodayContext.Provider value={contextValue}>
      <div
        className="today-pane"
        style={
          {
            "--today-sidebar-width": `${todaySidebarWidth}px`,
          } as CSSProperties
        }
      >
        <TodaySidebar
          route={availableRoute}
          onRouteChange={handleRouteChange}
          calendarCount={calendarCount}
          inboxCount={inboxCount}
          upcomingCount={upcomingCount}
        />
        <PaneResizeHandle
          label={t("today.layout.resizeSidebar")}
          value={todaySidebarWidth}
          min={TODAY_LAYOUT_LIMITS.todaySidebarWidth.min}
          max={TODAY_LAYOUT_LIMITS.todaySidebarWidth.max}
          defaultValue={TODAY_LAYOUT_LIMITS.todaySidebarWidth.defaultValue}
          onChange={setTodaySidebarWidth}
          onCommit={(value) => onLayoutChange?.({ todaySidebarWidth: value })}
        />
        <div className="today-main">{content}</div>
      </div>
    </TodayContext.Provider>
  );
});
