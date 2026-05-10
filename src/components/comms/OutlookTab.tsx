import { buildCommsFeedRows, type CommsProvider } from "../../lib/comms";
import type { InboxDecision } from "../../lib/inbox";
import type { OutlookMessageState } from "../../lib/outlook";
import { useTranslation } from "../../lib/i18n";
import { MessageList } from "./MessageList";

interface OutlookTabProps {
  messages: OutlookMessageState[];
  loading: boolean;
  error: string | null;
  onDecide: (provider: CommsProvider, id: string, decision: Exclude<InboxDecision, "pending">) => void;
}

export function OutlookTab({ messages, loading, error, onDecide }: OutlookTabProps) {
  const { t } = useTranslation();
  const rows = buildCommsFeedRows({ gmail: [], outlook: messages, telegram: [] });
  return (
    <MessageList
      rows={rows}
      loading={loading}
      error={error}
      loadingLabel={t("comms.outlook.loading")}
      emptyTitle={t("comms.outlook.empty.title")}
      emptyDescription={t("comms.outlook.empty.description")}
      onDecide={onDecide}
    />
  );
}
