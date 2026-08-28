import { useEffect } from "react";

import { updateMaruWorkspace } from "./maruDir";
import type { MaruAppMode } from "./settings";

interface PersistedEditorTab {
  id: string;
  workspacePath: string;
  entry: { relPath: string };
}

interface OpenTabsPersistenceOptions<T extends PersistedEditorTab> {
  tabs: T[];
  activeTab: T | null;
  leftActiveTabId: string | null;
  rightActiveTabId: string | null;
  focusedGroup: "left" | "right";
  openTabsKey(workspacePath: string): string;
  lastOpenKey(workspacePath: string): string;
}

/** Persists existing workspace mode metadata without adding settings state. */
export function useWorkspaceModePersistence(
  workspacePath: string | null,
  appMode: MaruAppMode,
): void {
  useEffect(() => {
    if (!workspacePath) return;
    void updateMaruWorkspace(workspacePath, { lastActiveMode: appMode }).catch(() => {});
  }, [appMode, workspacePath]);
}

/** Owns the legacy tab-session localStorage projection of canonical editor tabs. */
export function useOpenTabsPersistence<T extends PersistedEditorTab>({
  tabs,
  activeTab,
  leftActiveTabId,
  rightActiveTabId,
  focusedGroup,
  openTabsKey,
  lastOpenKey,
}: OpenTabsPersistenceOptions<T>): void {
  useEffect(() => {
    if (typeof window === "undefined") return;
    const byWorkspace = new Map<string, T[]>();
    for (const tab of tabs) {
      const bucket = byWorkspace.get(tab.workspacePath) ?? [];
      bucket.push(tab);
      byWorkspace.set(tab.workspacePath, bucket);
    }
    for (const [workspacePath, workspaceTabs] of byWorkspace) {
      const relPathForTabId = (tabId: string | null) =>
        tabId ? workspaceTabs.find((tab) => tab.id === tabId)?.entry.relPath ?? null : null;
      window.localStorage.setItem(
        openTabsKey(workspacePath),
        JSON.stringify({
          activeRelPath: activeTab?.workspacePath === workspacePath ? activeTab.entry.relPath : null,
          leftRelPath: relPathForTabId(leftActiveTabId),
          rightRelPath: relPathForTabId(rightActiveTabId),
          focusedGroup,
          relPaths: workspaceTabs.map((tab) => tab.entry.relPath),
        }),
      );
    }
    if (activeTab) window.localStorage.setItem(lastOpenKey(activeTab.workspacePath), activeTab.entry.relPath);
  }, [activeTab, focusedGroup, lastOpenKey, leftActiveTabId, openTabsKey, rightActiveTabId, tabs]);
}
