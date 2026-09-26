// @vitest-environment jsdom

import { act } from "react";
import { createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createDebouncedSaver } from "./debouncedSave";
import {
  dismissOperationNotice,
  getOperationNotice,
  setError,
  useError,
  type ErrorValue,
} from "./errorStore";
import {
  reportTeardownSaveFailure,
  useTeardownFlush,
  type TeardownSaveTarget,
  type Translate,
} from "./teardownSave";

const mocks = vi.hoisted(() => ({
  writeRecoveryCopy: vi.fn(),
}));

vi.mock("./maruDir", () => ({
  writeRecoveryCopy: mocks.writeRecoveryCopy,
}));

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT =
  true;

const t: Translate = (key) => key;

/** Reads the current error-store value by mounting a throwaway probe — the
 * store exposes no synchronous getter, only the useError() hook. */
async function readError(): Promise<ErrorValue> {
  const container = document.createElement("div");
  const probeRoot = createRoot(container);
  let seen: ErrorValue = null;
  function ErrorProbe() {
    seen = useError();
    return null;
  }
  await act(async () => {
    probeRoot.render(createElement(ErrorProbe));
  });
  await act(async () => probeRoot.unmount());
  container.remove();
  return seen;
}

// Every failed settle now routes through reportTeardownSaveFailure, which
// publishes to the shared, module-level operation-notice queue. Drain it
// after every test in this file (both describes below), or a notice left
// behind by one test — e.g. a saver that throws in the useTeardownFlush
// tests — leaks into a later test's getOperationNotice() as its stale head.
afterEach(() => {
  let notice = getOperationNotice();
  while (notice) {
    dismissOperationNotice(notice.operationId);
    notice = getOperationNotice();
  }
});

type Saver = ReturnType<typeof createDebouncedSaver<string>>;

function Probe({
  saver,
  describeValue,
}: {
  saver: Saver | null;
  describeValue: (value: string) => TeardownSaveTarget | null;
}) {
  useTeardownFlush(saver, describeValue, t);
  return null;
}

describe("useTeardownFlush", () => {
  let container: HTMLDivElement;
  let root: Root | null;

  beforeEach(() => {
    vi.clearAllMocks();
    // Matches the real writeRecoveryCopy's outside-Tauri behavior so these
    // tests (which don't care about the recovery copy) see the same
    // failedNoCopy path they did before reportTeardownSaveFailure existed.
    mocks.writeRecoveryCopy.mockRejectedValue(new Error("Recovery copies require the Tauri shell"));
  });

  afterEach(async () => {
    if (root) await act(async () => root?.unmount());
    container?.remove();
    root = null;
  });

  async function mount(saver: Saver | null, describeValue: (value: string) => TeardownSaveTarget | null) {
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    await act(async () => {
      root?.render(createElement(Probe, { saver, describeValue }));
    });
  }

  it("settles a pending value on unmount with exactly one save", async () => {
    const save = vi.fn();
    const saver = createDebouncedSaver<string>(save, 250);
    saver.schedule("draft.md");
    const describeValue = (value: string): TeardownSaveTarget => ({
      workPath: value,
      filePath: value,
      content: "secret content",
    });

    await mount(saver, describeValue);
    await act(async () => root?.unmount());
    root = null;

    expect(save).toHaveBeenCalledTimes(1);
    expect(save).toHaveBeenCalledWith("draft.md");
  });

  it("settles the old saver and registers the new one when the saver prop changes", async () => {
    const firstSave = vi.fn();
    const secondSave = vi.fn();
    const firstSaver = createDebouncedSaver<string>(firstSave, 250);
    const secondSaver = createDebouncedSaver<string>(secondSave, 250);
    firstSaver.schedule("first.md");
    const describeValue = (value: string): TeardownSaveTarget => ({
      workPath: value,
      filePath: value,
      content: "x",
    });

    await mount(firstSaver, describeValue);
    await act(async () => {
      root?.render(createElement(Probe, { saver: secondSaver, describeValue }));
    });
    expect(firstSave).toHaveBeenCalledTimes(1);

    secondSaver.schedule("second.md");
    await act(async () => root?.unmount());
    root = null;

    expect(secondSave).toHaveBeenCalledTimes(1);
    expect(secondSave).toHaveBeenCalledWith("second.md");
  });

  it("logs exactly one line naming the file and reason, and never the content, on a failing settle", async () => {
    const error = new Error("disk full");
    const saver = createDebouncedSaver<string>(() => {
      throw error;
    }, 250);
    saver.schedule("draft.md");
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const describeValue = (value: string): TeardownSaveTarget => ({
      workPath: value,
      filePath: "notes/draft.md",
      content: "top secret body",
    });

    await mount(saver, describeValue);
    await act(async () => root?.unmount());
    root = null;

    expect(errorSpy).toHaveBeenCalledTimes(1);
    const [line] = errorSpy.mock.calls[0] as [string];
    expect(line).toContain("notes/draft.md");
    expect(line).toContain("disk full");
    expect(line).not.toContain("top secret body");
    errorSpy.mockRestore();
  });

  it("writes nothing when describe returns null for a failed settle", async () => {
    const error = new Error("disk full");
    const saver = createDebouncedSaver<string>(() => {
      throw error;
    }, 250);
    saver.schedule("draft.md");
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);

    await mount(saver, () => null);
    await act(async () => root?.unmount());
    root = null;

    expect(errorSpy).not.toHaveBeenCalled();
    errorSpy.mockRestore();
  });
});

