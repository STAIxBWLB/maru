import { useSyncExternalStore } from "react";

import type { TelegramMessage, TelegramPollingStatus } from "./types";

// ---------------------------------------------------------------------------
// Telegram comms state (extracted from MainApp in step 9). A tiny store, not
// hook-local state, because two writers live in different places: the
// useTelegramEvents listener and MainApp's refreshCommsDashboard /
// start/stopTelegramPolling callbacks (which all stay in MainApp). The
// messages slice is currently write-only (the old per-message comms list is
// gone); it stays live so the listener behavior is unchanged.
// ---------------------------------------------------------------------------

export interface TelegramEventsState {
  messages: TelegramMessage[];
  polling: TelegramPollingStatus;
}

const INITIAL_TELEGRAM_EVENTS_STATE: TelegramEventsState = {
  messages: [],
  polling: {
    running: false,
    intervalSeconds: 60,
    lastStartedAt: null,
    lastFetchedAt: null,
    lastMessageCount: 0,
    lastError: null,
  },
};

let telegramEventsState: TelegramEventsState = INITIAL_TELEGRAM_EVENTS_STATE;
const subscribers = new Set<() => void>();

function publish(next: TelegramEventsState): void {
  if (next === telegramEventsState) return;
  telegramEventsState = next;
  for (const subscriber of subscribers) subscriber();
}

export function setTelegramMessages(messages: TelegramMessage[]): void {
  if (messages === telegramEventsState.messages) return;
  publish({ ...telegramEventsState, messages });
}

export function setTelegramPolling(polling: TelegramPollingStatus): void {
  if (polling === telegramEventsState.polling) return;
  publish({ ...telegramEventsState, polling });
}

function subscribe(subscriber: () => void): () => void {
  subscribers.add(subscriber);
  return () => {
    subscribers.delete(subscriber);
  };
}

export function useTelegramMessages(): TelegramMessage[] {
  return useSyncExternalStore(
    subscribe,
    () => telegramEventsState.messages,
    () => telegramEventsState.messages,
  );
}

export function useTelegramPolling(): TelegramPollingStatus {
  return useSyncExternalStore(
    subscribe,
    () => telegramEventsState.polling,
    () => telegramEventsState.polling,
  );
}
