// @vitest-environment jsdom

import { act } from "react";
import { createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createDebouncedSaver } from "./debouncedSave";
import { useTeardownFlush, type TeardownSaveTarget, type Translate } from "./teardownSave";

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT =
  true;

const t: Translate = (key) => key;

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
