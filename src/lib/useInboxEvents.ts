import { useEffect } from "react";

import {
  DEFAULT_INBOX_RUNTIME_CONFIG,
  readInboxRuntimeConfig,
  startInboxWatcher,
  stopInboxWatcher,
} from "./api";
import type { InboxDropItem, InboxEntry, InboxRuntimeConfig } from "./types";

// ---------------------------------------------------------------------------
// Inbox event subscriptions (extracted from MainApp in step 9), one hook
// wrapping the two effects that used to sit side by side:
//  1. runtime config bootstrap + inbox://runtime_config_updated listener
//     (active whenever a workspace is selected, regardless of surface mode);
//  2. inbox scan + notify watcher + inbox://file_events listener (deferred
//     until Inbox mode so startup document paint owns the I/O lane).
// Same gating and handler bodies as the inline effects. The state setters
// come in as params because inboxDrops/inboxEntries/inboxRuntimeConfig/
// inboxSourceFilter stay in MainApp.
// ---------------------------------------------------------------------------

export interface InboxEventsParams {
  inboxWorkspacePath: string | null;
  /** surfaceMode === "inbox". */
  surfaceModeInbox: boolean;
  refreshInbox: () => Promise<void>;
  refreshProcessedItems: () => Promise<void>;
  setInboxRuntimeConfig: (config: InboxRuntimeConfig) => void;
  setInboxSourceFilter: (value: string | null) => void;
  setInboxDrops: (drops: InboxDropItem[]) => void;
  setInboxEntries: (entries: InboxEntry[]) => void;
}

export function useInboxEvents({
  inboxWorkspacePath,
  surfaceModeInbox,
  refreshInbox,
  refreshProcessedItems,
  setInboxRuntimeConfig,
  setInboxSourceFilter,
  setInboxDrops,
  setInboxEntries,
}: InboxEventsParams): void {
  useEffect(() => {
    if (!inboxWorkspacePath) {
      setInboxRuntimeConfig(DEFAULT_INBOX_RUNTIME_CONFIG);
      setInboxSourceFilter(null);
      return;
    }
    let cancelled = false;
    let unlistenConfigEvent: (() => void) | null = null;
    void readInboxRuntimeConfig(inboxWorkspacePath)
      .then((config) => {
        if (!cancelled) setInboxRuntimeConfig(config);
      })
      .catch(() => {
        if (!cancelled) setInboxRuntimeConfig(DEFAULT_INBOX_RUNTIME_CONFIG);
      });
    void import("@tauri-apps/api/event")
      .then(({ listen }) =>
        listen("inbox://runtime_config_updated", (event) => {
          const payload = event.payload as
            | { workPath?: string; config?: InboxRuntimeConfig }
            | null;
          if (!payload?.config || payload.workPath !== inboxWorkspacePath) return;
          setInboxRuntimeConfig(payload.config);
          setInboxSourceFilter(null);
          void refreshInbox();
          void refreshProcessedItems();
        }),
      )
      .then((off) => {
        if (cancelled) off();
        else unlistenConfigEvent = off;
      })
      .catch(() => {
        // Browser dev shell without Tauri event bridge.
      });
    return () => {
      cancelled = true;
      unlistenConfigEvent?.();
    };
  }, [
    inboxWorkspacePath,
    refreshInbox,
    refreshProcessedItems,
    setInboxRuntimeConfig,
    setInboxSourceFilter,
  ]);

  // The watcher overlays the polling baseline: the backend emits one batched
  // `inbox://file_events` per 150 ms window, and each batch triggers a
  // re-scan (guarded against overlap) rather than a delta apply, which keeps
  // the UI source of truth a single `scan_inbox_drop` snapshot.
  useEffect(() => {
    if (!inboxWorkspacePath) {
      setInboxDrops([]);
      setInboxEntries([]);
      return;
    }
    if (!surfaceModeInbox) {
      return;
    }
    let cancelled = false;
    let unlistenFileEvent: (() => void) | null = null;

    void (async () => {
      // Cold scan first — watcher only catches subsequent events.
      void refreshInbox();

      try {
        await startInboxWatcher(inboxWorkspacePath);
      } catch (err) {
        // Most likely cause: <workspace>/inbox/downloads doesn't exist yet.
        // Surface a soft notice but keep polling functional.
        if (!cancelled) {
          // eslint-disable-next-line no-console
          console.info("[maru] inbox watcher not started:", err);
        }
        return;
      }

      try {
        const { listen } = await import("@tauri-apps/api/event");
        const off = await listen("inbox://file_events", () => {
          if (!cancelled) void refreshInbox();
        });
        if (cancelled) {
          off();
        } else {
          unlistenFileEvent = off;
        }
      } catch (err) {
        // Browser dev shell — `@tauri-apps/api/event` may not be wired.
        // eslint-disable-next-line no-console
        console.info("[maru] inbox event listener unavailable:", err);
      }
    })();

    return () => {
      cancelled = true;
      if (unlistenFileEvent) unlistenFileEvent();
      void stopInboxWatcher().catch(() => {
        // best-effort
      });
    };
  }, [inboxWorkspacePath, surfaceModeInbox, refreshInbox, setInboxDrops, setInboxEntries]);
}
