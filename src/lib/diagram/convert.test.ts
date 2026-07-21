import { describe, expect, it } from "vitest";

import { defaultCoalescer, undo, withSnapshot } from "./actions";
import {
  addLinkedView,
  addLinkedViewAction,
  classifyConversion,
  convertToNewDataset,
  detachViewMembers,
  detachWholeView,
  detachWholeViewAction,
  matrixToFlow,
  matrixToHierarchy,
  matrixToScorecard,
  matrixToTimeline,
  regenerateView,
  switchViewPattern,
  switchViewPatternAction,
} from "./convert";
import { reportFixtures } from "./__fixtures__/reports";
import {
  TABLE_PATTERN_ID,
  fixtureToMatrix,
  matrixFromRowsCols,
  type HierarchyDataset,
  type MatrixCell,
  type MatrixDataset,
  type PatternViewBounds,
  type ReportDataset,
  type SemanticTag,
} from "./reportTypes";
import { createDiagramStore } from "./state";
import { addTableNode } from "./tableActions";
import { createEmptyDoc, createInitialEphemeral, type DiagramDoc } from "./types";

const BOUNDS: PatternViewBounds = { x: 100, y: 80, w: 480, h: 320 };

function fixtureMatrix(kind: string, tags: (SemanticTag | undefined)[] = []): MatrixDataset {
  const fixture = reportFixtures.find((f) => f.kind === kind);
  if (!fixture) throw new Error(`no fixture ${kind}`);
  const matrix = fixtureToMatrix(fixture);
  return {
    ...matrix,
    columns: matrix.columns.map((col, i) => (tags[i] ? { ...col, tag: tags[i]! } : col)),
  };
}

function textMatrix(rows: string[][], tags: (SemanticTag | undefined)[] = []): MatrixDataset {
  const matrix = matrixFromRowsCols(rows.length, rows[0]?.length ?? 1);
  const cells: Record<string, MatrixCell> = {};
  for (const cell of Object.values(matrix.cells)) {
    const r = matrix.rows.findIndex((row) => row.id === cell.rowId);
    const c = matrix.columns.findIndex((col) => col.id === cell.colId);
    cells[cell.id] = { ...cell, text: rows[r]?.[c] ?? "" };
  }
  return {
    ...matrix,
    cells,
    columns: matrix.columns.map((col, i) => (tags[i] ? { ...col, tag: tags[i]! } : col)),
  };
}

function docWithView(
  dataset: ReportDataset,
  patternId: string,
  bounds: PatternViewBounds = BOUNDS,
): DiagramDoc {
  const doc = { ...createEmptyDoc("doc-1", 1), datasets: [dataset] };
  return addLinkedView(doc, dataset.id, patternId, bounds);
}

// ---------------------------------------------------------------------------
// Tag-driven matrix extraction
// ---------------------------------------------------------------------------

describe("matrixToScorecard", () => {
  it("extracts tagged columns into scorecard entries", () => {
    const matrix = fixtureMatrix("kpi-scorecard", [
      "label",
      undefined, // baseline — dropped with a warning
      "target",
      "actual",
      "status",
      "evidence",
    ]);
    const { dataset, warnings } = matrixToScorecard(matrix);
    expect(dataset.kind).toBe("scorecard");
    expect(dataset.entries).toHaveLength(4);
    const first = dataset.entries[0]!;
    expect(first.label).toBe("Trainees enrolled (cumulative)");
    expect(first.target).toBe("500");
    expect(first.actual).toBe("472");
    expect(first.status).toBe("On track");
    expect(first.evidence).toBe("Enrollment ledger export 2028-06");
    // the untagged baseline column is dropped, never silently
    expect(warnings.map((w) => w.key)).toContain("diagram.pattern.warn.unmappedColumn");
    expect(warnings.map((w) => w.key)).not.toContain(
      "diagram.pattern.warn.positionalFallback",
    );
  });
});

