import { describe, expect, it } from "vitest";

import {
  MATRIX_MAX_RENDERED_CELLS,
  matrixFromRowsCols,
  mergeCells,
  type MatrixCell,
  type MatrixDataset,
} from "./reportTypes";
import {
  addrAtLocalPoint,
  anchorIdsInRange,
  canInsertColumn,
  canInsertRow,
  cellAtAddr,
  cellIndex,
  cellRect,
  computeTableLayout,
  expandRangeToSpans,
  moveFocus,
  nonEmptyCellCount,
  normalizeRange,
  parseBorderShorthand,
  parseTsv,
  pasteTextGridAt,
  renderedCellCount,
  serializeRangeToTsv,
} from "./tableEditing";
import type { TableCellAddress, TableSelection } from "./types";

function cellAt(m: MatrixDataset, r: number, c: number): MatrixCell {
  const rowId = m.rows[r]?.id;
  const colId = m.columns[c]?.id;
  const cell = Object.values(m.cells).find((x) => x.rowId === rowId && x.colId === colId);
  if (!cell) throw new Error(`no cell at ${r},${c}`);
  return cell;
}

function addrOf(m: MatrixDataset, r: number, c: number): TableCellAddress {
  const cell = cellAt(m, r, c);
  return { rowId: cell.rowId, colId: cell.colId };
}

function sel(m: MatrixDataset, ar: number, ac: number, fr = ar, fc = ac): TableSelection {
  return { nodeId: "node-1", anchor: addrOf(m, ar, ac), focus: addrOf(m, fr, fc) };
}

function withTexts(m: MatrixDataset, texts: string[][]): MatrixDataset {
  const cells = { ...m.cells };
  texts.forEach((row, r) =>
    row.forEach((text, c) => {
      const cell = cellAt(m, r, c);
      cells[cell.id] = { ...cell, text };
    }),
  );
  return { ...m, cells };
}

describe("computeTableLayout", () => {
  it("splits unset tracks equally across the node bounds", () => {
    const m = matrixFromRowsCols(3, 3);
    const layout = computeTableLayout(m, 300, 150);
    expect(layout.colW).toEqual([100, 100, 100]);
    expect(layout.rowH).toEqual([50, 50, 50]);
    expect(layout.colX).toEqual([0, 100, 200]);
    expect(layout.totalW).toBe(300);
  });

  it("honors explicit widths and shares the remainder", () => {
    let m = matrixFromRowsCols(2, 3);
    m = {
      ...m,
      columns: m.columns.map((col, i) => (i === 0 ? { ...col, width: 120 } : col)),
      rows: m.rows.map((row, i) => (i === 0 ? { ...row, height: 40 } : row)),
    };
    const layout = computeTableLayout(m, 300, 140);
    expect(layout.colW[0]).toBe(120);
    expect(layout.colW[1]).toBe(90);
    expect(layout.colW[2]).toBe(90);
    expect(layout.rowH).toEqual([40, 100]);
  });
});

describe("ranges", () => {
  it("normalizes anchor/focus in any direction", () => {
    const m = matrixFromRowsCols(3, 3);
    const range = normalizeRange(m, sel(m, 2, 2, 0, 1));
    expect(range).toEqual({ r1: 0, c1: 1, r2: 2, c2: 2 });
  });

  it("expands a range that half-covers a merged cell", () => {
    let m = matrixFromRowsCols(3, 3);
    m = mergeCells(m, [cellAt(m, 0, 0).id, cellAt(m, 0, 1).id, cellAt(m, 1, 0).id, cellAt(m, 1, 1).id]);
    // Selecting (0,1)-(1,2) half-covers the 2x2 anchor at (0,0) → expands left.
    const expanded = expandRangeToSpans(m, { r1: 0, c1: 1, r2: 1, c2: 2 });
    expect(expanded).toEqual({ r1: 0, c1: 0, r2: 1, c2: 2 });
    // The expanded range tiles exactly: anchor ids are the merged cell + (0,2) + (1,2).
    expect(anchorIdsInRange(m, expanded)).toHaveLength(3);
  });

  it("counts only non-empty cells", () => {
    let m = matrixFromRowsCols(2, 2);
    m = withTexts(m, [["a", ""], [" ", "b"]]);
    const ids = anchorIdsInRange(m, { r1: 0, c1: 0, r2: 1, c2: 1 });
    expect(nonEmptyCellCount(m, ids)).toBe(2);
  });
});