describe("reportTeardownSaveFailure", () => {
  beforeEach(() => {
    // Full reset (not just clear) so no persistent default implementation
    // leaks in from the useTeardownFlush describe block above; every test
    // here sets its own explicit writeRecoveryCopy behavior.
    mocks.writeRecoveryCopy.mockReset();
  });

  it("publishes the failedNoCopy message and logs both reasons when the recovery copy also fails", async () => {
    mocks.writeRecoveryCopy.mockRejectedValueOnce(new Error("disk full (copy)"));
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const target: TeardownSaveTarget = {
      workPath: "/work",
      filePath: "notes/draft.md",
      content: "top secret body",
    };

    await reportTeardownSaveFailure(target, new Error("disk full"), t);

    const notice = getOperationNotice();
    expect(notice?.kind).toBe("error");
    expect(notice?.message).toBe("save.teardown.failedNoCopy");
    expect(notice?.recovery).toBeUndefined();

    expect(errorSpy).toHaveBeenCalledTimes(1);
    const [line] = errorSpy.mock.calls[0] as [string];
    expect(line).toContain("notes/draft.md");
    expect(line).toContain("disk full");
    expect(line).toContain("disk full (copy)");
    expect(line).not.toContain("top secret body");
    errorSpy.mockRestore();
  });

  it("publishes the failed message with a recovery path when the copy succeeds, and never leaks content", async () => {
    mocks.writeRecoveryCopy.mockResolvedValueOnce(".maru/recovery/20260925-notes-abcd1234.md");
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const target: TeardownSaveTarget = {
      workPath: "/work",
      filePath: "notes/draft.md",
      content: "top secret body",
    };

    await reportTeardownSaveFailure(target, new Error("disk full"), t);

    const notice = getOperationNotice();
    expect(notice?.message).toBe("save.teardown.failed");
    expect(notice?.recovery).toEqual({
      workPath: "/work",
      path: ".maru/recovery/20260925-notes-abcd1234.md",
    });
    expect(notice?.message).not.toContain("top secret body");

    const [line] = errorSpy.mock.calls[0] as [string];
    expect(line).toContain("notes/draft.md");
    expect(line).toContain("disk full");
    expect(line).toContain(".maru/recovery/20260925-notes-abcd1234.md");
    expect(line).not.toContain("top secret body");
    errorSpy.mockRestore();
  });

  it("two concurrent failures publish two distinct notices, dismissing the first exposes the second, and each gets its own recovery write", async () => {
    mocks.writeRecoveryCopy
      .mockResolvedValueOnce("recovery/a.md")
      .mockResolvedValueOnce("recovery/b.md");
    const targetA: TeardownSaveTarget = { workPath: "/work", filePath: "a.md", content: "A" };
    const targetB: TeardownSaveTarget = { workPath: "/work", filePath: "b.md", content: "B" };
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);

    await Promise.all([
      reportTeardownSaveFailure(targetA, new Error("disk full"), t),
      reportTeardownSaveFailure(targetB, new Error("disk full"), t),
    ]);

    expect(mocks.writeRecoveryCopy).toHaveBeenCalledTimes(2);
    expect(mocks.writeRecoveryCopy).toHaveBeenNthCalledWith(1, "/work", "a.md", "A", "disk full");
    expect(mocks.writeRecoveryCopy).toHaveBeenNthCalledWith(2, "/work", "b.md", "B", "disk full");

    const first = getOperationNotice();
    expect(first).toBeTruthy();
    const firstId = first?.operationId as string;
    dismissOperationNotice(firstId);

    const second = getOperationNotice();
    expect(second).toBeTruthy();
    expect(second?.operationId).not.toBe(firstId);
    dismissOperationNotice(second?.operationId as string);
    errorSpy.mockRestore();
  });

  it("clears the single-slot error toast only when it holds this same reason", async () => {
    mocks.writeRecoveryCopy.mockResolvedValueOnce("recovery/c.md");
    setError("disk full");
    const target: TeardownSaveTarget = { workPath: "/work", filePath: "c.md", content: "C" };

    await reportTeardownSaveFailure(target, new Error("disk full"), t);

    expect(await readError()).toBeNull();
    dismissOperationNotice(getOperationNotice()?.operationId as string);
  });

  it("leaves the single-slot error toast untouched when it holds a different message", async () => {
    mocks.writeRecoveryCopy.mockResolvedValueOnce("recovery/d.md");
    setError("some other error");
    const target: TeardownSaveTarget = { workPath: "/work", filePath: "d.md", content: "D" };

    await reportTeardownSaveFailure(target, new Error("disk full"), t);

    expect(await readError()).toBe("some other error");
    dismissOperationNotice(getOperationNotice()?.operationId as string);
  });
});