describe("matrixToTimeline", () => {
  it("falls back positionally for untagged columns, with a warning", () => {
    const matrix = textMatrix([
      ["Design", "2026-01", "2026-03"],
      ["Build", "2026-04", "2026-08"],
    ]);
    const { dataset, warnings } = matrixToTimeline(matrix);
    expect(dataset.items).toHaveLength(2);
    expect(dataset.items[0]).toMatchObject({ label: "Design", start: "2026-01", end: "2026-03" });
    expect(dataset.items[1]).toMatchObject({ label: "Build", start: "2026-04", end: "2026-08" });
    expect(warnings.map((w) => w.key)).toContain("diagram.pattern.warn.positionalFallback");
  });
});

describe("matrixToHierarchy", () => {
  it("resolves parent labels to ids and warns on unmatched parents", () => {
    const matrix = textMatrix(
      [
        ["Root", ""],
        ["Child A", "Root"],
        ["Child B", "Root"],
        ["Orphan", "Nobody"],
      ],
      ["label", "parent"],
    );
    const { dataset, warnings } = matrixToHierarchy(matrix);
    expect(dataset.nodes).toHaveLength(4);
    const byLabel = new Map(dataset.nodes.map((n) => [n.label, n]));
    expect(byLabel.get("Root")?.parentId).toBeNull();
    expect(byLabel.get("Child A")?.parentId).toBe(byLabel.get("Root")?.id);
    expect(byLabel.get("Child B")?.parentId).toBe(byLabel.get("Root")?.id);
    expect(byLabel.get("Orphan")?.parentId).toBeNull();
    expect(warnings.map((w) => w.key)).toContain("diagram.pattern.warn.unmatchedParent");
  });
});

describe("matrixToFlow", () => {
  it("builds link-mode flows from label/from/to tags", () => {
    const matrix = textMatrix(
      [
        ["draft", "Intake", "Review"],
        ["approve", "Review", "Publish"],
      ],
      ["label", "from", "to"],
    );
    const { dataset } = matrixToFlow(matrix);
    expect(dataset.nodes.map((n) => n.label)).toEqual(["Intake", "Review", "Publish"]);
    expect(dataset.links).toHaveLength(2);
    expect(dataset.links[0]?.label).toBe("draft");
    const idOf = (label: string) => dataset.nodes.find((n) => n.label === label)?.id;
    expect(dataset.links[0]?.from).toBe(idOf("Intake"));
    expect(dataset.links[0]?.to).toBe(idOf("Review"));
  });

  it("chains records in sequence mode when only a label is available", () => {
    const matrix = textMatrix([["Plan"], ["Do"], ["Check"]], ["label"]);
    const { dataset } = matrixToFlow(matrix);
    expect(dataset.nodes.map((n) => n.label)).toEqual(["Plan", "Do", "Check"]);
    expect(dataset.links).toHaveLength(2);
  });
});

// ---------------------------------------------------------------------------
// Same-family switch + linked views
// ---------------------------------------------------------------------------

describe("switchViewPattern", () => {
  const tree: HierarchyDataset = {
    id: "ds-tree",
    kind: "hierarchy",
    name: "Tree",
    nodes: [
      { id: "n-root", parentId: null, label: "Core problem" },
      { id: "n-a", parentId: "n-root", label: "Cause A" },
      { id: "n-b", parentId: "n-root", label: "Cause B" },
    ],
  };

  it("regenerates members from the SAME dataset (identity preserved)", () => {
    const doc = docWithView(tree, "report.problem-tree");
    const next = switchViewPattern(doc, doc.views![0]!.id, "report.objective-tree");
    // dataset object identity preserved — no copy
    expect(next.datasets![0]).toBe(tree);
    const view = next.views![0]!;
    expect(view.patternId).toBe("report.objective-tree");
    expect(view.datasetId).toBe(tree.id);
    // problem→objective preserves labels and structure exactly
    const titles = next.nodes.map((n) => n.title).sort();
    expect(titles).toEqual(["Cause A", "Cause B", "Core problem"]);
    expect(next.edges).toHaveLength(2);
    // projection hash updated
    expect(view.projectionHash).not.toBe(doc.views![0]!.projectionHash);
  });

  it("throws on cross-family targets (use convertToNewDataset)", () => {
    const doc = docWithView(tree, "report.problem-tree");
    expect(() => switchViewPattern(doc, doc.views![0]!.id, TABLE_PATTERN_ID)).toThrow();
    expect(() => switchViewPattern(doc, doc.views![0]!.id, "swot")).toThrow();
  });
});

