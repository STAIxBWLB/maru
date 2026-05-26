import { describe, expect, it } from "vitest";

import {
  addNode,
  defaultCoalescer,
  moveNodes,
  redo,
  removeNodes,
  setNodeHidden,
  setNodeLocked,
  setNodeMeta,
  setDocTitle,
  setSelection,
  undo,
  updateNode,
  withSnapshot,
} from "./actions";
import { createDiagramStore } from "./state";
import { createEmptyDoc, createInitialEphemeral } from "./types";

function freshStore() {
  return createDiagramStore({
    doc: createEmptyDoc("doc-1", 1),
    ephemeral: createInitialEphemeral(),
  });
}

describe("diagram actions", () => {
  it("addNode appends a node and selects it", () => {
    const store = freshStore();
    store.setState(addNode("simple", 10, 20, { title: "Hi" }));
    const state = store.getState();
    expect(state.doc.nodes).toHaveLength(1);
    expect(state.doc.nodes[0]?.title).toBe("Hi");
    expect([...state.ephemeral.selection.nodes]).toHaveLength(1);
  });

  it("moveNodes shifts all selected nodes", () => {
    const store = freshStore();
    store.setState(addNode("simple", 0, 0, { id: "a" }));
    store.setState(addNode("simple", 100, 0, { id: "b" }));
    store.setState(moveNodes(["a", "b"], 10, 5));
    const [a, b] = store.getState().doc.nodes;
    expect(a?.x).toBe(10);
    expect(a?.y).toBe(5);
    expect(b?.x).toBe(110);
    expect(b?.y).toBe(5);
  });

  it("removeNodes drops nodes and any incident edges", () => {
    const store = freshStore();
    store.setState(addNode("simple", 0, 0, { id: "a" }));
    store.setState(addNode("simple", 100, 0, { id: "b" }));
    store.setState((s) => ({
      ...s,
      doc: {
        ...s.doc,
        edges: [
          {
            id: "e1",
            fromNode: "a",
            fromPort: "e",
            toNode: "b",
            toPort: "w",
          },
        ],
      },
    }));
    store.setState(removeNodes(["a"]));
    const { nodes, edges } = store.getState().doc;
    expect(nodes.map((n) => n.id)).toEqual(["b"]);
    expect(edges).toEqual([]);
  });

  it("updateNode patches a single node", () => {
    const store = freshStore();
    store.setState(addNode("simple", 0, 0, { id: "a" }));
    store.setState(updateNode("a", { title: "Renamed" }));
    expect(store.getState().doc.nodes[0]?.title).toBe("Renamed");
  });

  it("withSnapshot commits to history on non-coalesced calls", () => {
    const store = freshStore();
    const coal = defaultCoalescer();
    let t = 0;
    store.setState(withSnapshot(addNode("simple", 0, 0, { id: "a" }), coal, { now: () => (t += 600) }));
    store.setState(withSnapshot(addNode("simple", 10, 10, { id: "b" }), coal, { now: () => (t += 600) }));
    expect(store.getState().ephemeral.history.past).toHaveLength(2);
  });

  it("withSnapshot coalesces rapid drag mutations into one entry", () => {
    const store = freshStore();
    const coal = defaultCoalescer();
    let t = 0;
    store.setState(addNode("simple", 0, 0, { id: "a" }));
    // first move snapshots (cleared coalescer)
    store.setState(withSnapshot(moveNodes(["a"], 5, 0), coal, { coalesce: true, now: () => (t += 1000) }));
    // subsequent rapid moves should NOT add additional history entries
    store.setState(withSnapshot(moveNodes(["a"], 5, 0), coal, { coalesce: true, now: () => (t += 50) }));
    store.setState(withSnapshot(moveNodes(["a"], 5, 0), coal, { coalesce: true, now: () => (t += 50) }));
    expect(store.getState().ephemeral.history.past).toHaveLength(1);
  });

  it("undo/redo navigate the history stack", () => {
    const store = freshStore();
    const coal = defaultCoalescer();
    let t = 0;
    store.setState(withSnapshot(addNode("simple", 0, 0, { id: "a" }), coal, { now: () => (t += 1000) }));
    store.setState(withSnapshot(addNode("simple", 10, 10, { id: "b" }), coal, { now: () => (t += 1000) }));
    expect(store.getState().doc.nodes).toHaveLength(2);
    store.setState(undo());
    expect(store.getState().doc.nodes).toHaveLength(1);
    store.setState(redo());
    expect(store.getState().doc.nodes).toHaveLength(2);
  });

  it("makes document title edits undoable", () => {
    const store = freshStore();
    const coal = defaultCoalescer();
    store.setState(withSnapshot(setDocTitle("Draft title"), coal, { now: () => 1000 }));
    expect(store.getState().doc.docTitle).toBe("Draft title");
    store.setState(undo());
    expect(store.getState().doc.docTitle).toBe("");
  });

  it("setSelection replaces selection sets", () => {
    const store = freshStore();
    store.setState(setSelection(["a", "b"]));
    expect([...store.getState().ephemeral.selection.nodes].sort()).toEqual(["a", "b"]);
  });

  it("does not move or delete locked nodes", () => {
    const store = freshStore();
    store.setState(addNode("simple", 0, 0, { id: "a" }));
    store.setState(addNode("simple", 100, 0, { id: "b" }));
    store.setState(setNodeLocked("a", true));

    store.setState(moveNodes(["a", "b"], 10, 5));
    expect(store.getState().doc.nodes.find((n) => n.id === "a")).toMatchObject({ x: 0, y: 0 });
    expect(store.getState().doc.nodes.find((n) => n.id === "b")).toMatchObject({ x: 110, y: 5 });

    store.setState(removeNodes(["a", "b"]));
    expect(store.getState().doc.nodes.map((n) => n.id)).toEqual(["a"]);
  });

  it("blocks locked-node edits while allowing lock and hide toggles", () => {
    const store = freshStore();
    store.setState(addNode("simple", 0, 0, { id: "a", title: "Original" }));
    store.setState(setNodeLocked("a", true));

    store.setState(updateNode("a", { title: "Changed" }));
    store.setState(setNodeMeta("a", { progress: 50 }));
    expect(store.getState().doc.nodes[0]).toMatchObject({
      title: "Original",
      locked: true,
    });
    expect(store.getState().doc.nodes[0]?.meta).toBeUndefined();

    store.setState(setNodeHidden("a", true));
    store.setState(setNodeLocked("a", false));
    store.setState(updateNode("a", { title: "Changed" }));
    expect(store.getState().doc.nodes[0]).toMatchObject({
      title: "Changed",
      hidden: true,
      locked: false,
    });
  });
});
