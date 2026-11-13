// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { HwpEditorSurfaceProps } from "./HwpEditorSurface";
import { unmountReactRoot } from "../../lib/testing/unmountReactRoot";

const mocks = vi.hoisted(() => ({ capture: vi.fn(), save: vi.fn(), surface: null as HwpEditorSurfaceProps | null, writable: true, workspaceRoot: "/workspace" }));
vi.mock("../../lib/hwpedPersistence", () => ({ captureHwpedSource: mocks.capture, saveHwpedDocument: mocks.save }));
vi.mock("../../lib/workspaceStore", () => ({ useWorkspaceRegistry: () => ({ workspaces: [{ path: mocks.workspaceRoot, provider: "local", visibility: "private", writePolicy: mocks.writable ? "direct" : "readOnly" }] }) }));
vi.mock("./HwpxViewer", () => ({ HwpxViewer: () => <div data-testid="preview" /> }));
vi.mock("./HwpEditorSurface", () => ({ HwpEditorSurface: (props: HwpEditorSurfaceProps) => { mocks.surface = props; return <div data-testid="editor-surface" />; } }));

import { HwpxEditorPane } from "./HwpxEditorPane";
import { LocaleContext } from "../../lib/i18n";
import { requestHwpxEditorNavigation } from "../../lib/hwpxEditorGuard";
import type { WorkspaceFileEntry } from "../../lib/types";
const t = (key: string, vars?: Record<string, string | number>) => vars?.message ? `${key}: ${vars.message}` : key;
const entry: WorkspaceFileEntry = { path: "/workspace/report.hwpx", relPath: "report.hwpx", name: "report.hwpx", extension: "hwpx", fileKind: "hwpx", sizeBytes: 10, updatedAt: null, gitTracked: false, binary: true };
const baseline = new Uint8Array([1, 2, 3]);