describe("moveFocus", () => {
  it("moves and clamps at the grid edges", () => {
    const m = matrixFromRowsCols(2, 2);
    const moved = moveFocus(m, sel(m, 0, 0), 1, 1, false);
    expect(cellIndex(m, moved.focus)).toEqual({ r: 1, c: 1 });
    const clamped = moveFocus(m, moved, 5, 5, false);
    expect(cellIndex(m, clamped.focus)).toEqual({ r: 1, c: 1 });
  });

  it("extends the range (anchor stays) with shift", () => {
    const m = matrixFromRowsCols(3, 3);
    const base = sel(m, 1, 1);
    const extended = moveFocus(m, base, 0, 1, true);
    expect(cellIndex(m, extended.anchor)).toEqual({ r: 1, c: 1 });
    expect(cellIndex(m, extended.focus)).toEqual({ r: 1, c: 2 });
  });

  it("landing inside a span selects its anchor cell", () => {
    let m = matrixFromRowsCols(2, 2);
    m = mergeCells(m, [cellAt(m, 0, 0).id, cellAt(m, 0, 1).id, cellAt(m, 1, 0).id, cellAt(m, 1, 1).id]);
    const moved = moveFocus(m, sel(m, 0, 0), 1, 1, false);
    // (1,1) is covered by the big anchor at (0,0).
    expect(moved.focus).toEqual(addrOf(m, 0, 0));
  });
});

describe("hit testing", () => {
  it("maps local points to cell addresses (span-aware)", () => {
    let m = matrixFromRowsCols(2, 2);
    m = mergeCells(m, [cellAt(m, 0, 0).id, cellAt(m, 1, 0).id]);
    const layout = computeTableLayout(m, 200, 100);
    expect(addrAtLocalPoint(m, layout, 10, 10)).toEqual(addrOf(m, 0, 0));
    // Bottom-left is covered by the rowSpan-2 anchor at (0,0).
    expect(addrAtLocalPoint(m, layout, 10, 90)).toEqual(addrOf(m, 0, 0));
    expect(addrAtLocalPoint(m, layout, 150, 90)).toEqual(addrOf(m, 1, 1));
    expect(addrAtLocalPoint(m, layout, 500, 500)).toBeNull();
  });

  it("cellRect spans merged tracks", () => {
    let m = matrixFromRowsCols(2, 2);
    m = mergeCells(m, [cellAt(m, 0, 0).id, cellAt(m, 0, 1).id]);
    const layout = computeTableLayout(m, 200, 100);
    const rect = cellRect(m, layout, cellAt(m, 0, 0), 0, 0);
    expect(rect).toEqual({ x: 0, y: 0, w: 200, h: 50 });
  });
});

describe("TSV serialize / parse", () => {
  it("round-trips text with tabs and newlines", () => {
    let m = matrixFromRowsCols(2, 2);
    m = withTexts(m, [["a\tb", "line1\nline2"], ["", "back\\slash"]]);
    const tsv = serializeRangeToTsv(m, { r1: 0, c1: 0, r2: 1, c2: 1 });
    expect(parseTsv(tsv)).toEqual([["a\tb", "line1\nline2"], ["", "back\\slash"]]);
  });

  it("serializes span-covered positions as empty except the anchor", () => {
    let m = matrixFromRowsCols(2, 2);
    m = withTexts(m, [["top", "x"], ["y", "z"]]);
    // Merging (0,0)+(1,0) joins their texts with \n (escaped in TSV).
    m = mergeCells(m, [cellAt(m, 0, 0).id, cellAt(m, 1, 0).id]);
    const tsv = serializeRangeToTsv(m, { r1: 0, c1: 0, r2: 1, c2: 1 });
    expect(tsv.split("\n")).toEqual(["top\\ny\tx", "\tz"]);
  });
});

