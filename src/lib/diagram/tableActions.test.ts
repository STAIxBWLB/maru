import { describe, expect, it } from "vitest";

import { defaultCoalescer, setSelection, undo, withSnapshot } from "./actions";
import { createCoalescer } from "./history";
import {
  deleteRow,
  insertRow,
  mergeCells,
  validateMatrix,
  type MatrixCell,
  type MatrixDataset,
} from "./reportTypes";
import { createDiagramStore, type DiagramStore } from "./state";
import {
  addTableNode,
  clearCellsText,
  copyCellsToClipboard,
  copyNodesToClipboard,
  matrixForTableNode,
  pasteClipboard,
  setCellText,
  setCellsStyle,
  setColumnTag,
  setColumnWidth,
  setDocPage,
  setRowHeight,
  setRowRole,
  setTableSelection,
  updateMatrix,
} from "./tableActions";
import { createEmptyDoc, createInitialEphemeral, type TableCellAddress } from "./types";

function freshStore() {
  return createDiagramStore({
    doc: createEmptyDoc("doc-1", 1),
    ephemeral: createInitialEphemeral(),
  });
}

/** Add a table and return its node + matrix. */
function seedTable(store: DiagramStore, rows = 3, cols = 3) {
  store.setState(withSnapshot(addTableNode(10, 20, rows, cols), defaultCoalescer()));
  const state = store.getState();
  const node = state.doc.nodes[0];
  if (!node) throw new Error("no node");
  const matrix = matrixForTableNode(node, state.doc.datasets);
  if (!matrix) throw new Error("no matrix");
  return { node, matrix };
}

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

function currentMatrix(store: DiagramStore): MatrixDataset {
  const state = store.getState();
  const matrix = matrixForTableNode(state.doc.nodes[0], state.doc.datasets);
  if (!matrix) throw new Error("no matrix");
  return matrix;
}

describe("addTableNode", () => {
  it("creates a node linked to a fresh matrix dataset + pattern view", () => {
    const store = freshStore();
    const { node, matrix } = seedTable(store, 2, 4);
    const state = store.getState();
    expect(node.kind).toBe("table");
    expect(matrix.rows).toHaveLength(2);
    expect(matrix.columns).toHaveLength(4);
    expect(validateMatrix(matrix).ok).toBe(true);
    const view = state.doc.views?.[0];
    expect(view?.datasetId).toBe(matrix.id);
    expect(view?.patternId).toBe("table");
    expect((node.meta as Record<string, unknown>).viewId).toBe(view?.id);
    expect((node.meta as Record<string, unknown>).memberId).toBe(matrix.id);
    expect([...state.ephemeral.selection.nodes]).toEqual([node.id]);
  });
});

describe("cell text editing + undo", () => {
  it("one commit = one undo entry; undo restores the prior text", () => {
    const store = freshStore();
    const { matrix } = seedTable(store);
    const cell = cellAt(matrix, 0, 0);
    const before = JSON.stringify(store.getState().doc);
    store.setState(
      withSnapshot(setCellText(matrix.id, cell.id, "hello"), defaultCoalescer()),
    );
    expect(store.getState().ephemeral.history.past).toHaveLength(2); // addTableNode + edit
    expect(cellAt(currentMatrix(store), 0, 0).text).toBe("hello");
    store.setState(undo());
    expect(JSON.stringify(store.getState().doc)).toBe(before);
  });

  it("coalesces rapid commits into a single history entry", () => {
    const store = freshStore();
    const { matrix } = seedTable(store);
    const cell = cellAt(matrix, 0, 0);
    let now = 10_000;
    const coalescer = createCoalescer(500);
    const clock = () => now;
    store.setState(withSnapshot(setCellText(matrix.id, cell.id, "h"), coalescer, { coalesce: true, now: clock }));
    now += 100;
    store.setState(withSnapshot(setCellText(matrix.id, cell.id, "he"), coalescer, { coalesce: true, now: clock }));
    now += 100;
    store.setState(withSnapshot(setCellText(matrix.id, cell.id, "hel"), coalescer, { coalesce: true, now: clock }));
    // addTableNode snapshot + exactly one coalesced typing entry.
    expect(store.getState().ephemeral.history.past).toHaveLength(2);
    expect(cellAt(currentMatrix(store), 0, 0).text).toBe("hel");
    store.setState(undo());
    expect(cellAt(currentMatrix(store), 0, 0).text).toBe("");
    // After the window elapses the next edit snapshots again.
    now += 1000;
    store.setState(withSnapshot(setCellText(matrix.id, cell.id, "x"), coalescer, { coalesce: true, now: clock }));
    expect(store.getState().ephemeral.history.past).toHaveLength(2);
  });

  it("no-ops when the value is unchanged (no history entry)", () => {
    const store = freshStore();
    const { matrix } = seedTable(store);
    const cell = cellAt(matrix, 0, 0);
    const depth = store.getState().ephemeral.history.past.length;
    store.setState(withSnapshot(setCellText(matrix.id, cell.id, ""), defaultCoalescer()));
    expect(store.getState().ephemeral.history.past).toHaveLength(depth);
  });
});

