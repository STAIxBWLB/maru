import { describe, expect, it } from "vitest";

import { addLinkedView, convertToNewDataset } from "./convert";
import { getPattern } from "./patterns";
import {
  analyzeViewDrag,
  detachViewMembersSnippet,
  insertPatternAt,
  insertPatternAtAction,
  newDocumentFromPattern,
  offsetViewBounds,
  presetApplyOpts,
  presetNodeStyle,
  singleLinkedViewId,
} from "./patternStudio";
import type { PatternPresetV1 } from "./presets";
import {
  TABLE_PATTERN_ID,
  matrixFromRowsCols,
  type MatrixCell,
  type MatrixDataset,
  type PatternViewBounds,
} from "./reportTypes";
import { createDiagramStore } from "./state";
import { createEmptyDoc, type DiagramDoc } from "./types";

const BOUNDS: PatternViewBounds = { x: 100, y: 80, w: 480, h: 320 };

function textMatrix(rows: string[][]): MatrixDataset {
  const matrix = matrixFromRowsCols(rows.length, rows[0]?.length ?? 1);
  const cells: Record<string, MatrixCell> = {};
  for (const cell of Object.values(matrix.cells)) {
    const r = matrix.rows.findIndex((row) => row.id === cell.rowId);
    const c = matrix.columns.findIndex((col) => col.id === cell.colId);
    cells[cell.id] = { ...cell, text: rows[r]?.[c] ?? "" };
  }
  return { ...matrix, cells };
}

function docWithView(
  dataset: MatrixDataset,
  patternId: string,
  bounds: PatternViewBounds = BOUNDS,
): DiagramDoc {
  const doc = { ...createEmptyDoc("doc-1", 1), datasets: [dataset] };
  return addLinkedView(doc, dataset.id, patternId, bounds);
}

describe("insertPatternAt", () => {
  it("creates dataset + view + members for a report pattern at the position", () => {
    const doc = createEmptyDoc("doc-1", 1);
    const { doc: next, nodeIds } = insertPatternAt(doc, "report.timeline", { x: 500, y: 400 });
    expect(next.datasets).toHaveLength(1);
    expect(next.datasets![0]!.kind).toBe("timeline");
    expect(next.views).toHaveLength(1);
    const view = next.views![0]!;
    expect(view.patternId).toBe("report.timeline");
    expect(view.bounds).toEqual({ x: 500 - 260, y: 400 - 170, w: 520, h: 340 });
    expect(nodeIds.length).toBeGreaterThan(0);
    expect(view.nodeIds).toEqual(nodeIds);
    for (const id of nodeIds) {
      const node = next.nodes.find((n) => n.id === id);
      expect(node?.meta?.viewId).toBe(view.id);
    }
    // source doc untouched
    expect(doc.nodes).toHaveLength(0);
    expect(doc.datasets).toBeUndefined();
  });

  it("creates a linked table view for the table pattern", () => {
    const doc = createEmptyDoc("doc-1", 1);
    const { doc: next } = insertPatternAt(doc, TABLE_PATTERN_ID, { x: 100, y: 100 });
    expect(next.views).toHaveLength(1);
    const tableNode = next.nodes.find((n) => n.kind === "table");
    expect(tableNode).toBeDefined();
    expect(tableNode?.meta?.memberId).toBe(next.datasets![0]!.id);
  });

  it("inserts freeform legacy templates without dataset/view", () => {
    const doc = createEmptyDoc("doc-1", 1);
    const { doc: next, nodeIds } = insertPatternAt(doc, "swot", { x: 300, y: 200 });
    expect(nodeIds.length).toBeGreaterThan(0);
    expect(next.datasets).toBeUndefined();
    expect(next.views).toBeUndefined();
  });

  it("throws on unknown patterns", () => {
    const doc = createEmptyDoc("doc-1", 1);
    expect(() => insertPatternAt(doc, "nope", { x: 0, y: 0 })).toThrow(/pattern not found/);
  });

  it("uses a preset dataset seed when provided, under a fresh id", () => {
    const seed = getPattern("report.timeline")!.createDataset!({
      t: (key: string) => key,
    });
    const doc = createEmptyDoc("doc-1", 1);
    const { doc: next } = insertPatternAt(doc, "report.timeline", { x: 0, y: 0 }, {
      datasetSeed: seed,
    });
    const inserted = next.datasets![0]!;
    expect({ ...inserted, id: seed.id }).toEqual(seed);
    expect(inserted.id).not.toBe(seed.id);
    expect(next.views![0]!.datasetId).toBe(inserted.id);
  });

  it("re-applying the same seed never aliases dataset ids", () => {
    // A preset saved from this very doc (or applied twice) must not collide:
    // updateMatrix matches datasets by id, so a duplicate would live-link
    // two views the user expects to be independent copies.
    const seed = getPattern("report.timeline")!.createDataset!({
      t: (key: string) => key,
    });
    const doc = createEmptyDoc("doc-1", 1);
    const first = insertPatternAt(doc, "report.timeline", { x: 0, y: 0 }, { datasetSeed: seed });
    const second = insertPatternAt(first.doc, "report.timeline", { x: 200, y: 0 }, {
      datasetSeed: seed,
    });
    const ids = second.doc.datasets!.map((ds) => ds.id);
    expect(new Set(ids).size).toBe(ids.length);
  });
});

