// @vitest-environment jsdom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { mkNode } from "../../../lib/diagram/nodeKinds";
import {
  matrixFromRowsCols,
  mergeCells,
  type MatrixCell,
  type MatrixDataset,
} from "../../../lib/diagram/reportTypes";
import { TABLE_ROLE_FILLS } from "../../../lib/diagram/tableEditing";
import type { TableCellAddress, TableSelection } from "../../../lib/diagram/types";
import { TableView } from "./TableView";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

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

interface Harness {
  container: HTMLDivElement;
  root: Root;
}

function renderTable(
  matrix: MatrixDataset,
  opts: {
    selection?: TableSelection | null;
    nodeSelected?: boolean;
    onCellPointerDown?: (event: unknown, addr: TableCellAddress) => void;
    onCellDoubleClick?: (event: unknown, addr: TableCellAddress) => void;
    onResizeHandlePointerDown?: (event: unknown, axis: "col" | "row", index: number) => void;
  } = {},
): Harness {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  const node = mkNode("table", 0, 0, { w: 300, h: 150 });
  act(() => {
    root.render(
      <svg>
        <TableView
          node={node}
          matrix={matrix}
          selection={opts.selection ?? null}
          nodeSelected={opts.nodeSelected ?? false}
          onCellPointerDown={opts.onCellPointerDown as never}
          onCellDoubleClick={opts.onCellDoubleClick as never}
          onResizeHandlePointerDown={opts.onResizeHandlePointerDown as never}
        />
      </svg>,
    );
  });
  return { container, root };
}

describe("TableView", () => {
  let harness: Harness | null = null;

  beforeEach(() => {
    document.body.innerHTML = "";
  });

  afterEach(() => {
    if (harness) {
      act(() => harness!.root.unmount());
      harness = null;
    }
    document.body.innerHTML = "";
  });

  it("renders one rect per anchor cell", () => {
    harness = renderTable(matrixFromRowsCols(3, 4));
    expect(harness.container.querySelectorAll("[data-cell-id]")).toHaveLength(12);
  });

  it("renders merged cells as a single spanned rect", () => {
    let m = matrixFromRowsCols(2, 2);
    m = mergeCells(m, [cellAt(m, 0, 0).id, cellAt(m, 0, 1).id]);
    harness = renderTable(m);
    const rects = harness.container.querySelectorAll("[data-cell-id]");
    expect(rects).toHaveLength(3);
    const merged = harness.container.querySelector(`[data-cell-id="${cellAt(m, 0, 0).id}"]`);
    expect(merged?.getAttribute("width")).toBe("300");
    expect(merged?.getAttribute("height")).toBe("75");
  });

  it("shades header rows and honors per-cell bg overrides", () => {
    let m = matrixFromRowsCols(2, 2);
    const headerId = m.rows[0]!.id;
    m = {
      ...m,
      rows: m.rows.map((row) => (row.id === headerId ? { ...row, role: "header" as const } : row)),
    };
    const styled = cellAt(m, 1, 0);
    m = {
      ...m,
      cells: { ...m.cells, [styled.id]: { ...styled, style: { bg: "#123456" } } },
    };
    harness = renderTable(m);
    const headerRect = harness.container.querySelector(`[data-cell-id="${cellAt(m, 0, 0).id}"]`);
    expect(headerRect?.getAttribute("fill")).toBe(TABLE_ROLE_FILLS.header);
    const styledRect = harness.container.querySelector(`[data-cell-id="${styled.id}"]`);
    expect(styledRect?.getAttribute("fill")).toBe("#123456");
  });

  it("renders cell text and bullets", () => {
    let m = matrixFromRowsCols(1, 1);
    const cell = cellAt(m, 0, 0);
    m = {
      ...m,
      cells: { ...m.cells, [cell.id]: { ...cell, text: "Hello", bullets: ["one", "two"] } },
    };
    harness = renderTable(m);
    expect(harness.container.textContent).toContain("Hello");
    expect(harness.container.textContent).toContain("one");
    expect(harness.container.querySelectorAll("li")).toHaveLength(2);
  });

  it("draws selection chrome tagged data-export-ignore", () => {
    const m = matrixFromRowsCols(2, 2);
    const selection: TableSelection = {
      nodeId: "node-1",
      anchor: addrOf(m, 0, 0),
      focus: addrOf(m, 1, 1),
    };
    harness = renderTable(m, { selection, nodeSelected: true });
    const chrome = harness.container.querySelector("[data-export-ignore]");
    expect(chrome).not.toBeNull();
    expect(harness.container.querySelector("[data-table-range]")).not.toBeNull();
    const active = harness.container.querySelector("[data-table-active-cell]");
    expect(active?.getAttribute("stroke-width")).toBe("2");
  });

  it("shows resize handles only when the node is selected", () => {
    const m = matrixFromRowsCols(2, 2);
    const onResize = () => undefined;
    harness = renderTable(m, { nodeSelected: true, onResizeHandlePointerDown: onResize });
    expect(harness.container.querySelectorAll("[data-resize-handle]")).toHaveLength(4);
    act(() => harness!.root.unmount());
    harness = renderTable(m, { nodeSelected: false, onResizeHandlePointerDown: onResize });
    expect(harness.container.querySelectorAll("[data-resize-handle]")).toHaveLength(0);
  });

  it("reports cell pointerdown and double-click with the cell address", () => {
    const m = matrixFromRowsCols(2, 2);
    const onDown = vi.fn();
    const onDbl = vi.fn();
    harness = renderTable(m, {
      nodeSelected: true,
      onCellPointerDown: onDown,
      onCellDoubleClick: onDbl,
    });
    const target = harness.container.querySelector(`[data-cell-id="${cellAt(m, 1, 1).id}"]`)!;
    act(() => {
      target.dispatchEvent(new MouseEvent("pointerdown", { bubbles: true }));
    });
    expect(onDown).toHaveBeenCalledTimes(1);
    expect(onDown.mock.calls[0]?.[1]).toEqual(addrOf(m, 1, 1));
    act(() => {
      target.dispatchEvent(new MouseEvent("dblclick", { bubbles: true }));
    });
    expect(onDbl).toHaveBeenCalledTimes(1);
    expect(onDbl.mock.calls[0]?.[1]).toEqual(addrOf(m, 1, 1));
  });

  it("starts a resize gesture from a column handle", () => {
    const m = matrixFromRowsCols(2, 2);
    const onResize = vi.fn();
    harness = renderTable(m, { nodeSelected: true, onResizeHandlePointerDown: onResize });
    const handle = harness.container.querySelector('[data-resize-handle="col"][data-index="0"]')!;
    act(() => {
      handle.dispatchEvent(new MouseEvent("pointerdown", { bubbles: true }));
    });
    expect(onResize).toHaveBeenCalledTimes(1);
    expect(onResize.mock.calls[0]?.[1]).toBe("col");
    expect(onResize.mock.calls[0]?.[2]).toBe(0);
  });
});
