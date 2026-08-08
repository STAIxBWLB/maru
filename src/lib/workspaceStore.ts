import { useEffect, useSyncExternalStore } from "react";

import { scanVault, scanVaultPaths, startVaultWatcher, stopVaultWatcher } from "./api";
import { ALL_DOCUMENTS_FILTER, type DocumentFilter } from "./documentIndex";
import type {
  ScanOptions,
  VaultEntry,
  WorkspaceEntryNode,
  WorkspaceFileEntry,
  WorkspaceRegistry,
  WorkspaceVisibility,
} from "./types";
import type { WorkspaceFilesScanStatus } from "./vaultStartup";

// ---------------------------------------------------------------------------
// Workspace system state (extracted from MainApp in step 8): the workspace
// registry, the per-workspace document index + file-tree twins, and the
// per-visibility explorer UI (query, filter, collapsed folders, selection).
// Same shape as editorTabsStore: one module-level state object replaced
// atomically by publish(), pure *InState helpers (unit-tested directly), and
// per-slice useSyncExternalStore hooks.
// ---------------------------------------------------------------------------

export interface WorkspaceEntriesState {
  entries: VaultEntry[];
  loading: boolean;
  refreshing: boolean;
  startupIoReady: boolean;
}

export const EMPTY_WORKSPACE_STATE: WorkspaceEntriesState = {
  entries: [],
  loading: false,
  refreshing: false,
  startupIoReady: false,
};

export interface WorkspaceFilesState {
  entries: WorkspaceFileEntry[];
  nodes: WorkspaceEntryNode[];
  scanStatus: WorkspaceFilesScanStatus;
  loading: boolean;
  refreshing: boolean;
}

export const EMPTY_WORKSPACE_FILES_STATE: WorkspaceFilesState = {
  entries: [],
  nodes: [],
  scanStatus: "unscanned",
  loading: false,
  refreshing: false,
};

export interface WorkspaceStoreState {
  registry: WorkspaceRegistry;
  states: Record<string, WorkspaceEntriesState>;
  fileStates: Record<string, WorkspaceFilesState>;
  explorerVisibility: WorkspaceVisibility;
  queryByVisibility: Record<WorkspaceVisibility, string>;
  fileQueryByVisibility: Record<WorkspaceVisibility, string>;
  documentFilterByVisibility: Record<WorkspaceVisibility, DocumentFilter>;
  collapsedTreeFoldersByVisibility: Record<WorkspaceVisibility, string[]>;
  collapsedFileFoldersByVisibility: Record<WorkspaceVisibility, string[]>;
  selectedFilePathsByWorkspace: Record<string, string[]>;
}

const INITIAL_WORKSPACE_STORE_STATE: WorkspaceStoreState = {
  registry: {
    workspaces: [],
    activeByVisibility: {
      private: null,
      public: null,
    },
    hiddenDefaults: [],
  },
  states: {},
  fileStates: {},
  explorerVisibility: "private",
  queryByVisibility: {
    private: "",
    public: "",
  },
  fileQueryByVisibility: {
    private: "",
    public: "",
  },
  documentFilterByVisibility: {
    private: ALL_DOCUMENTS_FILTER,
    public: ALL_DOCUMENTS_FILTER,
  },
  collapsedTreeFoldersByVisibility: {
    private: [],
    public: [],
  },
  collapsedFileFoldersByVisibility: {
    private: [],
    public: [],
  },
  selectedFilePathsByWorkspace: {},
};

// ---------------------------------------------------------------------------
// Pure state helpers. Store actions are thin wrappers that compute the next
// state with these and publish it atomically. Every helper returns the input
// state identity when the change is a no-op so subscribers do not re-render.
// ---------------------------------------------------------------------------

/** Shallow per-path merge into `states`; untouched paths keep their object
 *  identity (every consumer keys on array/object identity). */
