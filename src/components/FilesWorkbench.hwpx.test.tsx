// @vitest-environment jsdom
import { act, useEffect, useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { unmountReactRoot } from "../lib/testing/unmountReactRoot";
import type { WorkspaceEntryNode } from "../lib/types";
const mocks = vi.hoisted(() => ({ classify: vi.fn(), mounts: 0, unmounts: 0, category: "" }));
vi.mock("../lib/api", async (original) => ({ ...await original<typeof import("../lib/api")>(), binaryViewerClassify: mocks.classify }));
vi.mock("./BinaryViewerPane", () => ({ BinaryViewerPane: (props: { classification: { category: string } }) => {
  mocks.category = props.classification.category;
  const [edited, setEdited] = useState(false);
  useEffect(() => { mocks.mounts += 1; return () => { mocks.unmounts += 1; }; }, []);
  return <button data-testid="retained-editor" onClick={() => setEdited(true)}>{edited ? "unsaved Korean edits" : "original"}</button>;
} }));
import { FilesPreview } from "./FilesWorkbench";
import { LocaleContext } from "../lib/i18n";
const node: WorkspaceEntryNode = { kind: "file", targetKind: null, path: "/workspace/report.hwpx", relPath: "report.hwpx", parentRelPath: "", name: "report.hwpx", extension: "hwpx", fileKind: "hwpx", sizeBytes: 10, updatedAt: null, gitTracked: false, binary: true };
const t = (key: string) => key;
const prepare = () => {};
const reveal = () => {};
describe("Files preview retains the live HWPX session", () => {
  let root: Root; let container: HTMLDivElement;
  beforeEach(() => {
    (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    mocks.mounts = 0; mocks.unmounts = 0;
    mocks.classify.mockReset(); mocks.classify.mockResolvedValue({ category: "hwpx", detectedFormat: "hwpx", extension: "hwpx", sizeBytes: 10 });
    container = document.createElement("div"); document.body.appendChild(container); root = createRoot(container);
  });
  afterEach(async () => { await unmountReactRoot(root); container.remove(); });
  async function render(selectedEntries = [node]) {
    await act(async () => root.render(<LocaleContext.Provider value={{ locale: "ko", setLocale: () => {}, t }}><FilesPreview workspacePath="/workspace" entries={selectedEntries} selectedEntries={selectedEntries} selectedPaths={[node.path]} documentEditorPath={null} documentEditorNode={null} documentEditorError={null} onPrepareDocument={prepare} onReveal={reveal} /></LocaleContext.Provider>));
  }
  it("watcher metadata refresh does not unmount or reset unsaved edits", async () => {
    await render(); await act(async () => container.querySelector<HTMLButtonElement>("button")!.click());
    let finish!: (value: unknown) => void; mocks.classify.mockReturnValueOnce(new Promise((resolve) => { finish = resolve; }));
    await render([{ ...node, sizeBytes: 20, updatedAt: "2026-11-13T10:00:00Z" }]);
    expect(container.textContent).toContain("unsaved Korean edits"); expect(mocks.unmounts).toBe(0);
    await act(async () => finish({ category: "unsupported", detectedFormat: "unknown", extension: "hwpx", sizeBytes: 20 }));
    expect(container.textContent).toContain("unsaved Korean edits"); expect(mocks.mounts).toBe(1); expect(mocks.category).toBe("hwpx");
  });
  it("external deletion or classification failure keeps the selected editor mounted", async () => {
    await render(); await act(async () => container.querySelector<HTMLButtonElement>("button")!.click()); await render([]);
    expect(container.textContent).toContain("unsaved Korean edits"); expect(mocks.unmounts).toBe(0);
    mocks.classify.mockRejectedValueOnce(new Error("file disappeared")); await render([{ ...node, sizeBytes: 30 }]);
    expect(container.textContent).toContain("unsaved Korean edits"); expect(mocks.unmounts).toBe(0);
  });
});
