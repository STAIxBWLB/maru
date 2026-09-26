import { afterEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  globalListen: vi.fn(),
  windowListen: vi.fn(),
}));

vi.mock("@tauri-apps/api/event", () => ({ listen: mocks.globalListen }));
vi.mock("@tauri-apps/api/webviewWindow", () => ({
  getCurrentWebviewWindow: () => ({ label: "skill-editor", listen: mocks.windowListen }),
}));

import { clampMenuPosition, listenForMenuCommand, MENU_COMMAND_EVENT } from "./menu";

describe("clampMenuPosition", () => {
  it("keeps an already visible menu position unchanged", () => {
    expect(
      clampMenuPosition(
        { x: 120, y: 160 },
        { width: 210, height: 180 },
        { width: 900, height: 700 },
      ),
    ).toEqual({ x: 120, y: 160 });
  });

  it("moves a menu back inside the right and bottom viewport edges", () => {
    expect(
      clampMenuPosition(
        { x: 760, y: 560 },
        { width: 210, height: 180 },
        { width: 900, height: 700 },
      ),
    ).toEqual({ x: 682, y: 512 });
  });

  it("keeps the menu reachable when it is wider or taller than the viewport", () => {
    expect(
      clampMenuPosition(
        { x: -20, y: -10 },
        { width: 500, height: 500 },
        { width: 320, height: 240 },
      ),
    ).toEqual({ x: 8, y: 8 });
  });
});

describe("listenForMenuCommand", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.clearAllMocks();
  });

  // Review finding #2, round 3 (owner-observed): a global listen() registers
  // target Any, and Tauri delivers every event to an Any listener no matter
  // which label emit_to named, so app.quit routed to "main" also reached the
  // skill editor's main-is-gone fallback and stacked a second confirm sheet
  // on the editor window. Only a window-scoped listener honors the routing.
  it("listens on the current window only, so emit_to routing holds", async () => {
    vi.stubGlobal("window", { __TAURI_INTERNALS__: {} });
    const off = vi.fn();
    mocks.windowListen.mockResolvedValue(off);
    const handler = vi.fn();

    await expect(listenForMenuCommand(handler)).resolves.toBe(off);

    expect(mocks.globalListen).not.toHaveBeenCalled();
    expect(mocks.windowListen).toHaveBeenCalledWith(MENU_COMMAND_EVENT, expect.any(Function));
    mocks.windowListen.mock.calls[0][1]({ payload: "app.quit" });
    expect(handler).toHaveBeenCalledWith("app.quit");
  });
});