describe("structure ops undo to the exact prior state", () => {
  it("merge then undo restores cell-for-cell equality", () => {
    const store = freshStore();
    const { matrix } = seedTable(store, 2, 2);
    store.setState(
      withSnapshot(
        updateMatrix(matrix.id, (m) => {
          const a = cellAt(m, 0, 0);
          return { ...m, cells: { ...m.cells, [a.id]: { ...a, text: "A" } } };
        }),
        defaultCoalescer(),
      ),
    );
    const before = JSON.stringify(store.getState().doc);
    const ids = [cellAt(currentMatrix(store), 0, 0), cellAt(currentMatrix(store), 0, 1)].map((c) => c.id);
    store.setState(
      withSnapshot(
        updateMatrix(matrix.id, (m) => mergeCells(m, ids)),
        defaultCoalescer(),
      ),
    );
    const merged = currentMatrix(store);
    expect(Object.keys(merged.cells)).toHaveLength(3);
    expect(validateMatrix(merged).ok).toBe(true);
    store.setState(undo());
    expect(JSON.stringify(store.getState().doc)).toBe(before);
  });

  it("insert + delete row round-trip through undo", () => {
    const store = freshStore();
    const { matrix } = seedTable(store, 2, 2);
    const before = JSON.stringify(store.getState().doc);
    store.setState(
      withSnapshot(updateMatrix(matrix.id, (m) => insertRow(m, 1, "header")), defaultCoalescer()),
    );
    expect(currentMatrix(store).rows).toHaveLength(3);
    expect(currentMatrix(store).rows[1]?.role).toBe("header");
    const insertedId = currentMatrix(store).rows[1]!.id;
    store.setState(
      withSnapshot(updateMatrix(matrix.id, (m) => deleteRow(m, insertedId)), defaultCoalescer()),
    );
    expect(currentMatrix(store).rows).toHaveLength(2);
    store.setState(undo()); // undo delete
    store.setState(undo()); // undo insert
    expect(JSON.stringify(store.getState().doc)).toBe(before);
  });
});

describe("lock rule", () => {
  it("ignores dataset edits when the linked table node is locked", () => {
    const store = freshStore();
    const { node, matrix } = seedTable(store);
    store.setState((s) => ({
      ...s,
      doc: { ...s.doc, nodes: s.doc.nodes.map((n) => (n.id === node.id ? { ...n, locked: true } : n)) },
    }));
    const cell = cellAt(matrix, 0, 0);
    const before = store.getState().doc;
    store.setState(withSnapshot(setCellText(matrix.id, cell.id, "nope"), defaultCoalescer()));
    expect(store.getState().doc).toBe(before);
  });
});

describe("style / role / tag / resize", () => {
  it("applies style patches across a range", () => {
    const store = freshStore();
    const { matrix } = seedTable(store, 2, 2);
    const ids = Object.keys(matrix.cells);
    store.setState(
      withSnapshot(setCellsStyle(matrix.id, ids, { bold: true, align: "center" }), defaultCoalescer()),
    );
    for (const cell of Object.values(currentMatrix(store).cells)) {
      expect(cell.style?.bold).toBe(true);
      expect(cell.style?.align).toBe("center");
    }
  });

  it("clears range text", () => {
    const store = freshStore();
    const { matrix } = seedTable(store, 1, 2);
    const a = cellAt(matrix, 0, 0);
    store.setState(withSnapshot(setCellText(matrix.id, a.id, "x"), defaultCoalescer()));
    store.setState(
      withSnapshot(clearCellsText(matrix.id, [a.id, cellAt(matrix, 0, 1).id]), defaultCoalescer()),
    );
    expect(cellAt(currentMatrix(store), 0, 0).text).toBe("");
  });

  it("sets row roles and column tags", () => {
    const store = freshStore();
    const { matrix } = seedTable(store, 2, 2);
    const rowId = matrix.rows[0]!.id;
    const colId = matrix.columns[1]!.id;
    store.setState(withSnapshot(setRowRole(matrix.id, rowId, "header"), defaultCoalescer()));
    store.setState(withSnapshot(setColumnTag(matrix.id, colId, "owner"), defaultCoalescer()));
    expect(currentMatrix(store).rows[0]?.role).toBe("header");
    expect(currentMatrix(store).columns[1]?.tag).toBe("owner");
    store.setState(withSnapshot(setColumnTag(matrix.id, colId, null), defaultCoalescer()));
    expect(currentMatrix(store).columns[1]?.tag).toBeUndefined();
  });

  it("resizes tracks with a minimum clamp", () => {
    const store = freshStore();
    const { matrix } = seedTable(store, 2, 2);
    const colId = matrix.columns[0]!.id;
    const rowId = matrix.rows[0]!.id;
    store.setState(withSnapshot(setColumnWidth(matrix.id, colId, 123.6), defaultCoalescer()));
    store.setState(withSnapshot(setRowHeight(matrix.id, rowId, 4), defaultCoalescer()));
    expect(currentMatrix(store).columns[0]?.width).toBe(124);
    expect(currentMatrix(store).rows[0]?.height).toBe(16);
  });
});

