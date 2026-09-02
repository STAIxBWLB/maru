// @vitest-environment jsdom

import { act, StrictMode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  browserPasskeyStatus: vi.fn(),
  browserPasskeyRequestAuthorization: vi.fn(),
  siteViewReload: vi.fn(),
  siteViewOpenSafari: vi.fn(),
}));

vi.mock("../../lib/browserPasskeys", () => ({
  browserPasskeyStatus: mocks.browserPasskeyStatus,
  browserPasskeyRequestAuthorization: mocks.browserPasskeyRequestAuthorization,
}));

vi.mock("../../lib/maruDir", () => ({
  readSites: vi.fn(async () => ({ version: 1, sites: [] })),
  saveSites: vi.fn(async () => undefined),
}));

vi.mock("../../lib/siteView", () => ({
  SITE_VIEW_CLOSE_ACTIVE_REQUEST_EVENT: "maru:sites:close-active",
  nextSiteViewOpenRequests: (
    requests: Array<{ id: number; url: string }>,
    handledIds: Set<number>,
    availableSlots: number,
  ) => requests.filter((request) => !handledIds.has(request.id)).slice(0, availableSlots),
  siteViewBack: vi.fn(async () => undefined),
  siteViewClose: vi.fn(async () => undefined),
  siteViewForward: vi.fn(async () => undefined),
  siteViewHide: vi.fn(async () => undefined),
  siteViewNavigate: vi.fn(async () => undefined),
  siteViewOpen: vi.fn(async () => undefined),
  siteViewOpenExternal: vi.fn(async () => undefined),
  siteViewOpenSafari: mocks.siteViewOpenSafari,
  siteViewReload: mocks.siteViewReload,
  siteViewSetBounds: vi.fn(async () => undefined),
  siteViewShow: vi.fn(async () => undefined),
  siteViewTabRuntime: vi.fn(() => ({ shown: true, url: "https://jeju.ai/" })),
  subscribeSiteViewEvents: vi.fn(() => () => {}),
}));

import { SitesPane } from "./SitesPane";
import { LocaleContext } from "../../lib/i18n";

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT =
  true;

class ResizeObserverMock {
  observe() {}
  disconnect() {}
}

const messages: Record<string, string> = {
  "sites.passkeys.title": "Passkey sign-in",
  "sites.passkeys.checking": "Checking passkeys",
  "sites.passkeys.notDetermined": "Enable permission",
  "sites.passkeys.enable": "Enable passkeys",
  "sites.passkeys.enabling": "Enabling...",
  "sites.passkeys.authorized": "Passkeys are allowed. Reload and try again.",
  "sites.passkeys.reload": "Reload page",
  "sites.passkeys.denied": "Passkeys denied",
  "sites.passkeys.unsupported": "Passkeys unsupported",
  "sites.passkeys.unknown": "Passkey state unknown",
  "sites.passkeys.openSafari": "Open in Safari",
  "sites.passkeys.openingSafari": "Opening Safari...",
};

const t = (key: string) => messages[key] ?? key;

