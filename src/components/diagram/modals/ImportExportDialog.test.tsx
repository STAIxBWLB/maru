// @vitest-environment jsdom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createHash } from "node:crypto";
import { name, revision, version } from "../../../../sidecars/archify/PIN.json";
import { unmountReactRoot } from "../../../lib/testing/unmountReactRoot";

import { matrixFromRowsCols, type MatrixCell, type MatrixDataset } from "../../../lib/diagram/reportTypes";
import { createEmptyDoc, type DiagramDoc } from "../../../lib/diagram/types";
import { archifySpecToDataset } from "../../../lib/diagram/archifyCodec";
import { SEMANTIC_FIXTURES } from "../../../lib/diagram/__fixtures__/semantic";
import { canonicalSemanticExportInput } from "../../../lib/diagram/export";
import { extractEngineSvg } from "../../../lib/diagram/engineSvg";
import { DiagramStoreProvider } from "../DiagramStoreContext";
import type { GenerationHost } from "../../../lib/diagram/generation";
import type { ArchifyRenderArtifact, ArchifyRenderHost } from "../../../lib/archify";
import { LocaleContext, t as translate } from "../../../lib/i18n";
import "../../../lib/i18n/testing";
import { ImportExportDialog } from "./ImportExportDialog";

const { chooseSaveFileMock, diagramExportBlobToPathMock } = vi.hoisted(() => ({
  chooseSaveFileMock: vi.fn(),
  diagramExportBlobToPathMock: vi.fn(),
}));
vi.mock("../../../lib/api", async (importOriginal) => ({
  ...await importOriginal<typeof import("../../../lib/api")>(),
  chooseSaveFile: chooseSaveFileMock,
}));
vi.mock("../../../lib/diagram", async (importOriginal) => ({
  ...await importOriginal<typeof import("../../../lib/diagram")>(),
  diagramExportBlobToPath: diagramExportBlobToPathMock,
}));

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

function filledMatrix(rows: string[][]): MatrixDataset {
  const matrix = matrixFromRowsCols(rows.length, Math.max(...rows.map((r) => r.length)));
  const rowIndex = new Map(matrix.rows.map((row, i) => [row.id, i]));
  const colIndex = new Map(matrix.columns.map((col, i) => [col.id, i]));
  const cells: Record<string, MatrixCell> = {};
  for (const cell of Object.values(matrix.cells)) {
    const r = rowIndex.get(cell.rowId) ?? 0;
    const c = colIndex.get(cell.colId) ?? 0;
    cells[cell.id] = { ...cell, text: rows[r]?.[c] ?? "" };
  }
  return { ...matrix, cells };
}

interface Harness {
  container: HTMLDivElement;
  root: Root;
  onImportDoc: ReturnType<typeof vi.fn>;
  onImportDataset: ReturnType<typeof vi.fn>;
  onClose: ReturnType<typeof vi.fn>;
  setDoc: (doc: DiagramDoc) => void;
}

function renderDialog(
  mode: "import" | "export",
  doc?: DiagramDoc,
  hostOverride: GenerationHost | null = null,
  workspace: string | null = null,
): Harness {
  const onImportDoc = vi.fn();
  const onImportDataset = vi.fn();
  const onClose = vi.fn();
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  const render = (currentDoc: DiagramDoc) => {
    act(() => {
      root.render(
        <DiagramStoreProvider workPath={workspace} hostOverride={hostOverride}>
          <LocaleContext.Provider
            value={{
              locale: "ko",
              setLocale: () => {},
              t: (key, vars) => translate("ko", key, vars),
            }}
          >
            <ImportExportDialog
              open
              mode={mode}
              doc={currentDoc}
              workspace={workspace}
              dirty={false}
              onImportDoc={onImportDoc}
              onImportDataset={onImportDataset}
              onClose={onClose}
            />
          </LocaleContext.Provider>
        </DiagramStoreProvider>,
      );
    });
  };
  render(doc ?? createEmptyDoc("doc-1", 1));
  return { container, root, onImportDoc, onImportDataset, onClose, setDoc: render };
}

