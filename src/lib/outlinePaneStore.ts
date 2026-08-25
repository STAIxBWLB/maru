import { useSyncExternalStore } from "react";

import {
  getEditorTabsState,
  useActiveTabIds,
  useDocTabs,
} from "./editorTabsStore";
import type { DocumentPayload, FileQueueItem } from "./types";

/** The Outline facade is deliberately keyed by workspace. `tabId` is an
 * optional render selector, not owned state: tabs and drafts remain in
 * editorTabsStore. */
export interface OutlinePaneScope {
  workspacePath: string;
  tabId?: string | null;
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

export interface OutlinePaneState {
  document: OutlineDocumentSlice;
  fileQueue: OutlineFileQueueSlice;
  operation: OutlineOperationSlice;
}

const EMPTY_DOCUMENT_SLICE: OutlineDocumentSlice = {
  document: null,
  draftContent: "",
};
const EMPTY_FILE_QUEUE_SLICE: OutlineFileQueueSlice = {
  fileQueue: [],
  selectedFileQueueItemIds: [],
  canApplyFileQueue: false,
};
const EMPTY_OPERATION_SLICE: OutlineOperationSlice = {
  applyingFileQueue: false,
  fileQueueError: null,
};
const EMPTY_OUTLINE_PANE_STATE: OutlinePaneState = {
  document: EMPTY_DOCUMENT_SLICE,
  fileQueue: EMPTY_FILE_QUEUE_SLICE,
  operation: EMPTY_OPERATION_SLICE,
};

let statesByWorkspace: Record<string, OutlinePaneState> = {};
const subscribers = new Set<() => void>();
const documentSliceCache = new Map<string, { tab: object | null; slice: OutlineDocumentSlice }>();

function stateFor(scope: OutlinePaneScope): OutlinePaneState {
  return statesByWorkspace[scope.workspacePath] ?? EMPTY_OUTLINE_PANE_STATE;
}

function publish(next: Record<string, OutlinePaneState>): void {
  if (next === statesByWorkspace) return;
  statesByWorkspace = next;
  for (const subscriber of subscribers) subscriber();
}

function documentSliceFromTabs(scope: OutlinePaneScope): OutlineDocumentSlice | null {
  const state = getEditorTabsState();
  const tabId = scope.tabId ?? state.activeTabId;
  const tab = state.tabs.find(
    (candidate) => candidate.id === tabId && candidate.workspacePath === scope.workspacePath,
  ) ?? null;
  if (!tab) return null;
  const cached = documentSliceCache.get(scope.workspacePath);
  if (cached?.tab === tab) return cached.slice;
  const slice = { document: tab.document, draftContent: tab.draftContent };
  documentSliceCache.set(scope.workspacePath, { tab, slice });
  return slice;
}

/** A non-React current snapshot for command ports and narrow shell adapters. */
export function getOutlinePaneState(scope: OutlinePaneScope): OutlinePaneState {
  return stateFor(scope);
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
  };
  if (
    next.document === current.document &&
    next.fileQueue === current.fileQueue &&
    next.operation === current.operation
  ) return current;
  publish({ ...statesByWorkspace, [scope.workspacePath]: next });
  return next;
}

export function cleanupOutlinePaneWorkspace(workspacePath: string): void {
  if (!(workspacePath in statesByWorkspace)) return;
  const next = { ...statesByWorkspace };
  delete next[workspacePath];
  documentSliceCache.delete(workspacePath);
  publish(next);
}

function subscribe(subscriber: () => void): () => void {
  subscribers.add(subscriber);
  return () => subscribers.delete(subscriber);
}

/**
 * Stable facade slice. Canonical document/draft values come from
 * editorTabsStore; the local subscription supplies a stable fallback for
 * lifecycle tests and future pane-local hydration.
 */
export function useOutlineDocumentSlice(scope: OutlinePaneScope): OutlineDocumentSlice {
  const fallback = useSyncExternalStore(
    subscribe,
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
    subscribe,
    () => stateFor(scope).fileQueue,
    () => stateFor(scope).fileQueue,
  );
}

export function useOutlineOperationSlice(scope: OutlinePaneScope): OutlineOperationSlice {
  return useSyncExternalStore(
    subscribe,
    () => stateFor(scope).operation,
    () => stateFor(scope).operation,
  );
}

/** Test-only reset keeps the module singleton deterministic without exposing
 * mutation to production callers. */
export function resetOutlinePaneStoreForTest(): void {
  statesByWorkspace = {};
  documentSliceCache.clear();
  for (const subscriber of subscribers) subscriber();
}

export { createOutlinePaneCommands } from "./editorSurfaceAdapter";