describe("SitesPane passkey and opened URL integration", () => {
  let container: HTMLDivElement;
  let root: Root | null = null;

  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
    window.sessionStorage.clear();
    Object.defineProperty(window, "__TAURI_INTERNALS__", {
      value: {},
      configurable: true,
    });
    vi.stubGlobal("ResizeObserver", ResizeObserverMock);
    mocks.browserPasskeyStatus.mockResolvedValue({
      supported: true,
      authorization: "notDetermined",
      requiresManagedEntitlement: true,
    });
    mocks.browserPasskeyRequestAuthorization.mockResolvedValue({
      supported: true,
      authorization: "authorized",
      requiresManagedEntitlement: true,
    });
    mocks.siteViewReload.mockResolvedValue(undefined);
    mocks.siteViewOpenSafari.mockResolvedValue(undefined);
  });

  afterEach(async () => {
    await act(async () => root?.unmount());
    root = null;
    container.remove();
    delete window.__TAURI_INTERNALS__;
    vi.unstubAllGlobals();
    vi.clearAllMocks();
    vi.useRealTimers();
  });

  it("shows the default macOS unsupported notice once and then collapses it", async () => {
    vi.useFakeTimers();
    mocks.browserPasskeyStatus.mockResolvedValue({
      supported: false,
      authorization: "unsupported",
      requiresManagedEntitlement: true,
    });

    root = createRoot(container);
    await act(async () => {
      root?.render(
        <LocaleContext.Provider value={{ locale: "en", setLocale: () => {}, t }}>
          <SitesPane overlayOpen={false} />
        </LocaleContext.Provider>,
      );
    });
    await act(async () => {});

    expect(container.querySelector(".sites-passkey-status")?.classList).not.toContain("empty");
    expect(container.textContent).toContain("Passkeys unsupported");

    await act(async () => {
      vi.advanceTimersByTime(5_000);
    });
    expect(container.querySelector(".sites-passkey-status")?.classList).toContain("empty");

    await act(async () => root?.unmount());
    root = createRoot(container);
    await act(async () => {
      root?.render(
        <LocaleContext.Provider value={{ locale: "en", setLocale: () => {}, t }}>
          <SitesPane overlayOpen={false} />
        </LocaleContext.Provider>,
      );
    });
    await act(async () => {});

    expect(container.querySelector(".sites-passkey-status")?.classList).toContain("empty");
  });

  it("checks on mount, opens queued URLs, and requests only after Enable", async () => {
    const onOpenedUrlsHandled = vi.fn();
    root = createRoot(container);
    await act(async () => {
      root?.render(
        <StrictMode>
          <LocaleContext.Provider value={{ locale: "en", setLocale: () => {}, t }}>
            <SitesPane
              overlayOpen={false}
              openedUrls={[
                { id: 1, url: "https://jeju.ai/" },
                { id: 2, url: "https://jeju.ai/" },
              ]}
              onOpenedUrlsHandled={onOpenedUrlsHandled}
            />
          </LocaleContext.Provider>
        </StrictMode>,
      );
    });
    await act(async () => {});

    expect(mocks.browserPasskeyStatus).toHaveBeenCalled();
    expect(mocks.browserPasskeyRequestAuthorization).not.toHaveBeenCalled();
    expect(onOpenedUrlsHandled).toHaveBeenCalledTimes(1);
    expect(onOpenedUrlsHandled).toHaveBeenCalledWith([1, 2]);
    expect(container.querySelectorAll('[role="tab"]')).toHaveLength(2);
    expect(container.textContent).toContain("jeju.ai");

    const enable = Array.from(container.querySelectorAll("button")).find(
      (button) => button.textContent === "Enable passkeys",
    );
    expect(enable).toBeTruthy();
    await act(async () => enable?.click());
    await act(async () => {});

    expect(mocks.browserPasskeyRequestAuthorization).toHaveBeenCalledOnce();
    expect(container.textContent).toContain("Passkeys are allowed. Reload and try again.");
    const reload = Array.from(container.querySelectorAll("button")).find(
      (button) => button.textContent === "Reload page",
    );
    await act(async () => reload?.click());
    expect(mocks.siteViewReload).toHaveBeenCalledOnce();

    await act(async () => root?.unmount());
    root = null;
    mocks.browserPasskeyStatus.mockResolvedValue({
      supported: true,
      authorization: "denied",
      requiresManagedEntitlement: true,
    });
    root = createRoot(container);
    await act(async () => {
      root?.render(
        <LocaleContext.Provider value={{ locale: "en", setLocale: () => {}, t }}>
          <SitesPane overlayOpen={false} />
        </LocaleContext.Provider>,
      );
    });
    await act(async () => {});
    const safari = Array.from(container.querySelectorAll("button")).find(
      (button) => button.textContent === "Open in Safari",
    );
    expect(safari).toBeTruthy();
    await act(async () => safari?.click());
    expect(mocks.siteViewOpenSafari).toHaveBeenCalledWith("https://jeju.ai");

    await act(async () => root?.unmount());
    root = null;
    mocks.browserPasskeyStatus.mockResolvedValue({
      supported: true,
      authorization: "notDetermined",
      requiresManagedEntitlement: true,
    });
    mocks.browserPasskeyRequestAuthorization.mockRejectedValue(
      new Error("system request failed"),
    );
    root = createRoot(container);
    await act(async () => {
      root?.render(
        <LocaleContext.Provider value={{ locale: "en", setLocale: () => {}, t }}>
          <SitesPane overlayOpen={false} />
        </LocaleContext.Provider>,
      );
    });
    await act(async () => {});
    const retryEnable = Array.from(container.querySelectorAll("button")).find(
      (button) => button.textContent === "Enable passkeys",
    );
    await act(async () => retryEnable?.click());
    await act(async () => {});

    expect(container.textContent).toContain("system request failed");
    expect(
      Array.from(container.querySelectorAll("button")).some(
        (button) => button.textContent === "Open in Safari",
      ),
    ).toBe(true);

    await act(async () => root?.unmount());
    root = null;
    mocks.browserPasskeyStatus.mockResolvedValue({
      supported: false,
      authorization: "unsupported",
      requiresManagedEntitlement: false,
    });
    root = createRoot(container);
    await act(async () => {
      root?.render(
        <LocaleContext.Provider value={{ locale: "en", setLocale: () => {}, t }}>
          <SitesPane overlayOpen={false} />
        </LocaleContext.Provider>,
      );
    });
    await act(async () => {});

    expect(container.querySelector(".sites-passkey-status")?.classList).toContain("empty");
    expect(container.textContent).not.toContain("Passkey sign-in");
  });
});
