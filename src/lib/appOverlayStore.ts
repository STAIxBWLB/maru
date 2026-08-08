import { useSyncExternalStore } from "react";

import type { ComposeDialogSeed } from "../components/skills/ComposeDialog";
import type { GitStatus, WorkspaceVisibility } from "./types";

// ---------------------------------------------------------------------------
// App overlay/dialog UI state (extracted from MainApp in step 9): the
// settings overlay, command palette, skill compose dialog, new-document
// dialog, add-workspace dialog, and git commit dialog. Same shape as
// workspaceStore/editorTabsStore: one module-level state object replaced
// atomically by publish(), pure *InState helpers (unit-tested directly), and
// per-slice useSyncExternalStore hooks.
// ---------------------------------------------------------------------------

export interface NewDocumentDialogSeed {
  title: string;
  relPath: string | null;
  docType?: string | null;
  openLibrary?: boolean;
}

export interface AppOverlayStoreState {
  settingsOverlay: { tab: string | null } | null;
  commandPaletteOpen: boolean;
  composeSeed: ComposeDialogSeed | null;
  newDocument: { seed: NewDocumentDialogSeed | null } | null;
  addWorkspace: { defaultVisibility: WorkspaceVisibility } | null;
  commitDialog: { path: string; status: GitStatus } | null;
}

/** Settings opens as an in-app overlay, not a separate window. Seeded from
 *  the URL so the legacy `?window=settings&tab=…` deep link keeps working
 *  (pinned by agents-settings/today/smoke e2e specs). */
function initialSettingsOverlay(): { tab: string | null } | null {
  if (typeof window === "undefined") return null;
  const params = new URLSearchParams(window.location.search);
  if (params.get("window") !== "settings") return null;
  return { tab: params.get("tab") };
}

const INITIAL_APP_OVERLAY_STORE_STATE: AppOverlayStoreState = {
  settingsOverlay: initialSettingsOverlay(),
  commandPaletteOpen: false,
  composeSeed: null,
  newDocument: null,
  addWorkspace: null,
  commitDialog: null,
};

// ---------------------------------------------------------------------------
// Pure state helpers. Store actions are thin wrappers that compute the next
// state with these and publish it atomically. Every helper returns the input
// state identity when the change is a no-op so subscribers do not re-render.
// ---------------------------------------------------------------------------

/** `tab === undefined` is the plain "open preferences" call: it keeps an
 *  already-open overlay on its current tab. An explicit tab (including null)
 *  always replaces, matching the per-section settings openers. */
export function openSettingsInState(
  state: AppOverlayStoreState,
  tab?: string | null,
): AppOverlayStoreState {
  if (tab === undefined) {
    return state.settingsOverlay !== null ? state : { ...state, settingsOverlay: { tab: null } };
  }
  if (state.settingsOverlay?.tab === tab) return state;
  return { ...state, settingsOverlay: { tab } };
}

export function closeSettingsInState(state: AppOverlayStoreState): AppOverlayStoreState {
  return state.settingsOverlay === null ? state : { ...state, settingsOverlay: null };
}

export function setSettingsTabInState(
  state: AppOverlayStoreState,
  tab: string | null,
): AppOverlayStoreState {
  if (state.settingsOverlay?.tab === tab) return state;
  return { ...state, settingsOverlay: { tab } };
}

export function setCommandPaletteOpenInState(
  state: AppOverlayStoreState,
  open: boolean,
): AppOverlayStoreState {
  return state.commandPaletteOpen === open ? state : { ...state, commandPaletteOpen: open };
}

export function openComposeInState(
  state: AppOverlayStoreState,
  seed: ComposeDialogSeed,
): AppOverlayStoreState {
  return state.composeSeed === seed ? state : { ...state, composeSeed: seed };
}

export function closeComposeInState(state: AppOverlayStoreState): AppOverlayStoreState {
  return state.composeSeed === null ? state : { ...state, composeSeed: null };
}

export function openNewDocumentDialogInState(
  state: AppOverlayStoreState,
  seed: NewDocumentDialogSeed | null = null,
): AppOverlayStoreState {
  return state.newDocument !== null && state.newDocument.seed === seed
    ? state
    : { ...state, newDocument: { seed } };
}

/** Closing clears the seed, matching the old onOpenChange(false) handler. */
export function closeNewDocumentDialogInState(state: AppOverlayStoreState): AppOverlayStoreState {
  return state.newDocument === null ? state : { ...state, newDocument: null };
}

/** Re-opening without an explicit visibility keeps the previous one, as the
 *  old boolean flip did. */
export function openAddWorkspaceDialogInState(
  state: AppOverlayStoreState,
  defaultVisibility?: WorkspaceVisibility,
): AppOverlayStoreState {
  const visibility = defaultVisibility ?? state.addWorkspace?.defaultVisibility ?? "private";
  if (state.addWorkspace?.defaultVisibility === visibility) return state;
  return { ...state, addWorkspace: { defaultVisibility: visibility } };
}

export function closeAddWorkspaceDialogInState(state: AppOverlayStoreState): AppOverlayStoreState {
  return state.addWorkspace === null ? state : { ...state, addWorkspace: null };
}

