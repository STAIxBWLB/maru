import { useEffect } from "react";
import { transformTabs } from "./editorTabsStore";
import { getWorkspaceStoreState } from "./workspaceStore";

/** Refresh file metadata after a committed HWPX save without replacing its
 * in-memory editor session or disk revision baseline. */
export function useHwpxSaveRefresh(
  refreshWorkspaceFiles: (workspacePath: string) => Promise<void>,
): void {
  useEffect(() => {
    const refreshSavedHwpx = (event: Event) => {
      const detail = (event as CustomEvent<{ workspacePath: string; documentPath: string }>).detail;
      if (!detail || typeof detail.workspacePath !== "string" || typeof detail.documentPath !== "string") return;
      void refreshWorkspaceFiles(detail.workspacePath).then(() => {
        const fresh = getWorkspaceStoreState().fileStates[detail.workspacePath]?.entries.find((entry) => entry.relPath === detail.documentPath);
        if (!fresh) return;
        transformTabs({ mapBinaryTab: (tab) => tab.workspacePath === detail.workspacePath && tab.fileEntry.relPath === detail.documentPath
          ? { ...tab, fileEntry: fresh, classification: { ...tab.classification, sizeBytes: fresh.sizeBytes } } : tab });
      });
    };
    window.addEventListener("maru:hwpx-saved", refreshSavedHwpx);
    return () => window.removeEventListener("maru:hwpx-saved", refreshSavedHwpx);
  }, [refreshWorkspaceFiles]);
}
