import { useEffect, type MutableRefObject } from "react";

import { readMaruSettings } from "./maruDir";
import { DEFAULT_MARU_SETTINGS, normalizeMaruSettings, type MaruSettings } from "./settings";
import { bindShellSettingsRead, captureShellSettingsRevision, getShellSettings, hydrateShellSettings } from "./shellSettingsStore";

interface ShellSettingsHydrationOptions<TMode> {
  settingsWorkPath: string | null;
  booting: boolean;
  workspaceCount: number;
  requestRef: MutableRefObject<number>;
  autoOpenPathRef: MutableRefObject<string | null>;
  autoOpenModeRef: MutableRefObject<TMode | null>;
  setSettings(settings: MaruSettings): void;
  setAppMode(mode: TMode): void;
  resolveMode(settings: MaruSettings, preserveAutoOpen: boolean): TMode;
  setEditorPaneViewModes(modes: MaruSettings["ui"]["editorPaneViewModes"]): void;
  setRightPaneTab(tab: MaruSettings["ui"]["rightPaneTab"]): void;
  setLoaded(loaded: boolean): void;
}

/**
 * The settings owner keeps the original workspace-load generation guard and
 * applies the existing keys to their facade owners after a successful load.
 */
export function useShellSettingsHydration<TMode>({
  settingsWorkPath,
  booting,
  workspaceCount,
  requestRef,
  autoOpenPathRef,
  autoOpenModeRef,
  setSettings,
  setAppMode,
  resolveMode,
  setEditorPaneViewModes,
  setRightPaneTab,
  setLoaded,
}: ShellSettingsHydrationOptions<TMode>): void {
  useEffect(() => {
    let cancelled = false;
    const requestId = requestRef.current;
    const readStartedAt = captureShellSettingsRevision();
    setLoaded(false);
    if (!settingsWorkPath) {
      if (booting && workspaceCount === 0) return () => { cancelled = true; };
      setSettings(normalizeMaruSettings(DEFAULT_MARU_SETTINGS));
      setLoaded(true);
      return;
    }
    void readMaruSettings(settingsWorkPath)
      .then((settings) => {
        if (cancelled || !hydrateShellSettings(settings, requestId, requestRef.current, readStartedAt)) return;
        const effective = getShellSettings();
        const preserveAutoOpen = autoOpenPathRef.current === settingsWorkPath;
        setAppMode(resolveMode(effective, preserveAutoOpen));
        setEditorPaneViewModes(effective.ui.editorPaneViewModes);
        setRightPaneTab(effective.ui.rightPaneTab);
        setLoaded(true);
      })
      .catch(() => {
        if (cancelled) return;
        setSettings(bindShellSettingsRead(normalizeMaruSettings(DEFAULT_MARU_SETTINGS), readStartedAt));
        setLoaded(true);
      });
    return () => { cancelled = true; };
  }, [
    autoOpenModeRef,
    autoOpenPathRef,
    booting,
    requestRef,
    resolveMode,
    setAppMode,
    setEditorPaneViewModes,
    setLoaded,
    setRightPaneTab,
    setSettings,
    settingsWorkPath,
    workspaceCount,
  ]);
}
