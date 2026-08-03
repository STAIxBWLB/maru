// Invoke wrappers + event names for the native browser-tab child webviews.
// Each tab is its own webview floating above the DOM; it stays alive while
// hidden so per-tab page state survives switching. The React side only reports
// bounds and show/hide intent. Module-level runtime state mirrors the native
// lifecycle so the pane survives StrictMode double-mounts and mode switches
// without re-creating webviews.

import { invoke } from "@tauri-apps/api/core";
import type { SiteViewBounds } from "./sites";

declare global {
  interface Window {
    __TAURI_INTERNALS__?: unknown;
  }
}

const isTauri = () =>
  typeof window !== "undefined" && Boolean(window.__TAURI_INTERNALS__);

// Event names emitted by Rust to the main webview. These constants are the
// only place the strings live on the frontend — keep in sync with the Rust
// site_view module. (Naming follows the existing `catalog://refresh`
// precedent.)
export const SITE_VIEW_NAVIGATED_EVENT = "sites://navigated";
export const SITE_VIEW_PAGE_LOAD_EVENT = "sites://page-load";
export const SITE_VIEW_TITLE_EVENT = "sites://title-changed";
export const SITE_VIEW_OPEN_REQUESTED_EVENT = "sites://open-requested";
export const SITE_VIEW_CLOSE_ACTIVE_REQUEST_EVENT = "maru:sites:close-active";

export function requestSiteViewCloseActive(): void {
  window.dispatchEvent(new Event(SITE_VIEW_CLOSE_ACTIVE_REQUEST_EVENT));
}

export interface SiteViewNavigatedPayload {
  tabId: string;
  url: string;
}

export interface SiteViewPageLoadPayload {
  tabId: string;
  url: string;
  state: "started" | "finished";
}

export interface SiteViewTitlePayload {
  tabId: string;
  title: string;
}

interface SiteViewTabState {
  shown: boolean;
  url: string | null;
}

const tabs = new Map<string, SiteViewTabState>();

export function siteViewTabRuntime(tabId: string): Readonly<SiteViewTabState> | null {
  return tabs.get(tabId) ?? null;
}

export function siteViewOpenTabIds(): string[] {
  return [...tabs.keys()];
}

export async function siteViewOpen(
  tabId: string,
  url: string,
  bounds: SiteViewBounds,
): Promise<void> {
  if (!isTauri()) return;
  await invoke("site_view_open", { tabId, url, ...bounds });
  // Rust shows the opened tab and the caller activates it next, so every other
  // tab is about to be hidden.
  for (const state of tabs.values()) state.shown = false;
  tabs.set(tabId, { shown: true, url });
}

export async function siteViewNavigate(tabId: string, url: string): Promise<void> {
  if (!isTauri()) return;
  const state = tabs.get(tabId);
  if (!state) return;
  await invoke("site_view_navigate", { tabId, url });
  state.url = url;
}

export async function siteViewSetBounds(
  tabId: string,
  bounds: SiteViewBounds,
): Promise<void> {
  if (!isTauri() || !tabs.has(tabId)) return;
  await invoke("site_view_set_bounds", { tabId, ...bounds });
}

/** Shows one tab and hides the others. No-ops when already shown, so callers
 *  can invoke freely from rAF batches. */
export async function siteViewShow(tabId: string): Promise<void> {
  if (!isTauri()) return;
  const state = tabs.get(tabId);
  if (!state || state.shown) return;
  state.shown = true; // optimistic; reverted on failure
  try {
    await invoke("site_view_show", { tabId });
    for (const [id, other] of tabs) {
      if (id !== tabId) other.shown = false;
    }
  } catch (err) {
    state.shown = false;
    throw err;
  }
}

