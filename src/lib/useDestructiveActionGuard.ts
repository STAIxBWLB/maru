import { useCallback, useEffect, useRef, useState } from "react";
import type { MutableRefObject } from "react";

import type { DebouncedSaver } from "./debouncedSave";
import { setError } from "./errorStore";
import type { MaruSettings } from "./settings";
import { flushPendingSavesForQuit } from "./teardownSave";
import { relaunchApp } from "./updater";
import {
  closeSkillEditorForQuit,
  requestSkillEditorQuitCheck,
  tauriAvailable,
} from "./windowLayout";

// ---------------------------------------------------------------------------
// Destructive-action guard (extracted from MainApp in step 9): the dirty-draft
// confirm dialog behind window close and update relaunch. Owns the pending
// action state, the one-shot close-replay guard, and the onCloseRequested
// subscription. The settings flush and the close replay interact through
// settingsSaverRef/closeConfirmedRef exactly as the inline version did.
// ---------------------------------------------------------------------------

export type DestructiveAction = "close" | "relaunch" | "save-failed";

/** 300 ms — the flush is only announced with an indicator when it takes
 * longer than this to settle (D-04). */
export const QUIT_SAVING_INDICATOR_MS = 300;

export interface DestructiveActionGuardParams {
  hasDirtyDrafts: () => boolean;
  settingsSaverRef: MutableRefObject<DebouncedSaver<MaruSettings> | null>;
}

export interface DestructiveActionGuard {
  pendingDestructiveAction: DestructiveAction | null;
  /** True once the quit flush has been running longer than
   * QUIT_SAVING_INDICATOR_MS; false again once it settles. */
  quitSaving: boolean;
  /** Set alongside pendingDestructiveAction === "save-failed"; tells the
   * dialog which body copy to show. */
  quitFailureKind: "failed" | "timeout" | null;
  /** Which action the failed/timed-out flush interrupted, so retryQuit and
   * quitAnyway know what to re-run or continue. */
  failedQuitAction: "close" | "relaunch" | null;
  requestRelaunch: () => Promise<void>;
  requestWindowClose: () => void;
  confirmDestructiveAction: () => Promise<void>;
  cancelDestructiveAction: () => void;
  /** Re-runs the interrupted action's entry point from a save-failed dialog. */
  retryQuit: () => void;
  /** Continues the interrupted action past a save-failed dialog: the
   * existing dirty-draft confirm if drafts are still dirty, otherwise the
   * settings-flush-then-close/relaunch today's confirm path already runs. */
  quitAnyway: () => Promise<void>;
  /** Cmd+Q / the app-menu Quit item: quits the whole app from any window,
   * not just the main window that received the menu event. Asks the skill
   * editor window's own guard first (review finding #2); a cancelled guard
   * there aborts the entire quit before main's own guard is ever reached. */
  requestAppQuit: () => Promise<void>;
}

