// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { LocaleContext, t } from "../../../lib/i18n";
import "../../../lib/i18n/testing";
import { unmountReactRoot } from "../../../lib/testing/unmountReactRoot";
import { RendersDialog } from "./RendersDialog";
import { parseRenderReceipt, type RenderGroup, type RenderReceipt } from "../../../lib/diagram/renders";
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
const mocks = vi.hoisted(() => ({ available: vi.fn(), list: vi.fn(), prepare: vi.fn(), remove: vi.fn(), open: vi.fn() }));
vi.mock("../../../lib/diagram/renders", async (original) => ({ ...await original<typeof import("../../../lib/diagram/renders")>(), rendersAvailable: mocks.available, listRenders: mocks.list, prepareRenderView: mocks.prepare, deleteRender: mocks.remove, openRender: mocks.open }));
vi.mock("../../../lib/binaryViewer", () => ({ assetUrlForPath: (file: string) => `asset://localhost/${file}` }));
const receipt: RenderReceipt = {
  schemaVersion: 1, docId: "doc-a", documentName: "saved", documentRevision: "a".repeat(64), diagramType: "architecture", renderedAt: "2026-11-08T00:00:00Z",
  inputSpecSha256: "b".repeat(64), outputSha256: "c".repeat(64), outputMimeType: "text/html", enginePin: { name: "archify", version: "3.0.0", revision: "pin" },
  gates: { schema: { status: "passed", scope: "schema" }, artifact: { status: "passed", scope: "artifact" }, browser: { status: "not-run", scope: "none" }, visualReview: { status: "not-run", scope: "manual" } },
};
const engineSvgReceipt: RenderReceipt = {
  schemaVersion: 1, docId: "native-static-export", documentName: "Native engine export", documentRevision: "d".repeat(64),
  datasetId: "native-static-export-dataset", diagramType: "architecture", renderedAt: "2026-11-09T00:00:00Z",
  inputSpecSha256: "e".repeat(64), engine: { id: "maru-diagram-engine", version: "0.2.0", revision: "render-v1" },
  engineOutputSha256: "f".repeat(64), outputSha256: "1".repeat(64), outputMimeType: "image/svg+xml",
  conversion: { format: "svg", theme: "light", pixelRatio: 1 },
  gates: { schema: { status: "passed", scope: "architecture-document-validity" }, artifact: { status: "passed", scope: "independent-svg-artifact" }, browser: { status: "not-run", scope: "non-browser-rasterization" }, visualReview: { status: "not-run", scope: "manual" } },
};
const enginePngReceipt: RenderReceipt = {
  ...engineSvgReceipt,
  renderedAt: "2026-11-09T00:00:01Z",
  outputSha256: "2".repeat(64),
  outputMimeType: "image/png",
  conversion: { format: "png", theme: "dark", pixelRatio: 1 },
  gates: { ...engineSvgReceipt.gates, artifact: { status: "passed", scope: "independent-svg-and-png-artifacts" } },
};
const group: RenderGroup = { docId: "doc-a", documentName: "saved", orphaned: false, renders: [{ docId: "doc-a", renderId: "render-a", verified: true, artifactName: "index.html", receipt }] };
const mixedHistory: RenderGroup[] = [
  {
    docId: "native-static-export",
    documentName: "Native engine export",
    orphaned: true,
    renders: [
      { docId: "native-static-export", renderId: "engine-svg", verified: true, artifactName: "render.svg", receipt: engineSvgReceipt },
      { docId: "native-static-export", renderId: "engine-png", verified: true, artifactName: "render.png", receipt: enginePngReceipt },
    ],
  },
  {
    docId: "native-render-doc",
    documentName: "native-render",
    orphaned: false,
    renders: [{ docId: "native-render-doc", renderId: "legacy-html", verified: true, artifactName: "index.html", receipt }],
  },
];
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
  it("keeps engine image entries ahead of a legacy HTML entry without rejecting its enginePin receipt", async () => {
    mocks.list.mockResolvedValue(mixedHistory);
    mocks.prepare.mockImplementation(async (_workspace: string, _docId: string, renderId: string) => {
      if (renderId === "legacy-html") return { path: "legacy/index.html", mimeType: "text/html", receipt };
      return {
        path: renderId === "engine-png" ? "engine/render.png" : "engine/render.svg",
        mimeType: renderId === "engine-png" ? "image/png" : "image/svg+xml",
        receipt: renderId === "engine-png" ? enginePngReceipt : engineSvgReceipt,
      };
    });
    expect(parseRenderReceipt(engineSvgReceipt)?.engine).toEqual({ id: "maru-diagram-engine", version: "0.2.0", revision: "render-v1" });
    expect(parseRenderReceipt(receipt)?.engine).toEqual({ id: "archify", version: "3.0.0", revision: "pin" });

    await mount("light");
    const entries = () => [...document.querySelectorAll<HTMLButtonElement>('[data-testid="diagram-render-entry"]')];
    expect(entries()).toHaveLength(3);
    await act(async () => { entries()[0]!.click(); });
    expect(document.querySelector("img")?.getAttribute("src")).toContain("engine/render.svg");
    expect(document.querySelector("iframe")).toBeNull();

    await act(async () => { entries()[2]!.click(); });
    const frame = document.querySelector<HTMLIFrameElement>("iframe")!;
    expect(frame).not.toBeNull();
    expect(frame.src).toContain("legacy/index.html?theme=light");
    expect(frame.getAttribute("sandbox")?.split(" ")).not.toContain("allow-same-origin");
    expect(frame.getAttribute("referrerpolicy")).toBe("no-referrer");

    await mount("dark");
    const darkFrame = document.querySelector<HTMLIFrameElement>("iframe")!;
    expect(darkFrame).not.toBe(frame);
    expect(darkFrame.src).toContain("legacy/index.html?theme=dark");
    expect(darkFrame.getAttribute("sandbox")).toBe(frame.getAttribute("sandbox"));
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
