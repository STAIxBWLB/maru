import { useSyncExternalStore } from "react";

import { buildDocumentIndex, type DocumentIndex, type DocumentFilter } from "./documentIndex";
import type {
  DocumentBrowserMode,
  DocumentLabelMode,
  DocumentViewDefinition,
  FavoriteItem,
  SortKey,
} from "./settings";
import type { FileStoreOperation, VaultEntry, WorkspaceVisibility } from "./types";
import type { ExplorerDragPayload } from "./fileDrag";
import type { FavoriteTarget } from "../components/FavoritesSection";

export interface DocumentBrowserScope {
  workspacePath: string;
  visibility: WorkspaceVisibility;
}

export interface DocumentRevealIntent {
  targetPath: string;
  nonce: number;
}

export interface DocumentBrowserQueryFilterSlice {
  documentIndex: DocumentIndex;
  query: string;
  loading: boolean;
  documentFilter: DocumentFilter;
  documentViews: DocumentViewDefinition[];
  browserMode: DocumentBrowserMode;
  sortKey: SortKey;
  documentLabelMode: DocumentLabelMode;
  collapsedTreeFolders: string[];
}

export interface DocumentBrowserWorkspaceSlice {
  workspaceVisibility: WorkspaceVisibility;
  publicWorkspaceAvailable: boolean;
  activeWorkspaceLabel: string | null;
  vaultPath: string | null;
  refreshing: boolean;
}

export interface DocumentBrowserSelectionSlice {
  selectedPath: string | null;
}

export interface DocumentBrowserCapabilitiesSlice {
  publicWorkspaceAvailable: boolean;
}

export interface DocumentBrowserFavoritesSlice {
  favorites: FavoriteItem[];
}

export interface DocumentBrowserFileQueueSlice {
  selectedFileQueueCount: number;
}

export interface DocumentBrowserRevealSlice {
  intent: DocumentRevealIntent | null;
}

export interface DocumentBrowserState {
  queryFilter: DocumentBrowserQueryFilterSlice;
  workspace: DocumentBrowserWorkspaceSlice;
  selection: DocumentBrowserSelectionSlice;
  capabilities: DocumentBrowserCapabilitiesSlice;
  favorites: DocumentBrowserFavoritesSlice;
  fileQueue: DocumentBrowserFileQueueSlice;
  reveal: DocumentBrowserRevealSlice;
}

export type DocumentBrowserSliceName = keyof DocumentBrowserState;

export interface DocumentListCommands {
  setWorkspaceVisibility(visibility: WorkspaceVisibility): void;
  addPublicWorkspace(): void;
  setQuery(query: string): void;
  setBrowserMode(mode: DocumentBrowserMode): void;
  setSortKey(key: SortKey): void;
  setCollapsedTreeFolders(paths: string[]): void;
  selectEntry(entry: VaultEntry): void | Promise<unknown>;
  revealInFinder(targetPath: string): void;
  revealInFiles(targetPath: string): void;
  ignore?(relPath: string, kind: "file" | "directory"): void;
  refresh(): void;
  close?(): void;
  openFavorite(favorite: FavoriteItem): void;
  removeFavorite(favorite: FavoriteItem): void;
  toggleFavorite(target: FavoriteTarget): void;
  isFavorite(kind: FavoriteItem["kind"], relPath: string): boolean;
  isFavoriteMissing(favorite: FavoriteItem): boolean;
  applyFileQueueToDestination?(
    targetPath: string,
    targetKind: "file" | "directory",
    operation: FileStoreOperation,
    itemIds?: string[],
  ): void;
  applyExplorerDragToDestination?(
    payload: ExplorerDragPayload,
    targetPath: string,
    targetKind: "file" | "directory",
    operation: FileStoreOperation,
  ): void;
}

