// Invoke wrappers + event names for the native "sites-embed" child webview.
// The webview floats above the DOM and stays alive while hidden; the React
// side only reports bounds and show/hide intent. Module-level runtime state
// mirrors the native lifecycle so the pane survives StrictMode double-mounts
// and mode switches without re-creating the webview.

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

export interface SiteViewNavigatedPayload {
  url: string;
}

export interface SiteViewPageLoadPayload {
  url: string;
  state: "started" | "finished";
}

export interface SiteViewTitlePayload {
  title: string;
}

interface SiteViewRuntimeState {
  opened: boolean;
  shown: boolean;
  url: string | null;
}

const state: SiteViewRuntimeState = { opened: false, shown: false, url: null };

export function siteViewRuntime(): Readonly<SiteViewRuntimeState> {
  return state;
}

export async function siteViewOpen(url: string, bounds: SiteViewBounds): Promise<void> {
  if (!isTauri()) return;
  await invoke("site_view_open", { url, ...bounds });
  state.opened = true;
  state.shown = true;
  state.url = url;
}

export async function siteViewNavigate(url: string): Promise<void> {
  if (!isTauri() || !state.opened) return;
  await invoke("site_view_navigate", { url });
  state.url = url;
}

export async function siteViewSetBounds(bounds: SiteViewBounds): Promise<void> {
  if (!isTauri() || !state.opened) return;
  await invoke("site_view_set_bounds", { ...bounds });
}

/** No-ops when already shown — callers can invoke freely from rAF batches. */
export async function siteViewShow(): Promise<void> {
  if (!isTauri() || !state.opened || state.shown) return;
  state.shown = true; // optimistic; reverted on failure
  try {
    await invoke("site_view_show");
  } catch (err) {
    state.shown = false;
    throw err;
  }
}

export async function siteViewHide(): Promise<void> {
  if (!isTauri() || !state.opened || !state.shown) return;
  state.shown = false;
  try {
    await invoke("site_view_hide");
  } catch (err) {
    state.shown = true;
    throw err;
  }
}

export async function siteViewClose(): Promise<void> {
  if (!isTauri() || !state.opened) return;
  state.opened = false;
  state.shown = false;
  state.url = null;
  await invoke("site_view_close");
}

export async function siteViewReload(): Promise<void> {
  if (!isTauri() || !state.opened) return;
  await invoke("site_view_reload");
}

export async function siteViewBack(): Promise<void> {
  if (!isTauri() || !state.opened) return;
  await invoke("site_view_back");
}

export async function siteViewForward(): Promise<void> {
  if (!isTauri() || !state.opened) return;
  await invoke("site_view_forward");
}

export async function siteViewOpenExternal(url: string): Promise<void> {
  if (!isTauri()) {
    window.open(url, "_blank", "noopener,noreferrer");
    return;
  }
  await invoke("site_view_open_external", { url });
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
        state.url = event.payload.url;
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
    console.info("[anchor] site view listeners unavailable:", err);
  });
  return () => {
    disposed = true;
    for (const off of unlisteners.splice(0)) off();
  };
}