export function updateWorkspaceStateInState(
  state: WorkspaceStoreState,
  path: string,
  patch: Partial<WorkspaceEntriesState>,
): WorkspaceStoreState {
  const current = state.states[path] ?? EMPTY_WORKSPACE_STATE;
  const merged: WorkspaceEntriesState = { ...current, ...patch };
  const changed = (Object.keys(patch) as (keyof WorkspaceEntriesState)[]).some(
    (key) => merged[key] !== current[key],
  );
  if (!changed) return state;
  return { ...state, states: { ...state.states, [path]: merged } };
}

/** Shallow per-path merge into `fileStates` (the files twin of
 *  updateWorkspaceStateInState). */
export function updateWorkspaceFileStateInState(
  state: WorkspaceStoreState,
  path: string,
  patch: Partial<WorkspaceFilesState>,
): WorkspaceStoreState {
  const current = state.fileStates[path] ?? EMPTY_WORKSPACE_FILES_STATE;
  const merged: WorkspaceFilesState = { ...current, ...patch };
  const changed = (Object.keys(patch) as (keyof WorkspaceFilesState)[]).some(
    (key) => merged[key] !== current[key],
  );
  if (!changed) return state;
  return { ...state, fileStates: { ...state.fileStates, [path]: merged } };
}

/** Workspace removal: drop only its entries state. The fileStates twin and
 *  the tab cleanup stay with the App orchestrators, matching the previous
 *  behavior exactly. */
export function removeWorkspaceStateInState(
  state: WorkspaceStoreState,
  path: string,
): WorkspaceStoreState {
  if (!(path in state.states)) return state;
  const states = { ...state.states };
  delete states[path];
  return { ...state, states };
}

export function setWorkspaceRegistryInState(
  state: WorkspaceStoreState,
  registry: WorkspaceRegistry,
): WorkspaceStoreState {
  return state.registry === registry ? state : { ...state, registry };
}

export function setExplorerVisibilityInState(
  state: WorkspaceStoreState,
  visibility: WorkspaceVisibility,
): WorkspaceStoreState {
  return state.explorerVisibility === visibility ? state : { ...state, explorerVisibility: visibility };
}

/** The registry/visibility co-write every activate flow does (switch, add,
 *  register, boot, remove) in a single transition. */
export function activateWorkspaceInState(
  state: WorkspaceStoreState,
  registry: WorkspaceRegistry,
  visibility: WorkspaceVisibility,
): WorkspaceStoreState {
  if (state.registry === registry && state.explorerVisibility === visibility) return state;
  return { ...state, registry, explorerVisibility: visibility };
}

export function setQueryInState(
  state: WorkspaceStoreState,
  visibility: WorkspaceVisibility,
  query: string,
): WorkspaceStoreState {
  if (state.queryByVisibility[visibility] === query) return state;
  return {
    ...state,
    queryByVisibility: { ...state.queryByVisibility, [visibility]: query },
  };
}

export function setFileQueryInState(
  state: WorkspaceStoreState,
  visibility: WorkspaceVisibility,
  query: string,
): WorkspaceStoreState {
  if (state.fileQueryByVisibility[visibility] === query) return state;
  return {
    ...state,
    fileQueryByVisibility: { ...state.fileQueryByVisibility, [visibility]: query },
  };
}

export function setDocumentFilterInState(
  state: WorkspaceStoreState,
  visibility: WorkspaceVisibility,
  filter: DocumentFilter,
): WorkspaceStoreState {
  if (state.documentFilterByVisibility[visibility] === filter) return state;
  return {
    ...state,
    documentFilterByVisibility: { ...state.documentFilterByVisibility, [visibility]: filter },
  };
}

/** The custom-view prune MainApp ran in an effect: a custom filter whose view
 *  disappeared falls back to "all". */
export function pruneCustomDocumentFiltersInState(
  state: WorkspaceStoreState,
  validViewIds: ReadonlySet<string>,
): WorkspaceStoreState {
  let changed = false;
  const next = { ...state.documentFilterByVisibility };
  for (const visibility of ["private", "public"] as const) {
    const filter = next[visibility];
    if (filter.kind === "custom" && !validViewIds.has(filter.viewId)) {
      next[visibility] = { kind: "all" };
      changed = true;
    }
  }
  return changed ? { ...state, documentFilterByVisibility: next } : state;
}