describe("addLinkedView", () => {
  it("creates a second live view of one dataset with view-scoped member ids", () => {
    const matrix = fixtureMatrix("kpi-scorecard", ["label"]);
    const doc = docWithView(matrix, TABLE_PATTERN_ID);
    const next = addLinkedView(doc, matrix.id, "report.checklist", { x: 700, y: 80, w: 300, h: 200 });
    expect(next.views).toHaveLength(2);
    expect(next.datasets).toHaveLength(1);
    const [v1, v2] = next.views!;
    expect(v1!.datasetId).toBe(matrix.id);
    expect(v2!.datasetId).toBe(matrix.id);
    expect(v1!.nodeIds[0]).not.toBe(v2!.nodeIds[0]);
    // both views' members exist on canvas
    for (const id of [...v1!.nodeIds, ...v2!.nodeIds]) {
      expect(next.nodes.some((n) => n.id === id), id).toBe(true);
    }
  });
});

// ---------------------------------------------------------------------------
// classifyConversion + cross-family conversion
// ---------------------------------------------------------------------------

describe("classifyConversion", () => {
  it("distinguishes same-family, cross-family, and freeform", () => {
    const tree: HierarchyDataset = {
      id: "ds-cls",
      kind: "hierarchy",
      name: "T",
      nodes: [{ id: "n1", parentId: null, label: "Root" }],
    };
    const doc = docWithView(tree, "report.problem-tree");
    const viewId = doc.views![0]!.id;
    expect(classifyConversion(doc, viewId, "report.objective-tree")).toBe("same-family");
    expect(classifyConversion(doc, viewId, TABLE_PATTERN_ID)).toBe("cross-family");
    expect(classifyConversion(doc, viewId, "report.kpi-scorecard")).toBe("cross-family");
    expect(classifyConversion(doc, viewId, "swot")).toBe("freeform");
    expect(classifyConversion(doc, "no-such-view", "report.objective-tree")).toBe("freeform");
  });
});

describe("convertToNewDataset", () => {
  it("creates a new dataset of the target kind; source untouched", () => {
    const matrix = fixtureMatrix("kpi-scorecard", [
      "label",
      undefined,
      "target",
      "actual",
      "status",
      "evidence",
    ]);
    const doc = docWithView(matrix, TABLE_PATTERN_ID);
    const sourceView = doc.views![0]!;
    const { doc: next, warnings } = convertToNewDataset(
      doc,
      sourceView.id,
      "report.kpi-scorecard",
    );
    // source dataset + view untouched
    expect(next.datasets).toHaveLength(2);
    expect(next.datasets![0]).toBe(matrix);
    expect(next.views).toHaveLength(2);
    expect(next.views![0]).toBe(sourceView);
    // new dataset + view
    const scorecard = next.datasets![1]!;
    expect(scorecard.kind).toBe("scorecard");
    const newView = next.views![1]!;
    expect(newView.datasetId).toBe(scorecard.id);
    expect(newView.patternId).toBe("report.kpi-scorecard");
    expect(newView.bounds.x).toBe(sourceView.bounds.x + 48);
    // new members carry view linkage
    for (const id of newView.nodeIds) {
      const node = next.nodes.find((n) => n.id === id);
      expect(node?.meta?.viewId).toBe(newView.id);
    }
    // baseline column dropped with a warning
    expect(warnings.some((w) => w.includes("unmappedColumn"))).toBe(true);
  });

  it("respects a user-confirmed mapping over positional fallback", () => {
    const matrix = textMatrix([
      ["2026-01", "Design phase", "2026-03"],
    ]);
    const doc = docWithView(matrix, TABLE_PATTERN_ID);
    const columns = matrix.columns;
    const { doc: next } = convertToNewDataset(doc, doc.views![0]!.id, "report.timeline", {
      label: columns[1]!.id,
      start: columns[0]!.id,
      end: columns[2]!.id,
    });
    const timeline = next.datasets![1]!;
    if (timeline.kind !== "timeline") throw new Error("wrong kind");
    expect(timeline.items[0]).toMatchObject({
      label: "Design phase",
      start: "2026-01",
      end: "2026-03",
    });
  });
});

