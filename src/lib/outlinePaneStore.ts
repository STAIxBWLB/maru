import { useSyncExternalStore } from "react";

import { useActiveTabIds, useDocTabs } from "./editorTabsStore";
import { getDocumentBrowserSlice, useDocumentBrowserSlice, type DocumentBrowserScope } from "./documentBrowserStore";
import type { BuiltInDocumentView, DocumentFilter } from "./documentIndex";
import type {
  DocumentViewDefinition,
  ExplorerPaneMode,
  MaruAppMode,
  RightPaneTab,
} from "./settings";
import type { DocumentPayload, FileQueueItem, VaultEntry, WorkspaceFileEntry } from "./types";
import {
  EMPTY_WORKSPACE_FILES_PANE_FILTERS,
  type WorkspaceFilesPaneFilters,
} from "./workspaceFileTree";

/** The Outline facade is deliberately keyed by workspace. `tabId` is an
 * optional render selector, not owned state: tabs and drafts remain in
 * editorTabsStore. */
export interface OutlinePaneScope {
  workspacePath: string;
  tabId?: string | null;
  browserScope?: DocumentBrowserScope;
}

export interface OutlineDocumentSlice {
  document: DocumentPayload | null;
  draftContent: string;
}

export interface OutlineFileQueueSlice {
  fileQueue: FileQueueItem[];
  selectedFileQueueItemIds: string[];
  canApplyFileQueue: boolean;
}

export interface OutlineOperationSlice {
  applyingFileQueue: boolean;
  fileQueueError: string | null;
}

/** Render-only values from the document/sidebar domain. Commands remain in
 * editorSurfaceAdapter so this facade never owns shell side effects. */
export interface OutlineSidebarSlice {
  entries: VaultEntry[];
  readOnly: boolean;
  isManagedVaultNote: boolean;
  activeTab: RightPaneTab;
  activeLine: number | null;
  appMode: MaruAppMode;
  contentCount: number;
  typeCounts: Array<[string, number]>;
  documentViews: DocumentViewDefinition[];
  viewCounts: Record<BuiltInDocumentView, number>;
  customViewCounts: Record<string, number>;
  recentEntries: VaultEntry[];
  canCreateDocument: boolean;
}

/** Browser data remains owned by documentBrowserStore; Outline composes this
 * view instead of publishing a second synchronized sidebar record. */
export interface OutlineBrowserSlice {
  selectedPath: string | null;
  query: string;
  documentFilter: DocumentFilter;
}

export interface OutlineExplorerSlice {
  workspaceFileEntries: WorkspaceFileEntry[];
  explorerWorkspacePath: string | null;
  explorerExpandedFolders: string[];
  explorerSelectedPath: string | null;
  explorerLoading: boolean;
  explorerReady: boolean;
  explorerRefreshing: boolean;
  explorerIncludeDotFolders: string[];
  selectedWorkspaceFileEntries: WorkspaceFileEntry[];
  filesPaneFilters: WorkspaceFilesPaneFilters;
  explorerPaneMode: ExplorerPaneMode;
}

export interface OutlinePaneState {
  document: OutlineDocumentSlice;
  fileQueue: OutlineFileQueueSlice;
  operation: OutlineOperationSlice;
  sidebar: OutlineSidebarSlice;
  explorer: OutlineExplorerSlice;
}

