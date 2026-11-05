// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { SiteEntry } from "../../lib/sites";

const mocks = vi.hoisted(() => ({
  invoke: vi.fn(), readSites: vi.fn(), clipboard: vi.fn(), setError: vi.fn(),
  listeners: new Map<string, (event: { payload: unknown }) => void>(),
  deferOpenUnsubscribe: false,
  deferredOpenUnsubscribes: [] as Array<() => void>,
  settledDeliveries: 0,
}));
vi.mock("@tauri-apps/api/core", () => ({ invoke: mocks.invoke }));
vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn(async (name: string, handler: (event: { payload: unknown }) => void) => {
  mocks.listeners.set(name, handler);
  return () => { if (mocks.listeners.get(name) === handler) mocks.listeners.delete(name); };
}) }));
vi.mock("../../lib/siteView", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../lib/siteView")>();
  return {
    ...actual,
    subscribeSiteViewOpenSettled: (handler: (tabId: string) => void) => {
      const off = actual.subscribeSiteViewOpenSettled((tabId) => {
        mocks.settledDeliveries += 1;
        handler(tabId);
      });
      return () => {
        // Deterministically retain the passive subscription past unmount
        // commit while the real SitesPane layout cleanup has already run.
        if (mocks.deferOpenUnsubscribe) mocks.deferredOpenUnsubscribes.push(off);
        else off();
      };
    },
  };
});
vi.mock("../../lib/errorStore", () => ({ setError: mocks.setError }));
vi.mock("../../lib/maruDir", () => ({ readSites: mocks.readSites, saveSites: vi.fn(async () => {}) }));
vi.mock("../../lib/confirmDialog", () => ({ confirmDialog: vi.fn(async () => true) }));
vi.mock("../../lib/clipboard", () => ({ clipboardWriteText: mocks.clipboard }));
vi.mock("../../lib/browserPasskeys", () => ({
  browserPasskeyStatus: vi.fn(async () => ({ supported: false, authorization: "unsupported" })),
  browserPasskeyRequestAuthorization: vi.fn(),
}));
// Drive the sidebar's real new-tab callback, separate from ordinary selection.
vi.mock("./SitesSidebar", () => ({ SitesSidebar: (props: {
  sites: SiteEntry[]; onOpenInNewTab: (site: SiteEntry) => void; onSelect: (site: SiteEntry) => void; onDelete: (site: SiteEntry) => void;
}) => <div>{props.sites.map((site) => <span key={site.id}>
  <button data-new={site.id} onClick={() => props.onOpenInNewTab(site)}>New tab</button>
  <button data-select={site.id} onClick={() => props.onSelect(site)}>Open</button>
  <button data-delete={site.id} onClick={() => props.onDelete(site)}>Delete</button>
</span>)}</div> }));

import { LocaleContext } from "../../lib/i18n";
import { unmountReactRoot } from "../../lib/testing/unmountReactRoot";
import { siteViewCloseAll, siteViewTabRuntime } from "../../lib/siteView";
import { ACON_SITE_LAUNCH } from "../../lib/siteLaunch";
import { SitesPane } from "./SitesPane";

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
const site: SiteEntry = {
  id: "console", label: "Console", url: "http://127.0.0.1", launch: ACON_SITE_LAUNCH,
  category: null, favicon: null, localPath: null, devUrl: null, order: 0,
  createdAt: null, lastUsedAt: null, notes: null,
};
const ticket = "http://127.0.0.1:43211/#single-use-ticket";

