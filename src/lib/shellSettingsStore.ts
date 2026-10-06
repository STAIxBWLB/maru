import { useSyncExternalStore } from "react";

import {
  DEFAULT_MARU_SETTINGS,
  normalizeMaruSettings,
  type MaruSettings,
} from "./settings";

type SettingsUpdater = MaruSettings | ((current: MaruSettings) => MaruSettings);
type Subscriber = () => void;

export interface ShellSettingsOrigin { readonly actorId: string; readonly revision: number }
export type GuardedShellSettingsPath = "ui.activeAppMode" | `ui.layout.${string}`;
interface PendingIntent { revision: number; value: unknown; base: unknown }
let actorId = globalThis.crypto?.randomUUID?.() ?? `shell-${Date.now()}-${Math.random()}`;
let localRevision = 0;
const pendingIntents = new Map<string, PendingIntent>();
const lastLocalChanges = new Map<string, number>();
let saveOrigins = new WeakMap<MaruSettings, ShellSettingsOrigin>();
let saveBases = new WeakMap<MaruSettings, ReadonlyMap<string, unknown>>();
let readOrigins = new WeakMap<MaruSettings, ShellSettingsOrigin>();

export function captureShellSettingsRevision(): ShellSettingsOrigin {
  return Object.freeze({ actorId, revision: localRevision });
}
export function isOwnShellSettingsOrigin(origin: ShellSettingsOrigin | undefined): boolean {
  return origin?.actorId === actorId;
}
export function bindShellSettingsRead(value: MaruSettings, origin: ShellSettingsOrigin): MaruSettings {
  readOrigins.set(value, origin);
  return value;
}
export function getShellSettingsSaveOrigin(value: MaruSettings): ShellSettingsOrigin | undefined {
  return saveOrigins.get(value);
}
/** Keep the invocation-time read fence when an event crosses IPC/JSON and
 * therefore cannot retain the snapshot's private WeakMap identity. */
export function getShellSettingsReadOrigin(value: MaruSettings): ShellSettingsOrigin | undefined {
  return readOrigins.get(value);
}
export function getPendingShellSettingsRevision(): number {
  return Math.max(0, ...Array.from(pendingIntents.values(), (intent) => intent.revision));
}
export function hasPendingShellSettingsIntent(path: GuardedShellSettingsPath): boolean {
  return pendingIntents.has(path);
}

function guardedLeaves(value: MaruSettings): Map<string, unknown> {
  const leaves = new Map<string, unknown>([["ui.activeAppMode", value.ui.activeAppMode]]);
  const walk = (entry: unknown, prefix: string) => {
    if (entry && typeof entry === "object" && !Array.isArray(entry)) {
      for (const [key, child] of Object.entries(entry)) walk(child, `${prefix}.${key}`);
    } else leaves.set(prefix, entry);
  };
  walk(value.ui.layout, "ui.layout");
  return leaves;
}
function readPath(value: MaruSettings, path: string): unknown {
  let entry: unknown = value;
  for (const key of path.split(".")) {
    if (!entry || typeof entry !== "object") return undefined;
    entry = (entry as Record<string, unknown>)[key];
  }
  return entry;
}
function writePath(value: MaruSettings, path: string, replacement: unknown): void {
  const keys = path.split(".");
  let entry = value as unknown as Record<string, unknown>;
  for (const key of keys.slice(0, -1)) {
    const child = entry[key];
    entry[key] = child && typeof child === "object" && !Array.isArray(child) ? { ...child } : {};
    entry = entry[key] as Record<string, unknown>;
  }
  if (replacement === undefined) delete entry[keys[keys.length - 1]];
  else entry[keys[keys.length - 1]] = replacement;
}

/** Retrying/coalescing an unrelated change must still include unsaved intent
 * in the backend's changed-leaf patch rather than using its UI value as base. */
