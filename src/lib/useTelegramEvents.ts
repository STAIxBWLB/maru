import { useEffect } from "react";
import type { MutableRefObject } from "react";

import { setTelegramMessages, setTelegramPolling } from "./telegramEventsStore";
import type { TelegramMessage, TelegramPollingStatus } from "./types";

// ---------------------------------------------------------------------------
// Telegram comms-mode event subscription (extracted from MainApp in step 9):
// while the comms surface is active and its workspace config has settled,
// kick the dashboard refresh once and mirror telegram://messages payloads
// into the telegram events store. Same gating and handler body as the inline
// effect; the latest-callback ref keeps re-subscription off filter keystrokes.
// ---------------------------------------------------------------------------

export interface TelegramEventsParams {
  /** surfaceMode === "comms" and the workspace config load is not idle/pending. */
  enabled: boolean;
  /** Kept as a dep so ready/error transitions re-kick the dashboard refresh,
   *  exactly as the inline effect's status dep did. */
  configStatus: string;
  inboxWorkspacePath: string | null;
  refreshCommsDashboardRef: MutableRefObject<() => void>;
}

export function useTelegramEvents({
  enabled,
  configStatus,
  inboxWorkspacePath,
  refreshCommsDashboardRef,
}: TelegramEventsParams): void {
  useEffect(() => {
    if (!enabled) return;
    let disposed = false;
    let unlistenTelegram: (() => void) | null = null;
    void refreshCommsDashboardRef.current();
    void import("@tauri-apps/api/event")
      .then(({ listen }) =>
        listen("telegram://messages", (event) => {
          const payload = event.payload as
            | {
                workPath?: string | null;
                messages?: TelegramMessage[];
                status?: TelegramPollingStatus;
              }
            | null;
          if (payload?.workPath && payload.workPath !== inboxWorkspacePath) return;
          if (payload?.messages) setTelegramMessages(payload.messages);
          if (payload?.status) setTelegramPolling(payload.status);
        }),
      )
      .then((off) => {
        if (disposed) off();
        else unlistenTelegram = off;
      })
      .catch(() => {});
    return () => {
      disposed = true;
      unlistenTelegram?.();
    };
  }, [enabled, configStatus, inboxWorkspacePath, refreshCommsDashboardRef]);
}
