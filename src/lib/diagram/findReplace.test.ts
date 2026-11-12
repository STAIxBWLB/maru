import { describe, expect, it } from "vitest";

import { findInDoc, replaceAllInDoc } from "./findReplace";
import { createDiagramStore } from "./state";
import { createEmptyDoc, createInitialEphemeral } from "./types";

function buildDoc() {
  const doc = createEmptyDoc("doc", 1);
  doc.nodes.push(
    { id: "n1", kind: "simple", x: 0, y: 0, w: 100, h: 50, title: "Hello world", body: "deeper world" },
    { id: "n2", kind: "simple", x: 0, y: 0, w: 100, h: 50, title: "Other", meta: { memo: "note world" } },
  );
  doc.edges.push({
    id: "e1",
    fromNode: "n1",
    fromPort: "e",
    toNode: "n2",
    toPort: "w",
    label: "world bridge",
  });
  return doc;
}

describe("findReplace", () => {
  it("findInDoc matches titles, bodies, edge labels", () => {
    const doc = buildDoc();
    const out = findInDoc(doc, "world");
    expect(out).toHaveLength(3); // title, body, edge label (memo excluded by default)
    expect(out.map((m) => m.field).sort()).toEqual(["body", "label", "title"]);
  });

  it("findInDoc can include memos when asked", () => {
    const doc = buildDoc();
    const out = findInDoc(doc, "world", { includeMemo: true });
    expect(out.find((m) => m.field === "memo")?.id).toBe("n2");
  });

  it("findInDoc is case-insensitive by default", () => {
    const doc = buildDoc();
    expect(findInDoc(doc, "WORLD")).toHaveLength(3);
    expect(findInDoc(doc, "WORLD", { caseSensitive: true })).toHaveLength(0);
  });

  it("findInDoc skips members the canvas does not draw", () => {
    const doc = buildDoc();
    doc.layers.push({ id: "veiled", name: "Veiled", visible: true, locked: false, order: 1 });
    doc.nodes.push(
      { id: "hidden", kind: "simple", x: 0, y: 0, w: 100, h: 50, title: "world hidden" },
      { id: "layered", kind: "simple", x: 0, y: 0, w: 100, h: 50, title: "world layered", layerId: "veiled" },
    );
    // Control: with nothing hidden and the layer shown, find reaches both, so
    // the count below is not a property of the query alone.
    expect(findInDoc(doc, "world")).toHaveLength(5);
    doc.nodes[2]!.hidden = true;
    doc.layers[1]!.visible = false;
    const out = findInDoc(doc, "world");
    expect(out).toHaveLength(3);
    expect(out.some((m) => m.id === "hidden" || m.id === "layered")).toBe(false);
    // An edge label is not hidden by an invisible endpoint.
    expect(out.some((m) => m.kind === "edge")).toBe(true);
  });

  it("replaceAllInDoc rewrites exactly the members Find lists", () => {
    const replaceIn = (layerVisible: boolean, hidden: boolean) => {
      const doc = buildDoc();
      doc.layers.push({ id: "veiled", name: "Veiled", visible: layerVisible, locked: false, order: 1 });
      doc.nodes.push(
        { id: "hidden", kind: "simple", x: 0, y: 0, w: 100, h: 50, title: "world hidden", hidden },
        { id: "layered", kind: "simple", x: 0, y: 0, w: 100, h: 50, title: "world layered", layerId: "veiled" },
      );
      const store = createDiagramStore({ doc, ephemeral: createInitialEphemeral() });
      store.setState(replaceAllInDoc("world", "planet"));
      const next = store.getState().doc;
      return { titles: next.nodes.map((node) => node.title ?? null), label: next.edges[0]?.label };
    };
    // Control: drawn, every member is rewritten, so the text kept below is the
    // visibility rule rather than the query.
    expect(replaceIn(true, false)).toEqual({
      titles: ["Hello planet", "Other", "planet hidden", "planet layered"],
      label: "planet bridge",
    });
    // The count the bar shows is what Replace All changes.
    expect(replaceIn(false, true)).toEqual({
      titles: ["Hello planet", "Other", "world hidden", "world layered"],
      label: "planet bridge",
    });
  });

  it("replaceAllInDoc updates titles, bodies, edge labels via the store", () => {
    const doc = buildDoc();
    const store = createDiagramStore({ doc, ephemeral: createInitialEphemeral() });
    store.setState(replaceAllInDoc("world", "planet"));
    const next = store.getState().doc;
    expect(next.nodes[0]?.title).toBe("Hello planet");
    expect(next.nodes[0]?.body).toBe("deeper planet");
    expect(next.edges[0]?.label).toBe("planet bridge");
  });

  it("replaceAllInDoc is a no-op when nothing matches", () => {
    const doc = buildDoc();
    const store = createDiagramStore({ doc, ephemeral: createInitialEphemeral() });
    const before = store.getState();
    store.setState(replaceAllInDoc("missing", "planet"));
    expect(store.getState()).toBe(before);
  });
});
