import { describe, expect, it } from "vitest";

import { reportFixtures } from "./__fixtures__/reports";
import {
  MATRIX_MAX_COLS,
  MATRIX_MAX_RENDERED_CELLS,
  MATRIX_MAX_ROWS,
  computeProjectionHash,
  createDatasetId,
  createMatrixCellId,
  createMatrixColumnId,
  createMatrixRowId,
  createPatternViewId,
  deleteColumn,
  deleteRow,
  fixtureToMatrix,
  insertColumn,
  insertRow,
  matrixFromRowsCols,
  mergeCells,
  splitCell,
  validateMatrix,
  type MatrixCell,
  type MatrixDataset,
} from "./reportTypes";

describe("id generators", () => {
  it("generate stable, unique, non-empty ids", () => {
    const generators = [
      createDatasetId,
      createPatternViewId,
      createMatrixRowId,
      createMatrixColumnId,
      createMatrixCellId,
    ];
    const ids = new Set<string>();
    for (const gen of generators) {
      for (let i = 0; i < 50; i += 1) {
        const id = gen();
        expect(id).toBeTruthy();
        expect(ids.has(id)).toBe(false);
        ids.add(id);
      }
    }
  });
});

describe("computeProjectionHash", () => {
  it("is stable regardless of key order", () => {
    const a = computeProjectionHash({ x: 1, y: [2, 3], z: { b: true, a: "s" } });
    const b = computeProjectionHash({ z: { a: "s", b: true }, y: [2, 3], x: 1 });
    expect(a).toBe(b);
    expect(a).toMatch(/^[0-9a-f]{8}$/);
  });

  it("changes when the input changes", () => {
    expect(computeProjectionHash({ a: 1 })).not.toBe(computeProjectionHash({ a: 2 }));
  });
});

describe("matrixFromRowsCols", () => {
  it("builds a valid empty matrix", () => {
    const m = matrixFromRowsCols(3, 4);
    expect(m.kind).toBe("matrix");
    expect(m.rows).toHaveLength(3);
    expect(m.columns).toHaveLength(4);
    expect(Object.keys(m.cells)).toHaveLength(12);
    expect(validateMatrix(m).ok).toBe(true);
  });

  it("supports zero-sized matrices", () => {
    const m = matrixFromRowsCols(0, 0);
    expect(validateMatrix(m).ok).toBe(true);
  });
});

function cellAt(m: MatrixDataset, r: number, c: number): MatrixCell {
  const row = m.rows[r];
  const col = m.columns[c];
  if (!row || !col) throw new Error(`no row/col at ${r},${c}`);
  const cell = Object.values(m.cells).find(
    (candidate) => candidate.rowId === row.id && candidate.colId === col.id,
  );
  if (!cell) throw new Error(`no cell at ${r},${c}`);
  return cell;
}

describe("validateMatrix", () => {
  it("rejects overlapping spans", () => {
    const m = matrixFromRowsCols(2, 2);
    const a = cellAt(m, 0, 0);
    a.colSpan = 2;
    // (0,1) still has its own anchor cell while (0,0) spans over it.
    const result = validateMatrix(m);
    expect(result.ok).toBe(false);
    expect(result.errors.join("\n")).toMatch(/overlap/);
  });

  it("rejects spans that run out of range", () => {
    const m = matrixFromRowsCols(2, 2);
    cellAt(m, 0, 0).rowSpan = 3;
    expect(validateMatrix(m).ok).toBe(false);
    expect(validateMatrix(m).errors.join("\n")).toMatch(/out of range/);
  });

  it("rejects non-positive spans", () => {
    const m = matrixFromRowsCols(1, 1);
    cellAt(m, 0, 0).rowSpan = 0;
    expect(validateMatrix(m).ok).toBe(false);
  });

  it("rejects cells referencing unknown rows/columns", () => {
    const m = matrixFromRowsCols(1, 1);
    cellAt(m, 0, 0).rowId = "ghost";
    const result = validateMatrix(m);
    expect(result.ok).toBe(false);
    expect(result.errors.join("\n")).toMatch(/unknown rowId/);
  });

  it("rejects uncovered positions", () => {
    const m = matrixFromRowsCols(2, 2);
    const victim = cellAt(m, 1, 1);
    delete m.cells[victim.id];
    const result = validateMatrix(m);
    expect(result.ok).toBe(false);
    expect(result.errors.join("\n")).toMatch(/uncovered/);
  });

  it("enforces row/column/rendered-cell limits", () => {
    const wide = matrixFromRowsCols(1, MATRIX_MAX_COLS + 1);
    expect(validateMatrix(wide).ok).toBe(false);

    const tall = matrixFromRowsCols(MATRIX_MAX_ROWS + 1, 1);
    expect(validateMatrix(tall).ok).toBe(false);

    const huge = matrixFromRowsCols(MATRIX_MAX_ROWS, MATRIX_MAX_COLS);
    for (const cell of Object.values(huge.cells)) {
      cell.rowSpan = 2;
      cell.colSpan = 2;
    }
    const result = validateMatrix(huge);
    expect(result.ok).toBe(false);
    expect(result.errors.join("\n")).toMatch(
      new RegExp(`rendered cells.*${MATRIX_MAX_RENDERED_CELLS}`),
    );
  });
});

