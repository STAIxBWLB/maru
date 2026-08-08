import { useSyncExternalStore } from "react";

import type { BinaryViewerClassification } from "./api";
import { nextFallbackTabIdAfterClose, orderTabsById } from "./editorTabActions";
import type {
  DocumentPayload,
  VaultEntry,
  WorkspaceFileEntry,
  WorkspaceVisibility,
} from "./types";

export interface EditorTab {
  id: string;
  workspacePath: string;
  visibility: WorkspaceVisibility;
  entry: VaultEntry;
  document: DocumentPayload;
  draftContent: string;
}

export interface BinaryTab {
  kind: "binary";
  id: string;
  workspacePath: string;
  visibility: WorkspaceVisibility;
  fileEntry: WorkspaceFileEntry;
  classification: BinaryViewerClassification;
  status: "ready" | "error";
  error: string | null;
}

export type AnyTab = EditorTab | BinaryTab;

export type EditorGroupId = "left" | "right";

export interface StoredTabs {
  activeRelPath: string | null;
  leftRelPath: string | null;
  rightRelPath: string | null;
  focusedGroup: EditorGroupId;
  relPaths: string[];
}

export interface EditorTabsState {
  tabs: EditorTab[];
  binaryTabs: BinaryTab[];
  tabOrder: string[];
  activeTabId: string | null;
  leftActiveTabId: string | null;
  rightActiveTabId: string | null;
  focusedEditorGroup: EditorGroupId;
}

/** Keys left undefined are kept as-is; explicit null clears the id. */
export interface EditorTabIdsPatch {
  activeTabId?: string | null;
  leftActiveTabId?: string | null;
  rightActiveTabId?: string | null;
  focusedEditorGroup?: EditorGroupId;
}

export interface ResolvedEditorTabIds {
  leftResolvedTabId: string | null;
  rightResolvedTabId: string | null;
  resolvedActiveTabId: string | null;
}

export interface RestoredEditorTabIds {
  leftActiveTabId: string | null;
  rightActiveTabId: string | null;
  focusedEditorGroup: EditorGroupId;
}

const INITIAL_EDITOR_TABS_STATE: EditorTabsState = {
  tabs: [],
  binaryTabs: [],
  tabOrder: [],
  activeTabId: null,
  leftActiveTabId: null,
  rightActiveTabId: null,
  focusedEditorGroup: "left",
};

function orderedAnyTabsOf(state: EditorTabsState): AnyTab[] {
  return orderTabsById([...state.tabs, ...state.binaryTabs], state.tabOrder);
}

function isBinaryTabLike(tab: AnyTab): tab is BinaryTab {
  return (tab as BinaryTab).kind === "binary";
}

function mapPreservingIdentity<T>(items: T[], map: (item: T) => T): T[] {
  let changed = false;
  const next = items.map((item) => {
    const mapped = map(item);
    if (mapped !== item) changed = true;
    return mapped;
  });
  return changed ? next : items;
}

// ---------------------------------------------------------------------------
// Pure state helpers (unit-tested directly; store actions are thin wrappers
// that compute the next state with these and publish it atomically).
// ---------------------------------------------------------------------------

/** The tabOrder invariant the old prune/append effect maintained: drop ids
 *  whose tab no longer exists, append live ids missing from the order. Every
 *  mutation runs this instead of relying on a follow-up effect. */
export function syncTabOrderInState(state: EditorTabsState): EditorTabsState {
  const liveIds = [...state.tabs, ...state.binaryTabs].map((tab) => tab.id);
  const liveIdSet = new Set(liveIds);
  const next = state.tabOrder.filter((id) => liveIdSet.has(id));
  const seen = new Set(next);
  for (const id of liveIds) {
    if (seen.has(id)) continue;
    next.push(id);
    seen.add(id);
  }
  const unchanged =
    next.length === state.tabOrder.length &&
    next.every((id, index) => id === state.tabOrder[index]);
  return unchanged ? state : { ...state, tabOrder: next };
}

/** The group/active id resolution MainApp renders with. Pure so orchestrators
 *  can resolve against the current store state at call time instead of
 *  capturing render-scope values. */
