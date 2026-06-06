export interface StartupProfileMark {
  name: string;
  at: number;
  detail?: unknown;
}

export interface StartupProfileMeasure {
  name: string;
  start: number;
  end: number;
  duration: number;
  detail?: unknown;
}

export interface AnchorStartupProfile {
  enabled: boolean;
  marks: StartupProfileMark[];
  measures: StartupProfileMeasure[];
}

declare global {
  interface Window {
    __ANCHOR_STARTUP_PROFILE__?: AnchorStartupProfile;
  }
}

const STARTUP_PROFILE_KEY = "anchor:startup:profile";

interface OptionalIdleCallbacks {
  requestIdleCallback?: (callback: () => void, options?: { timeout?: number }) => number;
  cancelIdleCallback?: (handle: number) => void;
}

function now(): number {
  return globalThis.performance?.now?.() ?? Date.now();
}

export function startupProfileEnabled(): boolean {
  if (typeof window === "undefined") return false;
  try {
    const params = new URLSearchParams(window.location.search);
    if (params.get("startupProfile") === "1") return true;
    return window.localStorage.getItem(STARTUP_PROFILE_KEY) === "1";
  } catch {
    return false;
  }
}

function profile(): AnchorStartupProfile | null {
  if (!startupProfileEnabled()) return null;
  if (!window.__ANCHOR_STARTUP_PROFILE__) {
    window.__ANCHOR_STARTUP_PROFILE__ = {
      enabled: true,
      marks: [],
      measures: [],
    };
  }
  return window.__ANCHOR_STARTUP_PROFILE__;
}

export function markStartup(name: string, detail?: unknown): void {
  const target = profile();
  if (!target) return;
  const entry = { name, at: now(), detail };
  target.marks.push(entry);
  console.debug("[anchor-startup]", name, entry);
}

export async function measureStartup<T>(
  name: string,
  work: () => Promise<T>,
  detail?: unknown,
): Promise<T> {
  const target = profile();
  if (!target) return work();
  const start = now();
  markStartup(`${name}:start`, detail);
  try {
    return await work();
  } finally {
    const end = now();
    const entry = { name, start, end, duration: end - start, detail };
    target.measures.push(entry);
    markStartup(`${name}:end`, { ...entry, detail });
  }
}

export function scheduleStartupIdle(work: () => void, timeout = 1500): () => void {
  if (typeof window === "undefined") return () => {};
  const idleWindow = window as Window & OptionalIdleCallbacks;
  if (idleWindow.requestIdleCallback && idleWindow.cancelIdleCallback) {
    const handle = idleWindow.requestIdleCallback(work, { timeout });
    return () => idleWindow.cancelIdleCallback?.(handle);
  }
  const handle = window.setTimeout(work, timeout);
  return () => window.clearTimeout(handle);
}
