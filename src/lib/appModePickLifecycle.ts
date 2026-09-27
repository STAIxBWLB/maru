import { useEffect, useRef, type MutableRefObject } from "react";

import type { MaruAppMode, MaruSettings } from "./settings";

/** Settings patch shared by setPersistedAppMode and the pick re-application. */
export function withActiveAppMode(
  settings: MaruSettings,
  activeAppMode: MaruAppMode,
): MaruSettings {
  return {
    ...settings,
    ui: {
      ...settings.ui,
      activeAppMode,
      explorerPaneMode:
        activeAppMode === "files"
          ? "files"
          : activeAppMode === "pkm"
            ? "documents"
            : settings.ui.explorerPaneMode,
    },
  };
}

/**
 * A pending pick belongs to the settings of the workspace it was made in: it
 * survives the boot transition (no settings path yet → boot workspace) but
 * not a switch to another workspace, whose hydration must apply that
 * workspace's own stored mode (#387).
 */
export function pickSurvivesSettingsPathChange(
  previousPath: string | null,
  nextPath: string | null,
): boolean {
  return previousPath === null || previousPath === nextPath;
}

/**
 * The pick is re-applied while it is missing from the in-memory settings
 * (hydration or a save echo reverted them) or while a save is possible — a
 * pick made before the settings were writable never reached disk (#387).
 */
export function shouldReapplyAppModePick(input: {
  picked: MaruAppMode | null;
  settingsWorkPath: string | null;
  settingsWritable: boolean;
  storedAppMode: MaruAppMode;
}): boolean {
  if (input.picked === null || !input.settingsWorkPath) return false;
  return input.settingsWritable || input.storedAppMode !== input.picked;
}

interface AppModePickLifecycleOptions {
  settingsWorkPath: string | null;
  settingsWritable: boolean;
  storedAppMode: MaruAppMode;
  userPickRef: MutableRefObject<MaruAppMode | null>;
  updateSettings(updater: (current: MaruSettings) => MaruSettings): void;
}

/**
 * Owns the boot-time app-mode pick lifecycle (#387): a mode picked before the
 * workspace settings became writable is memory-only, so it is re-applied into
 * the settings (and persisted) once saves are possible, and restored whenever
 * hydration or a save echo reverts the in-memory settings while the pick is
 * still pending. The echo listener lifts the guard once the stored settings
 * catch up; a workspace switch drops the pick. Declared as one hook so
 * MainApp stays under the D-13 hook ceiling.
 */
export function useAppModePickLifecycle({
  settingsWorkPath,
  settingsWritable,
  storedAppMode,
  userPickRef,
  updateSettings,
}: AppModePickLifecycleOptions): void {
  const prevSettingsWorkPathRef = useRef<string | null>(null);
  useEffect(() => {
    if (!pickSurvivesSettingsPathChange(prevSettingsWorkPathRef.current, settingsWorkPath)) {
      userPickRef.current = null;
    }
    prevSettingsWorkPathRef.current = settingsWorkPath;
  }, [settingsWorkPath, userPickRef]);

  useEffect(() => {
    const picked = userPickRef.current;
    if (picked === null) return;
    if (!shouldReapplyAppModePick({ picked, settingsWorkPath, settingsWritable, storedAppMode })) {
      return;
    }
    updateSettings((current) => withActiveAppMode(current, picked));
  }, [settingsWorkPath, settingsWritable, storedAppMode, updateSettings, userPickRef]);
}