export function resolveEditorTabIds(
  state: EditorTabsState,
  editorSplitOpen: boolean,
): ResolvedEditorTabIds {
  const firstTabId = orderedAnyTabsOf(state)[0]?.id ?? null;
  const leftResolvedTabId = state.leftActiveTabId ?? state.activeTabId ?? firstTabId;
  const rightResolvedTabId =
    editorSplitOpen && state.rightActiveTabId ? state.rightActiveTabId : null;
  const resolvedActiveTabId =
    state.focusedEditorGroup === "right" && rightResolvedTabId
      ? rightResolvedTabId
      : leftResolvedTabId;
  return { leftResolvedTabId, rightResolvedTabId, resolvedActiveTabId };
}

/** Ordered view of all tabs (doc + binary) per tabOrder, tolerating unknown
 *  ids — the same ordering MainApp renders with. */
export function orderedTabsInState(state: EditorTabsState): AnyTab[] {
  return orderedAnyTabsOf(state);
}

export function updateDraftInState(
  state: EditorTabsState,
  tabId: string,
  content: string,
): EditorTabsState {
  const target = state.tabs.find((tab) => tab.id === tabId);
  if (!target || target.draftContent === content) return state;
  return {
    ...state,
    tabs: state.tabs.map((tab) => (tab.id === tabId ? { ...tab, draftContent: content } : tab)),
  };
}

export function activateTabInState(
  state: EditorTabsState,
  tabId: string,
  group: EditorGroupId,
): EditorTabsState {
  if (group === "right") {
    if (
      state.rightActiveTabId === tabId &&
      state.focusedEditorGroup === "right" &&
      state.activeTabId === tabId
    ) {
      return state;
    }
    return {
      ...state,
      rightActiveTabId: tabId,
      focusedEditorGroup: "right",
      activeTabId: tabId,
    };
  }
  if (
    state.leftActiveTabId === tabId &&
    state.focusedEditorGroup === "left" &&
    state.activeTabId === tabId
  ) {
    return state;
  }
  return {
    ...state,
    leftActiveTabId: tabId,
    focusedEditorGroup: "left",
    activeTabId: tabId,
  };
}

export function patchEditorIdsInState(
  state: EditorTabsState,
  patch: EditorTabIdsPatch,
): EditorTabsState {
  const next: EditorTabsState = {
    ...state,
    activeTabId: patch.activeTabId !== undefined ? patch.activeTabId : state.activeTabId,
    leftActiveTabId:
      patch.leftActiveTabId !== undefined ? patch.leftActiveTabId : state.leftActiveTabId,
    rightActiveTabId:
      patch.rightActiveTabId !== undefined ? patch.rightActiveTabId : state.rightActiveTabId,
    focusedEditorGroup: patch.focusedEditorGroup ?? state.focusedEditorGroup,
  };
  return next.activeTabId === state.activeTabId &&
    next.leftActiveTabId === state.leftActiveTabId &&
    next.rightActiveTabId === state.rightActiveTabId &&
    next.focusedEditorGroup === state.focusedEditorGroup
    ? state
    : next;
}

export interface InsertTabOptions {
  activate?: boolean;
  group?: EditorGroupId;
}

/** Upserts a tab (replace by id, else append) and syncs tabOrder in the same
 *  state transition. `activate` additionally activates the tab in `group`
 *  (default: the state's current focused group). */
export function insertTabInState(
  state: EditorTabsState,
  tab: AnyTab,
  options: InsertTabOptions = {},
): EditorTabsState {
  let next: EditorTabsState;
  if (isBinaryTabLike(tab)) {
    const exists = state.binaryTabs.some((item) => item.id === tab.id);
    next = {
      ...state,
      binaryTabs: exists
        ? state.binaryTabs.map((item) => (item.id === tab.id ? tab : item))
        : [...state.binaryTabs, tab],
    };
  } else {
    const exists = state.tabs.some((item) => item.id === tab.id);
    next = {
      ...state,
      tabs: exists
        ? state.tabs.map((item) => (item.id === tab.id ? tab : item))
        : [...state.tabs, tab],
    };
  }
  next = syncTabOrderInState(next);
  if (options.activate) {
    next = activateTabInState(next, tab.id, options.group ?? state.focusedEditorGroup);
  }
  return next;
}