export function openCommitDialogInState(
  state: AppOverlayStoreState,
  path: string,
  status: GitStatus,
): AppOverlayStoreState {
  return state.commitDialog !== null &&
    state.commitDialog.path === path &&
    state.commitDialog.status === status
    ? state
    : { ...state, commitDialog: { path, status } };
}

export function closeCommitDialogInState(state: AppOverlayStoreState): AppOverlayStoreState {
  return state.commitDialog === null ? state : { ...state, commitDialog: null };
}

/** In-DOM overlays that cover the content area; the native sites webview
 *  cannot stack under DOM modals, so SitesPane hides it while any is open.
 *  The approval dialog lives outside this store — callers OR it in. */
export function sitesOverlayOpenInState(state: AppOverlayStoreState): boolean {
  return (
    state.commandPaletteOpen ||
    state.settingsOverlay !== null ||
    state.newDocument !== null ||
    state.addWorkspace !== null ||
    state.composeSeed !== null ||
    state.commitDialog !== null
  );
}

// ---------------------------------------------------------------------------
// Store: one module-level state object, replaced atomically by publish().
// ---------------------------------------------------------------------------

let appOverlayStoreState: AppOverlayStoreState = INITIAL_APP_OVERLAY_STORE_STATE;
const subscribers = new Set<() => void>();

function publish(next: AppOverlayStoreState): void {
  if (next === appOverlayStoreState) return;
  appOverlayStoreState = next;
  for (const subscriber of subscribers) subscriber();
}

/** Non-React read for orchestrators that need the current overlay state at
 *  call time (keyboard/menu toggles) instead of capturing render-scope
 *  values. */
export function getAppOverlayStoreState(): AppOverlayStoreState {
  return appOverlayStoreState;
}

export function openSettings(tab?: string | null): void {
  publish(openSettingsInState(appOverlayStoreState, tab));
}

export function closeSettings(): void {
  publish(closeSettingsInState(appOverlayStoreState));
}

export function setSettingsTab(tab: string | null): void {
  publish(setSettingsTabInState(appOverlayStoreState, tab));
}

export function openCommandPalette(): void {
  publish(setCommandPaletteOpenInState(appOverlayStoreState, true));
}

export function closeCommandPalette(): void {
  publish(setCommandPaletteOpenInState(appOverlayStoreState, false));
}

export function openCompose(seed: ComposeDialogSeed): void {
  publish(openComposeInState(appOverlayStoreState, seed));
}

export function closeCompose(): void {
  publish(closeComposeInState(appOverlayStoreState));
}

export function openNewDocumentDialog(seed?: NewDocumentDialogSeed | null): void {
  publish(openNewDocumentDialogInState(appOverlayStoreState, seed ?? null));
}

export function closeNewDocumentDialog(): void {
  publish(closeNewDocumentDialogInState(appOverlayStoreState));
}

export function openAddWorkspaceDialog(defaultVisibility?: WorkspaceVisibility): void {
  publish(openAddWorkspaceDialogInState(appOverlayStoreState, defaultVisibility));
}

export function closeAddWorkspaceDialog(): void {
  publish(closeAddWorkspaceDialogInState(appOverlayStoreState));
}

export function openCommitDialog(path: string, status: GitStatus): void {
  publish(openCommitDialogInState(appOverlayStoreState, path, status));
}

export function closeCommitDialog(): void {
  publish(closeCommitDialogInState(appOverlayStoreState));
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

export function useSettingsOverlay(): { tab: string | null } | null {
  return useSyncExternalStore(
    subscribe,
    () => appOverlayStoreState.settingsOverlay,
    () => appOverlayStoreState.settingsOverlay,
  );
}

export function useCommandPaletteOpen(): boolean {
  return useSyncExternalStore(
    subscribe,
    () => appOverlayStoreState.commandPaletteOpen,
    () => appOverlayStoreState.commandPaletteOpen,
  );
}

export function useComposeSeed(): ComposeDialogSeed | null {
  return useSyncExternalStore(
    subscribe,
    () => appOverlayStoreState.composeSeed,
    () => appOverlayStoreState.composeSeed,
  );
}

export function useNewDocumentDialog(): { seed: NewDocumentDialogSeed | null } | null {
  return useSyncExternalStore(
    subscribe,
    () => appOverlayStoreState.newDocument,
    () => appOverlayStoreState.newDocument,
  );
}

export function useAddWorkspaceDialog(): { defaultVisibility: WorkspaceVisibility } | null {
  return useSyncExternalStore(
    subscribe,
    () => appOverlayStoreState.addWorkspace,
    () => appOverlayStoreState.addWorkspace,
  );
}

export function useCommitDialog(): { path: string; status: GitStatus } | null {
  return useSyncExternalStore(
    subscribe,
    () => appOverlayStoreState.commitDialog,
    () => appOverlayStoreState.commitDialog,
  );
}

/** The sites-overlay OR across every dialog slice. The approval gate stays
 *  outside this store, so the caller passes its open flag in. */
export function useSitesOverlayOpen(approvalOpen: boolean): boolean {
  const storeOverlayOpen = useSyncExternalStore(
    subscribe,
    () => sitesOverlayOpenInState(appOverlayStoreState),
    () => sitesOverlayOpenInState(appOverlayStoreState),
  );
  return storeOverlayOpen || approvalOpen;
}
