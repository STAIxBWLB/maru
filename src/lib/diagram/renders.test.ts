// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { archifySpecToDataset } from "./archifyCodec";
import { SEMANTIC_FIXTURES } from "./__fixtures__/semantic";
import { createEmptyDoc } from "./types";
import { rerenderDocument, type RenderGroup, type RenderReceipt, type StoredRender } from "./renders";
const mocks = vi.hoisted(() => ({ read: vi.fn(), render: vi.fn() }));
vi.mock("./persistence", async (original) => ({ ...await original<typeof import("./persistence")>(), readDiagramDetailed: mocks.read }));
vi.mock("../archify", async (original) => ({ ...await original<typeof import("../archify")>(), archifyRenderCandidate: mocks.render }));
const receipt: RenderReceipt = {
  schemaVersion: 1, docId: "doc", documentName: "saved", documentRevision: "a".repeat(64), diagramType: "architecture", renderedAt: "2026-11-08T00:00:00Z",
  inputSpecSha256: "b".repeat(64), outputSha256: "c".repeat(64), outputMimeType: "text/html", enginePin: { name: "archify", version: "3.0.0", revision: "pin" },
  gates: { schema: { status: "passed", scope: "schema" }, artifact: { status: "passed", scope: "artifact" }, browser: { status: "not-run", scope: "none" }, visualReview: { status: "not-run", scope: "manual" } },
};
const group: RenderGroup = { docId: "doc", documentName: "current-file", orphaned: false, renders: [] };
function source() {
  const doc = createEmptyDoc("doc", 1);
  const first = archifySpecToDataset("architecture", SEMANTIC_FIXTURES.architecture, { id: "first" }).dataset;
  const second = archifySpecToDataset("architecture", SEMANTIC_FIXTURES.architecture, { id: "second" }).dataset;
  doc.datasets = [first, second];
  mocks.read.mockResolvedValue({ doc, fileRevision: "f".repeat(64) });
  return { doc, first, second };
}
beforeEach(() => { vi.clearAllMocks(); Object.defineProperty(window, "__TAURI_INTERNALS__", { configurable: true, value: {} }); });
afterEach(() => { delete window.__TAURI_INTERNALS__; });
describe("saved render source binding", () => {
  it("re-renders the bound current dataset when several semantic datasets exist", async () => {
    const { doc, second } = source();
    second.spec = { ...second.spec, meta: { title: "Current changed source", output: "current.html" } };
    const before = JSON.stringify(doc);
    const render: StoredRender = { docId: "doc", renderId: "id", verified: true, receipt: { ...receipt, datasetId: "second" } };
    await rerenderDocument("/workspace", group, render);
    expect(mocks.read).toHaveBeenCalledWith("/workspace", "current-file");
    expect(mocks.render).toHaveBeenCalledWith("/workspace", "architecture", JSON.stringify(second.spec), {
      docId: "doc", documentName: "current-file", documentRevision: "f".repeat(64), diagramType: "architecture", datasetId: "second",
    });
    expect(JSON.stringify(doc)).toBe(before);
  });
  it("refuses an ambiguous legacy receipt or a removed source instead of choosing another dataset", async () => {
    source();
    const render: StoredRender = { docId: "doc", renderId: "id", verified: true, receipt };
    await expect(rerenderDocument("/workspace", group, render)).rejects.toThrow(/no unique source dataset/);
    await expect(rerenderDocument("/workspace", group, { ...render, receipt: { ...receipt, datasetId: "removed" } })).rejects.toThrow(/select/i);
    expect(mocks.render).not.toHaveBeenCalled();
  });
  it("allows a unique legacy source and holds a missing document for restoration", async () => {
    const { doc, first } = source(); doc.datasets = [first];
    await rerenderDocument("/workspace", group, { docId: "doc", renderId: "legacy", verified: true, receipt });
    expect(mocks.render).toHaveBeenCalledTimes(1);
    await expect(rerenderDocument("/workspace", { ...group, orphaned: true })).rejects.toThrow(/restore/);
    expect(mocks.render).toHaveBeenCalledTimes(1);
  });
  it("does not change diagram type for a legacy receipt with a sole mismatched dataset", async () => {
    const { doc } = source();
    doc.datasets = [archifySpecToDataset("workflow", SEMANTIC_FIXTURES.workflow).dataset];
    await expect(rerenderDocument("/workspace", group, { docId: "doc", renderId: "legacy", verified: true, receipt })).rejects.toThrow(/no unique source dataset/);
    expect(mocks.render).not.toHaveBeenCalled();
  });

  it("uses the original document identity when the store key is hashed", async () => {
    const { doc, first } = source(); doc.id = "도식"; doc.datasets = [first];
    await rerenderDocument("/workspace", { ...group, docId: "__hashed_bucket", originalDocId: "도식" }, { docId: "__hashed_bucket", renderId: "legacy", verified: true, receipt: { ...receipt, docId: "도식" } });
    expect(mocks.render).toHaveBeenCalledWith("/workspace", "architecture", JSON.stringify(first.spec), expect.objectContaining({ docId: "도식" }));
  });

  it("surfaces a nonfatal renderer history warning when the action specifically requests a stored rerender", async () => {
    const { doc, first } = source(); doc.datasets = [first];
    mocks.render.mockResolvedValueOnce({ storeWarning: "Render store is not writable; repair permissions and retry" });
    await expect(rerenderDocument("/workspace", group, { docId: "doc", renderId: "legacy", verified: true, receipt })).rejects.toThrow(/not kept in history.*repair permissions/);
  });

});