/** Merges `patch` into the doc tab with `tabId`. Callers must not change the
 *  id — remap flows go through transformTabs so tabOrder/active ids stay
 *  consistent. */
export function patchTabInState(
  state: EditorTabsState,
  tabId: string,
  patch: Partial<EditorTab>,
): EditorTabsState {
  if (!state.tabs.some((tab) => tab.id === tabId)) return state;
  return {
    ...state,
    tabs: state.tabs.map((tab) => (tab.id === tabId ? { ...tab, ...patch } : tab)),
  };
}

/** Maps every doc tab through `updater`, preserving array/tab identity for
 *  untouched entries so unchanged slices do not notify subscribers. */
export function mapDocTabsInState(
  state: EditorTabsState,
  updater: (tab: EditorTab) => EditorTab,
): EditorTabsState {
  const tabs = mapPreservingIdentity(state.tabs, updater);
  return tabs === state.tabs ? state : { ...state, tabs };
}

export interface CloseTabsOptions {
  /** Single-tab close resets focus to the left group when the right pane's tab
   *  closes; the multi-close path leaves focus untouched. */
  resetFocusOnRightClose?: boolean;
  /** Extra id patch applied inside the same state transition (closeOthers
   *  forces the surviving tab into the left group). */
  postIds?: EditorTabIdsPatch;
}

export interface CloseTabsResult {
  state: EditorTabsState;
  closedCount: number;
  /** True when the resolved right-pane tab was among the closed ids — the
   *  caller uses it to fold the editor split in layout settings. */
  rightClosed: boolean;
  fallbackId: string | null;
  removedDocTabs: EditorTab[];
}

export function closeTabsInState(
  state: EditorTabsState,
  tabIds: readonly string[],
  resolved: ResolvedEditorTabIds,
  options: CloseTabsOptions = {},
): CloseTabsResult {
  const closeSet = new Set(tabIds);
  if (closeSet.size === 0) {
    return { state, closedCount: 0, rightClosed: false, fallbackId: null, removedDocTabs: [] };
  }
  const ordered = orderedAnyTabsOf(state);
  const maruId =
    resolved.resolvedActiveTabId && closeSet.has(resolved.resolvedActiveTabId)
      ? resolved.resolvedActiveTabId
      : tabIds[0];
  const fallbackId = nextFallbackTabIdAfterClose(ordered, closeSet, maruId);
  const removedDocTabs = state.tabs.filter((tab) => closeSet.has(tab.id));
  const closedCount = ordered.reduce(
    (count, tab) => (closeSet.has(tab.id) ? count + 1 : count),
    0,
  );
  if (closedCount === 0) {
    return { state, closedCount, rightClosed: false, fallbackId, removedDocTabs };
  }
  const rightClosed = Boolean(
    resolved.rightResolvedTabId && closeSet.has(resolved.rightResolvedTabId),
  );
  let next: EditorTabsState = {
    ...state,
    tabs: state.tabs.filter((tab) => !closeSet.has(tab.id)),
    binaryTabs: state.binaryTabs.filter((tab) => !closeSet.has(tab.id)),
    tabOrder: state.tabOrder.filter((id) => !closeSet.has(id)),
    leftActiveTabId:
      resolved.leftResolvedTabId && closeSet.has(resolved.leftResolvedTabId)
        ? fallbackId
        : state.leftActiveTabId,
    rightActiveTabId: rightClosed ? null : state.rightActiveTabId,
    activeTabId:
      resolved.resolvedActiveTabId && closeSet.has(resolved.resolvedActiveTabId)
        ? fallbackId
        : state.activeTabId,
    focusedEditorGroup:
      rightClosed && options.resetFocusOnRightClose ? "left" : state.focusedEditorGroup,
  };
  if (options.postIds) next = patchEditorIdsInState(next, options.postIds);
  return { state: next, closedCount, rightClosed, fallbackId, removedDocTabs };
}

