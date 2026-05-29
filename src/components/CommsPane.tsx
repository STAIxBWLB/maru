import { RefreshCcw, Settings } from "lucide-react";
import { useMemo } from "react";
import type { LegacyLaunchdService } from "../lib/api";
import { useTranslation } from "../lib/i18n";
import { enumerateSourceChannels, sourceRunByChannel } from "../lib/inboxSources";
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
import { TelegramControls } from "./comms/TelegramControls";

interface CommsPaneProps {
  runtimeConfig: InboxRuntimeConfig;
  sourceRuns: InboxSourceRun[];
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
  onRefreshSourceRuns: () => void;
  onProcessedStatusFilter: (status: InboxProcessedStatus | "all") => void;
  onProcessedQuery: (query: string) => void;
  onRefreshProcessed: () => void;
  onSelectProcessedItem: (item: InboxProcessedItem) => void | Promise<void>;
  onStopProcessingMission: (id: string) => void | Promise<void>;
  onRevealPath: (path: string) => void;
  onRefreshTelegram: () => void;
  onStartTelegramPolling: () => void;
  onStopTelegramPolling: () => void;
  onTelegramLogin: () => void;
  onOpenCommsSettings: () => void;
  onRefreshMigration: () => void;
  onUnloadMigration: (plistPath: string) => void;
}

export function CommsPane({
  runtimeConfig,
  sourceRuns,
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
  onRefreshSourceRuns,
  onProcessedStatusFilter,
  onProcessedQuery,
  onRefreshProcessed,
  onSelectProcessedItem,
  onStopProcessingMission,
  onRevealPath,
  onRefreshTelegram,
  onStartTelegramPolling,
  onStopTelegramPolling,
  onTelegramLogin,
  onOpenCommsSettings,
  onRefreshMigration,
  onUnloadMigration,
}: CommsPaneProps) {
  const { t } = useTranslation();
  const channels = useMemo(() => enumerateSourceChannels(runtimeConfig), [runtimeConfig]);
  const runByChannel = useMemo(() => sourceRunByChannel(sourceRuns), [sourceRuns]);
  const processedByChannel = useMemo(() => {
    const map = new Map<string, number>();
    for (const item of processedItems) {
      map.set(item.channel, (map.get(item.channel) ?? 0) + 1);
    }
    return map;
  }, [processedItems]);
  const runningChannels = useMemo(() => {
    const set = new Set<string>();
    for (const mission of processingMissions) {
      const channel = inboxProcessChannel(mission);
      if (channel) set.add(channel);
    }
    return set;
  }, [processingMissions]);
  const missionsForActive = useMemo(
    () =>
      sourceFilter
        ? processingMissions.filter((mission) => inboxProcessChannel(mission) === sourceFilter)
        : [],
    [processingMissions, sourceFilter],
  );

  const refreshAll = () => {
    onRefresh();
    onRefreshSourceRuns();
  };

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
            onClick={refreshAll}
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
        total={processedItems.length}
        onChange={onSourceFilter}
      />
      <section className="comms-body">
        {sourceFilter === null ? (
          <AllSourcesOverview
            channels={channels}
            runByChannel={runByChannel}
            processedByChannel={processedByChannel}
            runningChannels={runningChannels}
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
              processedCount={processedByChannel.get(sourceFilter) ?? 0}
              actionBusy={actionBusy}
              onProcessNow={onProcessNow}
            />
            {sourceFilter === "telegram" ? (
              <TelegramControls
                pollingStatus={telegramPollingStatus}
                onRefresh={onRefreshTelegram}
                onStartPolling={onStartTelegramPolling}
                onStopPolling={onStopTelegramPolling}
                onTelegramLogin={onTelegramLogin}
                onOpenSettings={onOpenCommsSettings}
              />
            ) : null}
            <ProcessingMissionsPanel
              missions={missionsForActive}
              logLines={processingLogLines}
              onStop={onStopProcessingMission}
              emptyLabel={t("comms.source.noActiveProcess")}
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