export function setCollapsedTreeFoldersInState(
  state: WorkspaceStoreState,
  visibility: WorkspaceVisibility,
  paths: string[],
): WorkspaceStoreState {
  if (state.collapsedTreeFoldersByVisibility[visibility] === paths) return state;
  return {
    ...state,
    collapsedTreeFoldersByVisibility: {
      ...state.collapsedTreeFoldersByVisibility,
      [visibility]: paths,
    },
  };
}

export function setCollapsedFileFoldersInState(
  state: WorkspaceStoreState,
  visibility: WorkspaceVisibility,
  paths: string[],
): WorkspaceStoreState {
  if (state.collapsedFileFoldersByVisibility[visibility] === paths) return state;
  return {
    ...state,
    collapsedFileFoldersByVisibility: {
      ...state.collapsedFileFoldersByVisibility,
      [visibility]: paths,
    },
  };
}

export function setSelectedFilePathsInState(
  state: WorkspaceStoreState,
  workspacePath: string,
  paths: string[],
): WorkspaceStoreState {
  if (state.selectedFilePathsByWorkspace[workspacePath] === paths) return state;
  return {
    ...state,
    selectedFilePathsByWorkspace: {
      ...state.selectedFilePathsByWorkspace,
      [workspacePath]: paths,
    },
  };
}

/** Entry ordering identical to the Rust scan (vault.rs sort_by: updated_at
 *  desc, then lowercased title asc). `Option<String>` orders None last in the
 *  descending comparison, so null updatedAt sorts after any timestamp. */
function compareVaultEntries(a: VaultEntry, b: VaultEntry): number {
  if (a.updatedAt !== b.updatedAt) {
    if (a.updatedAt === null) return 1;
    if (b.updatedAt === null) return -1;
    return a.updatedAt < b.updatedAt ? 1 : -1;
  }
  const titleA = a.title.toLowerCase();
  const titleB = b.title.toLowerCase();
  if (titleA === titleB) return 0;
  return titleA < titleB ? -1 : 1;
}

/** Incremental watcher delta application against one workspace's entries:
 *  - upsert: a touched relPath present in freshEntries replaces the old entry
 *    (or is appended when it is a creation);
 *  - remove: a touched relPath absent from freshEntries is dropped (the file
 *    was deleted or became excluded — scan_vault_paths omits both);
 *  - re-sort by updatedAt desc then title (the Rust scan order);
 *  - entries outside touchedRelPaths keep their object identity; the states
 *  record identity is preserved when the delta is a no-op. */
export function applyVaultDeltaInState(
  states: Record<string, WorkspaceEntriesState>,
  workspacePath: string,
  freshEntries: VaultEntry[],
  touchedRelPaths: readonly string[],
): Record<string, WorkspaceEntriesState> {
  if (touchedRelPaths.length === 0) return states;
  const current = states[workspacePath] ?? EMPTY_WORKSPACE_STATE;
  const touched = new Set(touchedRelPaths);
  const freshByRelPath = new Map<string, VaultEntry>();
  for (const entry of freshEntries) {
    if (touched.has(entry.relPath)) freshByRelPath.set(entry.relPath, entry);
  }
  const next: VaultEntry[] = [];
  for (const entry of current.entries) {
    if (!touched.has(entry.relPath)) {
      next.push(entry);
      continue;
    }
    const fresh = freshByRelPath.get(entry.relPath);
    if (fresh) {
      next.push(fresh);
      freshByRelPath.delete(entry.relPath);
    }
    // Touched but absent from freshEntries: deleted (or newly excluded).
  }
  // Creations: fresh entries whose relPath was not previously indexed.
  for (const entry of freshByRelPath.values()) {
    next.push(entry);
  }
  next.sort(compareVaultEntries);
  const unchanged =
    next.length === current.entries.length &&
    next.every((entry, index) => entry === current.entries[index]);
  if (unchanged) return states;
  return {
    ...states,
    [workspacePath]: { ...current, entries: next },
  };
}

