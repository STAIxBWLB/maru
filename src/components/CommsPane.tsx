import { RefreshCcw, Settings } from "lucide-react";
import { useMemo } from "react";
import type { LegacyLaunchdService } from "../lib/api";
import { useTranslation } from "../lib/i18n";
import { enumerateSourceChannels, sourceRunByChannel } from "../lib/inboxSources";
import { latestActivityLine, type MissionProgress } from "../lib/missionProgress";
import type {
  InboxProcessedItem,
  InboxProcessedItemDetail,
  InboxProcessedStatus,
  InboxRuntimeConfig,
  InboxSourceRun,
  MissionRecord,
  TelegramPollingStatus,
} from "../lib/types";
import { ProcessedItemsBrowser } from "./inbox/ProcessedItemsBrowser";
import {
  ProcessingMissionsPanel,
  inboxProcessChannel,
} from "./inbox/ProcessingMissionsPanel";
import { AllSourcesOverview } from "./comms/AllSourcesOverview";
import { MigrationBanner } from "./comms/MigrationBanner";
import { SourceHeaderCard } from "./comms/SourceHeaderCard";
import { SourceSelector } from "./comms/SourceSelector";
import { SourceControls } from "./comms/SourceControls";

interface CommsPaneProps {
  runtimeConfig: InboxRuntimeConfig;
  sourceRuns: InboxSourceRun[];
  /** Stable per-channel processed totals (unfiltered, uncapped). */
  processedCounts: Record<string, number>;
  processedItems: InboxProcessedItem[];
  processedLoading: boolean;
  processedError: string | null;
  processedStatusFilter: InboxProcessedStatus | "all";
  processedQuery: string;
  processedDetail: InboxProcessedItemDetail | null;
  processingMissions: MissionRecord[];
  processingLogLines: Record<string, string[]>;
  sourceFilter: string | null;
  actionBusy?: boolean;
  telegramPollingStatus: TelegramPollingStatus;
  migrationServices: LegacyLaunchdService[];
  migrationBusy: boolean;
  onSourceFilter: (channel: string | null) => void;
  onProcessNow: (channel: string) => void;
  onRefresh: () => void;
  onProcessedStatusFilter: (status: InboxProcessedStatus | "all") => void;
  onProcessedQuery: (query: string) => void;
  onRefreshProcessed: () => void;
  onSelectProcessedItem: (item: InboxProcessedItem) => void | Promise<void>;
  onStopProcessingMission: (id: string) => void | Promise<void>;
  onRevealPath: (path: string) => void;
  onRefreshTelegram: () => void;
  onGwsReauth: () => void;
  onMsoReauth: () => void;
  onStartTelegramPolling: () => void;
  onStopTelegramPolling: () => void;
  onTelegramLogin: () => void;
  onDeepProcess: (channel: string) => void;
  onOpenCommsSettings: () => void;
  onRefreshMigration: () => void;
  onUnloadMigration: (plistPath: string) => void;
}

