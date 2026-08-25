import { useSyncExternalStore } from "react";

import {
  getEditorTabsState,
  type EditorGroupId,
  type EditorTab,
  type EditorTabsState,
  useActiveTabIds,
  useDocTabs,
  useTabOrder,
} from "./editorTabsStore";
import type { EditorViewMode, HtmlViewMode } from "../components/DocumentModeSurface";
import type { DocumentPayload, VaultEntry } from "./types";

/**
 * The Editor facade key is explicit. A tab id alone is not sufficient: the
 * same document may be displayed in both split groups or in another workspace.
 */
export interface EditorPaneScope {
  workspacePath: string;
  group: EditorGroupId;
  tabId: string;
}

export interface EditorPaneDocumentSlice {
  tab: EditorTab | null;
  document: DocumentPayload | null;
  draftContent: string;
}

export interface EditorPaneTabsSlice {
  tabs: readonly EditorTab[];
  tabOrder: readonly string[];
  activeTabId: string | null;
}

export interface EditorPaneViewPreviewSlice {
  viewMode: EditorViewMode;
  htmlViewMode: HtmlViewMode;
  htmlRiskAckDigest: string | null;
}

export interface EditorPaneOperationSlice {
  openingEntry: VaultEntry | null;
  saving: boolean;
  conflict: string | null;
  error: string | null;
}

export interface EditorPaneState {
  document: EditorPaneDocumentSlice;
  tabs: EditorPaneTabsSlice;
  viewPreview: EditorPaneViewPreviewSlice;
  operation: EditorPaneOperationSlice;
}

interface EditorPaneLocalState {
  viewPreview: EditorPaneViewPreviewSlice;
  operation: EditorPaneOperationSlice;
}

type EditorPaneDomain = keyof EditorPaneState;

const DEFAULT_VIEW_PREVIEW: EditorPaneViewPreviewSlice = {
  viewMode: "source",
  htmlViewMode: "visual",
  htmlRiskAckDigest: null,
};

const DEFAULT_OPERATION: EditorPaneOperationSlice = {
  openingEntry: null,
  saving: false,
  conflict: null,
  error: null,
};

const editorPaneLocalState = new Map<string, EditorPaneLocalState>();
const subscribers = new Map<string, Map<EditorPaneDomain, Set<() => void>>>();
const stateCache = new Map<
  string,
  { local: EditorPaneLocalState; tabsState: EditorTabsState; snapshot: EditorPaneState }
>();

function scopeKey(scope: EditorPaneScope): string {
  return `${scope.workspacePath}\u0000${scope.group}\u0000${scope.tabId}`;
}

function defaultLocalState(): EditorPaneLocalState {
  return { viewPreview: DEFAULT_VIEW_PREVIEW, operation: DEFAULT_OPERATION };
}

function localStateFor(scope: EditorPaneScope): EditorPaneLocalState {
  const key = scopeKey(scope);
  const existing = editorPaneLocalState.get(key);
  if (existing) return existing;
  const next = defaultLocalState();
  editorPaneLocalState.set(key, next);
  return next;
}

function getDocumentSlice(scope: EditorPaneScope, tabsState: EditorTabsState): EditorPaneDocumentSlice {
  const tab =
    tabsState.tabs.find(
      (candidate) => candidate.id === scope.tabId && candidate.workspacePath === scope.workspacePath,
    ) ?? null;
  return {
    tab,
    document: tab?.document ?? null,
    draftContent: tab?.draftContent ?? "",
  };
}

function getTabsSlice(scope: EditorPaneScope, tabsState: EditorTabsState): EditorPaneTabsSlice {
  return {
    tabs: tabsState.tabs.filter((tab) => tab.workspacePath === scope.workspacePath),
    tabOrder: tabsState.tabOrder,
    activeTabId: scope.group === "left" ? tabsState.leftActiveTabId : tabsState.rightActiveTabId,
  };
}

function notify(scope: EditorPaneScope, domain: EditorPaneDomain): void {
  for (const subscriber of subscribers.get(scopeKey(scope))?.get(domain) ?? []) subscriber();
}

function publishLocal(
  scope: EditorPaneScope,
  domain: "viewPreview" | "operation",
  next: EditorPaneLocalState,
): void {
  const key = scopeKey(scope);
  const current = localStateFor(scope);
  if (next === current) return;
  editorPaneLocalState.set(key, next);
  notify(scope, domain);
}

function subscribe(scope: EditorPaneScope, domain: EditorPaneDomain, subscriber: () => void): () => void {
  const key = scopeKey(scope);
  let domains = subscribers.get(key);
  if (!domains) {
    domains = new Map();
    subscribers.set(key, domains);
  }
  let domainSubscribers = domains.get(domain);
  if (!domainSubscribers) {
    domainSubscribers = new Set();
    domains.set(domain, domainSubscribers);
  }
  domainSubscribers.add(subscriber);
  return () => {
    domainSubscribers.delete(subscriber);
    if (domainSubscribers.size > 0) return;
    domains.delete(domain);
    if (domains.size === 0) subscribers.delete(key);
  };
}