const EMPTY_DOCUMENT_SLICE: OutlineDocumentSlice = { document: null, draftContent: "" };
const EMPTY_FILE_QUEUE_SLICE: OutlineFileQueueSlice = {
  fileQueue: [],
  selectedFileQueueItemIds: [],
  canApplyFileQueue: false,
};
const EMPTY_OPERATION_SLICE: OutlineOperationSlice = { applyingFileQueue: false, fileQueueError: null };
const EMPTY_SIDEBAR_SLICE: OutlineSidebarSlice = {
  entries: [],
  readOnly: false,
  isManagedVaultNote: false,
  activeTab: "workspace",
  activeLine: null,
  appMode: "pkm",
  contentCount: 0,
  typeCounts: [],
  documentViews: [],
  viewCounts: { inbox: 0, drafts: 0, archive: 0, recentlyUpdated: 0 },
  customViewCounts: {},
  recentEntries: [],
  canCreateDocument: false,
};
const EMPTY_EXPLORER_SLICE: OutlineExplorerSlice = {
  workspaceFileEntries: [],
  explorerWorkspacePath: null,
  explorerExpandedFolders: [],
  explorerSelectedPath: null,
  explorerLoading: false,
  explorerReady: false,
  explorerRefreshing: false,
  explorerIncludeDotFolders: [],
  selectedWorkspaceFileEntries: [],
  filesPaneFilters: EMPTY_WORKSPACE_FILES_PANE_FILTERS,
  explorerPaneMode: "documents",
};
const EMPTY_OUTLINE_PANE_STATE: OutlinePaneState = {
  document: EMPTY_DOCUMENT_SLICE,
  fileQueue: EMPTY_FILE_QUEUE_SLICE,
  operation: EMPTY_OPERATION_SLICE,
  sidebar: EMPTY_SIDEBAR_SLICE,
  explorer: EMPTY_EXPLORER_SLICE,
};

let statesByWorkspace: Record<string, OutlinePaneState> = {};
type SliceSubscriber = () => void;
type SliceSubscribers = Map<string, Set<SliceSubscriber>>;
const documentSubscribers: SliceSubscribers = new Map();
const fileQueueSubscribers: SliceSubscribers = new Map();
const operationSubscribers: SliceSubscribers = new Map();
const sidebarSubscribers: SliceSubscribers = new Map();
const explorerSubscribers: SliceSubscribers = new Map();
const documentSliceCache = new Map<string, { tab: object | null; slice: OutlineDocumentSlice }>();
const browserSliceCache = new Map<
  string,
  { selection: object; queryFilter: object; slice: OutlineBrowserSlice }
>();

function browserScopeFor(scope: OutlinePaneScope): DocumentBrowserScope {
  return scope.browserScope ?? { workspacePath: scope.workspacePath, visibility: "private" };
}

function browserSliceFor(scope: OutlinePaneScope): OutlineBrowserSlice {
  const browserScope = browserScopeFor(scope);
  const selection = getDocumentBrowserSlice(browserScope, "selection");
  const queryFilter = getDocumentBrowserSlice(browserScope, "queryFilter");
  const cacheKey = `${browserScope.visibility}:${browserScope.workspacePath}`;
  const cached = browserSliceCache.get(cacheKey);
  if (cached?.selection === selection && cached.queryFilter === queryFilter) return cached.slice;
  const slice = {
    selectedPath: selection.selectedPath,
    query: queryFilter.query,
    documentFilter: queryFilter.documentFilter,
  };
  browserSliceCache.set(cacheKey, { selection, queryFilter, slice });
  return slice;
}

function stateFor(scope: OutlinePaneScope): OutlinePaneState {
  return statesByWorkspace[scope.workspacePath] ?? EMPTY_OUTLINE_PANE_STATE;
}

function notify(subscribers: SliceSubscribers, workspacePath: string): void {
  for (const subscriber of subscribers.get(workspacePath) ?? []) subscriber();
}

function publishWorkspace(scope: OutlinePaneScope, next: OutlinePaneState): void {
  const current = stateFor(scope);
  if (next === current) return;
  statesByWorkspace = { ...statesByWorkspace, [scope.workspacePath]: next };
  if (next.document !== current.document) notify(documentSubscribers, scope.workspacePath);
  if (next.fileQueue !== current.fileQueue) notify(fileQueueSubscribers, scope.workspacePath);
  if (next.operation !== current.operation) notify(operationSubscribers, scope.workspacePath);
  if (next.sidebar !== current.sidebar) notify(sidebarSubscribers, scope.workspacePath);
  if (next.explorer !== current.explorer) notify(explorerSubscribers, scope.workspacePath);
}

function subscribeToSlice(
  subscribers: SliceSubscribers,
  scope: OutlinePaneScope,
  subscriber: SliceSubscriber,
): () => void {
  const scoped = subscribers.get(scope.workspacePath) ?? new Set<SliceSubscriber>();
  scoped.add(subscriber);
  subscribers.set(scope.workspacePath, scoped);
  return () => {
    scoped.delete(subscriber);
    if (scoped.size === 0) subscribers.delete(scope.workspacePath);
  };
}