export function CommsPane({
  runtimeConfig,
  sourceRuns,
  processedCounts,
  processedItems,
  processedLoading,
  processedError,
  processedStatusFilter,
  processedQuery,
  processedDetail,
  processingMissions,
  processingLogLines,
  sourceFilter,
  actionBusy = false,
  telegramPollingStatus,
  migrationServices,
  migrationBusy,
  onSourceFilter,
  onProcessNow,
  onRefresh,
  onProcessedStatusFilter,
  onProcessedQuery,
  onRefreshProcessed,
  onSelectProcessedItem,
  onStopProcessingMission,
  onRevealPath,
  onRefreshTelegram,
  onGwsReauth,
  onMsoReauth,
  onStartTelegramPolling,
  onStopTelegramPolling,
  onTelegramLogin,
  onDeepProcess,
  onOpenCommsSettings,
  onRefreshMigration,
  onUnloadMigration,
}: CommsPaneProps) {
  const { t } = useTranslation();
  const channels = useMemo(() => enumerateSourceChannels(runtimeConfig), [runtimeConfig]);
  const runByChannel = useMemo(() => sourceRunByChannel(sourceRuns), [sourceRuns]);
  // Stable, unfiltered per-channel totals from the backend — independent of the
  // processed-items search/status filter and its result cap.
  const processedByChannel = useMemo(
    () => new Map(Object.entries(processedCounts)),
    [processedCounts],
  );
  const totalProcessed = useMemo(
    () => Object.values(processedCounts).reduce((sum, count) => sum + count, 0),
    [processedCounts],
  );
  const runningChannels = useMemo(() => {
    const set = new Set<string>();
    for (const mission of processingMissions) {
      const channel = inboxProcessChannel(mission);
      if (channel) set.add(channel);
    }
    return set;
  }, [processingMissions]);
  const progressByChannel = useMemo(() => {
    const map = new Map<string, MissionProgress>();
    for (const mission of processingMissions) {
      const channel = inboxProcessChannel(mission);
      if (!channel) continue;
      map.set(channel, {
        missionId: mission.id,
        status: mission.status,
        startedAt: mission.startedAt,
        latestActivity: latestActivityLine(processingLogLines[mission.id]),
      });
    }
    return map;
  }, [processingMissions, processingLogLines]);
  const missionsForActive = useMemo(
    () =>
      sourceFilter
        ? processingMissions.filter((mission) => inboxProcessChannel(mission) === sourceFilter)
        : [],
    [processingMissions, sourceFilter],
  );

  return (
    <main className="comms-pane" tabIndex={-1}>
      <header className="comms-header">
        <div>
          <h2>{t("comms.title")}</h2>
          <p>{t("comms.dashboardSubtitle")}</p>
        </div>
        <div className="comms-header-actions">
          <button
            type="button"
            className="icon-button"
            onClick={onRefresh}
            title={t("comms.refresh")}
            aria-label={t("comms.refresh")}
          >
            <RefreshCcw size={14} />
          </button>
          <button
            type="button"
            className="icon-button"
            onClick={onOpenCommsSettings}
            title={t("comms.openSettings")}
            aria-label={t("comms.openSettings")}
          >
            <Settings size={14} />
          </button>
        </div>
      </header>
      <MigrationBanner
        services={migrationServices}
        busy={migrationBusy}
        onRefresh={onRefreshMigration}
        onUnload={onUnloadMigration}
      />
      <SourceSelector
        channels={channels}
        active={sourceFilter}
        counts={processedByChannel}
        total={totalProcessed}
        onChange={onSourceFilter}
      />
      <section className="comms-body">
        {sourceFilter === null ? (
          <AllSourcesOverview
            channels={channels}
            runByChannel={runByChannel}
            processedByChannel={processedByChannel}
            runningChannels={runningChannels}
            progressByChannel={progressByChannel}
            actionBusy={actionBusy}
            onProcessNow={onProcessNow}
            onSelect={onSourceFilter}
          />
        ) : (
          <div className="comms-source-detail">
            <SourceHeaderCard
              channel={sourceFilter}
              run={runByChannel.get(sourceFilter) ?? null}
              running={runningChannels.has(sourceFilter)}
              progress={progressByChannel.get(sourceFilter) ?? null}
              processedCount={processedByChannel.get(sourceFilter) ?? 0}
              actionBusy={actionBusy}
              onProcessNow={onProcessNow}
            />
            <SourceControls
              channel={sourceFilter}
              pollingStatus={sourceFilter === "telegram" ? telegramPollingStatus : null}
              actionBusy={actionBusy}
              onRefresh={sourceFilter === "telegram" ? onRefreshTelegram : onRefresh}
              onReauth={
                sourceFilter === "gws"
                  ? onGwsReauth
                  : sourceFilter === "mso"
                    ? onMsoReauth
                    : sourceFilter === "telegram"
                      ? onTelegramLogin
                      : undefined
              }
              onProcessNow={onProcessNow}
              onDeepProcess={sourceFilter === "telegram" ? onDeepProcess : undefined}
              onStartPolling={onStartTelegramPolling}
              onStopPolling={onStopTelegramPolling}
              onOpenSettings={onOpenCommsSettings}
            />
            <ProcessingMissionsPanel
              missions={missionsForActive}
              logLines={processingLogLines}
              onStop={onStopProcessingMission}
              emptyLabel={t("comms.source.noActiveProcess")}
              waitingLabel={t("comms.progress.waiting")}
            />
            <div className="comms-results">
              <h3 className="comms-results-title">{t("comms.results.title")}</h3>
              <ProcessedItemsBrowser
                items={processedItems}
                loading={processedLoading}
                error={processedError}
                statusFilter={processedStatusFilter}
                query={processedQuery}
                detail={processedDetail}
                channelFilter={sourceFilter}
                emptyTitle={t("comms.results.empty.title")}
                emptyDescription={t("comms.results.empty.description")}
                onStatusFilter={onProcessedStatusFilter}
                onQuery={onProcessedQuery}
                onRefresh={onRefreshProcessed}
                onSelect={onSelectProcessedItem}
                onRevealPath={onRevealPath}
              />
            </div>
          </div>
        )}
      </section>
    </main>
  );
}
