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
