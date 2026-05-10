import { buildCommsFeedRows, type CommsProvider } from "../../lib/comms";
import type { GmailMessageState } from "../../lib/gmail";
import type { InboxDecision } from "../../lib/inbox";
import { useTranslation } from "../../lib/i18n";
import { MessageList } from "./MessageList";

interface GmailTabProps {
  messages: GmailMessageState[];
  loading: boolean;
  error: string | null;
  onDecide: (provider: CommsProvider, id: string, decision: Exclude<InboxDecision, "pending">) => void;
}

export function GmailTab({ messages, loading, error, onDecide }: GmailTabProps) {
  const { t } = useTranslation();
  const rows = buildCommsFeedRows({ gmail: messages, outlook: [], telegram: [] });
  return (
    <MessageList
      rows={rows}
      loading={loading}
      error={error}
      loadingLabel={t("inbox.gmail.loading")}
      emptyTitle={t("inbox.gmail.empty.title")}
      emptyDescription={t("inbox.gmail.empty.description")}
      onDecide={onDecide}
    />
  );
}