describe("insertPatternAtAction", () => {
  it("selects the inserted members", () => {
    const store = createDiagramStore();
    store.setState(insertPatternAtAction("report.process", { x: 100, y: 100 }));
    const state = store.getState();
    expect(state.ephemeral.selection.nodes.size).toBeGreaterThan(0);
    const view = state.doc.views![0]!;
    expect([...state.ephemeral.selection.nodes]).toEqual(view.nodeIds);
  });
});

describe("newDocumentFromPattern", () => {
  it("builds a fresh report doc with dataset + view", () => {
    const doc = newDocumentFromPattern("report.raci", { t: (key: string) => key });
    expect(doc.datasets).toHaveLength(1);
    expect(doc.views).toHaveLength(1);
    expect(doc.docTitle).toBe("diagram.pattern.raci.label");
    expect(doc.nodes.length).toBeGreaterThan(0);
  });

  it("builds a freeform doc without dataset/view", () => {
    const doc = newDocumentFromPattern("mind-map", { t: (key: string) => key });
    expect(doc.datasets).toBeUndefined();
    expect(doc.views).toBeUndefined();
    expect(doc.nodes.length).toBeGreaterThan(0);
  });

  it("keeps the blank template working (empty doc)", () => {
    const doc = newDocumentFromPattern("blank", { t: () => "Blank" });
    expect(doc.nodes).toHaveLength(0);
    expect(doc.docTitle).toBe("Blank");
  });
});

describe("preset application", () => {
  it("presetApplyOpts maps theme/style/datasetSeed", () => {
    const seed = getPattern("report.raci")!.createDataset!({ t: (key: string) => key });
    const preset: PatternPresetV1 = {
      v: 1,
      id: "preset-1",
      name: "My RACI",
      patternId: "report.raci",
      theme: "dark",
      style: { bg: "#000000", fs: 14, bogus: "ignored-type-ok" },
      datasetSeed: seed,
      createdAt: 1,
      updatedAt: 1,
    };
    const opts = presetApplyOpts(preset);
    expect(opts.theme).toBe("dark");
    expect(opts.datasetSeed).toBe(seed);
    expect(opts.style?.bg).toBe("#000000");
  });

  it("presetNodeStyle keeps only known keys with matching types", () => {
    expect(
      presetNodeStyle({ bg: "#fff", fs: 12, fw: "bold", align: "left", unknown: 1 }),
    ).toEqual({ bg: "#fff", fs: 12, align: "left" });
    expect(presetNodeStyle({ fw: "bold" })).toBeUndefined();
    expect(presetNodeStyle(undefined)).toBeUndefined();
  });

  it("applies preset style to inserted members", () => {
    const doc = createEmptyDoc("doc-1", 1);
    const { doc: next } = insertPatternAt(doc, "report.checklist", { x: 0, y: 0 }, {
      style: { bg: "#123456" },
    });
    for (const node of next.nodes) {
      expect(node.style?.bg).toBe("#123456");
    }
  });
});

describe("singleLinkedViewId", () => {
  it("resolves exactly one selected view-linked node", () => {
    const doc = docWithView(textMatrix([["A"]]), TABLE_PATTERN_ID);
    const view = doc.views![0]!;
    expect(singleLinkedViewId(doc, [view.nodeIds[0]!])).toBe(view.id);
    expect(singleLinkedViewId(doc, [])).toBeNull();
    expect(singleLinkedViewId(doc, [view.nodeIds[0]!, "other"])).toBeNull();
    expect(singleLinkedViewId(doc, ["ghost"])).toBeNull();
  });
});

