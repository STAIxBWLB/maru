// Maru Dashboard — one hook per widget domain. Each hook owns its async
// command, exposes { data, loading, error, refresh }, and skips the call
// entirely when there is no workspace. A widget failure stays inside its own
// state; the grid never breaks.

import { useCallback, useEffect, useRef, useState } from "react";

import { buildAgentBoard, listAgents, type AgentBoard } from "../../lib/agents";
import {
  dotSyncOverview,
  gitStatus,
  listAiMissions,
  listDrafts,
  listSchedules,
  scanInboxDrop,
  scanInboxEntries,
  scanTaskNotes,
  type DotSyncOverview,
} from "../../lib/api";
import { catalogScan, type CatalogScanReport } from "../../lib/catalog";
import { dashboardLogicalDay } from "../../lib/dashboard";
import type { TasksSettings } from "../../lib/settings";
import { rowsToTaskEntries, type TaskEntry } from "../../lib/tasks";
import {
  todayCalendarCommitments,
  todayOpen,
  type CalendarCommitment,
  type TodaySnapshot,
} from "../../lib/today";
import type { DraftEntry, GitStatus, InboxDropItem, InboxEntry } from "../../lib/types";

export interface DashboardWidgetData<T> {
  data: T | null;
  loading: boolean;
  error: string | null;
  refresh: () => void;
}

function toErrorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function useWidgetData<T>(
  enabled: boolean,
  fetcher: () => Promise<T>,
  deps: readonly unknown[],
): DashboardWidgetData<T> {
  const [state, setState] = useState<{ data: T | null; loading: boolean; error: string | null }>({
    data: null,
    loading: enabled,
    error: null,
  });
  const [nonce, setNonce] = useState(0);
  const fetcherRef = useRef(fetcher);
  useEffect(() => {
    fetcherRef.current = fetcher;
  });

  useEffect(() => {
    if (!enabled) {
      setState({ data: null, loading: false, error: null });
      return;
    }
    let cancelled = false;
    setState((prev) => ({ ...prev, loading: true, error: null }));
    fetcherRef
      .current()
      .then((data) => {
        if (!cancelled) setState({ data, loading: false, error: null });
      })
      .catch((err) => {
        if (!cancelled) {
          setState((prev) => ({ data: prev.data, loading: false, error: toErrorMessage(err) }));
        }
      });
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [enabled, nonce, ...deps]);

  const refresh = useCallback(() => setNonce((value) => value + 1), []);
  return { ...state, refresh };
}

export function useDashboardToday(
  workPath: string | null,
  settings: TasksSettings,
  epoch: number,
): DashboardWidgetData<TodaySnapshot> {
  const enabled = Boolean(workPath) && settings.today.enabled;
  return useWidgetData(
    enabled,
    () =>
      todayOpen(
        workPath!,
        new Date().toISOString(),
        settings.timezone ?? "Asia/Seoul",
        settings.today.dayStart,
        settings.today.sleepStart,
      ),
    [workPath, settings.timezone, settings.today.dayStart, settings.today.sleepStart, epoch],
  );
}

export function useDashboardTasks(
  workPath: string | null,
  epoch: number,
): DashboardWidgetData<TaskEntry[]> {
  return useWidgetData(
    Boolean(workPath),
    async () => rowsToTaskEntries(await scanTaskNotes(workPath!)),
    [workPath, epoch],
  );
}

export function useDashboardSchedule(
  workPath: string | null,
  settings: TasksSettings,
  epoch: number,
): DashboardWidgetData<CalendarCommitment[]> {
  const calendarsKey = settings.today.availabilityCalendars.join("\n");
  return useWidgetData(
    Boolean(workPath),
    () =>
      todayCalendarCommitments(
        workPath!,
        dashboardLogicalDay(new Date(), settings.today.dayStart),
        settings.timezone ?? "Asia/Seoul",
        settings.today.dayStart,
        settings.today.sleepStart,
        settings.today.availabilityCalendars,
      ),
    [
      workPath,
      settings.timezone,
      settings.today.dayStart,
      settings.today.sleepStart,
      calendarsKey,
      epoch,
    ],
  );
}

export function useDashboardCatalog(
  workPath: string | null,
  epoch: number,
): DashboardWidgetData<CatalogScanReport> {
  return useWidgetData(Boolean(workPath), () => catalogScan(workPath!), [workPath, epoch]);
}

export interface DashboardInboxData {
  dropItems: InboxDropItem[];
  entries: InboxEntry[];
}

export function useDashboardInbox(
  workPath: string | null,
  epoch: number,
): DashboardWidgetData<DashboardInboxData> {
  return useWidgetData(
    Boolean(workPath),
    async () => {
      const [dropItems, entries] = await Promise.all([
        scanInboxDrop(workPath!),
        scanInboxEntries(workPath!),
      ]);
      return { dropItems, entries };
    },
    [workPath, epoch],
  );
}

export function useDashboardAgents(
  workPath: string | null,
  epoch: number,
): DashboardWidgetData<AgentBoard> {
  return useWidgetData(
    Boolean(workPath),
    async () => {
      const [agents, schedules, missions] = await Promise.all([
        listAgents(),
        listSchedules(workPath!),
        listAiMissions(),
      ]);
      return buildAgentBoard(agents, schedules, missions);
    },
    [workPath, epoch],
  );
}

export function useDashboardDrafts(
  workPath: string | null,
  epoch: number,
): DashboardWidgetData<DraftEntry[]> {
  return useWidgetData(Boolean(workPath), () => listDrafts(workPath!), [workPath, epoch]);
}

export function useDashboardGit(
  workPath: string | null,
  epoch: number,
): DashboardWidgetData<GitStatus> {
  return useWidgetData(Boolean(workPath), () => gitStatus(workPath!), [workPath, epoch]);
}

export function useDashboardSync(epoch: number): DashboardWidgetData<DotSyncOverview> {
  return useWidgetData(true, () => dotSyncOverview(), [epoch]);
}