describe("HwpxEditorPane persistence", () => {
  let container: HTMLDivElement;
  let root: Root | null = null;
  beforeEach(() => {
    (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    mocks.surface = null; mocks.writable = true; mocks.workspaceRoot = "/workspace"; mocks.capture.mockReset(); mocks.save.mockReset();
    mocks.capture.mockResolvedValue({ source: { dataBase64: "AQID", revision: "a".repeat(64) } });
    mocks.save.mockResolvedValue({ revision: "b".repeat(64), sizeBytes: 2, snapshotPath: ".maru/versions/original.hwpx" });
    container = document.createElement("div"); document.body.appendChild(container); root = createRoot(container);
  });
  afterEach(async () => { if (root) await unmountReactRoot(root); root = null; container.remove(); });
  async function render(target = entry, workspacePath = "/workspace") {
    await act(async () => { root!.render(<LocaleContext.Provider value={{ locale: "ko", setLocale: () => {}, t }}><HwpxEditorPane entry={target} workspacePath={workspacePath} onPreviewExternal={() => {}} onOpenExternal={() => {}} /></LocaleContext.Provider>); });
  }
  const query = (id: string) => document.querySelector<HTMLButtonElement>(`[data-testid="${id}"]`)!;
  async function open() {
    await act(async () => { container.querySelector<HTMLButtonElement>(".hwp-editor-pane-toggle")!.click(); });
    await act(async () => {});
    await act(async () => { mocks.surface!.onReady(mocks.surface!.file); });
  }
  async function change(data = new Uint8Array([9, 9])) {
    await act(async () => { mocks.surface!.onChange({ name: entry.name, data }); });
  }
  it("keeps preview default and captures real bytes only when opening", async () => {
    await render(); expect(query("preview")).not.toBeNull(); expect(mocks.capture).not.toHaveBeenCalled();
    await open(); expect(mocks.capture).toHaveBeenCalledWith("/workspace", "report.hwpx"); expect(mocks.surface!.file.data).toEqual(baseline); expect(query("hwpx-save").disabled).toBe(true);
  });
  it("separates pending from applied-unsaved and preserves unsaved after Apply and preview", async () => {
    await render(); await open();
    await act(async () => mocks.surface!.onDirtyChange(true));
    expect(query("hwpx-save").disabled).toBe(true); expect(query("hwpx-status").textContent).toContain("hwpEditorApplyFirst");
    await change(); await act(async () => mocks.surface!.onDirtyChange(false));
    expect(query("hwpx-save").disabled).toBe(false);
    await act(async () => container.querySelector<HTMLButtonElement>(".hwp-editor-pane-toggle")!.click());
    expect(container.querySelector(".hwp-editor-host")!.hasAttribute("hidden")).toBe(true); expect(query("hwpx-status").textContent).toContain("hwpEditorNotSaved");
  });
  it("undo back to exact baseline clears unsaved", async () => {
    await render(); await open(); await change(); await change(baseline.slice()); expect(query("hwpx-save").disabled).toBe(true); expect(query("hwpx-status").textContent).not.toContain("hwpEditorNotSaved");
  });
  it("saves captured applied bytes and revision once, then advances the baseline", async () => {
    let finish!: (value: unknown) => void; mocks.save.mockReturnValue(new Promise((resolve) => { finish = resolve; }));
    await render(); await open(); await change();
    await act(async () => { query("hwpx-save").click(); query("hwpx-save").click(); });
    expect(mocks.save).toHaveBeenCalledTimes(1); expect(mocks.save).toHaveBeenCalledWith("/workspace", "report.hwpx", "CQk=", "a".repeat(64)); expect(mocks.surface!.locked).toBe(true);
    await act(async () => finish({ revision: "b".repeat(64), sizeBytes: 2, snapshotPath: ".maru/versions/a.hwpx" }));
    expect(query("hwpx-status").textContent).toContain("hwpEditorSaved"); expect(query("hwpx-save").disabled).toBe(true);
  });
  it("blocks saving during engine activity and in a read-only workspace", async () => {
    await render(); await open(); await change(); await act(async () => mocks.surface!.onActivityChange(true)); expect(query("hwpx-save").disabled).toBe(true);
    await act(async () => mocks.surface!.onActivityChange(false)); mocks.writable = false; await render(); expect(query("hwpx-save").disabled).toBe(true);
  });
  it("synchronously refuses a save as engine activity starts before React commits", async () => {
    await render(); await open(); await change();
    await act(async () => { mocks.surface!.onActivityChange(true); query("hwpx-save").click(); });
    expect(mocks.save).not.toHaveBeenCalled();
  });
  it("retains edits on failure and only normalized document conflicts offer reload", async () => {
    mocks.save.mockRejectedValue({ code: "forged_conflict", message: "denied" });
    await render(); await open(); await change(); await act(async () => query("hwpx-save").click());
    expect(query("hwpx-error")).not.toBeNull(); expect(query("hwpx-conflict")).toBeNull(); expect(query("hwpx-save").disabled).toBe(false);
    mocks.save.mockRejectedValue({ code: "document_conflict", message: "changed" }); await act(async () => query("hwpx-save").click());
    expect(query("hwpx-conflict")).not.toBeNull(); expect(mocks.surface!.file.data).toEqual(baseline);
    await act(async () => query("hwpx-reload").click()); await act(async () => query("hwpx-discard-cancel").click()); expect(mocks.capture).toHaveBeenCalledTimes(1);
    mocks.capture.mockRejectedValue(new Error("read failed")); await act(async () => query("hwpx-reload").click()); await act(async () => query("hwpx-discard").click());
    expect(query("hwpx-save").disabled).toBe(false); expect(query("hwpx-status").textContent).toContain("hwpEditorNotSaved");
    expect(query("hwpx-error").textContent).toContain("read failed"); expect(query("hwpx-conflict")).not.toBeNull();
  });
  it("cancelled navigation preserves edits; failed save cannot approve leaving", async () => {
    await render(); await open(); await change(); let decision!: Promise<boolean>;
    await act(async () => { decision = requestHwpxEditorNavigation(); }); expect(query("hwpx-discard-dialog")).not.toBeNull();
    await act(async () => query("hwpx-discard-cancel").click()); expect(await decision).toBe(false); expect(query("hwpx-save").disabled).toBe(false);
    await act(async () => { decision = requestHwpxEditorNavigation(); }); mocks.save.mockRejectedValue(new Error("failed")); await act(async () => query("hwpx-discard-save").click());
    expect(query("hwpx-discard-dialog")).toBeNull(); expect(await decision).toBe(false);
    expect(query("hwpx-error").textContent).toContain("failed"); expect(query("hwpx-save").disabled).toBe(false);
  });
  it("a late save cannot clear another path or workspace session", async () => {
    let finish!: (value: unknown) => void; mocks.save.mockReturnValue(new Promise((resolve) => { finish = resolve; }));
    await render(); await open(); await change(); await act(async () => query("hwpx-save").click());
    await render({ ...entry, path: "/workspace/other/report.hwpx", relPath: "other/report.hwpx" }); await open(); await change(new Uint8Array([8]));
    await act(async () => finish({ revision: "b".repeat(64), sizeBytes: 2, snapshotPath: "old.hwpx" })); expect(query("hwpx-status").textContent).toContain("hwpEditorNotSaved");
    await render({ ...entry, path: "/second/report.hwpx" }, "/second"); expect(container.querySelector('[data-testid="editor-surface"]')).toBeNull();
  });
  it("separates newline-containing workspace/path pairs and ignores the old session's results", async () => {
    const firstRoot = "/workspace";
    const firstRelPath = "nested\nreport.hwpx";
    const secondRoot = "/workspace\nnested";
    const secondRelPath = "report.hwpx";
    expect(`${firstRoot}\n${firstRelPath}`).toBe(`${secondRoot}\n${secondRelPath}`);
    const firstEntry = { ...entry, path: `${firstRoot}/${firstRelPath}`, relPath: firstRelPath, name: firstRelPath };
    const secondEntry = { ...entry, path: `${secondRoot}/${secondRelPath}`, relPath: secondRelPath };
    let finishOldSave!: (value: unknown) => void;
    mocks.save.mockReturnValueOnce(new Promise((resolve) => { finishOldSave = resolve; }));
    await render(firstEntry, firstRoot); await open(); await change();
    const oldSurface = mocks.surface!;
    await act(async () => query("hwpx-save").click());

    mocks.workspaceRoot = secondRoot;
    await render(secondEntry, secondRoot);
    expect(container.querySelector('[data-testid="editor-surface"]')).toBeNull();
    expect(query("hwpx-save")).toBeNull();
    await open();
    expect(mocks.capture).toHaveBeenCalledTimes(2);
    expect(mocks.capture).toHaveBeenNthCalledWith(1, firstRoot, firstRelPath);
    expect(mocks.capture).toHaveBeenNthCalledWith(2, secondRoot, secondRelPath);
    // Both disk files intentionally have identical baseline bytes and SHA.
    // The old save and callbacks still belong solely to the first session.
    await act(async () => {
      finishOldSave({ revision: "b".repeat(64), sizeBytes: 2, snapshotPath: "old.hwpx" });
      oldSurface.onChange({ name: firstEntry.name, data: new Uint8Array([99]) });
      oldSurface.onDirtyChange(true); oldSurface.onActivityChange(true);
    });
    expect(query("hwpx-status").textContent).not.toContain("hwpEditorNotSaved");
    expect(query("hwpx-status").textContent).not.toContain("hwpEditorApplyFirst");
    expect(query("hwpx-status").textContent).not.toContain("hwpEditorSaved");
    expect(query("hwpx-save").disabled).toBe(true);
    await change(new Uint8Array([8]));
    await act(async () => query("hwpx-save").click());
    expect(mocks.save).toHaveBeenLastCalledWith(secondRoot, secondRelPath, "CA==", "a".repeat(64));
  });
  it("reload ignores callbacks from the old handle and keeps the new baseline", async () => {
    await render(); await open(); const oldSurface = mocks.surface!; await change();
    mocks.save.mockRejectedValue({ code: "document_conflict", message: "changed" });
    await act(async () => query("hwpx-save").click());
    mocks.capture.mockResolvedValue({ source: { dataBase64: "CAg=", revision: "c".repeat(64) } });
    await act(async () => query("hwpx-reload").click()); await act(async () => query("hwpx-discard").click());
    await act(async () => { mocks.surface!.onReady(mocks.surface!.file); oldSurface.onReady(oldSurface.file); oldSurface.onChange({ name: entry.name, data: new Uint8Array([9]) }); oldSurface.onDirtyChange(true); oldSurface.onActivityChange(true); });
    expect(query("hwpx-status").textContent).not.toContain("hwpEditorNotSaved"); expect(query("hwpx-status").textContent).not.toContain("hwpEditorApplyFirst");
    await change(new Uint8Array([7])); expect(query("hwpx-save").disabled).toBe(false);
  });
  it("editor accepts files beyond preview bound up to 32 MiB", async () => {
    await render({ ...entry, sizeBytes: 20 * 1024 * 1024 + 1 }); expect(container.querySelector(".hwp-editor-pane-toggle")).not.toBeNull();
    await render({ ...entry, sizeBytes: 32 * 1024 * 1024 + 1 }); expect(container.querySelector(".hwp-editor-pane-toggle")).toBeNull();
  });
});
