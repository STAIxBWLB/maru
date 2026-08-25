import { useSyncExternalStore, type ReactNode } from "react";

import {
  getEditorTabsState,
  type EditorGroupId,
  type EditorTab,
  type EditorTabsState,
  updateTabDraft,
  useActiveTabIds,
  useDocTabs,
  useTabOrder,
} from "./editorTabsStore";
import type { EditorViewMode, HtmlViewMode } from "../components/DocumentModeSurface";
import type { DocumentPayload, KgNodeRef, VaultEntry } from "./types";
import type { EditorTabSummary } from "../components/EditorPane";

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

/** Shell-derived display inputs. Canonical documents and drafts remain in editorTabsStore. */
export interface EditorPanePresentationSlice {
  tabs: readonly EditorTabSummary[];
  activeTabId: string | null;
  outlineOpen: boolean;
  activeWorkspaceLabel: string | null;
  documentLabel: string | null;
  readOnly: boolean;
  canSnapshot: boolean;
  readOnlyReason: string | null;
  entries: readonly VaultEntry[];
  bodyOverride: ReactNode;
  vaultPath: string | null;
  isManagedVaultNote: boolean;
  kgHighlightRefs: readonly KgNodeRef[] | null;
}

export interface EditorPaneState {
  scope: EditorPaneScope;
  document: EditorPaneDocumentSlice;
  tabs: EditorPaneTabsSlice;
  viewPreview: EditorPaneViewPreviewSlice;
  operation: EditorPaneOperationSlice;
  presentation: EditorPanePresentationSlice;
}

