import { buildCommsFeedRows, type CommsProvider } from "../../lib/comms";
import type { GmailMessageState } from "../../lib/gmail";
import type { InboxDecision } from "../../lib/inbox";
import type { OutlookMessageState } from "../../lib/outlook";
import type { TelegramMessageState } from "../../lib/telegram";
import { useTranslation } from "../../lib/i18n";
import { MessageList } from "./MessageList";

interface AllTabProps {
  gmail: GmailMessageState[];
  outlook: OutlookMessageState[];
  telegram: TelegramMessageState[];
  onDecide: (provider: CommsProvider, id: string, decision: Exclude<InboxDecision, "pending">) => void;
}

export function AllTab({ gmail, outlook, telegram, onDecide }: AllTabProps) {
  const { t } = useTranslation();
  const rows = buildCommsFeedRows({ gmail, outlook, telegram });
  return (
    <MessageList
      rows={rows}
      emptyTitle={t("comms.empty.title")}
      emptyDescription={t("comms.empty.description")}
      onDecide={onDecide}
    />
  );
}
