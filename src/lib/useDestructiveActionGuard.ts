import { useCallback, useEffect, useRef, useState } from "react";
import type { MutableRefObject } from "react";

import type { DebouncedSaver } from "./debouncedSave";
import { setError } from "./errorStore";
import type { MaruSettings } from "./settings";
import { relaunchApp } from "./updater";
import { tauriAvailable } from "./windowLayout";

// ---------------------------------------------------------------------------
// Destructive-action guard (extracted from MainApp in step 9): the dirty-draft
// confirm dialog behind window close and update relaunch. Owns the pending
// action state, the one-shot close-replay guard, and the onCloseRequested
// subscription. The settings flush and the close replay interact through
// settingsSaverRef/closeConfirmedRef exactly as the inline version did.
// ---------------------------------------------------------------------------

export type DestructiveAction = "close" | "relaunch";

export interface DestructiveActionGuardParams {
  hasDirtyDrafts: () => boolean;
  settingsSaverRef: MutableRefObject<DebouncedSaver<MaruSettings> | null>;
}

export interface DestructiveActionGuard {
  pendingDestructiveAction: DestructiveAction | null;
  requestRelaunch: () => Promise<void>;
  requestWindowClose: () => void;
  confirmDestructiveAction: () => Promise<void>;
  cancelDestructiveAction: () => void;
}

export function useDestructiveActionGuard({
  hasDirtyDrafts,
  settingsSaverRef,
}: DestructiveActionGuardParams): DestructiveActionGuard {
  // Dirty-draft guard: "close" = window close requested, "relaunch" = update
  // ready. Non-null shows the confirm dialog; the action runs on confirm.
  const [pendingDestructiveAction, setPendingDestructiveAction] =
    useState<DestructiveAction | null>(null);
  const closeConfirmedRef = useRef(false);

  const relaunchAfterSettingsFlush = useCallback(async () => {
    try {
      await settingsSaverRef.current?.flush();
      await relaunchApp();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }, [settingsSaverRef]);

  const requestRelaunch = useCallback(async () => {
    if (hasDirtyDrafts()) {
      setPendingDestructiveAction("relaunch");
      return;
    }
    await relaunchAfterSettingsFlush();
  }, [hasDirtyDrafts, relaunchAfterSettingsFlush]);

  const confirmDestructiveAction = useCallback(async () => {
    const action = pendingDestructiveAction;
    setPendingDestructiveAction(null);
    if (action === "relaunch") {
      await relaunchAfterSettingsFlush();
      return;
    }
    if (action === "close") {
      try {
        await settingsSaverRef.current?.flush();
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err));
      }
      closeConfirmedRef.current = true;
      try {
        const { getCurrentWindow } = await import("@tauri-apps/api/window");
        await getCurrentWindow().close();
      } catch (err) {
        closeConfirmedRef.current = false;
        setError(err instanceof Error ? err.message : String(err));
      }
    }
  }, [pendingDestructiveAction, relaunchAfterSettingsFlush, settingsSaverRef]);

  const cancelDestructiveAction = useCallback(() => {
    setPendingDestructiveAction(null);
  }, []);

  const requestWindowClose = useCallback(() => {
    void import("@tauri-apps/api/window")
      .then(({ getCurrentWindow }) => getCurrentWindow().close())
      .catch((err) => setError(err instanceof Error ? err.message : String(err)));
  }, []);

  // Main-window close: flush pending settings writes before the window goes
  // away, and gate on unsaved drafts instead of losing them silently. The
  // Rust side no longer force-destroys windows on CloseRequested, so this
  // handler's preventDefault actually wins.
  useEffect(() => {
    if (!tauriAvailable()) return;
    let disposed = false;
    let unlisten: (() => void) | null = null;
    let closing = false;

    void import("@tauri-apps/api/window")
      .then(({ getCurrentWindow }) => {
        if (disposed) return;
        const appWindow = getCurrentWindow();
        if (appWindow.label !== "main") return;
        return appWindow.onCloseRequested(async (event) => {
          // A close confirmed via the dirty-draft dialog replays through
          // here; consume the one-shot guard and let the default close proceed.
          if (closeConfirmedRef.current) {
            closeConfirmedRef.current = false;
            return;
          }
          if (closing) return;
          event.preventDefault();
          if (hasDirtyDrafts()) {
            setPendingDestructiveAction("close");
            return;
          }
          closing = true;
          try {
            await settingsSaverRef.current?.flush();
          } catch (err) {
            setError(err instanceof Error ? err.message : String(err));
          }
          closeConfirmedRef.current = true;
          try {
            await appWindow.close();
          } catch (err) {
            closeConfirmedRef.current = false;
            closing = false;
            setError(err instanceof Error ? err.message : String(err));
          }
        });
      })
      .then((off) => {
        if (!off) return;
        if (disposed) off();
        else unlisten = off;
      })
      .catch(() => {});

    return () => {
      disposed = true;
      unlisten?.();
    };
  }, [hasDirtyDrafts, settingsSaverRef]);

  return {
    pendingDestructiveAction,
    requestRelaunch,
    requestWindowClose,
    confirmDestructiveAction,
    cancelDestructiveAction,
  };
}