/** Returns one cached four-domain snapshot until either canonical tabs or the local scope changes. */
export function getEditorPaneState(scope: EditorPaneScope): EditorPaneState {
  const key = scopeKey(scope);
  const local = localStateFor(scope);
  const tabsState = getEditorTabsState();
  const cached = stateCache.get(key);
  if (cached?.local === local && cached.tabsState === tabsState) return cached.snapshot;

  const previous = cached?.snapshot;
  const document =
    cached?.tabsState === tabsState ? (previous?.document ?? getDocumentSlice(scope, tabsState)) : getDocumentSlice(scope, tabsState);
  const tabs =
    cached?.tabsState === tabsState ? (previous?.tabs ?? getTabsSlice(scope, tabsState)) : getTabsSlice(scope, tabsState);
  const snapshot = {
    document,
    tabs,
    viewPreview: local.viewPreview,
    operation: local.operation,
  };
  stateCache.set(key, { local, tabsState, snapshot });
  return snapshot;
}

export function patchEditorPaneViewPreview(
  scope: EditorPaneScope,
  patch: Partial<EditorPaneViewPreviewSlice>,
): EditorPaneState {
  const current = localStateFor(scope);
  const nextViewPreview = { ...current.viewPreview, ...patch };
  const changed = (Object.keys(patch) as (keyof EditorPaneViewPreviewSlice)[]).some(
    (key) => nextViewPreview[key] !== current.viewPreview[key],
  );
  if (!changed) return getEditorPaneState(scope);
  publishLocal(scope, "viewPreview", { ...current, viewPreview: nextViewPreview });
  return getEditorPaneState(scope);
}

export function patchEditorPaneOperation(
  scope: EditorPaneScope,
  patch: Partial<EditorPaneOperationSlice>,
): EditorPaneState {
  const current = localStateFor(scope);
  const nextOperation = { ...current.operation, ...patch };
  const changed = (Object.keys(patch) as (keyof EditorPaneOperationSlice)[]).some(
    (key) => nextOperation[key] !== current.operation[key],
  );
  if (!changed) return getEditorPaneState(scope);
  publishLocal(scope, "operation", { ...current, operation: nextOperation });
  return getEditorPaneState(scope);
}

/** Applies a persisted mode only when the shell's workspace generation is current. */
export function hydrateEditorPaneState(
  scope: EditorPaneScope,
  requestId: number,
  patch: Pick<EditorPaneViewPreviewSlice, "viewMode">,
  currentRequestId: number,
): boolean {
  if (requestId !== currentRequestId) return false;
  patchEditorPaneViewPreview(scope, patch);
  return true;
}

export function hasEditorPaneState(scope: EditorPaneScope): boolean {
  return editorPaneLocalState.has(scopeKey(scope));
}

function cleanupMatching(predicate: (scope: EditorPaneScope) => boolean): void {
  for (const key of [...editorPaneLocalState.keys()]) {
    const [workspacePath, group, tabId] = key.split("\u0000") as [string, EditorGroupId, string];
    const scope = { workspacePath, group, tabId };
    if (!predicate(scope)) continue;
    editorPaneLocalState.delete(key);
    stateCache.delete(key);
    subscribers.delete(key);
  }
}

export function cleanupEditorPaneTab(scope: EditorPaneScope): void {
  cleanupMatching(
    (candidate) =>
      candidate.workspacePath === scope.workspacePath &&
      candidate.group === scope.group &&
      candidate.tabId === scope.tabId,
  );
}

export function cleanupEditorPaneGroup(workspacePath: string, group: EditorGroupId): void {
  cleanupMatching((scope) => scope.workspacePath === workspacePath && scope.group === group);
}

export function cleanupEditorPaneWorkspace(workspacePath: string): void {
  cleanupMatching((scope) => scope.workspacePath === workspacePath);
}

/** Moves only facade-local transient state between scopes; canonical drafts remain in editorTabsStore. */
export function replaceEditorPaneScope(from: EditorPaneScope, to: EditorPaneScope): void {
  const fromKey = scopeKey(from);
  const local = editorPaneLocalState.get(fromKey);
  if (!local || fromKey === scopeKey(to)) return;
  editorPaneLocalState.delete(fromKey);
  stateCache.delete(fromKey);
  editorPaneLocalState.set(scopeKey(to), local);
  stateCache.delete(scopeKey(to));
}

export interface EditorPaneCommands {
  save: () => Promise<void>;
}

export function createEditorPaneCommands({
  getState,
  save,
}: {
  getState: () => EditorPaneState;
  save: (state: EditorPaneState) => void | Promise<void>;
}): EditorPaneCommands {
  return { save: async () => save(getState()) };
}

function useEditorPaneDomain<T>(scope: EditorPaneScope, domain: EditorPaneDomain, read: () => T): T {
  return useSyncExternalStore(
    (subscriber) => subscribe(scope, domain, subscriber),
    read,
    read,
  );
}

export function useEditorDocumentSlice(scope: EditorPaneScope): EditorPaneDocumentSlice {
  useDocTabs();
  return useEditorPaneDomain(scope, "document", () => getEditorPaneState(scope).document);
}

export function useEditorTabsSlice(scope: EditorPaneScope): EditorPaneTabsSlice {
  useDocTabs();
  useTabOrder();
  useActiveTabIds();
  return useEditorPaneDomain(scope, "tabs", () => getEditorPaneState(scope).tabs);
}

export function useEditorViewPreviewSlice(scope: EditorPaneScope): EditorPaneViewPreviewSlice {
  return useEditorPaneDomain(scope, "viewPreview", () => getEditorPaneState(scope).viewPreview);
}

export function useEditorOperationSlice(scope: EditorPaneScope): EditorPaneOperationSlice {
  return useEditorPaneDomain(scope, "operation", () => getEditorPaneState(scope).operation);
}

/** Test-only reset. It never reaches or mutates editorTabsStore. */
export function resetEditorPaneStoreForTests(): void {
  editorPaneLocalState.clear();
  stateCache.clear();
  subscribers.clear();
}
