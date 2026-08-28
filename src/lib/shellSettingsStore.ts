import { useSyncExternalStore } from "react";

import {
  DEFAULT_MARU_SETTINGS,
  normalizeMaruSettings,
  type MaruSettings,
} from "./settings";

type SettingsUpdater = MaruSettings | ((current: MaruSettings) => MaruSettings);
type Subscriber = () => void;

export interface ShellLayoutSlice {
  layout: MaruSettings["ui"]["layout"];
  themeMode: MaruSettings["ui"]["themeMode"];
  rightWorkbenchSurface: MaruSettings["ui"]["rightWorkbenchSurface"];
}

export interface ShellDocumentBrowserSlice {
  documentBrowserMode: MaruSettings["ui"]["documentBrowserMode"];
  documentSortKey: MaruSettings["ui"]["documentSortKey"];
  documentViews: MaruSettings["ui"]["documentViews"];
  favorites: MaruSettings["ui"]["favorites"];
}

export interface ShellTerminalGraphSlice {
  terminal: MaruSettings["terminal"];
  graph: MaruSettings["graph"];
}

interface ShellSettingsSlices {
  layout: ShellLayoutSlice;
  documentBrowser: ShellDocumentBrowserSlice;
  terminalGraph: ShellTerminalGraphSlice;
  ai: MaruSettings["ai"];
  composer: MaruSettings["composer"];
  meetings: MaruSettings["meetings"];
  tasks: MaruSettings["tasks"];
}

const subscribers = new Set<Subscriber>();
const domainSubscribers = new Map<keyof ShellSettingsSlices, Set<Subscriber>>();
let settings = normalizeMaruSettings(DEFAULT_MARU_SETTINGS);
let slices = createSlices(settings);

function equalRecord(left: Record<string, unknown>, right: Record<string, unknown>): boolean {
  const leftKeys = Object.keys(left);
  return leftKeys.length === Object.keys(right).length && leftKeys.every((key) => left[key] === right[key]);
}

function reuseSlice<T extends Record<string, unknown>>(previous: T, next: T): T {
  return equalRecord(previous, next) ? previous : next;
}

function createSlices(next: MaruSettings, previous?: ShellSettingsSlices): ShellSettingsSlices {
  const layout = {
    layout: next.ui.layout,
    themeMode: next.ui.themeMode,
    rightWorkbenchSurface: next.ui.rightWorkbenchSurface,
  };
  const documentBrowser = {
    documentBrowserMode: next.ui.documentBrowserMode,
    documentSortKey: next.ui.documentSortKey,
    documentViews: next.ui.documentViews,
    favorites: next.ui.favorites,
  };
  const terminalGraph = { terminal: next.terminal, graph: next.graph };
  return {
    layout: previous ? reuseSlice(previous.layout, layout) : layout,
    documentBrowser: previous ? reuseSlice(previous.documentBrowser, documentBrowser) : documentBrowser,
    terminalGraph: previous ? reuseSlice(previous.terminalGraph, terminalGraph) : terminalGraph,
    ai: next.ai,
    composer: next.composer,
    meetings: next.meetings,
    tasks: next.tasks,
  };
}

function notify(set: Set<Subscriber> | undefined): void {
  for (const subscriber of set ?? []) subscriber();
}

function publish(next: MaruSettings): MaruSettings {
  if (next === settings) return settings;
  const previousSlices = slices;
  settings = next;
  slices = createSlices(next, previousSlices);
  notify(subscribers);
  for (const domain of Object.keys(slices) as (keyof ShellSettingsSlices)[]) {
    if (slices[domain] !== previousSlices[domain]) notify(domainSubscribers.get(domain));
  }
  return settings;
}

function subscribe(subscriber: Subscriber): () => void {
  subscribers.add(subscriber);
  return () => subscribers.delete(subscriber);
}

function subscribeDomain(domain: keyof ShellSettingsSlices, subscriber: Subscriber): () => void {
  let domainSet = domainSubscribers.get(domain);
  if (!domainSet) {
    domainSet = new Set();
    domainSubscribers.set(domain, domainSet);
  }
  domainSet.add(subscriber);
  return () => {
    domainSet?.delete(subscriber);
    if (domainSet?.size === 0) domainSubscribers.delete(domain);
  };
}

/** Canonical normalized settings snapshot for the shell and lazy mode adapters. */
export function getShellSettings(): MaruSettings {
  return settings;
}

/** Applies an existing-key settings update without introducing a second owner in MainApp. */
export function updateShellSettings(updater: SettingsUpdater): MaruSettings {
  return publish(normalizeMaruSettings(typeof updater === "function" ? updater(settings) : updater));
}

/** Applies hydration only when the caller's workspace-load generation remains current. */
export function hydrateShellSettings(
  incoming: MaruSettings,
  requestId: number,
  currentRequestId: number,
): boolean {
  if (requestId !== currentRequestId) return false;
  publish(normalizeMaruSettings(incoming));
  return true;
}

export function useShellSettings(): MaruSettings {
  return useSyncExternalStore(subscribe, getShellSettings, getShellSettings);
}

export function useShellLayoutSlice(): ShellLayoutSlice {
  return useSyncExternalStore(
    (subscriber) => subscribeDomain("layout", subscriber),
    () => slices.layout,
    () => slices.layout,
  );
}

export function useShellDocumentBrowserSlice(): ShellDocumentBrowserSlice {
  return useSyncExternalStore(
    (subscriber) => subscribeDomain("documentBrowser", subscriber),
    () => slices.documentBrowser,
    () => slices.documentBrowser,
  );
}

export function useShellTerminalGraphSlice(): ShellTerminalGraphSlice {
  return useSyncExternalStore(
    (subscriber) => subscribeDomain("terminalGraph", subscriber),
    () => slices.terminalGraph,
    () => slices.terminalGraph,
  );
}

export function useShellAiSlice(): MaruSettings["ai"] {
  return useSyncExternalStore((subscriber) => subscribeDomain("ai", subscriber), () => slices.ai, () => slices.ai);
}

export function useShellComposerSlice(): MaruSettings["composer"] {
  return useSyncExternalStore((subscriber) => subscribeDomain("composer", subscriber), () => slices.composer, () => slices.composer);
}

export function useShellMeetingsSlice(): MaruSettings["meetings"] {
  return useSyncExternalStore((subscriber) => subscribeDomain("meetings", subscriber), () => slices.meetings, () => slices.meetings);
}

export function useShellTasksSlice(): MaruSettings["tasks"] {
  return useSyncExternalStore((subscriber) => subscribeDomain("tasks", subscriber), () => slices.tasks, () => slices.tasks);
}

/** Test-only reset. Production hydration always uses the request-generation guard. */
export function resetShellSettingsStoreForTests(): void {
  settings = normalizeMaruSettings(DEFAULT_MARU_SETTINGS);
  slices = createSlices(settings);
  notify(subscribers);
  for (const set of domainSubscribers.values()) notify(set);
}