export function shellSettingsSaveBase(base: MaruSettings, snapshot?: MaruSettings): MaruSettings {
  const result = { ...base };
  const captured = snapshot ? saveBases.get(snapshot) : undefined;
  if (captured) for (const [path, value] of captured) writePath(result, path, value);
  else if (!snapshot) for (const [path, intent] of pendingIntents) writePath(result, path, intent.base);
  return result;
}

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
export function updateShellSettings(updater: SettingsUpdater, explicitIntent: readonly GuardedShellSettingsPath[] = []): MaruSettings {
  const before = guardedLeaves(settings);
  const next = normalizeMaruSettings(typeof updater === "function" ? updater(settings) : updater);
  const after = guardedLeaves(next);
  localRevision += 1;
  for (const [path, value] of after) {
    if (Object.is(before.get(path), value) && !explicitIntent.some((prefix) => path === prefix || path.startsWith(`${prefix}.`))) continue;
    // A null/object transition supersedes older parent/child leaf intents.
    for (const key of lastLocalChanges.keys()) {
      if (key !== path && (key.startsWith(`${path}.`) || path.startsWith(`${key}.`))) {
        lastLocalChanges.delete(key); pendingIntents.delete(key);
      }
    }
    lastLocalChanges.set(path, localRevision);
    const previousPending = pendingIntents.get(path);
    const priorValue = before.has(path) ? before.get(path) : readPath(settings, path);
    const base = Object.is(priorValue, value) && previousPending ? previousPending.base : priorValue;
    pendingIntents.set(path, { revision: localRevision, value, base });
  }
  saveOrigins.set(next, captureShellSettingsRevision());
  saveBases.set(next, new Map<string, unknown>(Array.from(pendingIntents, ([path, intent]) => [path, intent.base] as const)));
  return publish(next);
}

/** Whole-blob incoming state cannot acknowledge a local choice merely by
 * matching its value. Only this actor's revision-bound, read-back save can. */
export function applyIncomingShellSettings(incoming: MaruSettings, saveOrigin?: ShellSettingsOrigin, readStartedAt?: ShellSettingsOrigin): MaruSettings {
  const readOrigin = readStartedAt ?? readOrigins.get(incoming);
  const cuts = [saveOrigin, readOrigin].filter((origin): origin is ShellSettingsOrigin => origin?.actorId === actorId).map((origin) => origin.revision);
  const cutoff = cuts.length ? Math.min(...cuts) : undefined;
  const next = normalizeMaruSettings(incoming);
  for (const [path, revision] of lastLocalChanges) {
    let pending = pendingIntents.get(path);
    let effectiveRevision = revision;
    const persistedValue = readPath(next, path);
    // Explicitly selecting an unchanged UI default before hydration can
    // leave a guessed base equal to the desired value. Learn a different
    // actual disk baseline once, so the next authorized snapshot writes a
    // changed leaf. Old queued snapshots keep their immutable stamp/base.
    if (pending && (readOrigin || saveOrigin) && Object.is(pending.base, pending.value) && !Object.is(persistedValue, pending.value)) {
      localRevision += 1;
      effectiveRevision = localRevision;
      pending = { ...pending, revision: effectiveRevision, base: persistedValue };
      pendingIntents.set(path, pending);
      lastLocalChanges.set(path, effectiveRevision);
    }
    if (pending && saveOrigin?.actorId === actorId && saveOrigin.revision >= pending.revision && Object.is(readPath(next, path), pending.value)) {
      pendingIntents.delete(path);
    }
    if (pendingIntents.has(path) || (cutoff !== undefined && effectiveRevision > cutoff)) {
      const remaining = pendingIntents.get(path);
      writePath(next, path, remaining ? remaining.value : readPath(settings, path));
    }
  }
  return publish(normalizeMaruSettings(next));
}

/** Applies hydration only when the caller's workspace-load generation remains current. */
export function hydrateShellSettings(
  incoming: MaruSettings,
  requestId: number,
  currentRequestId: number,
  readStartedAt?: ShellSettingsOrigin,
): boolean {
  if (requestId !== currentRequestId) return false;
  applyIncomingShellSettings(incoming, undefined, readStartedAt);
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
  actorId = globalThis.crypto?.randomUUID?.() ?? `shell-${Date.now()}-${Math.random()}`;
  localRevision = 0;
  pendingIntents.clear(); lastLocalChanges.clear();
  saveOrigins = new WeakMap(); saveBases = new WeakMap(); readOrigins = new WeakMap();
  settings = normalizeMaruSettings(DEFAULT_MARU_SETTINGS);
  slices = createSlices(settings);
  notify(subscribers);
  for (const set of domainSubscribers.values()) notify(set);
}