describe("table selection lifecycle", () => {
  it("setSelection to other nodes clears the table selection", () => {
    const store = freshStore();
    const { node, matrix } = seedTable(store);
    store.setState(
      setTableSelection({ nodeId: node.id, anchor: addrOf(matrix, 0, 0), focus: addrOf(matrix, 0, 0) }),
    );
    expect(store.getState().ephemeral.tableSelection).not.toBeNull();
    store.setState(setSelection([]));
    expect(store.getState().ephemeral.tableSelection).toBeNull();
  });

  it("setSelection keeping the table node preserves the table selection", () => {
    const store = freshStore();
    const { node, matrix } = seedTable(store);
    const ts = { nodeId: node.id, anchor: addrOf(matrix, 0, 0), focus: addrOf(matrix, 1, 1) };
    store.setState(setTableSelection(ts));
    store.setState(setSelection([node.id]));
    expect(store.getState().ephemeral.tableSelection).toEqual(ts);
  });
});

describe("clipboard", () => {
  it("copies nodes and pastes them offset with fresh ids", () => {
    const store = freshStore();
    seedTable(store);
    store.setState(copyNodesToClipboard());
    expect(store.getState().ephemeral.clipboard?.kind).toBe("nodes");
    store.setState(withSnapshot(pasteClipboard(), defaultCoalescer()));
    const nodes = store.getState().doc.nodes;
    expect(nodes).toHaveLength(2);
    expect(nodes[1]?.id).not.toBe(nodes[0]?.id);
    expect(nodes[1]?.x).toBe((nodes[0]?.x ?? 0) + 24);
    expect([...store.getState().ephemeral.selection.nodes]).toEqual([nodes[1]!.id]);
  });

  it("pastes a copied cell range at the active cell (clipped)", () => {
    const store = freshStore();
    const { node, matrix } = seedTable(store, 2, 2);
    const a = cellAt(matrix, 0, 0);
    store.setState(withSnapshot(setCellText(matrix.id, a.id, "A"), defaultCoalescer()));
    store.setState(copyCellsToClipboard([["A", "B"], ["C", "D"]]));
    // Active cell at (1,1): only "A" lands (rest clipped).
    store.setState(
      setTableSelection({ nodeId: node.id, anchor: addrOf(currentMatrix(store), 1, 1), focus: addrOf(currentMatrix(store), 1, 1) }),
    );
    store.setState(withSnapshot(pasteClipboard(), defaultCoalescer()));
    expect(cellAt(currentMatrix(store), 1, 1).text).toBe("A");
    expect(cellAt(currentMatrix(store), 0, 1).text).toBe("");
  });

  it("cell paste is a no-op without an active table selection", () => {
    const store = freshStore();
    seedTable(store);
    store.setState(copyCellsToClipboard([["A"]]));
    const before = store.getState().doc;
    store.setState(withSnapshot(pasteClipboard(), defaultCoalescer()));
    expect(store.getState().doc).toBe(before);
  });
});

describe("page frame", () => {
  it("setDocPage stores non-free formats and normalizes free to absent", () => {
    const store = freshStore();
    store.setState(withSnapshot(setDocPage("a4-portrait"), defaultCoalescer()));
    expect(store.getState().doc.page).toBe("a4-portrait");
    store.setState(withSnapshot(setDocPage("free"), defaultCoalescer()));
    expect(store.getState().doc.page).toBeUndefined();
  });
});
