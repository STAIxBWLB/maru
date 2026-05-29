import { LogIn, Play, RefreshCcw, Settings, Square } from "lucide-react";
import type { TelegramPollingStatus } from "../../lib/types";
import { useTranslation } from "../../lib/i18n";

interface TelegramControlsProps {
  pollingStatus: TelegramPollingStatus;
  onRefresh: () => void;
  onStartPolling: () => void;
  onStopPolling: () => void;
  onTelegramLogin: () => void;
  onOpenSettings: () => void;
}

export function TelegramControls({
  pollingStatus,
  onRefresh,
  onStartPolling,
  onStopPolling,
  onTelegramLogin,
  onOpenSettings,
}: TelegramControlsProps) {
  const { t } = useTranslation();
  return (
    <div className="telegram-status">
      <span className={pollingStatus.running ? "status-dot active" : "status-dot"} />
      <span>
        {pollingStatus.running
          ? t("comms.telegram.pollingOn", { seconds: pollingStatus.intervalSeconds })
          : t("comms.telegram.pollingOff")}
      </span>
      {pollingStatus.lastFetchedAt ? (
        <span>{t("comms.telegram.lastFetch", { time: pollingStatus.lastFetchedAt })}</span>
      ) : null}
      <button type="button" className="secondary-button" onClick={onRefresh}>
        <RefreshCcw size={14} />
        <span>{t("comms.refresh")}</span>
      </button>
      <button type="button" className="secondary-button" onClick={onTelegramLogin}>
        <LogIn size={14} />
        <span>{t("comms.telegram.login")}</span>
      </button>
      {pollingStatus.running ? (
        <button type="button" className="secondary-button" onClick={onStopPolling}>
          <Square size={14} />
          <span>{t("comms.telegram.stopPolling")}</span>
        </button>
      ) : (
        <button type="button" className="secondary-button" onClick={onStartPolling}>
          <Play size={14} />
          <span>{t("comms.telegram.startPolling")}</span>
        </button>
      )}
      <button
        type="button"
        className="secondary-button"
        onClick={onOpenSettings}
        title={t("comms.openSettings")}
      >
        <Settings size={14} />
        <span>{t("comms.openSettings")}</span>
      </button>
    </div>
  );
}