export function subscribeOutlineDocumentSlice(scope: OutlinePaneScope, subscriber: SliceSubscriber): () => void {
  return subscribeToSlice(documentSubscribers, scope, subscriber);
}

export function subscribeOutlineFileQueueSlice(scope: OutlinePaneScope, subscriber: SliceSubscriber): () => void {
  return subscribeToSlice(fileQueueSubscribers, scope, subscriber);
}

function subscribeOutlineOperationSlice(scope: OutlinePaneScope, subscriber: SliceSubscriber): () => void {
  return subscribeToSlice(operationSubscribers, scope, subscriber);
}

export function subscribeOutlineSidebarSlice(scope: OutlinePaneScope, subscriber: SliceSubscriber): () => void {
  return subscribeToSlice(sidebarSubscribers, scope, subscriber);
}

export function subscribeOutlineExplorerSlice(scope: OutlinePaneScope, subscriber: SliceSubscriber): () => void {
  return subscribeToSlice(explorerSubscribers, scope, subscriber);
}

function sameFileQueueItems(left: FileQueueItem[], right: FileQueueItem[]): boolean {
  return left === right || (left.length === right.length && left.every((item, index) => item === right[index]));
}

function sameItemIds(left: string[], right: string[]): boolean {
  return left === right || (left.length === right.length && left.every((id, index) => id === right[index]));
}

export function replaceOutlineFileQueueInState(state: OutlinePaneState, fileQueue: FileQueueItem[]): OutlinePaneState {
  if (sameFileQueueItems(state.fileQueue.fileQueue, fileQueue)) return state;
  return { ...state, fileQueue: { ...state.fileQueue, fileQueue } };
}

export function setOutlineFileQueueCanApplyInState(
  state: OutlinePaneState,
  canApplyFileQueue: boolean,
): OutlinePaneState {
  return state.fileQueue.canApplyFileQueue === canApplyFileQueue
    ? state
    : { ...state, fileQueue: { ...state.fileQueue, canApplyFileQueue } };
}

export function selectOutlineFileQueueItemInState(
  state: OutlinePaneState,
  id: string,
  additive: boolean,
): OutlinePaneState {
  const selected = state.fileQueue.selectedFileQueueItemIds;
  const nextSelected = !additive
    ? [id]
    : selected.includes(id) ? selected.filter((item) => item !== id) : [...selected, id];
  if (sameItemIds(selected, nextSelected)) return state;
  return { ...state, fileQueue: { ...state.fileQueue, selectedFileQueueItemIds: nextSelected } };
}

export function setOutlineFileQueueSelectionInState(
  state: OutlinePaneState,
  selectedFileQueueItemIds: string[],
): OutlinePaneState {
  if (sameItemIds(state.fileQueue.selectedFileQueueItemIds, selectedFileQueueItemIds)) return state;
  return { ...state, fileQueue: { ...state.fileQueue, selectedFileQueueItemIds } };
}

export function updateOutlineFileQueueItemInState(
  state: OutlinePaneState,
  id: string,
  patch: Partial<Pick<FileQueueItem, "targetDir" | "operation">>,
): OutlinePaneState {
  const index = state.fileQueue.fileQueue.findIndex((item) => item.id === id);
  if (index < 0) return state;
  const item = state.fileQueue.fileQueue[index];
  const nextItem: FileQueueItem = { ...item, ...patch, status: "queued", message: null, targetPath: null };
  if (
    nextItem.targetDir === item.targetDir &&
    nextItem.operation === item.operation &&
    nextItem.status === item.status &&
    nextItem.message === item.message &&
    nextItem.targetPath === item.targetPath
  ) return state;
  const fileQueue = [...state.fileQueue.fileQueue];
  fileQueue[index] = nextItem;
  return { ...state, fileQueue: { ...state.fileQueue, fileQueue } };
}

export function setOutlineOperationInState(
  state: OutlinePaneState,
  patch: Partial<OutlineOperationSlice>,
): OutlinePaneState {
  const operation = { ...state.operation, ...patch };
  return operation.applyingFileQueue === state.operation.applyingFileQueue &&
    operation.fileQueueError === state.operation.fileQueueError
    ? state
    : { ...state, operation };
}