export interface TabTransform {
  mapDocTab?: (tab: EditorTab) => EditorTab;
  mapBinaryTab?: (tab: BinaryTab) => BinaryTab;
  mapTabId?: (id: string) => string;
}

/** File move/rename flows rewrite tab objects, their ids, tabOrder, and the
 *  active ids in one transition. Mappers must return the input unchanged for
 *  unaffected entries so identity is preserved. */
export function transformTabsInState(
  state: EditorTabsState,
  transform: TabTransform,
): EditorTabsState {
  const mapId = transform.mapTabId;
  const remapId = (id: string | null) => (id && mapId ? mapId(id) : id);
  const tabs = transform.mapDocTab
    ? mapPreservingIdentity(state.tabs, transform.mapDocTab)
    : state.tabs;
  const binaryTabs = transform.mapBinaryTab
    ? mapPreservingIdentity(state.binaryTabs, transform.mapBinaryTab)
    : state.binaryTabs;
  const tabOrder = mapId ? mapPreservingIdentity(state.tabOrder, mapId) : state.tabOrder;
  const activeTabId = remapId(state.activeTabId);
  const leftActiveTabId = remapId(state.leftActiveTabId);
  const rightActiveTabId = remapId(state.rightActiveTabId);
  if (
    tabs === state.tabs &&
    binaryTabs === state.binaryTabs &&
    tabOrder === state.tabOrder &&
    activeTabId === state.activeTabId &&
    leftActiveTabId === state.leftActiveTabId &&
    rightActiveTabId === state.rightActiveTabId
  ) {
    return state;
  }
  return syncTabOrderInState({
    ...state,
    tabs,
    binaryTabs,
    tabOrder,
    activeTabId,
    leftActiveTabId,
    rightActiveTabId,
  });
}

/** loadWorkspace with no startup candidate: drop the workspace's doc tabs,
 *  keep active ids only while their tab survives, and reset to the left
 *  group. Binary tabs are untouched (matches the previous behavior). */
export function resetWorkspaceTabsInState(
  state: EditorTabsState,
  workspacePath: string,
): EditorTabsState {
  const tabs = state.tabs.filter((tab) => tab.workspacePath !== workspacePath);
  const keepId = (id: string | null) =>
    id && tabs.some((tab) => tab.id === id) ? id : null;
  return syncTabOrderInState({
    ...state,
    tabs,
    activeTabId: keepId(state.activeTabId),
    leftActiveTabId: keepId(state.leftActiveTabId),
    rightActiveTabId: null,
    focusedEditorGroup: "left",
  });
}

/** Workspace removal: drop its doc tabs and prune the order; active ids are
 *  left dangling exactly as before (resolution falls back, and the follow-up
 *  loadWorkspace resets them). */
export function removeWorkspaceDocTabsInState(
  state: EditorTabsState,
  workspacePath: string,
): EditorTabsState {
  const tabs = state.tabs.filter((tab) => tab.workspacePath !== workspacePath);
  if (tabs.length === state.tabs.length) return state;
  return syncTabOrderInState({ ...state, tabs });
}

/** Applies the persisted split/focus choice after a workspace restore. */
export function applyRestoredIdsInState(
  state: EditorTabsState,
  ids: RestoredEditorTabIds,
): EditorTabsState {
  return {
    ...state,
    leftActiveTabId: ids.leftActiveTabId,
    rightActiveTabId: ids.rightActiveTabId,
    focusedEditorGroup: ids.focusedEditorGroup,
    activeTabId:
      ids.focusedEditorGroup === "right" && ids.rightActiveTabId
        ? ids.rightActiveTabId
        : ids.leftActiveTabId,
  };
}

/** Startup restore of the primary tab: replace the workspace's doc tabs with
 *  the freshly read primary tab and apply the stored group/focus ids. */