export function useDestructiveActionGuard({
  hasDirtyDrafts,
  settingsSaverRef,
}: DestructiveActionGuardParams): DestructiveActionGuard {
  // Dirty-draft guard: "close" = window close requested, "relaunch" = update
  // ready, "save-failed" = the quit flush failed or timed out. Non-null shows
  // a dialog; the action runs on confirm/retry/quit-anyway.
  const [pendingDestructiveAction, setPendingDestructiveAction] =
    useState<DestructiveAction | null>(null);
  const [quitSaving, setQuitSaving] = useState(false);
  const [quitFailureKind, setQuitFailureKind] = useState<"failed" | "timeout" | null>(null);
  const [failedQuitAction, setFailedQuitAction] = useState<"close" | "relaunch" | null>(null);
  const closeConfirmedRef = useRef(false);
  // Review finding #2: set only by requestAppQuit, once the skill editor's
  // own guard has already cleared. closeAfterSettingsFlush destroys the
  // skill editor window right before it closes main, so the two disappear
  // together only when a whole-app quit actually goes through — a plain
  // window close (red button, Cmd+W) never touches this ref and leaves the
  // skill editor alone. Cleared on any cancel so an aborted quit kills
  // nothing and a later plain close doesn't inherit the flag.
  const quitWholeAppRef = useRef(false);

  const relaunchAfterSettingsFlush = useCallback(async () => {
    try {
      await settingsSaverRef.current?.flush();
      await relaunchApp();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }, [settingsSaverRef]);

  const closeAfterSettingsFlush = useCallback(async () => {
    try {
      await settingsSaverRef.current?.flush();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
    closeConfirmedRef.current = true;
    try {
      // Review finding #2: only once every guard on the way here has
      // passed (this function is the single choke point every close/quit
      // path funnels through) do we actually destroy the skill editor, and
      // only when this close is part of a whole-app quit, not a plain
      // per-window close.
      if (quitWholeAppRef.current) {
        await closeSkillEditorForQuit();
      }
      const { getCurrentWindow } = await import("@tauri-apps/api/window");
      await getCurrentWindow().close();
    } catch (err) {
      closeConfirmedRef.current = false;
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      quitWholeAppRef.current = false;
    }
  }, [settingsSaverRef]);

  // D-03/D-04/D-05: the flush step shared by close and relaunch alike. A
  // clean settle clears the 300 ms indicator and lets the caller continue; a
  // failed or timed-out settle records which action was interrupted and
  // raises the save-failed dialog instead.
  const runQuitFlush = useCallback(async (action: "close" | "relaunch") => {
    const indicatorTimer = setTimeout(() => setQuitSaving(true), QUIT_SAVING_INDICATOR_MS);
    const outcome = await flushPendingSavesForQuit();
    clearTimeout(indicatorTimer);
    setQuitSaving(false);
    if (outcome.kind !== "clean") {
      setFailedQuitAction(action);
      setQuitFailureKind(outcome.kind);
      setPendingDestructiveAction("save-failed");
    }
    return outcome;
  }, []);

  const requestRelaunch = useCallback(async () => {
    const outcome = await runQuitFlush("relaunch");
    if (outcome.kind !== "clean") return;
    if (hasDirtyDrafts()) {
      setPendingDestructiveAction("relaunch");
      return;
    }
    await relaunchAfterSettingsFlush();
  }, [hasDirtyDrafts, relaunchAfterSettingsFlush, runQuitFlush]);

  const confirmDestructiveAction = useCallback(async () => {
    const action = pendingDestructiveAction;
    setPendingDestructiveAction(null);
    if (action === "relaunch") {
      await relaunchAfterSettingsFlush();
      return;
    }
    if (action === "close") {
      await closeAfterSettingsFlush();
    }
  }, [pendingDestructiveAction, relaunchAfterSettingsFlush, closeAfterSettingsFlush]);

  const cancelDestructiveAction = useCallback(() => {
    setPendingDestructiveAction(null);
    setQuitFailureKind(null);
    setFailedQuitAction(null);
    // Cancelling any guard cancels the whole quit and kills nothing (D-05):
    // a whole-app quit in flight must not leave the skill editor destroyed
    // on a later plain close.
    quitWholeAppRef.current = false;
  }, []);

  const requestWindowClose = useCallback(() => {
    void import("@tauri-apps/api/window")
      .then(({ getCurrentWindow }) => getCurrentWindow().close())
      .catch((err) => setError(err instanceof Error ? err.message : String(err)));
  }, []);

  const requestAppQuit = useCallback(async () => {
    if (!quitWholeAppRef.current) {
      const proceed = await requestSkillEditorQuitCheck();
      if (!proceed) return;
      quitWholeAppRef.current = true;
    }
    requestWindowClose();
  }, [requestWindowClose]);

  const retryQuit = useCallback(() => {
    const action = failedQuitAction;
    setPendingDestructiveAction(null);
    setQuitFailureKind(null);
    setFailedQuitAction(null);
    if (action === "close") {
      requestWindowClose();
    } else if (action === "relaunch") {
      void requestRelaunch();
    }
  }, [failedQuitAction, requestWindowClose, requestRelaunch]);

  const quitAnyway = useCallback(async () => {
    const action = failedQuitAction;
    setPendingDestructiveAction(null);
    setQuitFailureKind(null);
    setFailedQuitAction(null);
    if (action === "close") {
      if (hasDirtyDrafts()) {
        setPendingDestructiveAction("close");
        return;
      }
      await closeAfterSettingsFlush();
    } else if (action === "relaunch") {
      if (hasDirtyDrafts()) {
        setPendingDestructiveAction("relaunch");
        return;
      }
      await relaunchAfterSettingsFlush();
    }
  }, [failedQuitAction, hasDirtyDrafts, closeAfterSettingsFlush, relaunchAfterSettingsFlush]);

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
          if (closing) {
            // A repeat close request while the flush is in flight must not
            // fall through to the default close — the confirmed replay
            // (closeConfirmedRef) is the only path allowed to proceed.
            event.preventDefault();
            return;
          }
          event.preventDefault();
          closing = true;
          // D-03/D-04/D-05: flush every mounted autosave surface first,
          // bounded to 3 s. A failed or timed-out flush never closes — it
          // raises the save-failed dialog instead (runQuitFlush).
          const outcome = await runQuitFlush("close");
          if (outcome.kind !== "clean") {
            closing = false;
            return;
          }
          if (hasDirtyDrafts()) {
            closing = false;
            setPendingDestructiveAction("close");
            return;
          }
          await closeAfterSettingsFlush();
          closing = false;
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
  }, [closeAfterSettingsFlush, hasDirtyDrafts, runQuitFlush]);

  return {
    pendingDestructiveAction,
    quitSaving,
    quitFailureKind,
    failedQuitAction,
    requestRelaunch,
    requestWindowClose,
    confirmDestructiveAction,
    cancelDestructiveAction,
    retryQuit,
    quitAnyway,
    requestAppQuit,
  };
}
