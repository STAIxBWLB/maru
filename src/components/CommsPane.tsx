import { RefreshCcw, Settings } from "lucide-react";
import { useState } from "react";
import type { LegacyLaunchdService } from "../lib/api";
import type { CommsProvider } from "../lib/comms";
import type { GmailMessageState } from "../lib/gmail";
import type { InboxDecision } from "../lib/inbox";
import type { OutlookMessageState } from "../lib/outlook";
import type { TelegramMessageState } from "../lib/telegram";
import type { TelegramPollingStatus } from "../lib/types";
import { useTranslation } from "../lib/i18n";
import { AllTab } from "./comms/AllTab";
import { CommsTabs, type CommsTab } from "./comms/CommsTabs";
import { GmailTab } from "./comms/GmailTab";
import { MigrationBanner } from "./comms/MigrationBanner";
import { OutlookTab } from "./comms/OutlookTab";
import { TelegramTab } from "./comms/TelegramTab";

interface CommsPaneProps {
  gmailMessages: GmailMessageState[];
  gmailLoading: boolean;
  gmailError: string | null;
  gmailStatus: string;
  outlookMessages: OutlookMessageState[];
  outlookLoading: boolean;
  outlookError: string | null;
  outlookStatus: string;
  telegramMessages: TelegramMessageState[];
  telegramLoading: boolean;
  telegramError: string | null;
  telegramPollingStatus: TelegramPollingStatus;
  migrationServices: LegacyLaunchdService[];
  migrationBusy: boolean;
  onRefresh: () => void;
  onRefreshTelegram: () => void;
  onDecide: (provider: CommsProvider, id: string, decision: Exclude<InboxDecision, "pending">) => void;
  onStartTelegramPolling: () => void;
  onStopTelegramPolling: () => void;
  onTelegramLogin: () => void;
  onOpenCommsSettings: () => void;
  onRefreshMigration: () => void;
  onUnloadMigration: (plistPath: string) => void;
}

export function CommsPane({
  gmailMessages,
  gmailLoading,
  gmailError,
  gmailStatus,
  outlookMessages,
  outlookLoading,
  outlookError,
  outlookStatus,
  telegramMessages,
  telegramLoading,
  telegramError,
  telegramPollingStatus,
  migrationServices,
  migrationBusy,
  onRefresh,
  onRefreshTelegram,
  onDecide,
  onStartTelegramPolling,
  onStopTelegramPolling,
  onTelegramLogin,
  onOpenCommsSettings,
  onRefreshMigration,
  onUnloadMigration,
}: CommsPaneProps) {
  const { t, locale } = useTranslation();
  const [activeTab, setActiveTab] = useState<CommsTab>("all");
  return (
    <main className="comms-pane" tabIndex={-1}>
      <header className="comms-header">
        <div>
          <h2>{t("comms.title")}</h2>
          <p>
            {t("comms.subtitle", {
              gmail: pendingCount(gmailMessages).toLocaleString(locale),
              outlook: pendingCount(outlookMessages).toLocaleString(locale),
              telegram: pendingCount(telegramMessages).toLocaleString(locale),
            })}
            {gmailStatus ? ` · Gmail ${gmailStatus}` : ""}
            {outlookStatus ? ` · Outlook ${outlookStatus}` : ""}
          </p>
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
      <CommsTabs
        activeTab={activeTab}
        onTabChange={setActiveTab}
        counts={{
          gmail: gmailMessages.length,
          outlook: outlookMessages.length,
          telegram: telegramMessages.length,
        }}
      />
      <section className="comms-body">
        {activeTab === "all" ? (
          <AllTab
            gmail={gmailMessages}
            outlook={outlookMessages}
            telegram={telegramMessages}
            onDecide={onDecide}
          />
        ) : null}
        {activeTab === "gmail" ? (
          <GmailTab
            messages={gmailMessages}
            loading={gmailLoading}
            error={gmailError}
            onDecide={onDecide}
          />
        ) : null}
        {activeTab === "outlook" ? (
          <OutlookTab
            messages={outlookMessages}
            loading={outlookLoading}
            error={outlookError}
            onDecide={onDecide}
          />
        ) : null}
        {activeTab === "telegram" ? (
          <TelegramTab
            messages={telegramMessages}
            loading={telegramLoading}
            error={telegramError}
            pollingStatus={telegramPollingStatus}
            onRefresh={onRefreshTelegram}
            onStartPolling={onStartTelegramPolling}
            onStopPolling={onStopTelegramPolling}
            onTelegramLogin={onTelegramLogin}
            onOpenSettings={onOpenCommsSettings}
            onDecide={onDecide}
          />
        ) : null}
      </section>
    </main>
  );
}

function pendingCount<T extends { decision: InboxDecision }>(items: T[]): number {
  return items.filter((item) => item.decision === "pending").length;
}
