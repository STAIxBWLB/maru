import type { VaultEntry } from "./types";
import type {
  ExplorerPaneMode,
  MaruAppMode,
  RightPaneTab,
} from "./settings";

export interface StoredVaultTabs {
  activeRelPath: string | null;
  relPaths: string[];
}

export interface VaultStartupPlan {
  candidate: VaultEntry | null;
  tabEntries: VaultEntry[];
}

export interface WorkspaceFilesScanState {
  paneMode: "documents" | "files";
  startupIoReady: boolean;
  scanStatus: WorkspaceFilesScanStatus;
  loading: boolean;
  refreshing: boolean;
}

export type WorkspaceFilesScanStatus = "unscanned" | "ready" | "failed";

export function workspaceFileScanPaneMode(input: {
  visibleAppMode: MaruAppMode;
  outlineOpen: boolean;
  rightPaneTab: RightPaneTab;
  explorerPaneMode: ExplorerPaneMode;
}): ExplorerPaneMode {
  if (input.visibleAppMode === "files") return "files";
  return input.visibleAppMode === "pkm" &&
    input.outlineOpen &&
    input.rightPaneTab === "explorer"
    ? "files"
    : input.explorerPaneMode;
}

export function workspaceFilesScanStatusAfterFailure(
  current: WorkspaceFilesScanStatus,
): WorkspaceFilesScanStatus {
  return current === "ready" ? "ready" : "failed";
}

export function isCurrentWorkspaceFilesScanRequest(
  latestByPath: Readonly<Record<string, number>>,
  path: string,
  requestSeq: number,
): boolean {
  return latestByPath[path] === requestSeq;
}

export function planVaultStartup(
  entries: VaultEntry[],
  storedTabs: StoredVaultTabs | null,
  preferRelPath: string | null,
): VaultStartupPlan {
  const findEntry = (relOrPath: string | null | undefined) =>
    relOrPath
      ? entries.find((entry) => entry.relPath === relOrPath || entry.path === relOrPath) ?? null
      : null;

  const preferredEntry = findEntry(preferRelPath);
  const storedActiveEntry = findEntry(storedTabs?.activeRelPath);
  const storedEntries =
    storedTabs?.relPaths
      .map(findEntry)
      .filter((entry): entry is VaultEntry => entry !== null) ?? [];
  const candidate = preferredEntry ?? storedActiveEntry ?? storedEntries[0] ?? entries[0] ?? null;

  if (!candidate) {
    return { candidate: null, tabEntries: [] };
  }

  const tabEntries = [candidate, ...storedEntries]
    .filter(
      (entry, index, arr) => arr.findIndex((other) => other.path === entry.path) === index,
    )
    .slice(0, 8);

  return { candidate, tabEntries };
}

export function mergeFreshEntry<T extends { entry: VaultEntry }>(
  tab: T,
  freshEntries: VaultEntry[],
): T {
  const freshEntry = freshEntries.find((entry) => entry.path === tab.entry.path);
  return freshEntry ? { ...tab, entry: freshEntry } : tab;
}

export function shouldLazyScanWorkspaceFiles({
  paneMode,
  startupIoReady,
  scanStatus,
  loading,
  refreshing,
}: WorkspaceFilesScanState): boolean {
  return (
    paneMode === "files" &&
    startupIoReady &&
    scanStatus === "unscanned" &&
    !loading &&
    !refreshing
  );
}