describe("mergeCells / splitCell", () => {
  it("merges a rectangle, joining non-empty texts with newlines", () => {
    let m = matrixFromRowsCols(3, 3);
    cellAt(m, 0, 0).text = "alpha";
    cellAt(m, 0, 1).text = "";
    cellAt(m, 1, 0).text = "beta";
    const ids = [cellAt(m, 0, 0).id, cellAt(m, 0, 1).id, cellAt(m, 1, 0).id, cellAt(m, 1, 1).id];
    const originalCellCount = Object.keys(m.cells).length;
    m = mergeCells(m, ids);
    expect(validateMatrix(m).ok).toBe(true);
    expect(Object.keys(m.cells)).toHaveLength(originalCellCount - 3);
    const merged = cellAt(m, 0, 0);
    expect(merged.text).toBe("alpha\nbeta");
    expect(merged.rowSpan).toBe(2);
    expect(merged.colSpan).toBe(2);
  });

  it("rejects non-rectangular selections", () => {
    const m = matrixFromRowsCols(3, 3);
    const ids = [cellAt(m, 0, 0).id, cellAt(m, 1, 1).id];
    expect(() => mergeCells(m, ids)).toThrow(/rectangle/);
  });

  it("does not mutate the input dataset", () => {
    const m = matrixFromRowsCols(2, 2);
    const before = JSON.stringify(m);
    mergeCells(m, [cellAt(m, 0, 0).id, cellAt(m, 0, 1).id]);
    expect(JSON.stringify(m)).toBe(before);
  });

  it("split is the inverse of merge (structure, not text)", () => {
    let m = matrixFromRowsCols(2, 2);
    cellAt(m, 0, 0).text = "merged";
    m = mergeCells(m, [cellAt(m, 0, 0).id, cellAt(m, 0, 1).id, cellAt(m, 1, 0).id, cellAt(m, 1, 1).id]);
    const mergedId = cellAt(m, 0, 0).id;
    m = splitCell(m, mergedId);
    expect(validateMatrix(m).ok).toBe(true);
    expect(Object.keys(m.cells)).toHaveLength(4);
    expect(cellAt(m, 0, 0).text).toBe("merged");
    expect(cellAt(m, 0, 0).rowSpan).toBeUndefined();
    expect(cellAt(m, 0, 0).colSpan).toBeUndefined();
    expect(cellAt(m, 1, 1).text).toBe("");
  });

  it("splitCell on a 1x1 cell is a no-op", () => {
    const m = matrixFromRowsCols(1, 1);
    expect(splitCell(m, cellAt(m, 0, 0).id)).toBe(m);
  });
});