// ---------------------------------------------------------------------------
// Store: one module-level state object, replaced atomically by publish().
// ---------------------------------------------------------------------------

let workspaceStoreState: WorkspaceStoreState = INITIAL_WORKSPACE_STORE_STATE;
const subscribers = new Set<() => void>();

function publish(next: WorkspaceStoreState): void {
  if (next === workspaceStoreState) return;
  workspaceStoreState = next;
  for (const subscriber of subscribers) subscriber();
}

/** Non-React read for orchestrators that need the current workspace state at
 *  call time (favorites, JSX visibility flips, the graph initial-load effect)
 *  instead of capturing render-scope values. */
export function getWorkspaceStoreState(): WorkspaceStoreState {
  return workspaceStoreState;
}

export function setWorkspaceRegistry(registry: WorkspaceRegistry): void {
  publish(setWorkspaceRegistryInState(workspaceStoreState, registry));
}

export function setExplorerVisibility(visibility: WorkspaceVisibility): void {
  publish(setExplorerVisibilityInState(workspaceStoreState, visibility));
}

/** registry + explorer visibility in one transition. */
export function activateWorkspace(
  registry: WorkspaceRegistry,
  visibility: WorkspaceVisibility,
): void {
  publish(activateWorkspaceInState(workspaceStoreState, registry, visibility));
}

export function updateWorkspaceState(
  path: string,
  patch: Partial<WorkspaceEntriesState>,
): void {
  publish(updateWorkspaceStateInState(workspaceStoreState, path, patch));
}

export function updateWorkspaceFileState(
  path: string,
  patch: Partial<WorkspaceFilesState>,
): void {
  publish(updateWorkspaceFileStateInState(workspaceStoreState, path, patch));
}

export function removeWorkspaceState(path: string): void {
  publish(removeWorkspaceStateInState(workspaceStoreState, path));
}

export function setQueryByVisibility(visibility: WorkspaceVisibility, query: string): void {
  publish(setQueryInState(workspaceStoreState, visibility, query));
}

export function setFileQueryByVisibility(visibility: WorkspaceVisibility, query: string): void {
  publish(setFileQueryInState(workspaceStoreState, visibility, query));
}

export function setDocumentFilterByVisibility(
  visibility: WorkspaceVisibility,
  filter: DocumentFilter,
): void {
  publish(setDocumentFilterInState(workspaceStoreState, visibility, filter));
}

export function pruneCustomDocumentFilters(validViewIds: ReadonlySet<string>): void {
  publish(pruneCustomDocumentFiltersInState(workspaceStoreState, validViewIds));
}

export function setCollapsedTreeFoldersByVisibility(
  visibility: WorkspaceVisibility,
  paths: string[],
): void {
  publish(setCollapsedTreeFoldersInState(workspaceStoreState, visibility, paths));
}

export function setCollapsedFileFoldersByVisibility(
  visibility: WorkspaceVisibility,
  paths: string[],
): void {
  publish(setCollapsedFileFoldersInState(workspaceStoreState, visibility, paths));
}

export function setSelectedFilePathsByWorkspace(
  workspacePath: string,
  paths: string[],
): void {
  publish(setSelectedFilePathsInState(workspaceStoreState, workspacePath, paths));
}

// ---------------------------------------------------------------------------
// Async scan actions. One monotonic scan sequence per workspace path, shared
// by full rescans and watcher delta applications: whichever starts latest
// wins, so a late response from the losing side can never clobber the newer
// state (the step-5 guard, ported from workspaceFileRequestSeqRef).
// ---------------------------------------------------------------------------

const scanSeqByPath: Record<string, number> = {};

function nextWorkspaceScanSeq(path: string): number {
  const seq = (scanSeqByPath[path] ?? 0) + 1;
  scanSeqByPath[path] = seq;
  return seq;
}

function isCurrentWorkspaceScan(path: string, seq: number): boolean {
  return scanSeqByPath[path] === seq;
}

