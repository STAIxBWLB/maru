// Maru Today — root pane for the "tasks" app mode. Owns the day snapshot
// (best-effort load; the shell renders in a degraded read-only mode when
// the backend is unavailable), persists route changes into the snapshot,
// and routes internally between the stage screens, the secondary panels,
// and the existing Tasks experience (route "all").

import {
  lazy,
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
  todayMutate,
  todayOpen,
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
  layout,
  onLayoutChange,
  rolloverEpoch = 0,
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
  const [loadTick, setLoadTick] = useState(0);
  const snapshotRef = useRef<TodaySnapshot | null>(null);
  const mutationQueueRef = useRef<Promise<void>>(Promise.resolve());
  const paneIdentityRef = useRef(0);
  const appliedRolloverEpochRef = useRef(0);

  const applySnapshot = useCallback((next: TodaySnapshot | null) => {
    snapshotRef.current = next;
    setSnapshot(next);
  }, []);

  useEffect(() => {
    paneIdentityRef.current += 1;
    mutationQueueRef.current = Promise.resolve();
    applySnapshot(null);
  }, [applySnapshot, workPath]);

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
        if (!cancelled) {
          applySnapshot(loaded);
          if (rolloverEpoch > appliedRolloverEpochRef.current) {
            appliedRolloverEpochRef.current = rolloverEpoch;
            onRouteChange(resolveRouteForDayState(loaded.dayState));
          }
        }
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
  }, [
    workPath,
    todaySettings,
    timezone,
    loadTick,
    rolloverEpoch,
    applySnapshot,
    onRouteChange,
  ]);

  const reload = useCallback(async () => {
    setLoadTick((tick) => tick + 1);
  }, []);

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

  useEffect(() => {
    if (snapshot && route !== availableRoute) {
      handleRouteChange(availableRoute);
    }
  }, [availableRoute, handleRouteChange, route, snapshot]);

  const contextValue = useMemo<TodayContextValue>(
    () => ({
      workPath,
      settings: todaySettings,
      timezone,
      defaultCalendar: effectiveSettings.defaultCalendar,
      gwsBinary: effectiveSettings.gwsBinary,
      snapshot,
      loading,
      mutate,
      reload,
    }),
    [workPath, todaySettings, timezone, effectiveSettings, snapshot, loading, mutate, reload],
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
}