export function restoreWorkspaceTabsInState(
  state: EditorTabsState,
  workspacePath: string,
  primaryTab: EditorTab,
  ids: RestoredEditorTabIds,
): EditorTabsState {
  const tabs = [
    ...state.tabs.filter((tab) => tab.workspacePath !== workspacePath),
    primaryTab,
  ];
  return applyRestoredIdsInState(syncTabOrderInState({ ...state, tabs }), ids);
}

export const RESTORED_COMPANION_TAB_CAP = 8;

/** Lazily hydrated companion tabs during startup restore: append unseen ids
 *  only, capped, then re-apply the stored group/focus ids. */
export function appendRestoredDocTabsInState(
  state: EditorTabsState,
  companions: readonly EditorTab[],
  ids: RestoredEditorTabIds,
  cap: number = RESTORED_COMPANION_TAB_CAP,
): EditorTabsState {
  const seen = new Set(state.tabs.map((tab) => tab.id));
  const fresh = companions.filter((tab) => {
    if (seen.has(tab.id)) return false;
    seen.add(tab.id);
    return true;
  });
  const tabs = fresh.length === 0 ? state.tabs : [...state.tabs, ...fresh].slice(0, cap);
  return applyRestoredIdsInState(syncTabOrderInState({ ...state, tabs }), ids);
}

/** closeAllCleanTabs: keep exactly the given doc tabs (the dirty ones), drop
 *  every binary tab, and reset order + active ids to the given fallback. */
export function replaceAllDocTabsInState(
  state: EditorTabsState,
  tabs: EditorTab[],
  ids: {
    activeTabId: string | null;
    leftActiveTabId: string | null;
    rightActiveTabId: string | null;
    focusedEditorGroup: EditorGroupId;
  },
): EditorTabsState {
  return {
    ...state,
    tabs,
    binaryTabs: [],
    tabOrder: tabs.map((tab) => tab.id),
    ...ids,
  };
}

// ---------------------------------------------------------------------------
// Store: one module-level state object, replaced atomically by publish().
// ---------------------------------------------------------------------------

let editorTabsState: EditorTabsState = INITIAL_EDITOR_TABS_STATE;
const subscribers = new Set<() => void>();

function publish(next: EditorTabsState): void {
  if (next === editorTabsState) return;
  editorTabsState = next;
  for (const subscriber of subscribers) subscriber();
}

/** Non-React read for close/relaunch guards and orchestrators that need the
 *  current tabs at call time (the store state is the always-current mirror;
 *  there is no separate tabsRef). */
export function getEditorTabsState(): EditorTabsState {
  return editorTabsState;
}

/** Synchronous draft update. HTML WYSIWYG flushes route through here, so a
 *  same-tick hasDirtyDrafts/save/close read observes fresh iframe edits. */
export function updateTabDraft(tabId: string, content: string): void {
  publish(updateDraftInState(editorTabsState, tabId, content));
}

/** Activates `tabId` in `group` (default: the focused group *at call time*). */
export function activateEditorTab(tabId: string, group?: EditorGroupId): void {
  publish(activateTabInState(editorTabsState, tabId, group ?? editorTabsState.focusedEditorGroup));
}

export function setFocusedEditorGroup(group: EditorGroupId): void {
  publish(patchEditorIdsInState(editorTabsState, { focusedEditorGroup: group }));
}

/** Composite id updates that must land in a single transition (split open /
 *  close, closeOthers' forced left activation, restored focus). */
export function patchEditorIds(patch: EditorTabIdsPatch): void {
  publish(patchEditorIdsInState(editorTabsState, patch));
}

export function insertDocTab(tab: EditorTab, options: InsertTabOptions = {}): void {
  publish(insertTabInState(editorTabsState, tab, options));
}

export function insertBinaryTab(tab: BinaryTab, options: InsertTabOptions = {}): void {
  publish(insertTabInState(editorTabsState, tab, options));
}

/** Id removal + fallback-id + tabOrder prune in one transition. The caller
 *  keeps its side effects (discarded-edit capture, layout-settings writes)
 *  and passes the render-resolved ids plus the single/multi-close flag. */
