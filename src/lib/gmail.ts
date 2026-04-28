import type { GmailMessage } from "./types";
import type { InboxDecision } from "./inbox";

export interface GmailMessageState {
  message: GmailMessage;
  decision: InboxDecision;
}

export function buildGmailMessageStates(
  messages: GmailMessage[],
  decisionsById: Map<string, InboxDecision>,
): GmailMessageState[] {
  return messages.map((message) => ({
    message,
    decision: decisionsById.get(message.id) ?? "pending",
  }));
}

/** Strip RFC5322 angle-bracket form `Display Name <addr@host>` down to a
 *  short label. Falls back to the raw value when no display name is
 *  present so OAuth-issued senders like `no-reply@plaud.ai` still
 *  render readably. */
export function shortFrom(raw: string): string {
  const trimmed = raw.trim();
  if (!trimmed) return "";
  const match = trimmed.match(/^"?([^"<]+?)"?\s*<[^>]+>$/);
  if (match) return match[1].trim();
  return trimmed;
}