/** Full document-index rescan for a workspace. Publishes the fresh entries
 *  (settling the loading flags the caller set) and returns them; returns null
 *  without publishing when a newer rescan or delta superseded this request —
 *  callers then skip their find-in-fresh tab swaps. */
export async function rescanWorkspaceEntries(
  path: string,
  scanOptions?: ScanOptions,
): Promise<VaultEntry[] | null> {
  const seq = nextWorkspaceScanSeq(path);
  const fresh = await scanVault(path, scanOptions);
  if (!isCurrentWorkspaceScan(path, seq)) return null;
  updateWorkspaceState(path, { entries: fresh, loading: false, refreshing: false });
  return fresh;
}

/** Publishes an incremental watcher delta (see applyVaultDeltaInState). */
export function applyVaultDelta(
  path: string,
  freshEntries: VaultEntry[],
  touchedRelPaths: readonly string[],
): void {
  const states = applyVaultDeltaInState(
    workspaceStoreState.states,
    path,
    freshEntries,
    touchedRelPaths,
  );
  if (states === workspaceStoreState.states) return;
  publish({ ...workspaceStoreState, states });
}

/** The watcher delta path: scan just the touched rel paths, then apply the
 *  delta behind the shared per-path seq guard. Before the first full scan
 *  lands (startupIoReady), a delta would diff against the empty baseline and
 *  publish just the touched files as the whole workspace — and its seq bump
 *  would discard that in-flight full scan — so it upgrades to a full rescan
 *  instead. */
export async function scanAndApplyVaultDelta(
  path: string,
  touchedRelPaths: readonly string[],
  scanOptions?: ScanOptions,
): Promise<void> {
  if (touchedRelPaths.length === 0) return;
  if (!workspaceStoreState.states[path]?.startupIoReady) {
    await rescanWorkspaceEntries(path, scanOptions);
    return;
  }
  const seq = nextWorkspaceScanSeq(path);
  const freshEntries = await scanVaultPaths(path, touchedRelPaths, scanOptions);
  if (!isCurrentWorkspaceScan(path, seq)) return;
  applyVaultDelta(path, freshEntries, touchedRelPaths);
}

/** Owns the vault watcher lifecycle and the `vault://index-delta`
 *  subscription for the watched workspace (previously the MainApp effect).
 *  Deltas apply incrementally via scan_vault_paths on just the touched rel
 *  paths; a touched `.maruignore`/`.anchorignore` changes the filter set
 *  itself, so that one falls back to a full rescan. version_count can lag on
 *  watcher-only flows: version files live under `.maru/versions`, which the
 *  watcher deliberately ignores — snapshotTab still full-rescans after
 *  creating one, which refreshes the count. */
export function useVaultWatcherSync(
  vaultWatchPath: string | null,
  enabled: boolean,
  scanOptions?: ScanOptions,
): void {
  useEffect(() => {
    if (!enabled || !vaultWatchPath) return;
    const path = vaultWatchPath;
    let disposed = false;
    let unlisten: (() => void) | null = null;
    let deltaTimer: ReturnType<typeof setTimeout> | null = null;
    // Touched rel paths accumulate across the trailing debounce window: each
    // event carries only its own batch, and applying just the latest batch
    // would silently drop the earlier ones (the old full rescan masked this).
    const pendingPaths = new Set<string>();
    void startVaultWatcher(path).catch(() => undefined);
    void import("@tauri-apps/api/event")
      .then(({ listen }) =>
        listen<{ workspacePath: string; paths: string[] }>("vault://index-delta", (event) => {
          if (event.payload.workspacePath !== path) return;
          for (const relPath of event.payload.paths) pendingPaths.add(relPath);
          if (deltaTimer) clearTimeout(deltaTimer);
          deltaTimer = setTimeout(() => {
            const touched = [...pendingPaths];
            pendingPaths.clear();
            if (
              touched.some(
                (relPath) => relPath === ".maruignore" || relPath === ".anchorignore",
              )
            ) {
              void rescanWorkspaceEntries(path, scanOptions).catch(() => undefined);
            } else {
              void scanAndApplyVaultDelta(path, touched, scanOptions).catch(() => undefined);
            }
          }, 150);
        }),
      )
      .then((off) => {
        if (disposed) off();
        else unlisten = off;
      })
      .catch(() => undefined);
    return () => {
      disposed = true;
      if (deltaTimer) clearTimeout(deltaTimer);
      unlisten?.();
      void stopVaultWatcher().catch(() => undefined);
    };
  }, [enabled, vaultWatchPath, scanOptions]);
}

