// @vitest-environment jsdom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { addLinkedView, type CrossConversionResult } from "../../../lib/diagram/convert";
import {
  TABLE_PATTERN_ID,
  matrixFromRowsCols,
  type MatrixCell,
  type MatrixDataset,
} from "../../../lib/diagram/reportTypes";
import { createEmptyDoc, type DiagramDoc } from "../../../lib/diagram/types";
import { LocaleContext, t as translate } from "../../../lib/i18n";
import "../../../lib/i18n/testing";
import { MappingPreviewDialog } from "./MappingPreviewDialog";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

function taggedMatrix(): MatrixDataset {
  const rows = [
    ["Task", "Start", "End", "Notes"],
    ["Design", "2026-01", "2026-03", "ux"],
    ["Build", "2026-04", "2026-08", "dev"],
  ];
  const matrix = matrixFromRowsCols(rows.length, rows[0]!.length);
  const headerRow = matrix.rows[0]!;
  headerRow.role = "header";
  const cells: Record<string, MatrixCell> = {};
  for (const cell of Object.values(matrix.cells)) {
    const r = matrix.rows.findIndex((row) => row.id === cell.rowId);
    const c = matrix.columns.findIndex((col) => col.id === cell.colId);
    cells[cell.id] = { ...cell, text: rows[r]?.[c] ?? "" };
  }
  return {
    ...matrix,
    cells,
    columns: matrix.columns.map((col, i) => {
      const tag = (["label", "start", "end", undefined] as const)[i];
      return tag ? { ...col, tag } : col;
    }),
  };
}

function sourceDoc(): { doc: DiagramDoc; viewId: string } {
  const dataset = taggedMatrix();
  const base = { ...createEmptyDoc("doc-1", 1), datasets: [dataset] };
  const doc = addLinkedView(base, dataset.id, TABLE_PATTERN_ID, {
    x: 0,
    y: 0,
    w: 480,
    h: 320,
  });
  return { doc, viewId: doc.views![0]!.id };
}

interface Harness {
  container: HTMLDivElement;
  root: Root;
  onConfirm: ReturnType<typeof vi.fn>;
  onCancel: ReturnType<typeof vi.fn>;
  doc: DiagramDoc;
  viewId: string;
}

function renderPreview(targetPatternId = "report.timeline"): Harness {
  const { doc, viewId } = sourceDoc();
  const onConfirm = vi.fn();
  const onCancel = vi.fn();
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  act(() => {
    root.render(
      <LocaleContext.Provider
        value={{
          locale: "ko",
          setLocale: () => {},
          t: (key, vars) => translate("ko", key, vars),
        }}
      >
        <MappingPreviewDialog
          open
          doc={doc}
          sourceViewId={viewId}
          targetPatternId={targetPatternId}
          onConfirm={onConfirm}
          onCancel={onCancel}
        />
      </LocaleContext.Provider>,
    );
  });
  return { container, root, onConfirm, onCancel, doc, viewId };
}

function queryAll<T extends Element>(selector: string): T[] {
  return [...document.body.querySelectorAll<T>(selector)];
}

describe("MappingPreviewDialog", () => {
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

  it("shows a mapping row per source column with suggested tags", () => {
    harness = renderPreview();
    const rows = queryAll<HTMLTableRowElement>(".maru-diagram-mapping-table tbody tr");
    expect(rows).toHaveLength(4);
    const selects = queryAll<HTMLSelectElement>(".maru-diagram-mapping-table select");
    expect(selects.map((s) => s.value)).toEqual(["label", "start", "end", ""]);
  });

  it("previews warnings for unmapped fields", () => {
    harness = renderPreview();
    // The untagged "Notes" column is dropped → unmappedColumn warning.
    const warnings = queryAll(".maru-diagram-mapping-warnings li");
    expect(warnings.length).toBeGreaterThan(0);
    expect(warnings.map((w) => w.textContent).join(" ")).toContain("Notes");
  });

  it("changing a dropdown updates the preview", () => {
    harness = renderPreview();
    const selects = queryAll<HTMLSelectElement>(".maru-diagram-mapping-table select");
    const notes = selects[3]!;
    const setter = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, "value")!.set!;
    act(() => {
      setter.call(notes, "owner");
      notes.dispatchEvent(new Event("change", { bubbles: true }));
    });
    // "Notes" is now mapped to owner → the unmapped-field warning disappears.
    const warnings = queryAll(".maru-diagram-mapping-warnings li");
    expect(warnings.map((w) => w.textContent).join(" ")).not.toContain("Notes");
  });

  it("confirm applies the conversion: new dataset, source untouched", () => {
    harness = renderPreview();
    const confirmBtn = queryAll<HTMLButtonElement>(".maru-diagram-template-actions button").find(
      (b) => b.className.includes("maru-diagram-toolbar-primary"),
    )!;
    act(() => {
      confirmBtn.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    expect(harness.onConfirm).toHaveBeenCalledTimes(1);
    const result = harness.onConfirm.mock.calls[0]![0] as CrossConversionResult;
    expect(result.doc.datasets).toHaveLength(2);
    expect(result.doc.views).toHaveLength(2);
    // Source dataset/view kept their identity; the new view is separate.
    expect(result.doc.datasets![0]).toBe(harness.doc.datasets![0]);
    expect(result.doc.views![0]).toBe(harness.doc.views![0]);
    const newView = result.doc.views![1]!;
    expect(newView.patternId).toBe("report.timeline");
    expect(newView.datasetId).not.toBe(harness.doc.views![0]!.datasetId);
    // Input doc graph untouched.
    expect(harness.doc.datasets).toHaveLength(1);
    expect(harness.doc.views).toHaveLength(1);
  });

  it("cancel closes without converting", () => {
    harness = renderPreview();
    const cancelBtn = queryAll<HTMLButtonElement>(".maru-diagram-template-actions button").find(
      (b) => !b.className.includes("maru-diagram-toolbar-primary"),
    )!;
    act(() => {
      cancelBtn.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    expect(harness.onCancel).toHaveBeenCalledTimes(1);
    expect(harness.onConfirm).not.toHaveBeenCalled();
  });
});
