import { describe, expect, it } from "vitest";

import {
  duplicateSelection,
  nudgeSelection,
  selectAllNodes,
  setNodeMeta,
  toggleFocusMode,
} from "./actions";
import { createDiagramStore } from "./state";
import {
  createEmptyDoc,
  createInitialEphemeral,
  type DiagramNode,
} from "./types";

function build(nodes: DiagramNode[], selection: string[] = []) {
  const ephemeral = createInitialEphemeral();
  for (const id of selection) ephemeral.selection.nodes.add(id);
  return createDiagramStore({
    doc: { ...createEmptyDoc("doc", 1), nodes },
    ephemeral,
  });
}

const node = (id: string, x = 0, y = 0): DiagramNode => ({
  id, kind: "simple", x, y, w: 80, h: 40,
});

describe("phase 5 actions", () => {
  it("nudgeSelection moves only selected nodes", () => {
    const store = build([node("a"), node("b", 100)], ["a"]);
    store.setState(nudgeSelection(5, -3));
    const next = store.getState().doc.nodes;
    expect(next[0]?.x).toBe(5);
    expect(next[0]?.y).toBe(-3);
    expect(next[1]?.x).toBe(100);
  });

  it("nudgeSelection no-op when nothing is selected", () => {
    const store = build([node("a")], []);
    const before = store.getState();
    store.setState(nudgeSelection(5, 0));
    expect(store.getState()).toBe(before);
  });

  it("nudgeSelection pins the member the caller resolved and moves the rest", () => {
    // An engine-drawn member carries a doc slot the layout overwrites, so the
    // nudge pins the position the canvas showed instead of moving that slot.
    const store = build([node("a", 40, 40), node("b", 100)], ["a", "b"]);
    store.setState(nudgeSelection(5, -3, [{ id: "a", x: 205, y: 297 }]));
    const [a, b] = store.getState().doc.nodes;
    expect([a?.x, a?.y]).toEqual([205, 297]);
    expect(a?.meta?.pinned).toBe(true);
    expect([b?.x, b?.y]).toEqual([105, -3]);
    expect(b?.meta?.pinned).toBeUndefined();
  });

  it("nudgeSelection keeps a locked member where it is", () => {
    const store = build([{ ...node("a"), locked: true }], ["a"]);
    store.setState(nudgeSelection(5, 0, [{ id: "a", x: 5, y: 0 }]));
    const [a] = store.getState().doc.nodes;
    expect([a?.x, a?.y]).toEqual([0, 0]);
    expect(a?.meta?.pinned).toBeUndefined();
  });

  it("selectAllNodes selects every node in the doc", () => {
    const store = build([node("a"), node("b")]);
    store.setState(selectAllNodes());
    expect([...store.getState().ephemeral.selection.nodes].sort()).toEqual(["a", "b"]);
  });

  it("duplicateSelection clones nodes + edges and reselects clones", () => {
    const store = build([node("a"), node("b", 100)], ["a", "b"]);
    store.setState((s) => ({
      ...s,
      doc: {
        ...s.doc,
        edges: [{
          id: "e1", fromNode: "a", fromPort: "e", toNode: "b", toPort: "w",
        }],
      },
    }));
    store.setState(duplicateSelection(10, 20));
    const next = store.getState().doc;
    expect(next.nodes).toHaveLength(4);
    expect(next.edges).toHaveLength(2);
    // selection now points to clones
    const selected = [...store.getState().ephemeral.selection.nodes];
    expect(selected).toHaveLength(2);
    expect(selected).not.toContain("a");
  });

  it("toggleFocusMode flips ephemeral focusMode", () => {
    const store = build([]);
    expect(store.getState().ephemeral.ui.focusMode).toBe(false);
    store.setState(toggleFocusMode());
    expect(store.getState().ephemeral.ui.focusMode).toBe(true);
    store.setState(toggleFocusMode(false));
    expect(store.getState().ephemeral.ui.focusMode).toBe(false);
  });

  it("setNodeMeta merges into meta without dropping other keys", () => {
    const store = build([{ ...node("a"), meta: { progress: 50 } }]);
    store.setState(setNodeMeta("a", { memo: "hello" }));
    const n = store.getState().doc.nodes[0]!;
    expect(n.meta).toEqual({ progress: 50, memo: "hello" });
  });
});
