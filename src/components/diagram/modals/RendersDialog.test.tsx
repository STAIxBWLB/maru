// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { LocaleContext, t } from "../../../lib/i18n";
import "../../../lib/i18n/testing";
import { unmountReactRoot } from "../../../lib/testing/unmountReactRoot";
import { RendersDialog } from "./RendersDialog";
import type { RenderGroup, RenderReceipt } from "../../../lib/diagram/renders";
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
const mocks = vi.hoisted(() => ({ available: vi.fn(), list: vi.fn(), prepare: vi.fn(), remove: vi.fn(), open: vi.fn() }));
vi.mock("../../../lib/diagram/renders", async (original) => ({ ...await original<typeof import("../../../lib/diagram/renders")>(), rendersAvailable: mocks.available, listRenders: mocks.list, prepareRenderView: mocks.prepare, deleteRender: mocks.remove, openRender: mocks.open }));
vi.mock("../../../lib/binaryViewer", () => ({ assetUrlForPath: (file: string) => `asset://localhost/${file}` }));
const receipt: RenderReceipt = {
  schemaVersion: 1, docId: "doc-a", documentName: "saved", documentRevision: "a".repeat(64), diagramType: "architecture", renderedAt: "2026-11-08T00:00:00Z",
  inputSpecSha256: "b".repeat(64), outputSha256: "c".repeat(64), outputMimeType: "text/html", enginePin: { name: "archify", version: "3.0.0", revision: "pin" },
  gates: { schema: { status: "passed", scope: "schema" }, artifact: { status: "passed", scope: "artifact" }, browser: { status: "not-run", scope: "none" }, visualReview: { status: "not-run", scope: "manual" } },
};
const group: RenderGroup = { docId: "doc-a", documentName: "saved", orphaned: false, renders: [{ docId: "doc-a", renderId: "render-a", verified: true, artifactName: "index.html", receipt }] };
let root: Root | undefined;
let container: HTMLDivElement;
async function mount(theme: "light" | "dark" = "light") {
  if (!root) { container = document.createElement("div"); document.body.append(container); root = createRoot(container); }
  await act(async () => root!.render(<LocaleContext.Provider value={{ locale: "en", setLocale: vi.fn(), t: (key, params) => t("en", key, params) }}><RendersDialog open workspace="/fixture" theme={theme} onClose={vi.fn()} onRerender={vi.fn(async () => {})} /></LocaleContext.Provider>));
}
async function click(selector: string) { await act(async () => { document.querySelector<HTMLButtonElement>(selector)!.click(); }); }
beforeEach(() => { vi.clearAllMocks(); mocks.available.mockReturnValue(true); mocks.list.mockResolvedValue([group]); mocks.prepare.mockResolvedValue({ path: "index.html", mimeType: "text/html", receipt }); });
afterEach(async () => { if (root) await unmountReactRoot(root); root = undefined; document.body.innerHTML = ""; });
describe("RendersDialog", () => {
  it("shows an honest desktop-only state with no browser placeholder entries", async () => {
    mocks.available.mockReturnValue(false); await mount();
    expect(document.body.textContent).toContain("require the desktop app");
    expect(mocks.list).not.toHaveBeenCalled(); expect(document.querySelector("iframe")).toBeNull();
  });
  it.each(["render_store_failed", "<script>forged</script>", 42])("shows structured list errors as inert text (%s)", async (code) => {
    mocks.list.mockRejectedValue({ code, message: "History cannot be read.", nextStep: "Reopen the workspace and refresh." });
    await mount();
    expect(document.querySelector('[role="alert"]')?.textContent).toContain("History cannot be read. Reopen the workspace and refresh.");
    expect(document.body.textContent).not.toContain("[object Object]");
    expect(document.querySelector("script")).toBeNull();
  });
  it("shows structured preparation and delete recovery messages", async () => {
    mocks.prepare.mockRejectedValue({ code: "render_invalid", message: "Artifact changed.", nextStep: "Re-render the diagram." });
    await mount(); await click('[data-testid="diagram-render-entry"]');
    expect(document.querySelector('[role="alert"]')?.textContent).toContain("Artifact changed. Re-render the diagram.");
    mocks.remove.mockRejectedValue({ code: "render_delete_failed", message: "History is busy.", nextStep: "Close the viewer and retry." });
    const buttons = () => [...document.querySelectorAll<HTMLButtonElement>("button")];
    await act(async () => buttons().find((button) => button.textContent === "Delete render")!.click());
    await act(async () => buttons().find((button) => button.textContent === "Confirm deletion")!.click());
    expect(document.body.textContent).toContain("History is busy. Close the viewer and retry.");
  });
  it("only mounts a prepared viewer, preserves sandbox and remounts for theme changes", async () => {
    await mount(); expect(document.querySelector("iframe")).toBeNull();
    await click('[data-testid="diagram-render-entry"]');
    const first = document.querySelector("iframe")!;
    expect(first.getAttribute("sandbox")?.split(" ")).not.toContain("allow-same-origin");
    expect(first.getAttribute("referrerpolicy")).toBe("no-referrer"); expect(first.src).toContain("theme=light");
    await mount("dark"); const next = document.querySelector("iframe")!;
    expect(next).not.toBe(first); expect(next.src).toContain("theme=dark");
    expect(mocks.prepare).toHaveBeenCalledTimes(2);
  });
  it("keeps mismatched and missing-receipt renders unviewable but deletable after confirmation", async () => {
    mocks.list.mockResolvedValue([{ ...group, orphaned: true, renders: [{ ...group.renders[0], verified: false, receipt: null, diagnostic: "receipt.json is missing; re-render" }] }]);
    mocks.prepare.mockRejectedValue(new Error("index.html changed; re-render the diagram"));
    await mount(); await click('[data-testid="diagram-render-entry"]');
    expect(document.querySelector("iframe")).toBeNull(); expect(document.body.textContent).toContain("index.html changed; re-render");
    const remove = [...document.querySelectorAll<HTMLButtonElement>("button")].find((button) => button.textContent === "Delete render")!;
    await act(async () => remove.click()); expect(mocks.remove).not.toHaveBeenCalled();
    const confirm = [...document.querySelectorAll<HTMLButtonElement>("button")].find((button) => button.textContent === "Confirm deletion")!;
    await act(async () => confirm.click()); expect(mocks.remove).toHaveBeenCalledWith("/fixture", "doc-a", "render-a");
  });
  it("keeps ambiguous groups viewable and deletable while disabling re-render with a recovery reason", async () => {
    mocks.list.mockResolvedValue([{ ...group, ambiguous: true, diagnostic: "Two diagrams share this ID; change one ID and refresh" }]);
    await mount(); await click('[data-testid="diagram-render-entry"]');
    expect(document.querySelector("iframe")).not.toBeNull();
    const buttons = [...document.querySelectorAll<HTMLButtonElement>("button")];
    expect(buttons.find((button) => button.textContent === "Re-render")?.disabled).toBe(true);
    expect(buttons.find((button) => button.textContent === "Delete render")?.disabled).toBe(false);
    expect(document.body.textContent).toContain("change one ID and refresh");
  });

});
