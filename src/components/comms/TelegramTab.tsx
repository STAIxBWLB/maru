import { RefreshCcw } from "lucide-react";
import { buildCommsFeedRows, type CommsProvider } from "../../lib/comms";
import type { InboxDecision } from "../../lib/inbox";
import type { TelegramMessageState } from "../../lib/telegram";
import type { TelegramPollingStatus } from "../../lib/types";
import { useTranslation } from "../../lib/i18n";
import { MessageList } from "./MessageList";

interface TelegramTabProps {
  messages: TelegramMessageState[];
  loading: boolean;
  error: string | null;
  pollingStatus: TelegramPollingStatus;
  onRefresh: () => void;
  onDecide: (provider: CommsProvider, id: string, decision: Exclude<InboxDecision, "pending">) => void;
}

export function TelegramTab({
  messages,
  loading,
  error,
  pollingStatus,
  onRefresh,
  onDecide,
}: TelegramTabProps) {
  const { t } = useTranslation();
  const rows = buildCommsFeedRows({ gmail: [], outlook: [], telegram: messages });
  return (
    <div className="telegram-tab">
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
      </div>
      <MessageList
        rows={rows}
        loading={loading}
        error={error ?? pollingStatus.lastError}
        loadingLabel={t("comms.telegram.loading")}
        emptyTitle={t("comms.telegram.empty.title")}
        emptyDescription={t("comms.telegram.empty.description")}
        onDecide={onDecide}
      />
    </div>
  );
}
