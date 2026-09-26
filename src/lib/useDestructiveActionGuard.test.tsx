// @vitest-environment jsdom

import { act } from "react";
import { createElement } from "react";
import type { MutableRefObject } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { DebouncedSaver } from "./debouncedSave";
import type { MaruSettings } from "./settings";
import {
  useDestructiveActionGuard,
  type DestructiveActionGuard,
} from "./useDestructiveActionGuard";

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT =
  true;

// A CloseRequested handler captured off the mocked onCloseRequested call, plus
// a controllable flushPendingSavesForQuit — every test below drives the guard
// through this handler exactly as the real Tauri window would.
const mocks = vi.hoisted(() => ({
  close: vi.fn<() => Promise<void>>(),
  onCloseRequested: vi.fn(),
  tauriAvailable: vi.fn(() => true),
  relaunchApp: vi.fn(),
  flushPendingSavesForQuit: vi.fn(),
}));

vi.mock("@tauri-apps/api/window", () => ({
  getCurrentWindow: () => ({
    label: "main",
    close: mocks.close,
    onCloseRequested: mocks.onCloseRequested,
  }),
}));

vi.mock("./windowLayout", () => ({
  tauriAvailable: mocks.tauriAvailable,
}));

vi.mock("./updater", () => ({
  relaunchApp: mocks.relaunchApp,
}));

vi.mock("./teardownSave", () => ({
  flushPendingSavesForQuit: mocks.flushPendingSavesForQuit,
}));

type CloseEvent = { preventDefault: () => void };
type CloseHandler = (event: CloseEvent) => Promise<void>;

function makeEvent(): CloseEvent {
  return { preventDefault: vi.fn() };
}

function capturedHandler(): CloseHandler {
  const call = mocks.onCloseRequested.mock.calls[0] as [CloseHandler] | undefined;
  if (!call) throw new Error("onCloseRequested was never called");
  return call[0];
}

/** Flushes the dynamic-import + mocked-async-API microtask chain the guard's
 * effect goes through before onCloseRequested is actually called. */
async function settleEffect(): Promise<void> {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
  });
}

function Probe({
  onGuard,
  hasDirtyDrafts,
  settingsSaverRef,
}: {
  onGuard: (guard: DestructiveActionGuard) => void;
  hasDirtyDrafts: () => boolean;
  settingsSaverRef: MutableRefObject<DebouncedSaver<MaruSettings> | null>;
}) {
  const guard = useDestructiveActionGuard({ hasDirtyDrafts, settingsSaverRef });
  onGuard(guard);
  return null;
}