function updateOutlinePaneState(
  scope: OutlinePaneScope,
  updater: (state: OutlinePaneState) => OutlinePaneState,
): OutlinePaneState {
  const next = updater(stateFor(scope));
  publishWorkspace(scope, next);
  return next;
}

export function replaceOutlineFileQueue(scope: OutlinePaneScope, fileQueue: FileQueueItem[]): OutlinePaneState {
  return updateOutlinePaneState(scope, (state) => replaceOutlineFileQueueInState(state, fileQueue));
}

export function setOutlineFileQueueCanApply(scope: OutlinePaneScope, canApplyFileQueue: boolean): OutlinePaneState {
  return updateOutlinePaneState(scope, (state) => setOutlineFileQueueCanApplyInState(state, canApplyFileQueue));
}

export function selectOutlineFileQueueItem(scope: OutlinePaneScope, id: string, additive: boolean): OutlinePaneState {
  return updateOutlinePaneState(scope, (state) => selectOutlineFileQueueItemInState(state, id, additive));
}

export function setOutlineFileQueueSelection(
  scope: OutlinePaneScope,
  selectedFileQueueItemIds: string[],
): OutlinePaneState {
  return updateOutlinePaneState(scope, (state) => setOutlineFileQueueSelectionInState(state, selectedFileQueueItemIds));
}

export function updateOutlineFileQueueItem(
  scope: OutlinePaneScope,
  id: string,
  patch: Partial<Pick<FileQueueItem, "targetDir" | "operation">>,
): OutlinePaneState {
  return updateOutlinePaneState(scope, (state) => updateOutlineFileQueueItemInState(state, id, patch));
}

export function setOutlineOperation(scope: OutlinePaneScope, patch: Partial<OutlineOperationSlice>): OutlinePaneState {
  return updateOutlinePaneState(scope, (state) => setOutlineOperationInState(state, patch));
}

/** The persisted right-pane choice is a narrow sidebar field. Keeping the
 * merge here preserves every other render-domain value and its identity. */
export function setOutlineRightPaneTab(scope: OutlinePaneScope, activeTab: RightPaneTab): OutlinePaneState {
  return updateOutlinePaneState(scope, (state) =>
    state.sidebar.activeTab === activeTab
      ? state
      : { ...state, sidebar: { ...state.sidebar, activeTab } },
  );
}

/** A non-React current snapshot for command ports and narrow shell adapters. */
export function getOutlinePaneState(scope: OutlinePaneScope): OutlinePaneState {
  return stateFor(scope);
}

export function getOutlineBrowserSlice(scope: OutlinePaneScope): OutlineBrowserSlice {
  return browserSliceFor(scope);
}

/**
 * Test/hydration support for the facade-local render domains. Production
 * document reads are composed from editorTabsStore by useOutlineDocumentSlice,
 * so this never becomes a second owner of document bodies or drafts.
 */
export function hydrateOutlinePaneState(
  scope: OutlinePaneScope,
  patch: Partial<OutlinePaneState>,
): OutlinePaneState {
  const current = stateFor(scope);
  const nextFileQueue = Array.isArray(patch.fileQueue)
    ? (patch.fileQueue.length === 0 && current.fileQueue.fileQueue.length === 0
      ? current.fileQueue
      : { ...current.fileQueue, fileQueue: patch.fileQueue })
    : patch.fileQueue ?? current.fileQueue;
  const next: OutlinePaneState = {
    document: patch.document ?? current.document,
    fileQueue: nextFileQueue,
    operation: patch.operation ?? current.operation,
    sidebar: patch.sidebar ?? current.sidebar,
    explorer: patch.explorer ?? current.explorer,
  };
  if (
    next.document === current.document &&
    next.fileQueue === current.fileQueue &&
    next.operation === current.operation &&
    next.sidebar === current.sidebar &&
    next.explorer === current.explorer
  ) return current;
  publishWorkspace(scope, next);
  return next;
}