// ---------------------------------------------------------------------------
// Detach
// ---------------------------------------------------------------------------

describe("detach", () => {
  it("detachViewMembers strips linkage and removes members from the view", () => {
    const tree: HierarchyDataset = {
      id: "ds-det",
      kind: "hierarchy",
      name: "T",
      nodes: [
        { id: "n1", parentId: null, label: "Root" },
        { id: "n2", parentId: "n1", label: "Child" },
      ],
    };
    const doc = docWithView(tree, "report.problem-tree");
    const view = doc.views![0]!;
    const memberId = view.nodeIds[0]!;
    const next = detachViewMembers(doc, view.id, [memberId]);
    const nextView = next.views![0]!;
    expect(nextView.nodeIds).not.toContain(memberId);
    const detached = next.nodes.find((n) => n.id === memberId)!;
    expect(detached.meta?.viewId).toBeUndefined();
    expect(detached.meta?.memberId).toBeUndefined();
  });

  it("detachWholeView removes the view, keeps nodes, blocks conversion", () => {
    const tree: HierarchyDataset = {
      id: "ds-det2",
      kind: "hierarchy",
      name: "T",
      nodes: [{ id: "n1", parentId: null, label: "Root" }],
    };
    const doc = docWithView(tree, "report.problem-tree");
    const view = doc.views![0]!;
    const next = detachWholeView(doc, view.id);
    expect(next.views ?? []).toHaveLength(0);
    expect(next.nodes).toHaveLength(1);
    expect(next.nodes[0]?.meta?.viewId).toBeUndefined();
    expect(classifyConversion(next, view.id, "report.objective-tree")).toBe("freeform");
  });

  it("keeps a table node's dataset pointer so the snippet still renders", () => {
    const store = createDiagramStore({
      doc: createEmptyDoc("doc-1", 1),
      ephemeral: createInitialEphemeral(),
    });
    store.setState(withSnapshot(addTableNode(10, 20, 2, 2), defaultCoalescer()));
    const state = store.getState();
    const view = state.doc.views![0]!;
    const datasetId = state.doc.datasets![0]!.id;
    store.setState(withSnapshot(detachWholeViewAction(view.id), defaultCoalescer()));
    const after = store.getState();
    expect(after.doc.views ?? []).toHaveLength(0);
    const table = after.doc.nodes[0]!;
    expect(table.meta?.viewId).toBeUndefined();
    expect(table.meta?.memberId).toBe(datasetId);
  });
});

// ---------------------------------------------------------------------------
// Projection sync
// ---------------------------------------------------------------------------