describe("useDestructiveActionGuard onCloseRequested", () => {
  let container: HTMLDivElement;
  let root: Root | null;
  let guard: DestructiveActionGuard;
  let settingsSaverRef: MutableRefObject<DebouncedSaver<MaruSettings> | null>;
  let settingsFlush: ReturnType<typeof vi.fn<() => Promise<void>>>;

  beforeEach(() => {
    vi.clearAllMocks();
    mocks.close.mockResolvedValue(undefined);
    settingsFlush = vi.fn<() => Promise<void>>();
    settingsFlush.mockResolvedValue(undefined);
    settingsSaverRef = {
      current: { schedule: vi.fn(), flush: settingsFlush, cancel: vi.fn() },
    };
  });

  afterEach(async () => {
    if (root) await act(async () => root?.unmount());
    container?.remove();
    root = null;
  });

  async function mount(hasDirtyDrafts: () => boolean): Promise<void> {
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    await act(async () => {
      root?.render(
        createElement(Probe, {
          onGuard: (g) => {
            guard = g;
          },
          hasDirtyDrafts,
          settingsSaverRef,
        }),
      );
    });
    await settleEffect();
  }

  it("clean and not dirty closes exactly once, and the replayed close event is not prevented", async () => {
    mocks.flushPendingSavesForQuit.mockResolvedValue({ kind: "clean" });
    await mount(() => false);

    const event = makeEvent();
    await act(async () => {
      await capturedHandler()(event);
    });

    expect(mocks.flushPendingSavesForQuit).toHaveBeenCalledTimes(1);
    expect(event.preventDefault).toHaveBeenCalledTimes(1);
    expect(settingsFlush).toHaveBeenCalledTimes(1);
    expect(mocks.close).toHaveBeenCalledTimes(1);

    // The real close() causes Tauri to replay CloseRequested; closeConfirmedRef
    // is now set, so this replay must not be prevented and must not re-close.
    const replay = makeEvent();
    await act(async () => {
      await capturedHandler()(replay);
    });
    expect(replay.preventDefault).not.toHaveBeenCalled();
    expect(mocks.close).toHaveBeenCalledTimes(1);
  });

  it("a failed flush never calls close", async () => {
    mocks.flushPendingSavesForQuit.mockResolvedValue({ kind: "failed", failures: 1 });
    await mount(() => false);

    await act(async () => {
      await capturedHandler()(makeEvent());
    });

    expect(mocks.close).not.toHaveBeenCalled();
    expect(settingsFlush).not.toHaveBeenCalled();
  });

  it("a timed-out flush never calls close", async () => {
    mocks.flushPendingSavesForQuit.mockResolvedValue({ kind: "timeout" });
    await mount(() => false);

    await act(async () => {
      await capturedHandler()(makeEvent());
    });

    expect(mocks.close).not.toHaveBeenCalled();
    expect(settingsFlush).not.toHaveBeenCalled();
  });

  it("two close events while the flush is pending call flush exactly once", async () => {
    let resolveFlush: ((outcome: { kind: "clean" }) => void) | null = null;
    mocks.flushPendingSavesForQuit.mockReturnValue(
      new Promise((resolve) => {
        resolveFlush = resolve;
      }),
    );
    await mount(() => false);

    const first = makeEvent();
    const second = makeEvent();
    // Fire both before the flush settles: the first starts the flush, the
    // second must be prevented without starting a second flush.
    let firstDone: Promise<void>;
    let secondDone: Promise<void>;
    await act(async () => {
      firstDone = capturedHandler()(first);
      secondDone = capturedHandler()(second);
      await Promise.resolve();
    });

    expect(mocks.flushPendingSavesForQuit).toHaveBeenCalledTimes(1);
    expect(first.preventDefault).toHaveBeenCalledTimes(1);
    expect(second.preventDefault).toHaveBeenCalledTimes(1);
    expect(mocks.close).not.toHaveBeenCalled();

    await act(async () => {
      resolveFlush?.({ kind: "clean" });
      await firstDone;
      await secondDone;
    });

    expect(mocks.close).toHaveBeenCalledTimes(1);
  });

  it("clean and dirty sets pending close without closing", async () => {
    mocks.flushPendingSavesForQuit.mockResolvedValue({ kind: "clean" });
    await mount(() => true);

    await act(async () => {
      await capturedHandler()(makeEvent());
    });

    expect(guard.pendingDestructiveAction).toBe("close");
    expect(mocks.close).not.toHaveBeenCalled();
    expect(settingsFlush).not.toHaveBeenCalled();
  });
});

