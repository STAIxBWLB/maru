import { useSyncExternalStore } from "react";
import type { TerminalDock, TerminalTheme, ToolPanelSurface } from "./settings";
import {
  EMPTY_TERMINAL_STATE,
  loadPersistedTerminalState,
  terminalTabsReducer,
  type ActiveTerminalContext,
  type TerminalTabsAction,
  type TerminalTabsState,
} from "./terminal";
import type { TerminalLaunchRequest } from "../components/TerminalPanel";

/** The only shell context that changes where a new terminal is launched. */
export interface TerminalPanelScope {
  cwd: string | null;
}

export interface TerminalPanelLayout {
  open: boolean;
  height: number;
  dock: TerminalDock;
  width: number;
  splitOpen: boolean;
  splitRatio: number;
  maximized: boolean;
  activeSurface: ToolPanelSurface;
  terminalTheme: TerminalTheme;
  graphTheme: "dark" | "light" | "app";
}

export interface TerminalPanelState {
  tabs: TerminalTabsState;
  layout: TerminalPanelLayout;
  activeContext: ActiveTerminalContext;
  request: TerminalLaunchRequest | null;
  error: string | null;
}

export interface TerminalPanelStoreSnapshot extends TerminalPanelState {}

const EMPTY_CONTEXT: ActiveTerminalContext = {
  workspaceRoot: null,
  scratchpadRoot: null,
  workspaceVisibility: "private",
  appMode: "pkm",
  docAbsPath: null,
  docRelPath: null,
  docTitle: null,
  docType: null,
};

const EMPTY_LAYOUT: TerminalPanelLayout = {
  open: false,
  height: 320,
  dock: "bottom",
  width: 640,
  splitOpen: false,
  splitRatio: 0.5,
  maximized: false,
  activeSurface: "terminal",
  terminalTheme: "dark",
  graphTheme: "app",
};

const EMPTY_STATE: TerminalPanelState = {
  tabs: loadPersistedTerminalState(),
  layout: EMPTY_LAYOUT,
  activeContext: EMPTY_CONTEXT,
  request: null,
  error: null,
};

let state = EMPTY_STATE;
let snapshot: TerminalPanelStoreSnapshot = state;
const subscribers = new Set<() => void>();

function publish(next: TerminalPanelState): void {
  if (next === state) return;
  state = next;
  snapshot = state;
  for (const subscriber of subscribers) subscriber();
}

function update(updater: (current: TerminalPanelState) => TerminalPanelState): void {
  publish(updater(state));
}

export function getTerminalPanelState(): TerminalPanelState {
  return state;
}

export function getTerminalPanelStoreSnapshot(): TerminalPanelStoreSnapshot {
  return snapshot;
}

export function subscribeTerminalPanelStore(subscriber: () => void): () => void {
  subscribers.add(subscriber);
  return () => subscribers.delete(subscriber);
}

function useTerminalPanelSlice<T>(selector: (current: TerminalPanelStoreSnapshot) => T): T {
  return useSyncExternalStore(subscribeTerminalPanelStore, () => selector(snapshot), () => selector(snapshot));
}

export function useTerminalTabsSlice(): TerminalTabsState {
  return useTerminalPanelSlice((current) => current.tabs);
}

export function useTerminalLayoutSlice(): TerminalPanelLayout {
  return useTerminalPanelSlice((current) => current.layout);
}

export function useTerminalActiveContextSlice(): ActiveTerminalContext {
  return useTerminalPanelSlice((current) => current.activeContext);
}

export function useTerminalRequestSlice(): TerminalLaunchRequest | null {
  return useTerminalPanelSlice((current) => current.request);
}

export function useTerminalErrorSlice(): string | null {
  return useTerminalPanelSlice((current) => current.error);
}

export function dispatchTerminalPanelTabs(action: TerminalTabsAction): void {
  update((current) => {
    const tabs = terminalTabsReducer(current.tabs, action);
    return tabs === current.tabs ? current : { ...current, tabs };
  });
}

export function setTerminalPanelLayout(patch: Partial<TerminalPanelLayout>): void {
  update((current) => {
    const layout = { ...current.layout, ...patch };
    return Object.keys(patch).every(
      (key) => layout[key as keyof TerminalPanelLayout] === current.layout[key as keyof TerminalPanelLayout],
    )
      ? current
      : { ...current, layout };
  });
}

export function setTerminalPanelActiveContext(activeContext: ActiveTerminalContext): void {
  update((current) => (current.activeContext === activeContext ? current : { ...current, activeContext }));
}

export function setTerminalPanelRequest(request: TerminalLaunchRequest | null): void {
  update((current) => (current.request === request ? current : { ...current, request }));
}

export function setTerminalPanelError(error: string | null): void {
  update((current) => (current.error === error ? current : { ...current, error }));
}

export function resetTerminalPanelStore(): void {
  publish({ ...EMPTY_STATE, tabs: EMPTY_TERMINAL_STATE });
}
