import type { VaultEntry } from "./types";

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
  hasEntries: boolean;
  loading: boolean;
  refreshing: boolean;
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
  hasEntries,
  loading,
  refreshing,
}: WorkspaceFilesScanState): boolean {
  return paneMode === "files" && startupIoReady && !hasEntries && !loading && !refreshing;
}
