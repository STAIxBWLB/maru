import type { InboxDecision } from "./inbox";
import type { OutlookMessage } from "./types";

export interface OutlookMessageState {
  message: OutlookMessage;
  decision: InboxDecision;
}

export function buildOutlookMessageStates(
  messages: OutlookMessage[],
  decisionsById: Map<string, InboxDecision>,
): OutlookMessageState[] {
  return messages.map((message) => ({
    message,
    decision: decisionsById.get(message.id) ?? "pending",
  }));
}

export function outlookPreview(message: OutlookMessage): string {
  return message.bodyPreview.trim();
}
