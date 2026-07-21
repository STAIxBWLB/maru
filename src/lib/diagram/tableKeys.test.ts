import { describe, expect, it } from "vitest";

import { defaultCoalescer, withSnapshot } from "./actions";
import { createDiagramStore, type DiagramStore } from "./state";
import {
  addTableNode,
  copyCellsToClipboard,
  matrixForTableNode,
  setTableSelection,
} from "./tableActions";
import { nextTableKeyAction } from "./tableKeys";
import { createEmptyDoc, createInitialEphemeral, type TableCellAddress } from "./types";
import type { MatrixCell, MatrixDataset } from "./reportTypes";

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

function key(init: KeyboardEventInit): KeyboardEvent {
  // Node environment has no DOM KeyboardEvent; nextTableKeyAction only reads
  // the modifier/key fields, so a plain object suffices.
  return {
    key: init.key ?? "",
    metaKey: init.metaKey ?? false,
    ctrlKey: init.ctrlKey ?? false,
    altKey: init.altKey ?? false,
    shiftKey: init.shiftKey ?? false,
  } as KeyboardEvent;
}

function seededStore(rows = 3, cols = 3): {
  store: DiagramStore;
  nodeId: string;
  matrix: MatrixDataset;
} {
  const store = createDiagramStore({
    doc: createEmptyDoc("doc-1", 1),
    ephemeral: createInitialEphemeral(),
  });
  store.setState(withSnapshot(addTableNode(0, 0, rows, cols), defaultCoalescer()));
  const state = store.getState();
  const node = state.doc.nodes[0]!;
  const matrix = matrixForTableNode(node, state.doc.datasets)!;
  store.setState(
    setTableSelection({ nodeId: node.id, anchor: addrOf(matrix, 1, 1), focus: addrOf(matrix, 1, 1) }),
  );
  return { store, nodeId: node.id, matrix };
}

describe("nextTableKeyAction", () => {
  it("Tab / Shift+Tab move right and left", () => {
    const { store, matrix } = seededStore();
    const right = nextTableKeyAction(key({ key: "Tab" }), store.getState());
    expect(right?.kind).toBe("select");
    if (right?.kind === "select") {
      expect(right.selection.focus).toEqual(addrOf(matrix, 1, 2));
      expect(right.selection.anchor).toEqual(addrOf(matrix, 1, 2));
    }
    const left = nextTableKeyAction(key({ key: "Tab", shiftKey: true }), store.getState());
    if (left?.kind === "select") {
      expect(left.selection.focus).toEqual(addrOf(matrix, 1, 0));
    }
  });

  it("Enter moves down", () => {
    const { store, matrix } = seededStore();
    const action = nextTableKeyAction(key({ key: "Enter" }), store.getState());
    if (action?.kind === "select") {
      expect(action.selection.focus).toEqual(addrOf(matrix, 2, 1));
    } else {
      expect.unreachable();
    }
  });

  it("arrows move the active cell; Shift+arrow extends the range", () => {
    const { store, matrix } = seededStore();
    const move = nextTableKeyAction(key({ key: "ArrowUp" }), store.getState());
    if (move?.kind === "select") {
      expect(move.selection.focus).toEqual(addrOf(matrix, 0, 1));
      expect(move.selection.anchor).toEqual(addrOf(matrix, 0, 1));
    } else {
      expect.unreachable();
    }
    const extend = nextTableKeyAction(key({ key: "ArrowLeft", shiftKey: true }), store.getState());
    if (extend?.kind === "select") {
      expect(extend.selection.anchor).toEqual(addrOf(matrix, 1, 1)); // anchor stays
      expect(extend.selection.focus).toEqual(addrOf(matrix, 1, 0));
    } else {
      expect.unreachable();
    }
  });

  it("F2 edits the active cell; printable chars seed the editor", () => {
    const { store, matrix } = seededStore();
    const f2 = nextTableKeyAction(key({ key: "F2" }), store.getState());
    expect(f2).toEqual({ kind: "edit", addr: addrOf(matrix, 1, 1) });
    const char = nextTableKeyAction(key({ key: "가" }), store.getState());
    expect(char).toEqual({ kind: "edit", addr: addrOf(matrix, 1, 1), initial: "가" });
  });

  it("Delete clears the whole selected range", () => {
    const { store, matrix } = seededStore();
    // Extend selection to a 2x2 range first.
    store.setState(
      setTableSelection({
        nodeId: store.getState().ephemeral.tableSelection!.nodeId,
        anchor: addrOf(matrix, 1, 1),
        focus: addrOf(matrix, 2, 2),
      }),
    );
    const action = nextTableKeyAction(key({ key: "Delete" }), store.getState());
    expect(action?.kind).toBe("clearRange");
    if (action?.kind === "clearRange") {
      expect(action.cellIds).toHaveLength(4);
    }
  });

  it("Cmd+C copies the range as a TSV grid; Cmd+V pastes only with a cells clipboard", () => {
    const { store } = seededStore();
    const copy = nextTableKeyAction(key({ key: "c", metaKey: true }), store.getState());
    expect(copy?.kind).toBe("copy");
    if (copy?.kind === "copy") {
      store.setState(copyCellsToClipboard(copy.texts));
    }
    const paste = nextTableKeyAction(key({ key: "v", metaKey: true }), store.getState());
    expect(paste?.kind).toBe("paste");
  });

  it("Cmd+V without a cells clipboard falls through", () => {
    const { store } = seededStore();
    expect(nextTableKeyAction(key({ key: "v", metaKey: true }), store.getState())).toBeNull();
  });

  it("returns null without a table selection or for locked tables", () => {
    const store = createDiagramStore({
      doc: createEmptyDoc("doc-1", 1),
      ephemeral: createInitialEphemeral(),
    });
    expect(nextTableKeyAction(key({ key: "Tab" }), store.getState())).toBeNull();

    const { store: locked, nodeId } = seededStore();
    locked.setState((s) => ({
      ...s,
      doc: { ...s.doc, nodes: s.doc.nodes.map((n) => (n.id === nodeId ? { ...n, locked: true } : n)) },
    }));
    expect(nextTableKeyAction(key({ key: "Tab" }), locked.getState())).toBeNull();
  });
});
