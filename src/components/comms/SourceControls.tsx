import { LogIn, Play, RefreshCcw, Settings, Sparkles, Square } from "lucide-react";
import type { ProviderAuthStatus, TelegramPollingStatus } from "../../lib/types";
import { useTranslation } from "../../lib/i18n";
import { AuthStatusBadge } from "./AuthStatusBadge";

interface SourceControlsProps {
  channel: string;
  authStatus?: ProviderAuthStatus | null;
  pollingStatus?: TelegramPollingStatus | null;
  actionBusy?: boolean;
  onRefresh: () => void;
  onReauth?: () => void;
  onProcessNow: (channel: string) => void;
  onDeepProcess?: (channel: string) => void;
  onStartPolling?: () => void;
  onStopPolling?: () => void;
  onOpenSettings?: () => void;
}

export function SourceControls({
  channel,
  authStatus,
  pollingStatus,
  actionBusy = false,
  onRefresh,
  onReauth,
  onProcessNow,
  onDeepProcess,
  onStartPolling,
  onStopPolling,
  onOpenSettings,
}: SourceControlsProps) {
  const { t } = useTranslation();
  const isTelegram = channel === "telegram";
  return (
    <div className="source-controls">
      <AuthStatusBadge status={authStatus} />
      {isTelegram && pollingStatus ? (
        <>
          <span className={pollingStatus.running ? "status-dot active" : "status-dot"} />
          <span>
            {pollingStatus.running
              ? t("comms.telegram.pollingOn", { seconds: pollingStatus.intervalSeconds })
              : t("comms.telegram.pollingOff")}
          </span>
        </>
      ) : null}
      <button type="button" className="secondary-button" onClick={onRefresh}>
        <RefreshCcw size={14} />
        <span>{t("comms.source.refresh")}</span>
      </button>
      {onReauth ? (
        <button type="button" className="secondary-button" onClick={onReauth}>
          <LogIn size={14} />
          <span>{isTelegram ? t("comms.telegram.login") : t("comms.auth.reauth")}</span>
        </button>
      ) : null}
      {isTelegram && pollingStatus ? (
        pollingStatus.running ? (
          <button type="button" className="secondary-button" onClick={onStopPolling}>
            <Square size={14} />
            <span>{t("comms.telegram.stopPolling")}</span>
          </button>
        ) : (
          <button type="button" className="secondary-button" onClick={onStartPolling}>
            <Play size={14} />
            <span>{t("comms.telegram.startPolling")}</span>
          </button>
        )
      ) : null}
      <button
        type="button"
        className="button button-primary button-sm"
        disabled={actionBusy}
        onClick={() => onProcessNow(channel)}
      >
        <Play size={14} />
        <span>{t("comms.source.processNow")}</span>
      </button>
      {isTelegram && onDeepProcess ? (
        <button
          type="button"
          className="secondary-button"
          disabled={actionBusy}
          onClick={() => onDeepProcess(channel)}
        >
          <Sparkles size={14} />
          <span>{t("comms.source.deepProcess")}</span>
        </button>
      ) : null}
      {onOpenSettings ? (
        <button
          type="button"
          className="secondary-button"
          onClick={onOpenSettings}
          title={t("comms.openSettings")}
        >
          <Settings size={14} />
          <span>{t("comms.openSettings")}</span>
        </button>
      ) : null}
    </div>
  );
}
