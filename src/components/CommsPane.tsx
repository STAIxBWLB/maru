import { RefreshCcw } from "lucide-react";
import { useState } from "react";
import type { LegacyLaunchdService } from "../lib/api";
import type { CommsProvider } from "../lib/comms";
import type { GmailMessageState } from "../lib/gmail";
import type { InboxDecision } from "../lib/inbox";
import type { OutlookMessageState } from "../lib/outlook";
import type { CommsSettings } from "../lib/settings";
import type { TelegramMessageState } from "../lib/telegram";
import type { TelegramPollingStatus } from "../lib/types";
import { useTranslation } from "../lib/i18n";
import { AllTab } from "./comms/AllTab";
import { CommsSettingsTab } from "./comms/CommsSettingsTab";
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
  telegramEnvHealthy: boolean | null;
  settings: CommsSettings;
  migrationServices: LegacyLaunchdService[];
  migrationBusy: boolean;
  onRefresh: () => void;
  onRefreshTelegram: () => void;
  onDecide: (provider: CommsProvider, id: string, decision: Exclude<InboxDecision, "pending">) => void;
  onSettingsChange: (settings: CommsSettings) => void;
  onStartTelegramPolling: () => void;
  onStopTelegramPolling: () => void;
  onTelegramLogin: () => void;
  onOpenSkillsEnvSettings: () => void;
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
  telegramEnvHealthy,
  settings,
  migrationServices,
  migrationBusy,
  onRefresh,
  onRefreshTelegram,
  onDecide,
  onSettingsChange,
  onStartTelegramPolling,
  onStopTelegramPolling,
  onTelegramLogin,
  onOpenSkillsEnvSettings,
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
        <button
          type="button"
          className="icon-button"
          onClick={onRefresh}
          title={t("comms.refresh")}
          aria-label={t("comms.refresh")}
        >
          <RefreshCcw size={14} />
        </button>
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
            onDecide={onDecide}
          />
        ) : null}
        {activeTab === "settings" ? (
          <CommsSettingsTab
            settings={settings}
            pollingStatus={telegramPollingStatus}
            telegramEnvHealthy={telegramEnvHealthy}
            onSettingsChange={onSettingsChange}
            onStartPolling={onStartTelegramPolling}
            onStopPolling={onStopTelegramPolling}
            onTelegramLogin={onTelegramLogin}
            onOpenSkillsEnvSettings={onOpenSkillsEnvSettings}
          />
        ) : null}
      </section>
    </main>
  );
}

function pendingCount<T extends { decision: InboxDecision }>(items: T[]): number {
  return items.filter((item) => item.decision === "pending").length;
}