describe("useDestructiveActionGuard quitSaving indicator and the save-failed dialog", () => {
  let container: HTMLDivElement;
  let root: Root | null;
  let guard: DestructiveActionGuard;
  let settingsSaverRef: MutableRefObject<DebouncedSaver<MaruSettings> | null>;
  let settingsFlush: ReturnType<typeof vi.fn<() => Promise<void>>>;
  let dirty: boolean;

  beforeEach(() => {
    vi.clearAllMocks();
    mocks.close.mockResolvedValue(undefined);
    mocks.relaunchApp.mockResolvedValue(undefined);
    settingsFlush = vi.fn<() => Promise<void>>();
    settingsFlush.mockResolvedValue(undefined);
    settingsSaverRef = {
      current: { schedule: vi.fn(), flush: settingsFlush, cancel: vi.fn() },
    };
    dirty = false;
  });

  afterEach(async () => {
    if (root) await act(async () => root?.unmount());
    container?.remove();
    root = null;
    vi.useRealTimers();
  });

  async function mount(): Promise<void> {
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    await act(async () => {
      root?.render(
        createElement(Probe, {
          onGuard: (g) => {
            guard = g;
          },
          hasDirtyDrafts: () => dirty,
          settingsSaverRef,
        }),
      );
    });
    await settleEffect();
  }

  it("quitSaving turns true only after 300ms of an in-flight flush, and false again once it resolves", async () => {
    vi.useFakeTimers();
    let resolveFlush: ((outcome: { kind: "clean" }) => void) | null = null;
    mocks.flushPendingSavesForQuit.mockReturnValue(
      new Promise((resolve) => {
        resolveFlush = resolve;
      }),
    );
    await mount();

    let done: Promise<void> = Promise.resolve();
    await act(async () => {
      done = capturedHandler()(makeEvent());
      await Promise.resolve();
    });
    expect(guard.quitSaving).toBe(false);

    await act(async () => {
      await vi.advanceTimersByTimeAsync(299);
    });
    expect(guard.quitSaving).toBe(false);

    await act(async () => {
      await vi.advanceTimersByTimeAsync(2);
    });
    expect(guard.quitSaving).toBe(true);

    await act(async () => {
      resolveFlush?.({ kind: "clean" });
      await done;
    });
    expect(guard.quitSaving).toBe(false);
  });

  it("a flush that resolves before 300ms never sets quitSaving", async () => {
    vi.useFakeTimers();
    mocks.flushPendingSavesForQuit.mockResolvedValue({ kind: "clean" });
    await mount();

    await act(async () => {
      await capturedHandler()(makeEvent());
    });
    expect(guard.quitSaving).toBe(false);

    await act(async () => {
      await vi.advanceTimersByTimeAsync(400);
    });
    expect(guard.quitSaving).toBe(false);
  });

  it("a failed flush sets save-failed with quitFailureKind failed and failedQuitAction close", async () => {
    mocks.flushPendingSavesForQuit.mockResolvedValue({ kind: "failed", failures: 1 });
    await mount();

    await act(async () => {
      await capturedHandler()(makeEvent());
    });

    expect(guard.pendingDestructiveAction).toBe("save-failed");
    expect(guard.quitFailureKind).toBe("failed");
    expect(guard.failedQuitAction).toBe("close");
  });

  it("a timed-out flush sets quitFailureKind timeout", async () => {
    mocks.flushPendingSavesForQuit.mockResolvedValue({ kind: "timeout" });
    await mount();

    await act(async () => {
      await capturedHandler()(makeEvent());
    });

    expect(guard.pendingDestructiveAction).toBe("save-failed");
    expect(guard.quitFailureKind).toBe("timeout");
    expect(guard.failedQuitAction).toBe("close");
  });

  it("retryQuit clears the dialog and re-enters the close flow via requestWindowClose", async () => {
    mocks.flushPendingSavesForQuit.mockResolvedValue({ kind: "failed", failures: 1 });
    await mount();
    await act(async () => {
      await capturedHandler()(makeEvent());
    });
    expect(guard.pendingDestructiveAction).toBe("save-failed");

    await act(async () => {
      guard.retryQuit();
      await Promise.resolve();
    });

    expect(guard.pendingDestructiveAction).toBeNull();
    expect(guard.quitFailureKind).toBeNull();
    expect(guard.failedQuitAction).toBeNull();
    // requestWindowClose() asks the OS to close, which is what makes the real
    // window replay CloseRequested through this same listener.
    expect(mocks.close).toHaveBeenCalledTimes(1);
  });

  it("retryQuit for a failed relaunch re-runs the flush, relaunching once the retry is clean", async () => {
    mocks.flushPendingSavesForQuit.mockResolvedValueOnce({ kind: "timeout" });
    await mount();
    await act(async () => {
      await guard.requestRelaunch();
    });
    expect(guard.pendingDestructiveAction).toBe("save-failed");
    expect(guard.failedQuitAction).toBe("relaunch");

    mocks.flushPendingSavesForQuit.mockResolvedValueOnce({ kind: "clean" });
    await act(async () => {
      guard.retryQuit();
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(mocks.flushPendingSavesForQuit).toHaveBeenCalledTimes(2);
    expect(mocks.relaunchApp).toHaveBeenCalledTimes(1);
    expect(guard.pendingDestructiveAction).toBeNull();
  });

  it("quitAnyway for a failed close flushes settings and closes when nothing is dirty", async () => {
    mocks.flushPendingSavesForQuit.mockResolvedValue({ kind: "failed", failures: 1 });
    await mount();
    await act(async () => {
      await capturedHandler()(makeEvent());
    });
    expect(guard.pendingDestructiveAction).toBe("save-failed");

    await act(async () => {
      await guard.quitAnyway();
    });

    expect(settingsFlush).toHaveBeenCalledTimes(1);
    expect(mocks.close).toHaveBeenCalledTimes(1);
    expect(guard.pendingDestructiveAction).toBeNull();
  });

  it("quitAnyway for a failed close with dirty drafts sets pending close instead of closing", async () => {
    mocks.flushPendingSavesForQuit.mockResolvedValue({ kind: "failed", failures: 1 });
    await mount();
    await act(async () => {
      await capturedHandler()(makeEvent());
    });
    expect(guard.pendingDestructiveAction).toBe("save-failed");

    dirty = true;
    await act(async () => {
      await guard.quitAnyway();
    });

    expect(guard.pendingDestructiveAction).toBe("close");
    expect(mocks.close).not.toHaveBeenCalled();
  });

  it("quitAnyway for a failed relaunch calls relaunchApp once when nothing is dirty", async () => {
    mocks.flushPendingSavesForQuit.mockResolvedValue({ kind: "timeout" });
    await mount();
    await act(async () => {
      await guard.requestRelaunch();
    });
    expect(guard.pendingDestructiveAction).toBe("save-failed");
    expect(guard.failedQuitAction).toBe("relaunch");

    await act(async () => {
      await guard.quitAnyway();
    });

    expect(mocks.relaunchApp).toHaveBeenCalledTimes(1);
    expect(guard.pendingDestructiveAction).toBeNull();
  });

  it("quitAnyway for a failed relaunch with dirty drafts sets pending relaunch instead of relaunching", async () => {
    mocks.flushPendingSavesForQuit.mockResolvedValue({ kind: "timeout" });
    await mount();
    await act(async () => {
      await guard.requestRelaunch();
    });
    expect(guard.failedQuitAction).toBe("relaunch");

    dirty = true;
    await act(async () => {
      await guard.quitAnyway();
    });

    expect(guard.pendingDestructiveAction).toBe("relaunch");
    expect(mocks.relaunchApp).not.toHaveBeenCalled();
  });

  it("cancelDestructiveAction clears a save-failed dialog and closes nothing", async () => {
    mocks.flushPendingSavesForQuit.mockResolvedValue({ kind: "failed", failures: 1 });
    await mount();
    await act(async () => {
      await capturedHandler()(makeEvent());
    });
    expect(guard.pendingDestructiveAction).toBe("save-failed");

    act(() => {
      guard.cancelDestructiveAction();
    });

    expect(guard.pendingDestructiveAction).toBeNull();
    expect(guard.quitFailureKind).toBeNull();
    expect(guard.failedQuitAction).toBeNull();
    expect(mocks.close).not.toHaveBeenCalled();
  });
});