function query<T extends Element>(selector: string): T | null {
  return document.body.querySelector<T>(selector);
}

async function pickFile(name: string, contents: string) {
  const input = query<HTMLInputElement>('[data-testid="ie-file-input"]')!;
  const file = new File([contents], name);
  Object.defineProperty(input, "files", { value: [file], configurable: true });
  await act(async () => {
    input.dispatchEvent(new Event("change", { bubbles: true }));
  });
}

async function click(el: Element) {
  await act(async () => {
    el.dispatchEvent(new MouseEvent("click", { bubbles: true }));
  });
}

function hash(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

const RENDER_HTML = '<!doctype html><html><body><svg viewBox="0 0 120 60"><text x="2" y="20">한글 다이어그램</text></svg></body></html>';

function renderArtifact(_diagramType: string, candidateJson: string): ArchifyRenderArtifact {
  const bytes = new TextEncoder().encode(RENDER_HTML);
  return {
    bytes: [...bytes],
    receipt: {
      schemaVersion: 1,
      inputSpecSha256: hash(new TextEncoder().encode(candidateJson)),
      enginePin: { name, version, revision },
      outputSha256: hash(bytes),
      outputMimeType: "text/html",
      gates: {
        schema: { status: "passed", scope: "pinned-engine-validation" },
        artifact: { status: "passed", scope: "pinned-engine-rendered-html" },
        browser: { status: "not-run", scope: "none" },
        visualReview: { status: "not-run", scope: "manual" },
      },
    },
  };
}

function semanticDoc(): { doc: DiagramDoc; dataset: ReturnType<typeof archifySpecToDataset>["dataset"] } {
  const { dataset } = archifySpecToDataset("architecture", SEMANTIC_FIXTURES.architecture);
  const doc = { ...createEmptyDoc("semantic-export", 1), datasets: [dataset] };
  return { doc, dataset };
}

function renderHostSpy(): ArchifyRenderHost {
  return vi.fn(async (diagramType, candidateJson) => renderArtifact(diagramType, candidateJson));
}

function generationHost(renderCandidate?: ArchifyRenderHost): GenerationHost {
  return {
    renderCandidate,
    runAgent: vi.fn(async () => ""),
    validateCandidate: vi.fn(async () => ({ ok: true, errors: [], warnings: [] })),
  };
}

async function selectFormat(id: string) {
  const select = query<HTMLSelectElement>('[data-testid="ie-format-select"]')!;
  await act(async () => {
    select.value = id;
    select.dispatchEvent(new Event("change", { bubbles: true }));
  });
}

async function waitForCalls(mock: { mock: { calls: unknown[][] } }, count: number) {
  await act(async () => {
    await vi.waitFor(() => expect(mock).toHaveBeenCalledTimes(count));
  });
}

async function flushAsyncUi() {
  await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });
}

function setNativeMode() {
  Object.defineProperty(window, "__TAURI_INTERNALS__", { configurable: true, value: {} });
}

