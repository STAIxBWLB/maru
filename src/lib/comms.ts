import type { GmailMessageState } from "./gmail";
import type { InboxDecision } from "./inbox";
import type { OutlookMessageState } from "./outlook";
import type { TelegramMessageState } from "./telegram";

export type CommsProvider = "gmail" | "outlook" | "telegram";

export interface CommsFeedRow {
  key: string;
  provider: CommsProvider;
  title: string;
  sender: string;
  preview: string;
  date: string;
  decision: InboxDecision;
  source: GmailMessageState | OutlookMessageState | TelegramMessageState;
}

export function buildCommsFeedRows({
  gmail,
  outlook,
  telegram,
}: {
  gmail: GmailMessageState[];
  outlook: OutlookMessageState[];
  telegram: TelegramMessageState[];
}): CommsFeedRow[] {
  return [
    ...gmail.map((entry) => ({
      key: `gmail:${entry.message.id}`,
      provider: "gmail" as const,
      title: entry.message.subject,
      sender: entry.message.from,
      preview: "",
      date: entry.message.date,
      decision: entry.decision,
      source: entry,
    })),
    ...outlook.map((entry) => ({
      key: `outlook:${entry.message.id}`,
      provider: "outlook" as const,
      title: entry.message.subject,
      sender: entry.message.from,
      preview: entry.message.bodyPreview,
      date: entry.message.date,
      decision: entry.decision,
      source: entry,
    })),
    ...telegram.map((entry) => ({
      key: `telegram:${entry.message.id}`,
      provider: "telegram" as const,
      title: entry.message.chatTitle,
      sender: entry.message.sender,
      preview: entry.message.text,
      date: entry.message.date,
      decision: entry.decision,
      source: entry,
    })),
  ].sort((a, b) => {
    const aTime = Date.parse(a.date);
    const bTime = Date.parse(b.date);
    if (Number.isFinite(aTime) && Number.isFinite(bTime) && aTime !== bTime) {
      return bTime - aTime;
    }
    return a.key.localeCompare(b.key);
  });
}
