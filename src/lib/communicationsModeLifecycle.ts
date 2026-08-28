import { useEffect, useMemo, useRef } from "react";

import type { MissionRecord } from "./types";
import { missionStoreLoadStamp } from "./useActiveMissions";

export interface CommunicationsRequestRefs {
  processedRequest: React.MutableRefObject<number>;
  processedDetailRequest: React.MutableRefObject<number>;
  processedItems: React.MutableRefObject<unknown[]>;
  processedItemsKey: React.MutableRefObject<string>;
  readinessRequest: React.MutableRefObject<number>;
  dashboardRequest: React.MutableRefObject<number>;
  migrationChecked: React.MutableRefObject<boolean>;
}

/**
 * Request ordering belongs to the communications owner. Keeping these refs
 * together prevents a workspace switch from accidentally accepting results
 * produced for the previous inbox provider configuration.
 */
export function useCommunicationsRequestRefs(): CommunicationsRequestRefs {
  const processedRequest = useRef(0);
  const processedDetailRequest = useRef(0);
  const processedItems = useRef<unknown[]>([]);
  const processedItemsKey = useRef("");
  const readinessRequest = useRef(0);
  const dashboardRequest = useRef(0);
  const migrationChecked = useRef(false);
  return useMemo(() => ({
    processedRequest,
    processedDetailRequest,
    processedItems,
    processedItemsKey,
    readinessRequest,
    dashboardRequest,
    migrationChecked,
  }), []);
}

export function useLatestCommunicationsDashboard(
  refreshDashboard: () => Promise<void>,
): React.MutableRefObject<() => Promise<void>> {
  const refreshRef = useRef(refreshDashboard);
  useEffect(() => {
    refreshRef.current = refreshDashboard;
  }, [refreshDashboard]);
  return refreshRef;
}

interface CommunicationsLifecycleOptions {
  processedQuery: string;
  inboxWorkspacePath: string | null;
  processedDeferredQuery: string;
  processedStatusFilter: string;
  commsSourceFilter: string | null;
  inboxSourceFilter: string | null;
  refs: CommunicationsRequestRefs;
  setProcessedDeferredQuery(value: string): void;
  setProcessedDetail(value: null): void;
  resetProcessedWorkspace(): void;
}

/** Owns processed-query debounce and workspace-generation invalidation. */
export function useCommunicationsProcessedLifecycle({
  processedQuery,
  inboxWorkspacePath,
  processedDeferredQuery,
  processedStatusFilter,
  commsSourceFilter,
  inboxSourceFilter,
  refs,
  setProcessedDeferredQuery,
  setProcessedDetail,
  resetProcessedWorkspace,
}: CommunicationsLifecycleOptions): void {
  useEffect(() => {
    const timer = window.setTimeout(() => {
      setProcessedDeferredQuery(processedQuery.trim());
    }, 250);
    return () => window.clearTimeout(timer);
  }, [processedQuery, setProcessedDeferredQuery]);

  useEffect(() => {
    refs.processedDetailRequest.current += 1;
    setProcessedDetail(null);
  }, [
    commsSourceFilter,
    inboxSourceFilter,
    processedDeferredQuery,
    processedStatusFilter,
    refs,
    setProcessedDetail,
  ]);

  useEffect(() => {
    refs.processedRequest.current += 1;
    refs.processedDetailRequest.current += 1;
    refs.readinessRequest.current += 1;
    refs.dashboardRequest.current += 1;
    refs.processedItems.current = [];
    refs.processedItemsKey.current = "";
    resetProcessedWorkspace();
  }, [inboxWorkspacePath, refs, resetProcessedWorkspace]);
}

interface CommunicationsRoutingOptions {
  surfaceMode: string;
  booting: boolean;
  settingsWorkspaceStartupReady: boolean;
  rightPaneTab: string;
  refreshProcessedItems(): Promise<void>;
  refreshProcessingMissions(): Promise<void>;
}

/** Routes mode changes to the owner commands without placing the effect in App. */
export function useCommunicationsRefreshRouting({
  surfaceMode,
  booting,
  settingsWorkspaceStartupReady,
  rightPaneTab,
  refreshProcessedItems,
  refreshProcessingMissions,
}: CommunicationsRoutingOptions): void {
  useEffect(() => {
    if (surfaceMode === "inbox" || surfaceMode === "comms") void refreshProcessedItems();
    if (!booting && settingsWorkspaceStartupReady && (
      surfaceMode === "inbox" ||
      surfaceMode === "meetings" ||
      surfaceMode === "tasks" ||
      rightPaneTab === "skills"
    )) {
      void refreshProcessingMissions();
    }
  }, [
    booting,
    refreshProcessedItems,
    refreshProcessingMissions,
    rightPaneTab,
    settingsWorkspaceStartupReady,
    surfaceMode,
  ]);
}

interface MissionCompletionOptions {
  processingMissions: MissionRecord[];
  isInboxProcessMission(record: MissionRecord): boolean;
  matchesActiveMission(record: MissionRecord): boolean;
  refreshProcessedItems(): Promise<void>;
  refreshSourceRuns(): Promise<void>;
  readMissionLog(id: string): Promise<void>;
}

/** Preserves event-only completion semantics across store snapshot reloads. */
export function useMissionCompletionLifecycle({
  processingMissions,
  isInboxProcessMission,
  matchesActiveMission,
  refreshProcessedItems,
  refreshSourceRuns,
  readMissionLog,
}: MissionCompletionOptions): void {
  const previousMissions = useRef<MissionRecord[] | null>(null);
  const previousLoadStamp = useRef(missionStoreLoadStamp());
  useEffect(() => {
    const previous = previousMissions.current;
    previousMissions.current = processingMissions;
    const loadStamp = missionStoreLoadStamp();
    const snapshotReloaded = loadStamp !== previousLoadStamp.current;
    previousLoadStamp.current = loadStamp;
    if (previous === null || snapshotReloaded || previous === processingMissions) return;
    const previousById = new Map(previous.map((mission) => [mission.id, mission]));
    for (const record of processingMissions) {
      if (previousById.get(record.id) === record) continue;
      const inboxMission = isInboxProcessMission(record);
      if (inboxMission && !matchesActiveMission(record)) {
        void refreshProcessedItems();
        void refreshSourceRuns();
      }
      if (!matchesActiveMission(record)) void readMissionLog(record.id).catch(() => {});
    }
  }, [
    isInboxProcessMission,
    matchesActiveMission,
    processingMissions,
    readMissionLog,
    refreshProcessedItems,
    refreshSourceRuns,
  ]);
}
