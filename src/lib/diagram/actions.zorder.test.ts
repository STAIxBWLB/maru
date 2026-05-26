import { describe, expect, it } from "vitest";

import {
  alignSelection,
  bringForward,
  bringToFront,
  moveNodeToIndex,
  pasteStyleToSelection,
  pickStyle,
  sendBackward,
  sendToBack,
  setNodeHidden,
  setNodeLocked,
} from "./actions";
import { createDiagramStore } from "./state";
import {
  createEmptyDoc,
  createInitialEphemeral,
  type DiagramNode,
} from "./types";

const node = (id: string, x = 0, y = 0): DiagramNode => ({
  id,
  kind: "simple",
  x,
  y,
  w: 80,
  h: 40,
});

function storeWith(nodes: DiagramNode[], selection: string[] = []) {
  const ephemeral = createInitialEphemeral();
  for (const id of selection) ephemeral.selection.nodes.add(id);
  return createDiagramStore({
    doc: { ...createEmptyDoc("doc", 1), nodes },
    ephemeral,
  });
}

describe("z-order actions", () => {
  it("bringToFront moves selected to end", () => {
    const store = storeWith([node("a"), node("b"), node("c")], ["a"]);
    store.setState(bringToFront());
    expect(store.getState().doc.nodes.map((n) => n.id)).toEqual(["b", "c", "a"]);
  });

  it("sendToBack moves selected to start", () => {
    const store = storeWith([node("a"), node("b"), node("c")], ["c"]);
    store.setState(sendToBack());
    expect(store.getState().doc.nodes.map((n) => n.id)).toEqual(["c", "a", "b"]);
  });

  it("bringForward steps one up", () => {
    const store = storeWith([node("a"), node("b"), node("c")], ["a"]);
    store.setState(bringForward());
    expect(store.getState().doc.nodes.map((n) => n.id)).toEqual(["b", "a", "c"]);
  });

  it("sendBackward steps one down", () => {
    const store = storeWith([node("a"), node("b"), node("c")], ["c"]);
    store.setState(sendBackward());
    expect(store.getState().doc.nodes.map((n) => n.id)).toEqual(["a", "c", "b"]);
  });

  it("moveNodeToIndex places a node at the target slot", () => {
    const store = storeWith([node("a"), node("b"), node("c")], []);
    store.setState(moveNodeToIndex("a", 2));
    expect(store.getState().doc.nodes.map((n) => n.id)).toEqual(["b", "c", "a"]);
  });
});

describe("lock / hide", () => {
  it("sets locked + hidden flags", () => {
    const store = storeWith([node("a"), node("b")]);
    store.setState(setNodeLocked("a", true));
    store.setState(setNodeHidden("b", true));
    const map = new Map(store.getState().doc.nodes.map((n) => [n.id, n] as const));
    expect(map.get("a")?.locked).toBe(true);
    expect(map.get("b")?.hidden).toBe(true);
  });
});

describe("style clipboard", () => {
  it("pickStyle returns only style keys from a styled node", () => {
    const n: DiagramNode = {
      ...node("a"),
      style: { bg: "#fff", border: "#000", fc: "#111", fs: 14 },
    };
    const picked = pickStyle(n);
    expect(picked).toEqual({ bg: "#fff", border: "#000", fc: "#111", fs: 14 });
  });

  it("pasteStyleToSelection merges onto each selected node", () => {
    const store = storeWith([
      { ...node("a"), style: { fc: "#111" } },
      { ...node("b"), style: { fc: "#222", bg: "#fafafa" } },
    ], ["a", "b"]);
    store.setState(pasteStyleToSelection({ bg: "#000", fc: "#fff" }));
    const map = new Map(store.getState().doc.nodes.map((n) => [n.id, n] as const));
    expect(map.get("a")?.style).toEqual({ fc: "#fff", bg: "#000" });
    expect(map.get("b")?.style).toEqual({ fc: "#fff", bg: "#000" });
  });

  it("pasteStyleToSelection is a no-op when nothing is selected", () => {
    const store = storeWith([node("a")], []);
    const before = store.getState().doc.nodes;
    store.setState(pasteStyleToSelection({ bg: "#000" }));
    expect(store.getState().doc.nodes).toBe(before);
  });
});

describe("alignSelection bridge", () => {
  it("alignSelection('left') applies through the store", () => {
    const store = storeWith([
      node("a", 100),
      node("b", 200),
      node("c", 50),
    ], ["a", "b", "c"]);
    store.setState(alignSelection("left"));
    const map = new Map(store.getState().doc.nodes.map((n) => [n.id, n] as const));
    expect(map.get("a")?.x).toBe(50);
    expect(map.get("b")?.x).toBe(50);
  });
});