// ---------------------------------------------------------------------------
// Hooks: one subscriber set, per-slice getSnapshot accessors returning the
// stable slice references so only affected slices re-render.
// ---------------------------------------------------------------------------

function subscribe(subscriber: () => void): () => void {
  subscribers.add(subscriber);
  return () => {
    subscribers.delete(subscriber);
  };
}

export function useWorkspaceRegistry(): WorkspaceRegistry {
  return useSyncExternalStore(
    subscribe,
    () => workspaceStoreState.registry,
    () => workspaceStoreState.registry,
  );
}

export function useWorkspaceStates(): Record<string, WorkspaceEntriesState> {
  return useSyncExternalStore(
    subscribe,
    () => workspaceStoreState.states,
    () => workspaceStoreState.states,
  );
}

export function useWorkspaceFileStates(): Record<string, WorkspaceFilesState> {
  return useSyncExternalStore(
    subscribe,
    () => workspaceStoreState.fileStates,
    () => workspaceStoreState.fileStates,
  );
}

/** Dynamic-path entries snapshot; the EMPTY fallback is the shared const so
 *  identity stays stable for paths with no state yet. */
export function useWorkspaceEntries(path: string | null): VaultEntry[] {
  return useSyncExternalStore(
    subscribe,
    () =>
      (path ? workspaceStoreState.states[path]?.entries : null) ??
      EMPTY_WORKSPACE_STATE.entries,
    () =>
      (path ? workspaceStoreState.states[path]?.entries : null) ??
      EMPTY_WORKSPACE_STATE.entries,
  );
}

export function useExplorerVisibility(): WorkspaceVisibility {
  return useSyncExternalStore(
    subscribe,
    () => workspaceStoreState.explorerVisibility,
    () => workspaceStoreState.explorerVisibility,
  );
}

export function useQueryByVisibility(): Record<WorkspaceVisibility, string> {
  return useSyncExternalStore(
    subscribe,
    () => workspaceStoreState.queryByVisibility,
    () => workspaceStoreState.queryByVisibility,
  );
}

export function useFileQueryByVisibility(): Record<WorkspaceVisibility, string> {
  return useSyncExternalStore(
    subscribe,
    () => workspaceStoreState.fileQueryByVisibility,
    () => workspaceStoreState.fileQueryByVisibility,
  );
}

export function useDocumentFilterByVisibility(): Record<WorkspaceVisibility, DocumentFilter> {
  return useSyncExternalStore(
    subscribe,
    () => workspaceStoreState.documentFilterByVisibility,
    () => workspaceStoreState.documentFilterByVisibility,
  );
}

export function useCollapsedTreeFoldersByVisibility(): Record<WorkspaceVisibility, string[]> {
  return useSyncExternalStore(
    subscribe,
    () => workspaceStoreState.collapsedTreeFoldersByVisibility,
    () => workspaceStoreState.collapsedTreeFoldersByVisibility,
  );
}

export function useCollapsedFileFoldersByVisibility(): Record<WorkspaceVisibility, string[]> {
  return useSyncExternalStore(
    subscribe,
    () => workspaceStoreState.collapsedFileFoldersByVisibility,
    () => workspaceStoreState.collapsedFileFoldersByVisibility,
  );
}

export function useSelectedFilePathsByWorkspace(): Record<string, string[]> {
  return useSyncExternalStore(
    subscribe,
    () => workspaceStoreState.selectedFilePathsByWorkspace,
    () => workspaceStoreState.selectedFilePathsByWorkspace,
  );
}