export function cleanupOutlinePaneWorkspace(workspacePath: string): void {
  if (!(workspacePath in statesByWorkspace)) return;
  const next = { ...statesByWorkspace };
  delete next[workspacePath];
  statesByWorkspace = next;
  documentSliceCache.delete(workspacePath);
  for (const cacheKey of browserSliceCache.keys()) {
    if (cacheKey.endsWith(`:${workspacePath}`)) browserSliceCache.delete(cacheKey);
  }
  notify(documentSubscribers, workspacePath);
  notify(fileQueueSubscribers, workspacePath);
  notify(operationSubscribers, workspacePath);
  notify(sidebarSubscribers, workspacePath);
  notify(explorerSubscribers, workspacePath);
}

/** Stable facade slice. Canonical document/draft values come from
 * editorTabsStore; the local subscription supplies a stable fallback for
 * lifecycle tests and future pane-local hydration. */
export function useOutlineDocumentSlice(scope: OutlinePaneScope): OutlineDocumentSlice {
  const fallback = useSyncExternalStore(
    (subscriber) => subscribeOutlineDocumentSlice(scope, subscriber),
    () => stateFor(scope).document,
    () => stateFor(scope).document,
  );
  const tabs = useDocTabs();
  const activeTabIds = useActiveTabIds();
  const tabId = scope.tabId ?? activeTabIds.activeTabId;
  const tab = tabs.find(
    (candidate) => candidate.id === tabId && candidate.workspacePath === scope.workspacePath,
  ) ?? null;
  if (!tab) return fallback;
  const cached = documentSliceCache.get(scope.workspacePath);
  if (cached?.tab === tab) return cached.slice;
  const slice = { document: tab.document, draftContent: tab.draftContent };
  documentSliceCache.set(scope.workspacePath, { tab, slice });
  return slice;
}

export function useOutlineFileQueueSlice(scope: OutlinePaneScope): OutlineFileQueueSlice {
  return useSyncExternalStore(
    (subscriber) => subscribeOutlineFileQueueSlice(scope, subscriber),
    () => stateFor(scope).fileQueue,
    () => stateFor(scope).fileQueue,
  );
}

export function useOutlineOperationSlice(scope: OutlinePaneScope): OutlineOperationSlice {
  return useSyncExternalStore(
    (subscriber) => subscribeOutlineOperationSlice(scope, subscriber),
    () => stateFor(scope).operation,
    () => stateFor(scope).operation,
  );
}

export function useOutlineSidebarSlice(scope: OutlinePaneScope): OutlineSidebarSlice {
  return useSyncExternalStore(
    (subscriber) => subscribeOutlineSidebarSlice(scope, subscriber),
    () => stateFor(scope).sidebar,
    () => stateFor(scope).sidebar,
  );
}

export function useOutlineBrowserSlice(scope: OutlinePaneScope): OutlineBrowserSlice {
  const browserScope = browserScopeFor(scope);
  const selection = useDocumentBrowserSlice(browserScope, "selection");
  const queryFilter = useDocumentBrowserSlice(browserScope, "queryFilter");
  const cacheKey = `${browserScope.visibility}:${browserScope.workspacePath}`;
  const cached = browserSliceCache.get(cacheKey);
  if (cached?.selection === selection && cached.queryFilter === queryFilter) return cached.slice;
  const slice = {
    selectedPath: selection.selectedPath,
    query: queryFilter.query,
    documentFilter: queryFilter.documentFilter,
  };
  browserSliceCache.set(cacheKey, { selection, queryFilter, slice });
  return slice;
}

export function useOutlineExplorerSlice(scope: OutlinePaneScope): OutlineExplorerSlice {
  return useSyncExternalStore(
    (subscriber) => subscribeOutlineExplorerSlice(scope, subscriber),
    () => stateFor(scope).explorer,
    () => stateFor(scope).explorer,
  );
}

/** Test-only reset keeps the module singleton deterministic without exposing
 * mutation to production callers. */
export function resetOutlinePaneStoreForTest(): void {
  statesByWorkspace = {};
  documentSliceCache.clear();
  browserSliceCache.clear();
  for (const subscribers of [
    documentSubscribers,
    fileQueueSubscribers,
    operationSubscribers,
    sidebarSubscribers,
    explorerSubscribers,
  ]) {
    for (const scoped of subscribers.values()) {
      for (const subscriber of scoped) subscriber();
    }
    subscribers.clear();
  }
}

export { createOutlinePaneCommands } from "./editorSurfaceAdapter";