/** Hides every tab — used when the browser surface itself goes away. */
export async function siteViewHide(): Promise<void> {
  if (!isTauri()) return;
  const shown = [...tabs.values()].filter((state) => state.shown);
  if (shown.length === 0) return;
  for (const state of shown) state.shown = false;
  try {
    await invoke("site_view_hide");
  } catch (err) {
    for (const state of shown) state.shown = true;
    throw err;
  }
}

export async function siteViewClose(tabId: string): Promise<void> {
  if (!isTauri()) return;
  if (!tabs.delete(tabId)) return;
  await invoke("site_view_close", { tabId });
}

export async function siteViewCloseAll(): Promise<void> {
  if (!isTauri()) return;
  if (tabs.size === 0) return;
  tabs.clear();
  await invoke("site_view_close_all");
}

export async function siteViewReload(tabId: string): Promise<void> {
  if (!isTauri() || !tabs.has(tabId)) return;
  await invoke("site_view_reload", { tabId });
}

export async function siteViewBack(tabId: string): Promise<void> {
  if (!isTauri() || !tabs.has(tabId)) return;
  await invoke("site_view_back", { tabId });
}

export async function siteViewForward(tabId: string): Promise<void> {
  if (!isTauri() || !tabs.has(tabId)) return;
  await invoke("site_view_forward", { tabId });
}

export async function siteViewOpenExternal(url: string): Promise<void> {
  if (!isTauri()) {
    window.open(url, "_blank", "noopener,noreferrer");
    return;
  }
  await invoke("site_view_open_external", { url });
}

/** Opens specifically in Safari so a Maru build registered for HTTP/HTTPS
 *  cannot recursively route its own fallback back into Maru. */
export async function siteViewOpenSafari(url: string): Promise<void> {
  if (!isTauri()) {
    window.open(url, "_blank", "noopener,noreferrer");
    return;
  }
  await invoke("site_view_open_safari", { url });
}

export async function siteViewTakeOpenedUrls(): Promise<string[]> {
  if (!isTauri()) return [];
  return invoke<string[]>("site_view_take_opened_urls");
}

export function sanitizeSiteViewOpenedUrls(urls: unknown): string[] {
  if (!Array.isArray(urls)) return [];
  return urls.filter((value): value is string => {
    if (typeof value !== "string") return false;
    try {
      const url = new URL(value);
      return url.protocol === "http:" || url.protocol === "https:";
    } catch {
      return false;
    }
  });
}

export interface SiteViewOpenRequest {
  id: number;
  url: string;
}

/** Assigns frontend-lifetime identities after validation. Equal URLs remain
 *  separate requests, which preserves two deliberate OS opens while letting
 *  React effects acknowledge each delivery exactly once. */
export function buildSiteViewOpenRequests(
  urls: unknown,
  previousId: number,
): { requests: SiteViewOpenRequest[]; nextId: number } {
  let nextId = previousId;
  const requests = sanitizeSiteViewOpenedUrls(urls).map((url) => ({
    id: ++nextId,
    url,
  }));
  return { requests, nextId };
}

/** Selects only unseen requests that currently fit. Requests beyond the cap
 *  remain unacknowledged so closing a tab makes them eligible on the next
 *  effect pass. */
export function nextSiteViewOpenRequests(
  requests: readonly SiteViewOpenRequest[],
  handledIds: ReadonlySet<number>,
  availableSlots: number,
): SiteViewOpenRequest[] {
  if (availableSlots <= 0) return [];
  return requests
    .filter((request) => !handledIds.has(request.id))
    .slice(0, availableSlots);
}

const openedUrlSubscribers = new Set<(urls: string[]) => void>();
let openedUrlBacklog: string[] = [];
const MAX_OPENED_URL_BACKLOG = 64;

function deliverOpenedUrls(value: unknown): void {
  const urls = sanitizeSiteViewOpenedUrls(value);
  if (urls.length === 0) return;
  if (openedUrlSubscribers.size === 0) {
    openedUrlBacklog = [...openedUrlBacklog, ...urls].slice(-MAX_OPENED_URL_BACKLOG);
    return;
  }
  for (const subscriber of openedUrlSubscribers) subscriber(urls);
}