const EMPTY_DOCUMENT_INDEX: DocumentIndex = buildDocumentIndex([]);
const EMPTY_QUERY_FILTER: DocumentBrowserQueryFilterSlice = {
  documentIndex: EMPTY_DOCUMENT_INDEX,
  query: "",
  loading: false,
  documentFilter: { kind: "all" },
  documentViews: [],
  browserMode: "list",
  sortKey: "modifiedDesc",
  documentLabelMode: "title",
  collapsedTreeFolders: [],
};
const EMPTY_WORKSPACE: DocumentBrowserWorkspaceSlice = {
  workspaceVisibility: "private",
  publicWorkspaceAvailable: false,
  activeWorkspaceLabel: null,
  vaultPath: null,
  refreshing: false,
};
const EMPTY_STATE: DocumentBrowserState = {
  queryFilter: EMPTY_QUERY_FILTER,
  workspace: EMPTY_WORKSPACE,
  selection: { selectedPath: null },
  capabilities: { publicWorkspaceAvailable: false },
  favorites: { favorites: [] },
  fileQueue: { selectedFileQueueCount: 0 },
  reveal: { intent: null },
};

type Subscriber = () => void;
type Subscribers = Map<string, Set<Subscriber>>;
let states: Record<string, DocumentBrowserState> = {};
let nextRevealNonce = 0;
const subscribers: { [K in DocumentBrowserSliceName]: Subscribers } = {
  queryFilter: new Map(),
  workspace: new Map(),
  selection: new Map(),
  capabilities: new Map(),
  favorites: new Map(),
  fileQueue: new Map(),
  reveal: new Map(),
};

function key(scope: DocumentBrowserScope): string {
  return `${scope.visibility}:${scope.workspacePath}`;
}

function stateFor(scope: DocumentBrowserScope): DocumentBrowserState {
  return states[key(scope)] ?? EMPTY_STATE;
}

function notify(slice: DocumentBrowserSliceName, scope: DocumentBrowserScope): void {
  for (const subscriber of subscribers[slice].get(key(scope)) ?? []) subscriber();
}

function publish(scope: DocumentBrowserScope, next: DocumentBrowserState): DocumentBrowserState {
  const current = stateFor(scope);
  if (next === current) return current;
  states = { ...states, [key(scope)]: next };
  (Object.keys(subscribers) as DocumentBrowserSliceName[]).forEach((slice) => {
    if (next[slice] !== current[slice]) notify(slice, scope);
  });
  return next;
}

function patch<T extends object>(current: T, next: Partial<T>): T {
  const candidate = { ...current } as T;
  for (const [property, value] of Object.entries(next)) {
    if (value !== undefined) {
      (candidate as Record<string, unknown>)[property] = value;
    }
  }
  return Object.keys(candidate).every(
    (property) => candidate[property as keyof T] === current[property as keyof T],
  )
    ? current
    : candidate;
}

export interface DocumentBrowserPublishPatch {
  documentIndex?: DocumentIndex;
  query?: string;
  loading?: boolean;
  documentFilter?: DocumentFilter;
  documentViews?: DocumentViewDefinition[];
  browserMode?: DocumentBrowserMode;
  sortKey?: SortKey;
  documentLabelMode?: DocumentLabelMode;
  collapsedTreeFolders?: string[];
  workspaceVisibility?: WorkspaceVisibility;
  publicWorkspaceAvailable?: boolean;
  activeWorkspaceLabel?: string | null;
  vaultPath?: string | null;
  refreshing?: boolean;
  selectedPath?: string | null;
  favorites?: FavoriteItem[];
  selectedFileQueueCount?: number;
}