describe("pasteTextGridAt", () => {
  it("writes a grid at the target address", () => {
    const m = matrixFromRowsCols(3, 3);
    const next = pasteTextGridAt(m, addrOf(m, 1, 1), [["a", "b"], ["c", "d"]]);
    expect(cellAtAddr(next, addrOf(next, 1, 1))?.text).toBe("a");
    expect(cellAtAddr(next, addrOf(next, 2, 2))?.text).toBe("d");
  });

  it("clips to the matrix bounds", () => {
    const m = matrixFromRowsCols(2, 2);
    const next = pasteTextGridAt(m, addrOf(m, 1, 1), [["a", "b"], ["c", "d"]]);
    expect(cellAtAddr(next, addrOf(next, 1, 1))?.text).toBe("a");
    expect(validateTexts(next)).toBe(1);
  });

  it("skips positions covered by another anchor's span", () => {
    let m = matrixFromRowsCols(2, 3);
    m = mergeCells(m, [cellAt(m, 0, 1).id, cellAt(m, 0, 2).id]);
    // Paste a 1x3 row at (0,0): (0,1) is the span anchor (written), (0,2) covered (skipped).
    const next = pasteTextGridAt(m, addrOf(m, 0, 0), [["a", "b", "c"]]);
    expect(cellAtAddr(next, addrOf(next, 0, 0))?.text).toBe("a");
    expect(cellAtAddr(next, addrOf(next, 0, 1))?.text).toBe("b");
    // (0,2) is covered by the (0,1) anchor — no own cell to receive "c".
    expect(cellIndex(next, { rowId: next.rows[0]!.id, colId: next.columns[2]!.id })).toEqual({ r: 0, c: 2 });
    const anchor = cellAt(next, 0, 1);
    expect(anchor.colSpan).toBe(2);
  });

  it("returns the same reference when nothing changes", () => {
    const m = matrixFromRowsCols(2, 2);
    expect(pasteTextGridAt(m, addrOf(m, 0, 0), [[""]])).toBe(m);
    expect(pasteTextGridAt(m, { rowId: "nope", colId: "nope" }, [["x"]])).toBe(m);
  });
});

function validateTexts(m: MatrixDataset): number {
  return Object.values(m.cells).filter((c) => c.text).length;
}

describe("limits", () => {
  it("allows inserts well under the caps", () => {
    const m = matrixFromRowsCols(3, 3);
    expect(canInsertRow(m)).toBe(true);
    expect(canInsertColumn(m)).toBe(true);
    expect(renderedCellCount(m)).toBe(9);
  });

  it("blocks inserts at the row/column caps", () => {
    const maxRows = matrixFromRowsCols(200, 1);
    expect(canInsertRow(maxRows)).toBe(false);
    const maxCols = matrixFromRowsCols(1, 50);
    expect(canInsertColumn(maxCols)).toBe(false);
  });

  it("blocks inserts that would exceed the rendered-cell cap", () => {
    // 70 x 70 = 4900 cells; adding a row adds 70 → 4970 ok; 100x50=5000 + 50 → over.
    const full = matrixFromRowsCols(100, 50);
    expect(renderedCellCount(full)).toBe(MATRIX_MAX_RENDERED_CELLS);
    expect(canInsertRow(full)).toBe(false);
    expect(canInsertColumn(full)).toBe(false);
  });
});

describe("parseBorderShorthand", () => {
  it("parses width/color/dash and none", () => {
    expect(parseBorderShorthand(undefined)).toBeNull();
    expect(parseBorderShorthand("none")).toEqual({ width: 0, color: "transparent", dash: false });
    expect(parseBorderShorthand("2px solid #dc2626")).toEqual({ width: 2, color: "#dc2626", dash: false });
    expect(parseBorderShorthand("1px dashed gray")).toEqual({ width: 1, color: "gray", dash: true });
  });
});
