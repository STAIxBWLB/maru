// @vitest-environment jsdom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { matrixFromRowsCols, type MatrixCell, type MatrixDataset } from "../../../lib/diagram/reportTypes";
import { createEmptyDoc, type DiagramDoc } from "../../../lib/diagram/types";
import { LocaleContext, t as translate } from "../../../lib/i18n";
import "../../../lib/i18n/testing";
import { ImportExportDialog } from "./ImportExportDialog";

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
}

function renderDialog(mode: "import" | "export", doc?: DiagramDoc): Harness {
  const onImportDoc = vi.fn();
  const onImportDataset = vi.fn();
  const onClose = vi.fn();
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  const finalDoc = doc ?? createEmptyDoc("doc-1", 1);
  act(() => {
    root.render(
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
          doc={finalDoc}
          workspace={null}
          dirty={false}
          onImportDoc={onImportDoc}
          onImportDataset={onImportDataset}
          onClose={onClose}
        />
      </LocaleContext.Provider>,
    );
  });
  return { container, root, onImportDoc, onImportDataset, onClose };
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

describe("ImportExportDialog (export)", () => {
  let harness: Harness | null = null;

  beforeEach(() => {
    document.body.innerHTML = "";
    (URL as unknown as { createObjectURL: unknown }).createObjectURL = vi.fn(() => "blob:mock");
    (URL as unknown as { revokeObjectURL: unknown }).revokeObjectURL = vi.fn();
  });

  afterEach(() => {
    if (harness) {
      act(() => harness!.root.unmount());
      harness.container.remove();
      harness = null;
    }
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
});

describe("ImportExportDialog (import)", () => {
  let harness: Harness | null = null;

  beforeEach(() => {
    document.body.innerHTML = "";
  });

  afterEach(() => {
    if (harness) {
      act(() => harness!.root.unmount());
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
