import { useEffect, type MutableRefObject } from "react";

import { readMaruSettings } from "./maruDir";
import { DEFAULT_MARU_SETTINGS, normalizeMaruSettings, type MaruSettings } from "./settings";
import { hydrateShellSettings } from "./shellSettingsStore";

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
    setLoaded(false);
    if (!settingsWorkPath) {
      if (booting && workspaceCount === 0) return () => { cancelled = true; };
      setSettings(normalizeMaruSettings(DEFAULT_MARU_SETTINGS));
      setLoaded(true);
      return;
    }
    void readMaruSettings(settingsWorkPath)
      .then((settings) => {
        if (cancelled || !hydrateShellSettings(settings, requestId, requestRef.current)) return;
        const preserveAutoOpen = autoOpenPathRef.current === settingsWorkPath;
        setAppMode(resolveMode(settings, preserveAutoOpen));
        setEditorPaneViewModes(settings.ui.editorPaneViewModes);
        setRightPaneTab(settings.ui.rightPaneTab);
        setLoaded(true);
      })
      .catch(() => {
        if (cancelled) return;
        setSettings(normalizeMaruSettings(DEFAULT_MARU_SETTINGS));
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