/** Publishes post-render shell data to immutable, independently subscribed slices. */
export function publishDocumentBrowser(
  scope: DocumentBrowserScope,
  update: DocumentBrowserPublishPatch,
): DocumentBrowserState {
  const current = stateFor(scope);
  const queryFilter = patch(current.queryFilter, {
    documentIndex: update.documentIndex,
    query: update.query,
    loading: update.loading,
    documentFilter: update.documentFilter,
    documentViews: update.documentViews,
    browserMode: update.browserMode,
    sortKey: update.sortKey,
    documentLabelMode: update.documentLabelMode,
    collapsedTreeFolders: update.collapsedTreeFolders,
  });
  const workspace = patch(current.workspace, {
    workspaceVisibility: update.workspaceVisibility,
    publicWorkspaceAvailable: update.publicWorkspaceAvailable,
    activeWorkspaceLabel: update.activeWorkspaceLabel,
    vaultPath: update.vaultPath,
    refreshing: update.refreshing,
  });
  const capabilities = patch(current.capabilities, {
    publicWorkspaceAvailable: update.publicWorkspaceAvailable,
  });
  const selection = patch(current.selection, { selectedPath: update.selectedPath });
  const favorites = patch(current.favorites, { favorites: update.favorites });
  const fileQueue = patch(current.fileQueue, { selectedFileQueueCount: update.selectedFileQueueCount });
  return publish(scope, {
    queryFilter,
    workspace,
    selection,
    capabilities,
    favorites,
    fileQueue,
    reveal: current.reveal,
  });
}

export function requestDocumentReveal(
  scope: DocumentBrowserScope,
  targetPath: string,
): DocumentRevealIntent {
  const intent = { targetPath, nonce: ++nextRevealNonce };
  const current = stateFor(scope);
  publish(scope, { ...current, reveal: { intent } });
  return intent;
}

export function acknowledgeDocumentReveal(scope: DocumentBrowserScope, nonce: number): boolean {
  const current = stateFor(scope);
  if (current.reveal.intent?.nonce !== nonce) return false;
  publish(scope, { ...current, reveal: { intent: null } });
  return true;
}

export function getDocumentBrowserSlice<K extends DocumentBrowserSliceName>(
  scope: DocumentBrowserScope,
  slice: K,
): DocumentBrowserState[K] {
  return stateFor(scope)[slice];
}

export function getDocumentBrowserState(scope: DocumentBrowserScope): DocumentBrowserState {
  return stateFor(scope);
}

function subscribe<K extends DocumentBrowserSliceName>(
  scope: DocumentBrowserScope,
  slice: K,
  subscriber: Subscriber,
): () => void {
  const scoped = subscribers[slice].get(key(scope)) ?? new Set<Subscriber>();
  scoped.add(subscriber);
  subscribers[slice].set(key(scope), scoped);
  return () => {
    scoped.delete(subscriber);
    if (scoped.size === 0) subscribers[slice].delete(key(scope));
  };
}

export function useDocumentBrowserSlice<K extends DocumentBrowserSliceName>(
  scope: DocumentBrowserScope,
  slice: K,
): DocumentBrowserState[K] {
  return useSyncExternalStore(
    (subscriber) => subscribe(scope, slice, subscriber),
    () => getDocumentBrowserSlice(scope, slice),
    () => getDocumentBrowserSlice(scope, slice),
  );
}

export function cleanupDocumentBrowserWorkspace(workspacePath: string): void {
  const keys = Object.keys(states).filter((entry) => entry.endsWith(`:${workspacePath}`));
  if (keys.length === 0) return;
  const next = { ...states };
  for (const entry of keys) delete next[entry];
  states = next;
  for (const entry of keys) {
    for (const subscribersByScope of Object.values(subscribers)) {
      for (const subscriber of subscribersByScope.get(entry) ?? []) subscriber();
      subscribersByScope.delete(entry);
    }
  }
}

export function resetDocumentBrowserStoreForTests(): void {
  states = {};
  nextRevealNonce = 0;
  for (const subscribersByScope of Object.values(subscribers)) {
    for (const scoped of subscribersByScope.values()) {
      for (const subscriber of scoped) subscriber();
    }
    subscribersByScope.clear();
  }
}