/** Subscribe to native open notifications and return an immediately usable
 *  cleanup. The event is only a wake-up; after the native listener is ready,
 *  this drains both the cold-start queue and every later event atomically. */
export function subscribeSiteViewOpenRequests(
  handler: (urls: string[]) => void,
): () => void {
  if (!isTauri()) return () => {};
  openedUrlSubscribers.add(handler);
  if (openedUrlBacklog.length > 0) {
    const backlog = openedUrlBacklog;
    openedUrlBacklog = [];
    handler(backlog);
  }
  let disposed = false;
  let draining: Promise<void> | null = null;
  let drainAgain = false;
  let unlisten: (() => void) | null = null;

  const drain = () => {
    if (disposed) return;
    if (draining) {
      drainAgain = true;
      return;
    }
    draining = siteViewTakeOpenedUrls()
      // The native command atomically removes these URLs. If this subscription
      // unmounts while the command is in flight, hand the result to the current
      // subscriber (or retain it for the next one) instead of losing the opens.
      .then(deliverOpenedUrls)
      .catch((err) => {
        if (!disposed) console.info("[maru] opened URL queue unavailable:", err);
      })
      .finally(() => {
        draining = null;
        if (!disposed && drainAgain) {
          drainAgain = false;
          drain();
        }
      });
  };

  void (async () => {
    const { listen } = await import("@tauri-apps/api/event");
    const off = await listen<unknown>(SITE_VIEW_OPEN_REQUESTED_EVENT, drain);
    if (disposed) {
      off();
      return;
    }
    unlisten = off;
    // Listener first, cold queue second: no launch/open event can be stranded.
    drain();
  })().catch((err) => {
    if (!disposed) console.info("[maru] opened URL listener unavailable:", err);
  });

  return () => {
    disposed = true;
    openedUrlSubscribers.delete(handler);
    unlisten?.();
  };
}

export interface SiteViewEventHandlers {
  onNavigated?: (payload: SiteViewNavigatedPayload) => void;
  onPageLoad?: (payload: SiteViewPageLoadPayload) => void;
  onTitleChanged?: (payload: SiteViewTitlePayload) => void;
}

/** Subscribe to the Rust navigation events. Returns a synchronous
 *  unsubscribe that is safe to call before the async listeners resolve
 *  (mirrors the listenForMenuCommand pattern in App.tsx). */
export function subscribeSiteViewEvents(handlers: SiteViewEventHandlers): () => void {
  if (!isTauri()) return () => {};
  let disposed = false;
  const unlisteners: Array<() => void> = [];
  void (async () => {
    const { listen } = await import("@tauri-apps/api/event");
    const offNavigated = await listen<SiteViewNavigatedPayload>(
      SITE_VIEW_NAVIGATED_EVENT,
      (event) => {
        const state = tabs.get(event.payload.tabId);
        if (state) state.url = event.payload.url;
        handlers.onNavigated?.(event.payload);
      },
    );
    const offPageLoad = await listen<SiteViewPageLoadPayload>(
      SITE_VIEW_PAGE_LOAD_EVENT,
      (event) => {
        handlers.onPageLoad?.(event.payload);
      },
    );
    const offTitle = await listen<SiteViewTitlePayload>(
      SITE_VIEW_TITLE_EVENT,
      (event) => {
        handlers.onTitleChanged?.(event.payload);
      },
    );
    if (disposed) {
      offNavigated();
      offPageLoad();
      offTitle();
      return;
    }
    unlisteners.push(offNavigated, offPageLoad, offTitle);
  })().catch((err) => {
    console.info("[maru] site view listeners unavailable:", err);
  });
  return () => {
    disposed = true;
    for (const off of unlisteners.splice(0)) off();
  };
}
