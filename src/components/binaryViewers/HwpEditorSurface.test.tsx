// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { DocumentHandle, HwpEngine } from "@hwp-editor/core";
import { unmountReactRoot } from "../../lib/testing/unmountReactRoot";
const mocks = vi.hoisted(() => ({ factory: vi.fn(), props: null as null | { file: DocumentHandle; engine: HwpEngine; readOnly: boolean } }));
vi.mock("../../lib/hwped", () => ({ createHwpedEngine: mocks.factory }));
vi.mock("@hwp-editor/react", () => ({ HwpEditor: (props: NonNullable<typeof mocks.props>) => { mocks.props = props; return <div />; } }));
import { HwpEditorSurface } from "./HwpEditorSurface";
import { LocaleContext } from "../../lib/i18n";

describe("HwpEditorSurface memory and activity boundary", () => {
  let root: Root; let container: HTMLDivElement;
  const file = { name: "report.hwpx", data: new Uint8Array([1, 2, 3]) };
  const activity = vi.fn();
  const base = { read: vi.fn(), render: vi.fn(), edit: vi.fn(), validate: vi.fn(), compose: vi.fn(), capabilities: vi.fn() };
  beforeEach(() => {
    (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    vi.clearAllMocks(); mocks.props = null; mocks.factory.mockReturnValue(base);
    container = document.createElement("div"); document.body.appendChild(container); root = createRoot(container);
  });
  afterEach(async () => { await unmountReactRoot(root); container.remove(); });
  async function render(locked = false) {
    await act(async () => root.render(<LocaleContext.Provider value={{ locale: "ko", setLocale: () => {}, t: (key) => key }}><HwpEditorSurface workspacePath="/workspace" file={file} locked={locked} onReady={() => {}} onChange={() => {}} onDirtyChange={() => {}} onActivityChange={activity} onError={() => {}} /></LocaleContext.Provider>));
  }
  it("never resolves an initial or same-name edited handle to a disk path", async () => {
    await render(); const options = mocks.factory.mock.calls[0][0] as { pathOf: (document: DocumentHandle) => string | undefined };
    expect(options.pathOf(file)).toBeUndefined(); expect(options.pathOf({ name: file.name, data: new Uint8Array([9]) })).toBeUndefined(); expect(mocks.props!.file.data).toEqual(file.data);
  });
  it("tracks overlapping read/render activity until both settle", async () => {
    let readDone!: (value: unknown) => void; let renderDone!: (value: unknown) => void;
    base.read.mockReturnValue(new Promise((resolve) => { readDone = resolve; })); base.render.mockReturnValue(new Promise((resolve) => { renderDone = resolve; }));
    await render(); const reading = mocks.props!.engine.read(file); const rendering = mocks.props!.engine.render(file);
    expect(activity.mock.calls).toEqual([[true], [true]]); readDone({}); await reading; expect(activity).toHaveBeenLastCalledWith(true); renderDone([]); await rendering; expect(activity).toHaveBeenLastCalledWith(false);
  });
  it("refuses composition before creating a document with a different origin", async () => {
    await render(); await expect(mocks.props!.engine.compose({} as never, "new.hwpx")).rejects.toThrow("hwpEditorComposeUnsupported"); expect(base.compose).not.toHaveBeenCalled();
  });
  it("refuses engine mutations while saving and restores activity on failure", async () => {
    await render(true); await expect(mocks.props!.engine.edit(file, [])).rejects.toThrow("hwpEditorBusy"); expect(base.edit).not.toHaveBeenCalled();
    await render(false); base.edit.mockRejectedValue(new Error("engine failed")); await expect(mocks.props!.engine.edit(file, [])).rejects.toThrow("engine failed"); expect(activity).toHaveBeenLastCalledWith(false);
  });
});