export function closeTabs(
  tabIds: readonly string[],
  resolved: ResolvedEditorTabIds,
  options: CloseTabsOptions = {},
): CloseTabsResult {
  const result = closeTabsInState(editorTabsState, tabIds, resolved, options);
  publish(result.state);
  return result;
}

export function patchTab(tabId: string, patch: Partial<EditorTab>): void {
  publish(patchTabInState(editorTabsState, tabId, patch));
}

/** Batch patch used by save/snapshot/studio-refresh/updateField flows. */
export function mapDocTabs(updater: (tab: EditorTab) => EditorTab): void {
  publish(mapDocTabsInState(editorTabsState, updater));
}

export function transformTabs(transform: TabTransform): void {
  publish(transformTabsInState(editorTabsState, transform));
}

export function resetWorkspaceTabs(workspacePath: string): void {
  publish(resetWorkspaceTabsInState(editorTabsState, workspacePath));
}

export function removeWorkspaceDocTabs(workspacePath: string): void {
  publish(removeWorkspaceDocTabsInState(editorTabsState, workspacePath));
}

export function restoreWorkspaceTabs(
  workspacePath: string,
  primaryTab: EditorTab,
  ids: RestoredEditorTabIds,
): void {
  publish(restoreWorkspaceTabsInState(editorTabsState, workspacePath, primaryTab, ids));
}

export function appendRestoredDocTabs(
  companions: readonly EditorTab[],
  ids: RestoredEditorTabIds,
): void {
  publish(appendRestoredDocTabsInState(editorTabsState, companions, ids));
}

export function replaceAllDocTabs(
  tabs: EditorTab[],
  ids: {
    activeTabId: string | null;
    leftActiveTabId: string | null;
    rightActiveTabId: string | null;
    focusedEditorGroup: EditorGroupId;
  },
): void {
  publish(replaceAllDocTabsInState(editorTabsState, tabs, ids));
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

function getDocTabsSnapshot(): EditorTab[] {
  return editorTabsState.tabs;
}

function getBinaryTabsSnapshot(): BinaryTab[] {
  return editorTabsState.binaryTabs;
}

function getTabOrderSnapshot(): string[] {
  return editorTabsState.tabOrder;
}

export interface ActiveEditorTabIds {
  activeTabId: string | null;
  leftActiveTabId: string | null;
  rightActiveTabId: string | null;
}

// Object identity stays stable unless one of the three ids actually changes.
let activeTabIdsCache: ActiveEditorTabIds | null = null;

function getActiveTabIdsSnapshot(): ActiveEditorTabIds {
  if (
    !activeTabIdsCache ||
    activeTabIdsCache.activeTabId !== editorTabsState.activeTabId ||
    activeTabIdsCache.leftActiveTabId !== editorTabsState.leftActiveTabId ||
    activeTabIdsCache.rightActiveTabId !== editorTabsState.rightActiveTabId
  ) {
    activeTabIdsCache = {
      activeTabId: editorTabsState.activeTabId,
      leftActiveTabId: editorTabsState.leftActiveTabId,
      rightActiveTabId: editorTabsState.rightActiveTabId,
    };
  }
  return activeTabIdsCache;
}

function getFocusedEditorGroupSnapshot(): EditorGroupId {
  return editorTabsState.focusedEditorGroup;
}

export function useDocTabs(): EditorTab[] {
  return useSyncExternalStore(subscribe, getDocTabsSnapshot, getDocTabsSnapshot);
}

export function useBinaryTabs(): BinaryTab[] {
  return useSyncExternalStore(subscribe, getBinaryTabsSnapshot, getBinaryTabsSnapshot);
}

export function useTabOrder(): string[] {
  return useSyncExternalStore(subscribe, getTabOrderSnapshot, getTabOrderSnapshot);
}

export function useActiveTabIds(): ActiveEditorTabIds {
  return useSyncExternalStore(subscribe, getActiveTabIdsSnapshot, getActiveTabIdsSnapshot);
}

export function useFocusedEditorGroup(): EditorGroupId {
  return useSyncExternalStore(
    subscribe,
    getFocusedEditorGroupSnapshot,
    getFocusedEditorGroupSnapshot,
  );
}