describe("Sites launch privacy and pane lifetime", () => {
  let container: HTMLDivElement;
  let root: Root | null;
  let frames: Map<number, FrameRequestCallback>;
  let nextFrame: number;
  async function render() {
    root ??= createRoot(container);
    await act(async () => root!.render(<LocaleContext.Provider value={{ locale: "en", setLocale: () => {}, t: (key) => key }}>
      <SitesPane overlayOpen={false} />
    </LocaleContext.Provider>));
  }
  async function frame() {
    await act(async () => {
      const queued = [...frames.values()]; frames.clear();
      for (const callback of queued) callback(0);
    });
  }
  async function click(selector: string) {
    const button = container.querySelector<HTMLButtonElement>(selector);
    expect(button).not.toBeNull();
    await act(async () => button!.click());
  }
  beforeEach(() => {
    container = document.createElement("div"); document.body.appendChild(container);
    root = null; frames = new Map(); nextFrame = 0;
    mocks.deferOpenUnsubscribe = false; mocks.settledDeliveries = 0;
    Object.defineProperty(window, "__TAURI_INTERNALS__", { value: {}, configurable: true });
    vi.stubGlobal("ResizeObserver", class { observe() {} disconnect() {} });
    vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => { frames.set(++nextFrame, callback); return nextFrame; });
    vi.stubGlobal("cancelAnimationFrame", (id: number) => frames.delete(id));
    vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockReturnValue({ x: 0, y: 0, width: 500, height: 400, top: 0, left: 0, bottom: 400, right: 500, toJSON: () => ({}) });
    mocks.readSites.mockResolvedValue({ version: 1, sites: [site] });
    mocks.invoke.mockReset().mockImplementation(async (command: string) => command === "site_view_open" ? ticket : undefined);
  });
  afterEach(async () => {
    mocks.deferOpenUnsubscribe = false;
    for (const off of mocks.deferredOpenUnsubscribes.splice(0)) off();
    if (!root) await render();
    await act(async () => {
      for (const button of container.querySelectorAll<HTMLButtonElement>('[aria-label="sites.tabs.close"]')) button.click();
    });
    await unmountReactRoot(root!); root = null;
    await siteViewCloseAll();
    container.remove(); delete window.__TAURI_INTERNALS__;
    vi.restoreAllMocks(); vi.unstubAllGlobals(); vi.clearAllMocks();
  });

  it("keeps sidebar new-tab tickets unavailable to Copy URL and bookmarking", async () => {
    await render();
    await click('[data-new="console"]');
    await frame(); await frame();
    expect(mocks.invoke).toHaveBeenCalledWith("site_view_open", expect.objectContaining({ launch: ACON_SITE_LAUNCH }));
    expect(container.querySelector<HTMLInputElement>('[aria-label="sites.address.label"]')?.value).toBe(ticket);
    const copy = container.querySelector<HTMLButtonElement>('[aria-label="sites.toolbar.copyUrl"]')!;
    const bookmark = container.querySelector<HTMLButtonElement>('[aria-label="sites.bookmark.edit"]')!;
    expect(copy.disabled).toBe(true); expect(bookmark.disabled).toBe(true);
    await act(async () => { copy.click(); bookmark.click(); });
    expect(mocks.clipboard).not.toHaveBeenCalled();
    expect(document.querySelector('[role="dialog"]')).toBeNull();
    await click('[data-delete="console"]');
    expect(container.querySelector<HTMLButtonElement>('[aria-label="sites.bookmark.add"]')?.disabled).toBe(true);
    expect(copy.disabled).toBe(true);
  });

  it("shows the prior page again after a visible tab relaunch fails", async () => {
    await render(); await click('[data-new="console"]'); await frame(); await frame();
    expect(siteViewTabRuntime("t1")?.shown).toBe(true);
    // A normal navigation clears the runtime launcher identity. Selecting the
    // console bookmark now retries the launcher in this same visible tab.
    const { siteViewNavigate } = await import("../../lib/siteView");
    await siteViewNavigate("t1", "https://previous.example/");
    mocks.invoke.mockImplementation(async (command: string) => {
      if (command === "site_view_open") throw new Error("injected launch failure");
    });
    await click('[data-select="console"]'); await frame(); await frame();
    expect(siteViewTabRuntime("t1")?.url).toBe("https://previous.example/");
    expect(siteViewTabRuntime("t1")?.shown).toBe(true);
    expect(container.querySelector<HTMLInputElement>('[aria-label="sites.address.label"]')?.value).toBe("https://previous.example/");
  });

  it("preserves ordinary page-load progress on remount after its open settled", async () => {
    await render(); await click('[data-new="console"]'); await frame(); await frame();
    await act(async () => mocks.listeners.get("sites://page-load")!({
      payload: { tabId: "t1", state: "started", url: ticket },
    }));
    expect(container.querySelector(".sites-url .spin")).not.toBeNull();
    await unmountReactRoot(root!); root = null;
    await render(); await frame();
    expect(container.querySelector(".sites-url .spin")).not.toBeNull();
  });

  it("reconciles an already-settled tab started offscreen and finishes it while mounted", async () => {
    await render(); await click('[data-new="console"]'); await frame(); await frame();
    expect(container.querySelector(".sites-url .spin")).toBeNull();
    const progress = mocks.listeners.get("sites://page-load")!;
    await unmountReactRoot(root!); root = null;
    await act(async () => progress({ payload: { tabId: "t1", state: "started", url: ticket } }));
    await render(); await frame();
    expect(container.querySelector(".sites-url .spin")).not.toBeNull();
    expect(container.querySelector<HTMLInputElement>('[aria-label="sites.address.label"]')?.value).toBe(ticket);
    await act(async () => progress({ payload: { tabId: "t1", state: "finished", url: ticket } }));
    expect(container.querySelector(".sites-url .spin")).toBeNull();
  });

  it("reconciles an already-settled tab finished offscreen without changing its URL", async () => {
    await render(); await click('[data-new="console"]'); await frame(); await frame();
    const progress = mocks.listeners.get("sites://page-load")!;
    await act(async () => progress({ payload: { tabId: "t1", state: "started", url: ticket } }));
    expect(container.querySelector(".sites-url .spin")).not.toBeNull();
    await unmountReactRoot(root!); root = null;
    await act(async () => progress({ payload: { tabId: "t1", state: "finished", url: ticket } }));
    await render(); await frame();
    expect(container.querySelector(".sites-url .spin")).toBeNull();
    expect(container.querySelector<HTMLInputElement>('[aria-label="sites.address.label"]')?.value).toBe(ticket);
  });

  it("reconciles offscreen progress for background tabs as well as the active tab", async () => {
    await render(); await click('[data-new="console"]'); await frame(); await frame();
    const progress = mocks.listeners.get("sites://page-load")!;
    await act(async () => progress({ payload: { tabId: "t1", state: "started", url: ticket } }));
    await click('[data-new="console"]'); await frame(); await frame();
    await unmountReactRoot(root!); root = null;
    await act(async () => {
      progress({ payload: { tabId: "t1", state: "finished", url: ticket } });
      progress({ payload: { tabId: "t2", state: "started", url: ticket } });
    });
    await render(); await frame();
    expect(container.querySelector(".sites-url .spin")).not.toBeNull();
    const firstTab = container.querySelectorAll<HTMLButtonElement>('.sites-tabstrip [role="tab"]')[0];
    await act(async () => firstTab.click()); await frame();
    expect(container.querySelector(".sites-url .spin")).toBeNull();
  });

  it("preserves an existing navigation spinner when runtime progress is unknown", async () => {
    await render(); await click('[data-new="console"]'); await frame(); await frame();
    expect(siteViewTabRuntime("t1")?.pageLoading).toBeUndefined();
    const input = container.querySelector<HTMLInputElement>('[aria-label="sites.address.label"]')!;
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!;
    await act(async () => { input.focus(); });
    await act(async () => {
      setter.call(input, "https://next.example/");
      input.dispatchEvent(new Event("input", { bubbles: true }));
    });
    await act(async () => { input.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true })); });
    expect(mocks.invoke).toHaveBeenCalledWith("site_view_navigate", expect.objectContaining({ tabId: "t1", url: "https://next.example/" }));
    expect(container.querySelector(".sites-url .spin")).not.toBeNull();
    expect(siteViewTabRuntime("t1")?.pageLoading).toBeUndefined();
    await unmountReactRoot(root!); root = null;
    await render(); await frame();
    expect(container.querySelector(".sites-url .spin")).not.toBeNull();
    expect(container.querySelector<HTMLInputElement>('[aria-label="sites.address.label"]')?.value).toBe("https://next.example/");
  });

  it.each(["started", "finished"] as const)("preserves page-load %s received before successful settlement", async (state) => {
    let resolve!: (url: string) => void;
    const opening = new Promise<string>((done) => { resolve = done; });
    mocks.invoke.mockImplementation(async (command: string) => command === "site_view_open" ? opening : undefined);
    await render(); await click('[data-new="console"]'); await frame();
    await act(async () => mocks.listeners.get("sites://page-load")!({
      payload: { tabId: "t1", state, url: ticket },
    }));
    await act(async () => resolve(ticket));
    await frame();
    expect(Boolean(container.querySelector(".sites-url .spin"))).toBe(state === "started");
    expect(container.querySelector<HTMLInputElement>('[aria-label="sites.address.label"]')?.value).toBe(ticket);
  });

  it.each(["before", "after"])("tracks finished while unmounted %s offscreen settlement", async (finishOrder) => {
    let resolve!: (url: string) => void;
    const opening = new Promise<string>((done) => { resolve = done; });
    mocks.invoke.mockImplementation(async (command: string) => command === "site_view_open" ? opening : undefined);
    await render(); await click('[data-new="console"]'); await frame();
    const progress = mocks.listeners.get("sites://page-load")!;
    await act(async () => progress({ payload: { tabId: "t1", state: "started", url: ticket } }));
    expect(container.querySelector(".sites-url .spin")).not.toBeNull();
    await unmountReactRoot(root!); root = null;
    expect(mocks.listeners.get("sites://page-load")).toBe(progress);
    if (finishOrder === "after") await act(async () => resolve(ticket));
    await act(async () => progress({ payload: { tabId: "t1", state: "finished", url: ticket } }));
    if (finishOrder === "before") await act(async () => resolve(ticket));
    await render(); await frame();
    expect(container.querySelector(".sites-url .spin")).toBeNull();
    expect(container.querySelector<HTMLInputElement>('[aria-label="sites.address.label"]')?.value).toBe(ticket);
    expect(siteViewTabRuntime("t1")?.shown).toBe(true);
  });

  it.each(["success", "failure"])("retains a %s settled after unmount commit until the replacement pane consumes it", async (outcome) => {
    let resolve!: (url: string) => void;
    let reject!: (error: Error) => void;
    const opening = new Promise<string>((done, fail) => { resolve = done; reject = fail; });
    mocks.invoke.mockImplementation(async (command: string) => command === "site_view_open" ? opening : undefined);
    await render(); await click('[data-new="console"]'); await frame();
    mocks.deferOpenUnsubscribe = true;
    await unmountReactRoot(root!); root = null;
    expect(mocks.deferredOpenUnsubscribes).toHaveLength(1);
    await act(async () => {
      if (outcome === "success") resolve(ticket);
      else reject(new Error("commit-gap failure"));
    });
    expect(mocks.settledDeliveries).toBe(1); // The stale passive handler really ran.
    for (const off of mocks.deferredOpenUnsubscribes.splice(0)) off();
    mocks.deferOpenUnsubscribe = false;
    await render(); await frame();
    expect(container.querySelector(".sites-url .spin")).toBeNull();
    if (outcome === "success") {
      expect(container.querySelector<HTMLInputElement>('[aria-label="sites.address.label"]')?.value).toBe(ticket);
      expect(siteViewTabRuntime("t1")?.shown).toBe(true);
    } else {
      expect(mocks.setError).toHaveBeenCalledWith("commit-gap failure");
      mocks.invoke.mockImplementation(async (command: string) => command === "site_view_open" ? ticket : undefined);
      await click('[data-select="console"]'); await frame(); await frame();
      expect(siteViewTabRuntime("t1")?.shown).toBe(true);
    }
  });

  it("clears a first-open failure completed offscreen and lets the bookmark retry", async () => {
    let reject!: (error: Error) => void;
    const opening = new Promise<string>((_, fail) => { reject = fail; });
    mocks.invoke.mockImplementation(async (command: string) => command === "site_view_open" ? opening : undefined);
    await render(); await click('[data-new="console"]'); await frame();
    await unmountReactRoot(root!); root = null;
    await act(async () => reject(new Error("offscreen first-open failure")));
    expect(siteViewTabRuntime("t1")).toBeNull();
    await render(); await frame();
    expect(container.querySelector(".sites-url .spin")).toBeNull();
    expect(mocks.setError).toHaveBeenCalledWith("offscreen first-open failure");
    mocks.invoke.mockImplementation(async (command: string) => command === "site_view_open" ? ticket : undefined);
    await click('[data-select="console"]'); await frame(); await frame();
    expect(siteViewTabRuntime("t1")?.shown).toBe(true);
    expect(mocks.invoke.mock.calls.filter(([command]) => command === "site_view_open")).toHaveLength(2);
  });

  it.each(["before remount", "after remount"])("settles an in-flight launch completed %s into the replacement pane", async (completion) => {
    let resolve!: (url: string) => void;
    const opening = new Promise<string>((done) => { resolve = done; });
    mocks.invoke.mockImplementation(async (command: string) => command === "site_view_open" ? opening : undefined);
    await render(); await click('[data-new="console"]'); await frame();
    expect(siteViewTabRuntime("t1")).toBeNull();
    await unmountReactRoot(root!); root = null;
    if (completion === "before remount") await act(async () => resolve(ticket));
    await render(); await frame();
    if (completion === "after remount") await act(async () => resolve(ticket));
    await frame();
    expect(siteViewTabRuntime("t1")?.shown).toBe(true);
    expect(container.querySelector<HTMLInputElement>('[aria-label="sites.address.label"]')?.value).toBe(ticket);
    expect(mocks.invoke.mock.calls.filter(([command]) => command === "site_view_open")).toHaveLength(1);
  });
});