describe("regenerateView", () => {
  const tree: HierarchyDataset = {
    id: "ds-regen",
    kind: "hierarchy",
    name: "T",
    nodes: [
      { id: "n1", parentId: null, label: "Root" },
      { id: "n2", parentId: "n1", label: "Child" },
    ],
  };

  it("is a no-op when the projection hash is unchanged", () => {
    const doc = docWithView(tree, "report.problem-tree");
    expect(regenerateView(doc, doc.views![0]!.id)).toBe(doc);
  });

  it("regenerates member text from the dataset (dataset wins)", () => {
    const doc = docWithView(tree, "report.problem-tree");
    const view = doc.views![0]!;
    // user-styled member survives (same member count); dataset text wins
    const styledNodes = doc.nodes.map((n, i) =>
      i === 0 ? { ...n, title: "USER EDIT", style: { bg: "#FF0000" } } : n,
    );
    const edited = {
      ...doc,
      nodes: styledNodes,
      datasets: [
        {
          ...tree,
          nodes: tree.nodes.map((n) =>
            n.id === "n1" ? { ...n, label: "Root (revised)" } : n,
          ),
        },
      ],
    };
    const next = regenerateView(edited, view.id);
    const titles = next.nodes.map((n) => n.title).sort();
    expect(titles).toEqual(["Child", "Root (revised)"]);
    // style override keyed by member index survives (member count unchanged)
    expect(next.nodes[0]?.style?.bg).toBe("#FF0000");
    expect(next.views![0]!.projectionHash).not.toBe(view.projectionHash);
  });

  it("resets style overrides when the member count changes", () => {
    const doc = docWithView(tree, "report.problem-tree");
    const view = doc.views![0]!;
    const styledNodes = doc.nodes.map((n, i) =>
      i === 0 ? { ...n, style: { bg: "#FF0000" } } : n,
    );
    const grown: HierarchyDataset = {
      ...tree,
      nodes: [...tree.nodes, { id: "n3", parentId: "n1", label: "New child" }],
    };
    const edited = { ...doc, nodes: styledNodes, datasets: [grown] };
    const next = regenerateView(edited, view.id);
    expect(next.nodes).toHaveLength(3);
    expect(next.nodes[0]?.style?.bg).not.toBe("#FF0000");
  });

  it("moves the projection with whole-view bounds", () => {
    const doc = docWithView(tree, "report.problem-tree");
    const view = doc.views![0]!;
    const before = doc.nodes.find((n) => n.id === view.nodeIds[0])!;
    const moved = {
      ...doc,
      views: [{ ...view, bounds: { ...view.bounds, x: view.bounds.x + 200 } }],
    };
    const next = regenerateView(moved, view.id);
    const after = next.nodes.find((n) => n.id === next.views![0]!.nodeIds[0])!;
    expect(after.x - before.x).toBe(200);
    expect(after.y).toBe(before.y);
  });
});

// ---------------------------------------------------------------------------
// Undo via action wrappers
// ---------------------------------------------------------------------------

describe("action wrappers + undo", () => {
  it("switch + linked-view actions are exactly undoable", () => {
    const tree: HierarchyDataset = {
      id: "ds-undo",
      kind: "hierarchy",
      name: "T",
      nodes: [
        { id: "n1", parentId: null, label: "Root" },
        { id: "n2", parentId: "n1", label: "Child" },
      ],
    };
    const base = { ...createEmptyDoc("doc-1", 1), datasets: [tree] };
    const store = createDiagramStore({ doc: base, ephemeral: createInitialEphemeral() });

    store.setState(
      withSnapshot(
        addLinkedViewAction(tree.id, "report.problem-tree", BOUNDS),
        defaultCoalescer(),
      ),
    );
    const afterAdd = store.getState().doc;
    expect(afterAdd.views).toHaveLength(1);

    store.setState(
      withSnapshot(
        switchViewPatternAction(afterAdd.views![0]!.id, "report.objective-tree"),
        defaultCoalescer(),
      ),
    );
    const afterSwitch = store.getState().doc;
    expect(afterSwitch.views![0]!.patternId).toBe("report.objective-tree");
    expect(store.getState().ephemeral.history.past).toHaveLength(2);

    store.setState(undo());
    expect(store.getState().doc).toEqual(afterAdd);
    store.setState(undo());
    expect(store.getState().doc).toEqual(base);
  });
});
