import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  invoke: vi.fn(),
  listen: vi.fn(),
}));

vi.mock("@tauri-apps/api/core", () => ({
  invoke: (cmd: string, args?: unknown) => mocks.invoke(cmd, args),
}));

vi.mock("@tauri-apps/api/event", () => ({
  listen: (event: string, handler: (event: { payload: unknown }) => void) =>
    mocks.listen(event, handler),
}));

import {
  buildSiteViewOpenRequests,
  nextSiteViewOpenRequests,
  sanitizeSiteViewOpenedUrls,
  SITE_VIEW_OPEN_REQUESTED_EVENT,
  siteViewOpenSafari,
  siteViewTakeOpenedUrls,
  subscribeSiteViewOpenRequests,
} from "./siteView";

describe("site view opened URL bridge", () => {
  beforeEach(() => {
    mocks.invoke.mockReset();
    mocks.listen.mockReset();
    mocks.listen.mockResolvedValue(() => {});
  });

  afterEach(() => {
    delete (globalThis as { window?: unknown }).window;
  });

  it("returns an empty startup queue in browser mode", async () => {
    await expect(siteViewTakeOpenedUrls()).resolves.toEqual([]);
    expect(mocks.invoke).not.toHaveBeenCalled();
  });

  it("invokes the drain and dedicated Safari commands in Tauri", async () => {
    (globalThis as { window?: unknown }).window = { __TAURI_INTERNALS__: {} };
    mocks.invoke.mockResolvedValueOnce(["https://jeju.ai/"]).mockResolvedValueOnce(undefined);

    await expect(siteViewTakeOpenedUrls()).resolves.toEqual(["https://jeju.ai/"]);
    await siteViewOpenSafari("https://jeju.ai/");

    expect(mocks.invoke).toHaveBeenNthCalledWith(1, "site_view_take_opened_urls", undefined);
    expect(mocks.invoke).toHaveBeenNthCalledWith(2, "site_view_open_safari", {
      url: "https://jeju.ai/",
    });
  });

  it("keeps only http and https URLs", () => {
    expect(
      sanitizeSiteViewOpenedUrls([
        "https://jeju.ai/a",
        "http://localhost:5307",
        "file:///tmp/private",
        "maru://settings",
        3,
      ]),
    ).toEqual(["https://jeju.ai/a", "http://localhost:5307"]);
  });

  it("gives repeated opens of the same URL separate identities", () => {
    const batch = buildSiteViewOpenRequests(
      ["https://jeju.ai", "https://jeju.ai"],
      40,
    );
    expect(batch).toEqual({
      requests: [
        { id: 41, url: "https://jeju.ai" },
        { id: 42, url: "https://jeju.ai" },
      ],
      nextId: 42,
    });
  });

  it("keeps requests beyond the tab cap eligible for a later retry", () => {
    const requests = Array.from({ length: 13 }, (_, index) => ({
      id: index + 1,
      url: `https://example.com/${index + 1}`,
    }));
    const first = nextSiteViewOpenRequests(requests, new Set(), 12);
    expect(first.map((request) => request.id)).toEqual([
      1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12,
    ]);
    expect(
      nextSiteViewOpenRequests(requests, new Set(first.map((request) => request.id)), 1),
    ).toEqual([requests[12]]);
  });

  it("treats an open event as a queue wake-up and does not replay drained URLs", async () => {
    const queue = ["https://halla.ai", "file:///tmp/private"];
    mocks.invoke.mockImplementation(async (command: string) => {
      if (command !== "site_view_take_opened_urls") return undefined;
      return queue.splice(0);
    });

    (globalThis as { window?: unknown }).window = { __TAURI_INTERNALS__: {} };
    const handler = vi.fn();
    const off = subscribeSiteViewOpenRequests(handler);
    await vi.waitFor(() => expect(handler).toHaveBeenCalledOnce());
    expect(mocks.listen).toHaveBeenCalledWith(SITE_VIEW_OPEN_REQUESTED_EVENT, expect.any(Function));
    const eventHandler = mocks.listen.mock.calls[0][1] as (event: {
      payload: unknown;
    }) => void;
    expect(handler).toHaveBeenCalledWith(["https://halla.ai"]);

    eventHandler({ payload: ["https://halla.ai"] });
    await vi.waitFor(() =>
      expect(mocks.invoke).toHaveBeenCalledTimes(2),
    );
    expect(handler).toHaveBeenCalledOnce();
    off();
  });

  it("hands a late drain response to the replacement subscriber", async () => {
    let resolveDrain!: (urls: string[]) => void;
    const pendingDrain = new Promise<string[]>((resolve) => {
      resolveDrain = resolve;
    });
    mocks.invoke.mockReturnValue(pendingDrain);
    const nativeOff = vi.fn();
    mocks.listen.mockResolvedValue(nativeOff);
    (globalThis as { window?: unknown }).window = { __TAURI_INTERNALS__: {} };
    const handler = vi.fn();

    const off = subscribeSiteViewOpenRequests(handler);
    await vi.waitFor(() => expect(mocks.invoke).toHaveBeenCalledOnce());
    off();
    resolveDrain(["https://jeju.ai"]);
    await Promise.resolve();
    await Promise.resolve();

    expect(nativeOff).toHaveBeenCalledOnce();
    expect(handler).not.toHaveBeenCalled();
    mocks.invoke.mockResolvedValue([]);
    const replacement = vi.fn();
    const replacementOff = subscribeSiteViewOpenRequests(replacement);
    expect(replacement).toHaveBeenCalledWith(["https://jeju.ai"]);
    replacementOff();
  });

  it("cancels before the native listener promise resolves without draining", async () => {
    let resolveListen!: (off: () => void) => void;
    const pendingListen = new Promise<() => void>((resolve) => {
      resolveListen = resolve;
    });
    const nativeOff = vi.fn();
    mocks.listen.mockReturnValue(pendingListen);
    (globalThis as { window?: unknown }).window = { __TAURI_INTERNALS__: {} };
    const handler = vi.fn();

    const off = subscribeSiteViewOpenRequests(handler);
    off();
    resolveListen(nativeOff);
    await vi.waitFor(() => expect(nativeOff).toHaveBeenCalledOnce());

    expect(mocks.invoke).not.toHaveBeenCalled();
    expect(handler).not.toHaveBeenCalled();
  });
});