describe("insert/delete rows and columns", () => {
  it("insertRow adds an empty row and keeps the matrix valid", () => {
    let m = matrixFromRowsCols(2, 3);
    m = insertRow(m, 1, "header");
    expect(m.rows).toHaveLength(3);
    expect(m.rows[1]?.role).toBe("header");
    expect(validateMatrix(m).ok).toBe(true);
    for (let c = 0; c < 3; c += 1) {
      expect(cellAt(m, 1, c).text).toBe("");
    }
  });

  it("insertRow extends spans crossing the insertion point", () => {
    let m = matrixFromRowsCols(3, 1);
    cellAt(m, 0, 0).rowSpan = 3;
    delete m.cells[cellAt(m, 1, 0).id];
    delete m.cells[cellAt(m, 2, 0).id];
    m = insertRow(m, 1);
    expect(m.rows).toHaveLength(4);
    expect(cellAt(m, 0, 0).rowSpan).toBe(4);
    expect(validateMatrix(m).ok).toBe(true);
  });

  it("deleteRow shrinks crossing spans and removes row cells", () => {
    let m = matrixFromRowsCols(3, 1);
    cellAt(m, 0, 0).rowSpan = 3;
    delete m.cells[cellAt(m, 1, 0).id];
    delete m.cells[cellAt(m, 2, 0).id];
    const rowId = m.rows[2]?.id ?? "";
    m = deleteRow(m, rowId);
    expect(m.rows).toHaveLength(2);
    expect(cellAt(m, 0, 0).rowSpan).toBe(2);
    expect(validateMatrix(m).ok).toBe(true);
  });

  it("deleteRow refuses to delete the anchor row of a multi-row span", () => {
    const m = matrixFromRowsCols(2, 1);
    cellAt(m, 0, 0).rowSpan = 2;
    delete m.cells[cellAt(m, 1, 0).id];
    expect(() => deleteRow(m, m.rows[0]?.id ?? "")).toThrow(/anchors/);
  });

  it("insert/delete column round-trips", () => {
    let m = matrixFromRowsCols(2, 2);
    cellAt(m, 0, 0).text = "keep";
    m = insertColumn(m, 1, { tag: "owner" });
    expect(m.columns).toHaveLength(3);
    expect(m.columns[1]?.tag).toBe("owner");
    expect(cellAt(m, 0, 0).text).toBe("keep");
    expect(validateMatrix(m).ok).toBe(true);
    m = deleteColumn(m, m.columns[1]?.id ?? "");
    expect(m.columns).toHaveLength(2);
    expect(cellAt(m, 0, 0).text).toBe("keep");
    expect(validateMatrix(m).ok).toBe(true);
  });

  it("deleteColumn refuses to delete the anchor column of a multi-column span", () => {
    const m = matrixFromRowsCols(1, 2);
    cellAt(m, 0, 0).colSpan = 2;
    delete m.cells[cellAt(m, 0, 1).id];
    expect(() => deleteColumn(m, m.columns[0]?.id ?? "")).toThrow(/anchors/);
  });
});

describe("fixtureToMatrix", () => {
  it("produces a valid matrix for every fixture", () => {
    for (const fixture of reportFixtures) {
      const m = fixtureToMatrix(fixture);
      expect(m.kind).toBe("matrix");
      expect(m.name).toBe(fixture.title);
      expect(m.columns).toHaveLength(fixture.columns.length);
      expect(m.rows).toHaveLength(fixture.rows.length);
      const result = validateMatrix(m);
      expect(result.errors).toEqual([]);
      expect(result.ok).toBe(true);
    }
  });

  it("preserves rowSpan cells from the PDM fixture", () => {
    const pdm = reportFixtures.find((f) => f.kind === "pdm");
    expect(pdm).toBeDefined();
    const m = fixtureToMatrix(pdm!);
    const spanning = Object.values(m.cells).filter((cell) => (cell.rowSpan ?? 1) > 1);
    expect(spanning).toHaveLength(2);
    expect(spanning.every((cell) => cell.rowSpan === 2)).toBe(true);
  });

  it("marks full-width group rows and subtotal rows in the budget fixture", () => {
    const budget = reportFixtures.find((f) => f.kind === "budget");
    const m = fixtureToMatrix(budget!);
    const roles = m.rows.map((row) => row.role);
    expect(roles).toContain("group");
    expect(roles).toContain("subtotal");
  });
});