describe("analyzeViewDrag", () => {
  it("treats a whole-membership gesture as linked", () => {
    const doc = docWithView(textMatrix([["A"]]), TABLE_PATTERN_ID);
    const view = doc.views![0]!;
    const analysis = analyzeViewDrag(doc, view.nodeIds);
    expect(analysis.subsets).toHaveLength(0);
    expect(analysis.full).toEqual([view.id]);
  });

  it("flags a strict subset of members for the detach prompt", () => {
    const doc = createEmptyDoc("doc-1", 1);
    const { doc: withTree } = insertPatternAt(doc, "report.problem-tree", { x: 0, y: 0 });
    const view = withTree.views![0]!;
    const subset = view.nodeIds.slice(0, 1);
    const analysis = analyzeViewDrag(withTree, subset);
    expect(analysis.full).toHaveLength(0);
    expect(analysis.subsets).toEqual([{ viewId: view.id, memberIds: subset }]);
  });

  it("ignores views untouched by the gesture", () => {
    const doc = docWithView(textMatrix([["A"]]), TABLE_PATTERN_ID);
    const analysis = analyzeViewDrag(doc, ["unrelated"]);
    expect(analysis.subsets).toHaveLength(0);
    expect(analysis.full).toHaveLength(0);
  });
});

describe("offsetViewBounds", () => {
  it("moves bounds and refreshes the projection hash", () => {
    const doc = docWithView(textMatrix([["A"]]), TABLE_PATTERN_ID);
    const view = doc.views![0]!;
    const next = offsetViewBounds(doc, [view.id], 24, 16);
    const moved = next.views![0]!;
    expect(moved.bounds).toEqual({ ...view.bounds, x: view.bounds.x + 24, y: view.bounds.y + 16 });
    expect(moved.projectionHash).not.toBe(view.projectionHash);
    expect(offsetViewBounds(doc, [], 1, 1)).toBe(doc);
  });
});

describe("detachViewMembersSnippet", () => {
  it("strips view linkage and stamps the snippet marker", () => {
    const doc = createEmptyDoc("doc-1", 1);
    const { doc: withTree, nodeIds } = insertPatternAt(doc, "report.problem-tree", { x: 0, y: 0 });
    const view = withTree.views![0]!;
    const target = nodeIds[0]!;
    const next = detachViewMembersSnippet(withTree, view.id, [target]);
    const node = next.nodes.find((n) => n.id === target)!;
    expect(node.meta?.viewId).toBeUndefined();
    expect(node.meta?.snippet).toBe(true);
    expect(next.views![0]!.nodeIds).not.toContain(target);
  });

  it("keeps the dataset pointer on detached table nodes", () => {
    const doc = docWithView(textMatrix([["A"]]), TABLE_PATTERN_ID);
    const view = doc.views![0]!;
    const next = detachViewMembersSnippet(doc, view.id, view.nodeIds);
    const node = next.nodes.find((n) => n.id === view.nodeIds[0])!;
    expect(node.meta?.viewId).toBeUndefined();
    expect(node.meta?.memberId).toBe(view.datasetId);
    expect(node.meta?.snippet).toBe(true);
  });
});

describe("cross-family conversion purity", () => {
  it("leaves the source doc, dataset, and view untouched", () => {
    const doc = docWithView(
      textMatrix([
        ["Design", "2026-01", "2026-03"],
        ["Build", "2026-04", "2026-08"],
      ]),
      TABLE_PATTERN_ID,
    );
    const sourceView = doc.views![0]!;
    const sourceDataset = doc.datasets![0]!;
    const sourceNodes = doc.nodes;
    const result = convertToNewDataset(doc, sourceView.id, "report.timeline");
    // The input doc graph is unchanged — same object identities.
    expect(result.doc).not.toBe(doc);
    expect(result.doc.datasets![0]).toBe(sourceDataset);
    const untouchedView = result.doc.views!.find((v) => v.id === sourceView.id)!;
    expect(untouchedView).toBe(sourceView);
    expect(result.doc.nodes.slice(0, sourceNodes.length)).toEqual(sourceNodes);
    // The new view points at a NEW dataset, not the source.
    const newView = result.doc.views!.find((v) => v.id !== sourceView.id)!;
    expect(newView.datasetId).not.toBe(sourceDataset.id);
    expect(doc.views).toHaveLength(1);
    expect(doc.datasets).toHaveLength(1);
  });
});