interface EditorPaneLocalState {
  viewPreview: EditorPaneViewPreviewSlice;
  operation: EditorPaneOperationSlice;
  presentation: EditorPanePresentationSlice;
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

const DEFAULT_PRESENTATION: EditorPanePresentationSlice = {
  tabs: [],
  activeTabId: null,
  outlineOpen: false,
  activeWorkspaceLabel: null,
  documentLabel: null,
  readOnly: false,
  canSnapshot: false,
  readOnlyReason: null,
  entries: [],
  bodyOverride: null,
  vaultPath: null,
  isManagedVaultNote: false,
  kgHighlightRefs: null,
};

const editorPaneLocalState = new Map<string, EditorPaneLocalState>();
const editorPaneGroupViewModes = new Map<string, EditorViewMode>();
const subscribers = new Map<string, Map<EditorPaneDomain, Set<() => void>>>();
const stateCache = new Map<
  string,
  {
    local: EditorPaneLocalState;
    groupViewMode: EditorViewMode;
    tabsState: EditorTabsState;
    snapshot: EditorPaneState;
  }
>();

function scopeKey(scope: EditorPaneScope): string {
  return `${scope.workspacePath}\u0000${scope.group}\u0000${scope.tabId}`;
}

function groupKey(workspacePath: string, group: EditorGroupId): string {
  return `${workspacePath}\u0000${group}`;
}

function groupViewModeFor(scope: EditorPaneScope, local: EditorPaneLocalState): EditorViewMode {
  return editorPaneGroupViewModes.get(groupKey(scope.workspacePath, scope.group)) ?? local.viewPreview.viewMode;
}

function defaultLocalState(): EditorPaneLocalState {
  return {
    viewPreview: DEFAULT_VIEW_PREVIEW,
    operation: DEFAULT_OPERATION,
    presentation: DEFAULT_PRESENTATION,
  };
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
  const groupViewMode = groupViewModeFor(scope, local);
  if (
    cached?.local === local &&
    cached.groupViewMode === groupViewMode &&
    cached.tabsState === tabsState
  ) {
    return cached.snapshot;
  }

  const previous = cached?.snapshot;
  const document =
    cached?.tabsState === tabsState ? (previous?.document ?? getDocumentSlice(scope, tabsState)) : getDocumentSlice(scope, tabsState);
  const tabs =
    cached?.tabsState === tabsState ? (previous?.tabs ?? getTabsSlice(scope, tabsState)) : getTabsSlice(scope, tabsState);
  const viewPreview =
    cached?.groupViewMode === groupViewMode
      ? cached.snapshot.viewPreview
      : { ...local.viewPreview, viewMode: groupViewMode };
  const snapshot = {
    scope,
    document,
    tabs,
    viewPreview,
    operation: local.operation,
    presentation: local.presentation,
  };
  stateCache.set(key, { local, groupViewMode, tabsState, snapshot });
  return snapshot;
}

export function setEditorPanePresentation(
  scope: EditorPaneScope,
  presentation: EditorPanePresentationSlice,
  operation: Pick<EditorPaneOperationSlice, "openingEntry" | "saving">,
): void {
  const current = localStateFor(scope);
  const presentationChanged = Object.keys(presentation).some(
    (key) => presentation[key as keyof EditorPanePresentationSlice] !== current.presentation[key as keyof EditorPanePresentationSlice],
  );
  const nextOperation = { ...current.operation, ...operation };
  const operationChanged = nextOperation.openingEntry !== current.operation.openingEntry || nextOperation.saving !== current.operation.saving;
  if (!presentationChanged && !operationChanged) return;
  const next = {
    ...current,
    ...(presentationChanged ? { presentation } : {}),
    ...(operationChanged ? { operation: nextOperation } : {}),
  };
  editorPaneLocalState.set(scopeKey(scope), next);
  stateCache.delete(scopeKey(scope));
  if (presentationChanged) notify(scope, "presentation");
  if (operationChanged) notify(scope, "operation");
}

/** Pure facade action: canonical draft ownership stays in editorTabsStore. */
export function updateEditorPaneDraft(scope: EditorPaneScope, content: string): void {
  if (getEditorPaneState(scope).document.draftContent === content) return;
  updateTabDraft(scope.tabId, content);
  stateCache.delete(scopeKey(scope));
  notify(scope, "document");
}

export function patchEditorPaneViewPreview(
  scope: EditorPaneScope,
  patch: Partial<EditorPaneViewPreviewSlice>,
): EditorPaneState {
  const current = localStateFor(scope);
  const currentViewMode = groupViewModeFor(scope, current);
  const nextViewMode = patch.viewMode ?? currentViewMode;
  const { viewMode: _viewMode, ...localPatch } = patch;
  const nextViewPreview = { ...current.viewPreview, ...localPatch };
  const localChanged = (Object.keys(localPatch) as (keyof Omit<EditorPaneViewPreviewSlice, "viewMode">)[]).some(
    (key) => nextViewPreview[key] !== current.viewPreview[key],
  );
  const groupChanged = nextViewMode !== currentViewMode;
  if (!localChanged && !groupChanged) return getEditorPaneState(scope);
  if (groupChanged) {
    editorPaneGroupViewModes.set(groupKey(scope.workspacePath, scope.group), nextViewMode);
    for (const key of [...stateCache.keys()]) {
      const [workspacePath, group, tabId] = key.split("\u0000") as [string, EditorGroupId, string];
      if (workspacePath !== scope.workspacePath || group !== scope.group) continue;
      stateCache.delete(key);
      notify({ workspacePath, group, tabId }, "viewPreview");
    }
  }
  if (localChanged) {
    publishLocal(scope, "viewPreview", { ...current, viewPreview: nextViewPreview });
  }
  return getEditorPaneState(scope);
}

/** Atomically applies the persisted left/right view modes for one workspace. */
export function setEditorPaneViewModes(
  workspacePath: string,
  modes: { left: EditorViewMode; right: EditorViewMode },
): void {
  const changedGroups = (Object.entries(modes) as [EditorGroupId, EditorViewMode][]).filter(
    ([group, mode]) => editorPaneGroupViewModes.get(groupKey(workspacePath, group)) !== mode,
  );
  if (changedGroups.length === 0) return;
  for (const [group, mode] of changedGroups) editorPaneGroupViewModes.set(groupKey(workspacePath, group), mode);
  for (const key of [...stateCache.keys()]) {
    const [cachedWorkspacePath, group] = key.split("\u0000") as [string, EditorGroupId, string];
    if (cachedWorkspacePath !== workspacePath || !changedGroups.some(([changed]) => changed === group)) continue;
    stateCache.delete(key);
    const [, , tabId] = key.split("\u0000") as [string, EditorGroupId, string];
    notify({ workspacePath, group, tabId }, "viewPreview");
  }
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
  editorPaneGroupViewModes.delete(groupKey(workspacePath, group));
}

export function cleanupEditorPaneWorkspace(workspacePath: string): void {
  cleanupMatching((scope) => scope.workspacePath === workspacePath);
  editorPaneGroupViewModes.delete(groupKey(workspacePath, "left"));
  editorPaneGroupViewModes.delete(groupKey(workspacePath, "right"));
}

export function cleanupEditorPaneTabAcrossGroups(workspacePath: string, tabId: string): void {
  cleanupMatching((scope) => scope.workspacePath === workspacePath && scope.tabId === tabId);
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

function useEditorPaneDomain<T>(scope: EditorPaneScope, domain: EditorPaneDomain, read: () => T): T {
  return useSyncExternalStore(
    (subscriber) => subscribe(scope, domain, subscriber),
    read,
    read,
  );
}

export function subscribeEditorDocument(scope: EditorPaneScope): (subscriber: () => void) => () => void {
  return (subscriber) => subscribe(scope, "document", subscriber);
}

export function subscribeEditorTabs(scope: EditorPaneScope): (subscriber: () => void) => () => void {
  return (subscriber) => subscribe(scope, "tabs", subscriber);
}

export function subscribeEditorViewPreview(scope: EditorPaneScope): (subscriber: () => void) => () => void {
  return (subscriber) => subscribe(scope, "viewPreview", subscriber);
}

export function subscribeEditorOperation(scope: EditorPaneScope): (subscriber: () => void) => () => void {
  return (subscriber) => subscribe(scope, "operation", subscriber);
}

export function getEditorDocumentSlice(scope: EditorPaneScope): EditorPaneDocumentSlice {
  return getEditorPaneState(scope).document;
}

export function getEditorTabsSlice(scope: EditorPaneScope): EditorPaneTabsSlice {
  return getEditorPaneState(scope).tabs;
}

export function getEditorViewPreviewSlice(scope: EditorPaneScope): EditorPaneViewPreviewSlice {
  return getEditorPaneState(scope).viewPreview;
}

export function getEditorOperationSlice(scope: EditorPaneScope): EditorPaneOperationSlice {
  return getEditorPaneState(scope).operation;
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

export function useEditorPresentationSlice(scope: EditorPaneScope): EditorPanePresentationSlice {
  return useEditorPaneDomain(scope, "presentation", () => getEditorPaneState(scope).presentation);
}

/** Test-only reset. It never reaches or mutates editorTabsStore. */
export function resetEditorPaneStoreForTests(): void {
  editorPaneLocalState.clear();
  editorPaneGroupViewModes.clear();
  stateCache.clear();
  subscribers.clear();
}
