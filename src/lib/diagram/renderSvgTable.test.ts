import { describe, expect, it } from "vitest";

import { renderDocToSvg } from "./renderSvg";
import {
  TABLE_PATTERN_ID,
  computeProjectionHash,
  matrixFromRowsCols,
  mergeCells,
  type MatrixCell,
  type MatrixDataset,
  type PatternView,
} from "./reportTypes";
import { TABLE_ROLE_FILLS } from "./tableEditing";
import { createEmptyDoc, type DiagramDoc, type DiagramNode } from "./types";

function cellAt(m: MatrixDataset, r: number, c: number): MatrixCell {
  const rowId = m.rows[r]?.id;
  const colId = m.columns[c]?.id;
  const cell = Object.values(m.cells).find((x) => x.rowId === rowId && x.colId === colId);
  if (!cell) throw new Error(`no cell at ${r},${c}`);
  return cell;
}

function docWithTable(matrix: MatrixDataset): DiagramDoc {
  const node: DiagramNode = {
    id: "node-1",
    kind: "table",
    x: 10,
    y: 20,
    w: 300,
    h: 150,
    meta: { viewId: "view-1", memberId: matrix.id },
  };
  const view: PatternView = {
    id: "view-1",
    datasetId: matrix.id,
    patternId: TABLE_PATTERN_ID,
    bounds: { x: 10, y: 20, w: 300, h: 150 },
    nodeIds: ["node-1"],
    edgeIds: [],
    projectionHash: computeProjectionHash({ patternId: TABLE_PATTERN_ID }),
  };
  return {
    ...createEmptyDoc("doc-1", 1),
    nodes: [node],
    datasets: [matrix],
    views: [view],
  };
}

describe("renderDocToSvg — matrix tables", () => {
  it("renders cell texts, role shading, and per-cell styles from the dataset", () => {
    let matrix = matrixFromRowsCols(2, 2, { name: "Report" });
    const header = matrix.rows[0]!.id;
    matrix = {
      ...matrix,
      rows: matrix.rows.map((row) => (row.id === header ? { ...row, role: "header" as const } : row)),
    };
    const a = cellAt(matrix, 0, 0);
    const b = cellAt(matrix, 1, 1);
    matrix = {
      ...matrix,
      cells: {
        ...matrix.cells,
        [a.id]: { ...a, text: "Header <cell>", style: { bold: true, align: "center" as const } },
        [b.id]: { ...b, text: "42", style: { bg: "#ffeeee" } },
      },
    };
    const { svg } = renderDocToSvg(docWithTable(matrix));
    expect(svg).toContain("Header &lt;cell&gt;");
    expect(svg).toContain("42");
    expect(svg).toContain(TABLE_ROLE_FILLS.header);
    expect(svg).toContain("#ffeeee");
    expect(svg).toContain("font-weight:700");
    expect(svg).toContain('data-node-id="node-1"');
    // Interactive chrome never leaks into exports.
    expect(svg).not.toContain("data-export-ignore");
    expect(svg).not.toContain("data-table-range");
  });

  it("renders merged cells as one spanned rect (no duplicate anchors)", () => {
    let matrix = matrixFromRowsCols(2, 2);
    const a = cellAt(matrix, 0, 0);
    matrix = mergeCells(matrix, [a.id, cellAt(matrix, 0, 1).id]);
    matrix = {
      ...matrix,
      cells: { ...matrix.cells, [a.id]: { ...matrix.cells[a.id]!, text: "merged" } },
    };
    const { svg } = renderDocToSvg(docWithTable(matrix));
    expect(svg).toContain("merged");
    // One spanned rect: width = full 300 node width at half height.
    expect(svg).toContain('width="300" height="75"');
  });

  it("keeps the legacy grid-line fallback for unlinked tables", () => {
    const doc: DiagramDoc = {
      ...createEmptyDoc("doc-1", 1),
      nodes: [
        { id: "legacy", kind: "table", x: 0, y: 0, w: 100, h: 100, meta: { rows: 2, cols: 2 } },
      ],
    };
    const { svg } = renderDocToSvg(doc);
    expect(svg).toContain('data-node-id="legacy"');
    expect((svg.match(/<line /g) ?? []).length).toBe(2); // one vertical + one horizontal
  });
});
