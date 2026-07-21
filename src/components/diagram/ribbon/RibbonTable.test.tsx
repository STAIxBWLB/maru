// @vitest-environment jsdom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { defaultCoalescer, withSnapshot } from "../../../lib/diagram/actions";
import { LocaleContext, t as translate } from "../../../lib/i18n";
import {
  mergeCells,
  type MatrixCell,
  type MatrixDataset,
} from "../../../lib/diagram/reportTypes";
import type { DiagramStore } from "../../../lib/diagram/state";
import {
  addTableNode,
  matrixForTableNode,
  setCellText,
} from "../../../lib/diagram/tableActions";
import {
  createEmptyDoc,
  createInitialEphemeral,
  type DiagramDoc,
  type TableCellAddress,
} from "../../../lib/diagram/types";
import {
  DiagramStoreProvider,
  _resetDiagramSharedStoreForTests,
  useDiagramStore,
} from "../DiagramStoreContext";
import { RibbonTable } from "./RibbonTable";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let probe: DiagramStore | null = null;
function StoreProbe() {
  probe = useDiagramStore();
  return null;
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

function currentMatrix(): MatrixDataset {
  const state = probe!.getState();
  const matrix = matrixForTableNode(state.doc.nodes[0], state.doc.datasets);
  if (!matrix) throw new Error("no matrix");
  return matrix;
}

interface SeedOpts {
  texts?: Array<[number, number, string]>;
  mergeFirstColumn?: boolean;
  anchor: [number, number];
  focus: [number, number];
}

function seedDoc(opts: SeedOpts): { doc: DiagramDoc; nodeId: string; matrix: MatrixDataset } {
  // Build the doc by replaying the real actions on a scratch store.
  const scratch: { state: ReturnType<typeof baseState> } = {
    state: baseState(),
  };
  function baseState() {
    return { doc: createEmptyDoc("doc-seed", 1), ephemeral: createInitialEphemeral() };
  }
  scratch.state = addTableNode(0, 0, 3, 3)(scratch.state);
  const node = scratch.state.doc.nodes[0]!;
  const matrix = matrixForTableNode(node, scratch.state.doc.datasets)!;
  if (opts.mergeFirstColumn) {
    scratch.state = {
      ...scratch.state,
      doc: {
        ...scratch.state.doc,
        datasets: scratch.state.doc.datasets!.map((ds) =>
          ds.id === matrix.id
            ? mergeCells(ds as MatrixDataset, [
                cellAt(ds as MatrixDataset, 0, 0).id,
                cellAt(ds as MatrixDataset, 1, 0).id,
              ])
            : ds,
        ),
      },
    };
  }
  for (const [r, c, text] of opts.texts ?? []) {
    const m = matrixForTableNode(node, scratch.state.doc.datasets)!;
    const cell = cellAt(m, r, c);
    scratch.state = setCellText(m.id, cell.id, text)(scratch.state);
  }
  const finalMatrix = matrixForTableNode(node, scratch.state.doc.datasets)!;
  return { doc: scratch.state.doc, nodeId: node.id, matrix: finalMatrix };
}

interface Harness {
  container: HTMLDivElement;
  root: Root;
}

let keySeq = 0;

function mountRibbon(opts: SeedOpts): Harness {
  const { doc, nodeId, matrix } = seedDoc(opts);
  const ephemeral = {
    ...createInitialEphemeral(),
    selection: { nodes: new Set([nodeId]), edges: new Set<string>() },
    tableSelection: {
      nodeId,
      anchor: addrOf(matrix, ...opts.anchor),
      focus: addrOf(matrix, ...opts.focus),
    },
  };
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  keySeq += 1;
  act(() => {
    root.render(
      <LocaleContext.Provider
        value={{
          locale: "ko",
          setLocale: () => {},
          t: (key, vars) => translate("ko", key, vars),
        }}
      >
        <DiagramStoreProvider initial={{ doc, ephemeral }} storeKey={`ribbon-test-${keySeq}`}>
          <StoreProbe />
          <RibbonTable />
        </DiagramStoreProvider>
      </LocaleContext.Provider>,
    );
  });
  return { container, root };
}

function clickButton(container: HTMLDivElement, label: string) {
  const button = [...container.querySelectorAll("button")].find(
    (b) => b.getAttribute("aria-label") === label,
  );
  if (!button) throw new Error(`button not found: ${label}`);
  expect((button as HTMLButtonElement).disabled).toBe(false);
  act(() => {
    button.dispatchEvent(new MouseEvent("click", { bubbles: true }));
  });
}

describe("RibbonTable — destructive-op confirmation gating", () => {
  let harness: Harness | null = null;
  let confirmSpy: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    document.body.innerHTML = "";
    probe = null;
    _resetDiagramSharedStoreForTests();
    confirmSpy = vi.fn(() => false);
    vi.stubGlobal("confirm", confirmSpy);
  });

  afterEach(() => {
    if (harness) {
      act(() => harness!.root.unmount());
      harness = null;
    }
    vi.unstubAllGlobals();
    document.body.innerHTML = "";
    _resetDiagramSharedStoreForTests();
  });

  it("merge asks before joining non-empty cells; cancel keeps the matrix", () => {
    harness = mountRibbon({
      texts: [
        [0, 0, "A"],
        [0, 1, "B"],
      ],
      anchor: [0, 0],
      focus: [0, 1],
    });
    const before = currentMatrix();
    clickButton(harness.container, "셀 병합");
    expect(confirmSpy).toHaveBeenCalledTimes(1);
    expect(currentMatrix()).toBe(before); // untouched
  });

  it("merge proceeds on confirm: texts join with newline in one undo step", () => {
    confirmSpy.mockReturnValue(true);
    harness = mountRibbon({
      texts: [
        [0, 0, "A"],
        [0, 1, "B"],
      ],
      anchor: [0, 0],
      focus: [0, 1],
    });
    const depthBefore = probe!.getState().ephemeral.history.past.length;
    clickButton(harness.container, "셀 병합");
    const matrix = currentMatrix();
    expect(Object.keys(matrix.cells)).toHaveLength(8);
    expect(cellAt(matrix, 0, 0).text).toBe("A\nB");
    expect(cellAt(matrix, 0, 0).colSpan).toBe(2);
    expect(probe!.getState().ephemeral.history.past).toHaveLength(depthBefore + 1);
  });

  it("merge of empty-only cells skips the confirmation", () => {
    harness = mountRibbon({ anchor: [0, 0], focus: [0, 1] });
    clickButton(harness.container, "셀 병합");
    expect(confirmSpy).not.toHaveBeenCalled();
    expect(Object.keys(currentMatrix().cells)).toHaveLength(8);
  });

  it("row delete with content requires confirmation; cancel keeps the row", () => {
    harness = mountRibbon({ texts: [[1, 0, "data"]], anchor: [1, 0], focus: [1, 0] });
    clickButton(harness.container, "행 삭제");
    expect(confirmSpy).toHaveBeenCalledTimes(1);
    expect(currentMatrix().rows).toHaveLength(3);
  });

  it("row delete proceeds on confirm", () => {
    confirmSpy.mockReturnValue(true);
    harness = mountRibbon({ texts: [[1, 0, "data"]], anchor: [1, 0], focus: [1, 0] });
    clickButton(harness.container, "행 삭제");
    expect(currentMatrix().rows).toHaveLength(2);
  });

  it("row delete blocked on a span anchor shows a localized notice", () => {
    confirmSpy.mockReturnValue(true);
    harness = mountRibbon({
      texts: [[0, 0, "merged"]],
      mergeFirstColumn: true,
      anchor: [0, 0],
      focus: [0, 0],
    });
    clickButton(harness.container, "행 삭제");
    expect(currentMatrix().rows).toHaveLength(3); // unchanged
    expect(harness.container.textContent).toContain("병합된 셀의 시작 행은 삭제할 수 없습니다.");
  });

  it("column delete with content requires confirmation", () => {
    harness = mountRibbon({ texts: [[0, 2, "data"]], anchor: [0, 2], focus: [0, 2] });
    clickButton(harness.container, "열 삭제");
    expect(confirmSpy).toHaveBeenCalledTimes(1);
    expect(currentMatrix().columns).toHaveLength(3);
  });

  it("header role toggle flips the focus row role", () => {
    harness = mountRibbon({ anchor: [1, 1], focus: [1, 1] });
    clickButton(harness.container, "머리글");
    expect(currentMatrix().rows[1]?.role).toBe("header");
    clickButton(harness.container, "머리글");
    expect(currentMatrix().rows[1]?.role).toBe("data");
  });

  it("semantic tag dropdown assigns the focus column's tag", () => {
    harness = mountRibbon({ anchor: [0, 2], focus: [0, 2] });
    const select = harness.container.querySelector("select")!;
    act(() => {
      const setter = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, "value")?.set;
      setter?.call(select, "owner");
      select.dispatchEvent(new Event("change", { bubbles: true }));
    });
    expect(currentMatrix().columns[2]?.tag).toBe("owner");
  });
});