describe("ImportExportDialog (export)", () => {
  let harness: Harness | null = null;

  beforeEach(async () => {
    document.body.innerHTML = "";
    (URL as unknown as { createObjectURL: unknown }).createObjectURL = vi.fn(() => "blob:mock");
    (URL as unknown as { revokeObjectURL: unknown }).revokeObjectURL = vi.fn();
    const { webcrypto } = await import("node:crypto");
    vi.stubGlobal("crypto", webcrypto);
    vi.stubGlobal("__TAURI_INTERNALS__", undefined);
    delete (window as Window & { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__;
    chooseSaveFileMock.mockReset().mockResolvedValue(null);
    diagramExportBlobToPathMock.mockReset().mockResolvedValue("/workspace/diagrams/saved.svg");
  });

  afterEach(async () => {
    if (harness) {
      await unmountReactRoot(harness.root);
      harness.container.remove();
      harness = null;
    }
    delete (window as Window & { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__;
    vi.unstubAllGlobals();
  });

  it("lists registry codecs and shows the declared fidelity badge", () => {
    harness = renderDialog("export");
    const select = query<HTMLSelectElement>('[data-testid="ie-format-select"]')!;
    const values = [...select.options].map((o) => o.value);
    for (const id of ["maru-json", "maru-svg", "png", "pdf", "mermaid"]) {
      expect(values).toContain(id);
    }
    // No matrix dataset in the doc — tabular codecs are filtered out.
    expect(values).not.toContain("csv");
    expect(values).not.toContain("archify-json");
    const badge = query('[data-testid="ie-fidelity-badge"]')!;
    expect(badge.textContent).toBe(translate("ko", "diagram.codec.fidelity.lossless"));
  });

  it("offers tabular codecs when a matrix dataset exists, with warnings", async () => {
    const doc = {
      ...createEmptyDoc("doc-2", 1),
      datasets: [filledMatrix([
        ["h1", "h2"],
        ["a", "b"],
      ])],
    };
    harness = renderDialog("export", doc);
    const select = query<HTMLSelectElement>('[data-testid="ie-format-select"]')!;
    await act(async () => {
      select.value = "markdown-table";
      select.dispatchEvent(new Event("change", { bubbles: true }));
    });
    const badge = query('[data-testid="ie-fidelity-badge"]')!;
    expect(badge.textContent).toBe(translate("ko", "diagram.codec.fidelity.structural"));
    expect(query('[data-testid="ie-ignored"]')!.textContent).toContain("styles");
  });

  it("commits an export via the browser download fallback", async () => {
    harness = renderDialog("export");
    const select = query<HTMLSelectElement>('[data-testid="ie-format-select"]')!;
    await act(async () => {
      select.value = "maru-json";
      select.dispatchEvent(new Event("change", { bubbles: true }));
    });
    await click(query('[data-testid="ie-export-confirm"]')!);
    expect(URL.createObjectURL).toHaveBeenCalled();
    expect(document.body.textContent).toContain(translate("ko", "diagram.dialog.export.done", { path: "diagram.json" }));
  });

  it("renders the semantic engine codec only on Export and displays verified hashes, gates and native readback", async () => {
    const { doc, dataset } = semanticDoc();
    const host = renderHostSpy();
    const override = generationHost(host);
    setNativeMode();
    chooseSaveFileMock.mockResolvedValue("/workspace/diagrams/Weekly-chart.svg");
    harness = renderDialog("export", doc, override, "/workspace");
    await selectFormat("archify-svg");
    expect(host).not.toHaveBeenCalled(); // codec preview is deliberately absent for engine formats

    const canonical = canonicalSemanticExportInput(doc, dataset.id);
    const artifact = renderArtifact(canonical.diagramType, canonical.candidateJson);
    const expectedSvg = extractEngineSvg(RENDER_HTML, "light");
    const expectedOutputHash = hash(new TextEncoder().encode(expectedSvg));
    const expectedInputHash = hash(new TextEncoder().encode(canonical.candidateJson));
    await click(query('[data-testid="ie-export-confirm"]')!);
    await waitForCalls(diagramExportBlobToPathMock, 1);
    const receipt = query<HTMLElement>('[data-testid="engine-export-receipt"]')!;
    expect(host).toHaveBeenCalledTimes(1);
    expect(host).toHaveBeenCalledWith("architecture", canonical.candidateJson);
    expect(receipt.textContent).toContain(`${name} ${version} (${revision})`);
    expect(receipt.textContent).toContain(expectedInputHash);
    expect(receipt.textContent).toContain(expectedOutputHash);
    expect(receipt.textContent).toContain(translate("ko", "diagram.dialog.ie.gatePassed"));
    expect(receipt.textContent).toContain(translate("ko", "diagram.dialog.ie.gateNotRun"));
    expect(diagramExportBlobToPathMock).toHaveBeenCalledWith(
      "/workspace/diagrams/Weekly-chart.svg",
      "svg",
      expect.anything(),
    );
    expect(receipt.textContent).not.toContain(artifact.receipt.outputSha256); // UI shows the converted SVG hash, not the HTML hash
  });

  it("cancels a pending render before the native chooser and never saves", async () => {
    const { doc } = semanticDoc();
    let resolveRender!: (artifact: ArchifyRenderArtifact) => void;
    let candidateJson = "";
    const host = vi.fn<ArchifyRenderHost>((_type, candidate) => {
      candidateJson = candidate;
      return new Promise<ArchifyRenderArtifact>((resolve) => { resolveRender = resolve; });
    });
    harness = renderDialog("export", doc, generationHost(host), "/workspace");
    setNativeMode();
    await selectFormat("archify-svg");
    await click(query('[data-testid="ie-export-confirm"]')!);
    await waitForCalls(host, 1);
    const cancel = [...document.body.querySelectorAll("button")].find(
      (button) => button.textContent === translate("ko", "diagram.dialog.ie.cancel"),
    )!;
    await click(cancel);
    resolveRender(renderArtifact("architecture", candidateJson));
    await flushAsyncUi();
    expect(chooseSaveFileMock).not.toHaveBeenCalled();
    expect(diagramExportBlobToPathMock).not.toHaveBeenCalled();
  });

  it("unmounts during render without opening the chooser or saving", async () => {
    const { doc } = semanticDoc();
    let resolveRender!: (artifact: ArchifyRenderArtifact) => void;
    let candidateJson = "";
    const host = vi.fn<ArchifyRenderHost>((_type, candidate) => {
      candidateJson = candidate;
      return new Promise<ArchifyRenderArtifact>((resolve) => { resolveRender = resolve; });
    });
    harness = renderDialog("export", doc, generationHost(host), "/workspace");
    setNativeMode();
    await selectFormat("archify-svg");
    await click(query('[data-testid="ie-export-confirm"]')!);
    await waitForCalls(host, 1);
    const pending = harness;
    await unmountReactRoot(pending.root);
    pending.container.remove();
    harness = null;
    resolveRender(renderArtifact("architecture", candidateJson));
    await flushAsyncUi();
    expect(chooseSaveFileMock).not.toHaveBeenCalled();
    expect(diagramExportBlobToPathMock).not.toHaveBeenCalled();
  });

  it("rejects a document change during render before the native chooser", async () => {
    const { doc } = semanticDoc();
    let resolveRender!: (artifact: ArchifyRenderArtifact) => void;
    let candidateJson = "";
    const host = vi.fn<ArchifyRenderHost>((_type, candidate) => {
      candidateJson = candidate;
      return new Promise<ArchifyRenderArtifact>((resolve) => { resolveRender = resolve; });
    });
    harness = renderDialog("export", doc, generationHost(host), "/workspace");
    setNativeMode();
    await selectFormat("archify-svg");
    await click(query('[data-testid="ie-export-confirm"]')!);
    await waitForCalls(host, 1);
    harness.setDoc({ ...doc, docTitle: "Changed after render started" });
    resolveRender(renderArtifact("architecture", candidateJson));
    await flushAsyncUi();
    expect(chooseSaveFileMock).not.toHaveBeenCalled();
    expect(diagramExportBlobToPathMock).not.toHaveBeenCalled();
  });

  it("does not save when the native chooser resolves after the document changes", async () => {
    const { doc } = semanticDoc();
    let resolveChoice!: (path: string | null) => void;
    chooseSaveFileMock.mockImplementation(() => new Promise((resolve) => { resolveChoice = resolve; }));
    const host = renderHostSpy();
    harness = renderDialog("export", doc, generationHost(host), "/workspace");
    setNativeMode();
    await selectFormat("archify-svg");
    await click(query('[data-testid="ie-export-confirm"]')!);
    await waitForCalls(chooseSaveFileMock, 1);
    harness.setDoc({ ...doc, docTitle: "Changed while chooser was open" });
    resolveChoice("/workspace/diagrams/late.svg");
    await flushAsyncUi();
    expect(host).toHaveBeenCalledTimes(1);
    expect(diagramExportBlobToPathMock).not.toHaveBeenCalled();
  });

  it("does not save when the native chooser is canceled", async () => {
    const { doc } = semanticDoc();
    const host = renderHostSpy();
    harness = renderDialog("export", doc, generationHost(host), "/workspace");
    setNativeMode();
    chooseSaveFileMock.mockResolvedValue(null);
    await selectFormat("archify-svg");
    await click(query('[data-testid="ie-export-confirm"]')!);
    await waitForCalls(chooseSaveFileMock, 1);
    await flushAsyncUi();
    expect(diagramExportBlobToPathMock).not.toHaveBeenCalled();
    expect(query('[data-testid="engine-export-receipt"]')!.textContent).toContain(
      translate("ko", "diagram.dialog.ie.gateNotRun"),
    );
  });
});

describe("ImportExportDialog (import)", () => {
  let harness: Harness | null = null;

  beforeEach(() => {
    document.body.innerHTML = "";
  });

  afterEach(async () => {
    if (harness) {
      await unmountReactRoot(harness.root);
      harness.container.remove();
      harness = null;
    }
  });

  it("parses a CSV file, previews rows, and commits a dataset", async () => {
    harness = renderDialog("import");
    await pickFile("data.csv", "h1,h2\na,b\n");
    expect(query('[data-testid="ie-preview-grid"]')).not.toBeNull();
    expect(query('[data-testid="ie-fidelity-badge"]')!.textContent).toBe(
      translate("ko", "diagram.codec.fidelity.structural"),
    );
    await click(query('[data-testid="ie-import-confirm"]')!);
    expect(harness.onImportDataset).toHaveBeenCalledTimes(1);
    const dataset = harness.onImportDataset.mock.calls[0]![0] as MatrixDataset;
    expect(dataset.kind).toBe("matrix");
    expect(dataset.rows[0]!.role).toBe("header");
    expect(harness.onClose).toHaveBeenCalled();
  });

  it("renders mermaid import warnings", async () => {
    harness = renderDialog("import");
    await pickFile("flow.mmd", "flowchart TD\n  A --> B\n");
    const warnings = query('[data-testid="ie-warnings"]')!;
    expect(warnings.textContent).toContain(
      translate("ko", "diagram.codec.warn.mermaidImport"),
    );
    await click(query('[data-testid="ie-import-confirm"]')!);
    expect(harness.onImportDoc).toHaveBeenCalledTimes(1);
  });

  it("gates oversized matrices behind a range selection", async () => {
    harness = renderDialog("import");
    const rows = Array.from({ length: 250 }, (_, i) => `r${i},x`).join("\n");
    await pickFile("big.csv", rows + "\n");
    expect(query('[data-testid="ie-range"]')).not.toBeNull();
    const r2 = query<HTMLInputElement>('[data-testid="ie-range-r2"]')!;
    expect(r2.value).toBe("200");
    await click(query('[data-testid="ie-import-confirm"]')!);
    expect(harness.onImportDataset).toHaveBeenCalledTimes(1);
    const dataset = harness.onImportDataset.mock.calls[0]![0] as MatrixDataset;
    expect(dataset.rows.length).toBe(200);
  });

  it("re-imports a Maru SVG losslessly", async () => {
    harness = renderDialog("import");
    const doc = createEmptyDoc("doc-svg", 1);
    doc.docTitle = "Embedded";
    const { serializeDoc } = await import("../../../lib/diagram/persistence");
    const svg =
      `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 10 10">` +
      `<metadata id="maru-diagram">${serializeDoc(doc)
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;")}</metadata>` +
      `</svg>`;
    await pickFile("doc.svg", svg);
    expect(query('[data-testid="ie-fidelity-badge"]')!.textContent).toBe(
      translate("ko", "diagram.codec.fidelity.lossless"),
    );
    await click(query('[data-testid="ie-import-confirm"]')!);
    expect(harness.onImportDoc).toHaveBeenCalledTimes(1);
    expect((harness.onImportDoc.mock.calls[0]![0] as DiagramDoc).docTitle).toBe("Embedded");
  });
});
