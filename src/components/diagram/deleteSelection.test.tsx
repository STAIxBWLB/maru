// @vitest-environment jsdom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { confirmDialog, messageDialog } from "../../lib/confirmDialog";
import { SEMANTIC_FIXTURES } from "../../lib/diagram/__fixtures__/semantic";
import { defaultCoalescer, undo } from "../../lib/diagram/actions";
import { archifySpecToDataset } from "../../lib/diagram/archifyCodec";
import { projectSemanticDocument } from "../../lib/diagram/semantic";
import { createDiagramStore, type DiagramStore } from "../../lib/diagram/state";
import { createInitialEphemeral, type DiagramDoc } from "../../lib/diagram/types";
import { LocaleContext, t as translate } from "../../lib/i18n";
import "../../lib/i18n/testing";
import { unmountReactRoot } from "../../lib/testing/unmountReactRoot";
import { DiagramStoreProvider, _resetDiagramSharedStoreForTests, useDiagramStore } from "./DiagramStoreContext";
import { deleteSelection } from "./deleteSelection";
import { RibbonEdit } from "./ribbon/RibbonEdit";

vi.mock("../../lib/confirmDialog", () => ({ confirmDialog: vi.fn(async () => true), messageDialog: vi.fn(async () => {}) }));

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const ko = (key: string, vars?: Record<string, string | number>) => translate("ko", key, vars);

function lifecycleDoc(): DiagramDoc {
  const doc = projectSemanticDocument(
    archifySpecToDataset("lifecycle", SEMANTIC_FIXTURES.lifecycle, { id: "ds" }).dataset,
  ).doc;
  return { ...doc, nodes: [...doc.nodes, { id: "note", kind: "text", x: 0, y: 400, w: 40, h: 20 }] };
}

function storeWith(doc: DiagramDoc, nodes: string[]): DiagramStore {
  return createDiagramStore({
    doc,
    ephemeral: { ...createInitialEphemeral(), selection: { nodes: new Set(nodes), edges: new Set() } },
  });
}

describe("deleteSelection", () => {
  beforeEach(() => {
    vi.mocked(messageDialog).mockClear();
    vi.mocked(confirmDialog).mockReset();
    vi.mocked(confirmDialog).mockResolvedValue(true);
  });

  it("asks before deleting a semantic member; cancel leaves the doc untouched", async () => {
    const store = storeWith(lifecycleDoc(), ["running"]);
    const before = store.getState().doc;
    vi.mocked(confirmDialog).mockResolvedValueOnce(false);
    await deleteSelection(store, defaultCoalescer(), ko);
    const message = vi.mocked(confirmDialog).mock.calls[0]![0];
    expect(message.startsWith(ko("diagram.semantic.removeConfirm"))).toBe(true);
    expect(message).toContain("Running");
    expect(message).toContain(ko("diagram.semantic.collection.transitions"));
    expect(store.getState().doc).toBe(before);
  });

  it("does not detach for a locked member that Delete keeps", async () => {
    const base = lifecycleDoc();
    const doc = { ...base, nodes: base.nodes.map((node) => (node.id === "running" ? { ...node, locked: true } : node)) };
    const store = storeWith(doc, ["running"]);
    await deleteSelection(store, defaultCoalescer(), ko);
    expect(confirmDialog).not.toHaveBeenCalled();
    expect(store.getState().doc.datasets).toEqual(doc.datasets);
  });

  it("cascades, keeps the dataset, and restores everything in one undo", async () => {
    const store = storeWith(lifecycleDoc(), ["running"]);
    const before = JSON.stringify(store.getState().doc);
    await deleteSelection(store, defaultCoalescer(), ko);
    const { doc, ephemeral } = store.getState();
    expect(doc.datasets).toHaveLength(1);
    expect(doc.nodes.map((n) => n.id)).toEqual(["ds:lane:main", "queued", "done", "note"]);
    expect(doc.edges).toHaveLength(0);
    expect(doc.nodes.find((node) => node.id === "done")?.meta?.memberId).toBeDefined();
    expect(ephemeral.history.past).toHaveLength(1);
    store.setState(undo());
    expect(JSON.stringify(store.getState().doc)).toBe(before);
  });

  it("does not delete using a stale confirmation after the document changes", async () => {
    const store = storeWith(lifecycleDoc(), ["running"]);
    let settle!: (value: boolean) => void;
    vi.mocked(confirmDialog).mockImplementationOnce(() => new Promise((resolve) => { settle = resolve; }));
    const pending = deleteSelection(store, defaultCoalescer(), ko);
    store.setState((state) => ({ ...state, doc: { ...state.doc, docTitle: "Changed" } }));
    const changed = store.getState().doc;
    settle(true);
    await pending;
    expect(store.getState().doc).toBe(changed);
    expect(messageDialog).toHaveBeenCalledWith(ko("diagram.semantic.editStale"), "warning");
  });

  it("refuses all selected edits if a dependent member is locked", async () => {
    const base = lifecycleDoc();
    const doc = { ...base, nodes: base.nodes.map((node) => node.id === "running" ? { ...node, locked: true } : node) };
    const store = storeWith(doc, ["ds:lane:main", "note"]);
    await deleteSelection(store, defaultCoalescer(), ko);
    expect(store.getState().doc).toBe(doc);
    expect(store.getState().ephemeral.history.past).toHaveLength(0);
  });

  it("commits a mixed semantic/freeform selection in one snapshot", async () => {
    const store = storeWith(lifecycleDoc(), ["running", "note"]);
    const before = store.getState().doc;
    await deleteSelection(store, defaultCoalescer(), ko);
    expect(store.getState().doc.nodes.map((node) => node.id)).toEqual(["ds:lane:main", "queued", "done"]);
    expect(store.getState().ephemeral.history.past).toHaveLength(1);
    store.setState(undo());
    expect(store.getState().doc).toEqual(before);
  });

  it.each(["node", "edge"] as const)("deletes a connected mixed selection with its selected freeform %s in one undo", async (selection) => {
    const base = lifecycleDoc();
    const bridge = { id: "bridge", fromNode: "running", fromPort: "e" as const, toNode: "note", toPort: "w" as const, label: "Annotation" };
    const doc = { ...base, edges: [...base.edges, bridge] };
    const store = storeWith(doc, selection === "node" ? ["running", "note"] : ["running"]);
    if (selection === "edge") store.setState((state) => ({ ...state, ephemeral: { ...state.ephemeral, selection: { ...state.ephemeral.selection, edges: new Set(["bridge"]) } } }));
    await deleteSelection(store, defaultCoalescer(), ko);
    expect(messageDialog).not.toHaveBeenCalled();
    expect(store.getState().doc.nodes.some((node) => node.id === "running")).toBe(false);
    expect(store.getState().doc.nodes.some((node) => node.id === "note")).toBe(selection === "edge");
    expect(store.getState().doc.edges.some((edge) => edge.id === "bridge")).toBe(false);
    expect(vi.mocked(confirmDialog).mock.calls[0]![0]).toContain(ko("diagram.semantic.annotationRemoved", { name: "Annotation (bridge)" }));
    expect(store.getState().ephemeral.history.past).toHaveLength(1);
    store.setState(undo());
    expect(store.getState().doc).toEqual(doc);
  });

  it("plans two semantic datasets joined by a freeform bridge as one deletion", async () => {
    const first = lifecycleDoc();
    const second = archifySpecToDataset("lifecycle", SEMANTIC_FIXTURES.lifecycle, { id: "other" }).dataset;
    second.idMap = Object.fromEntries(["queued", "running", "done", "tr1", "tr2"].map((id) => [id, `other-${id}`]));
    const projected = projectSemanticDocument(second).doc;
    const doc = { ...first, nodes: [...first.nodes, ...projected.nodes], datasets: [...first.datasets!, second], edges: [...first.edges, ...projected.edges,
      { id: "joined", fromNode: "running", fromPort: "e" as const, toNode: "other-running", toPort: "w" as const, label: "Shared annotation" },
    ] };
    const store = storeWith(doc, ["running", "other-running"]);
    await deleteSelection(store, defaultCoalescer(), ko);
    expect(messageDialog).not.toHaveBeenCalled();
    expect(store.getState().doc.nodes.some((node) => ["running", "other-running"].includes(node.id))).toBe(false);
    expect(store.getState().doc.edges).toHaveLength(0);
    expect(vi.mocked(confirmDialog).mock.calls[0]![0]).toContain("Shared annotation (joined)");
    expect(store.getState().ephemeral.history.past).toHaveLength(1);
    store.setState(undo());
    expect(store.getState().doc).toEqual(doc);
  });

  it("lists an internal annotation lost to a cascade and cancel retains it", async () => {
    const base = lifecycleDoc();
    const doc = { ...base, edges: [...base.edges, { id: "internal", fromNode: "running", fromPort: "e" as const, toNode: "done", toPort: "w" as const, label: "Keep track" }] };
    const store = storeWith(doc, ["running"]);
    vi.mocked(confirmDialog).mockResolvedValueOnce(false);
    await deleteSelection(store, defaultCoalescer(), ko);
    expect(vi.mocked(confirmDialog).mock.calls[0]![0]).toContain(ko("diagram.semantic.annotationRemoved", { name: "Keep track (internal)" }));
    expect(store.getState().doc).toBe(doc);
    expect(store.getState().ephemeral.history.past).toHaveLength(0);
  });

  it("still refuses an unselected external bridge without losing any objects", async () => {
    const base = lifecycleDoc();
    const doc = { ...base, edges: [...base.edges, { id: "external", fromNode: "running", fromPort: "e" as const, toNode: "note", toPort: "w" as const }] };
    const store = storeWith(doc, ["running"]);
    await deleteSelection(store, defaultCoalescer(), ko);
    expect(store.getState().doc).toBe(doc);
    expect(store.getState().ephemeral.history.past).toHaveLength(0);
    expect(messageDialog).toHaveBeenCalled();
    expect(confirmDialog).not.toHaveBeenCalled();
  });

  it("removes a selected semantic relation without detaching its endpoints", async () => {
    const store = storeWith(lifecycleDoc(), []);
    store.setState((state) => ({ ...state, ephemeral: { ...state.ephemeral, selection: { nodes: new Set(), edges: new Set(["tr1"]) } } }));
    await deleteSelection(store, defaultCoalescer(), ko);
    expect(store.getState().doc.nodes).toHaveLength(5);
    expect(store.getState().doc.edges.map((edge) => edge.id)).toEqual(["tr2"]);
    expect(store.getState().doc.datasets).toHaveLength(1);
    expect(store.getState().ephemeral.history.past).toHaveLength(1);
  });

  it("deletes freeform objects without asking", async () => {
    const store = storeWith(lifecycleDoc(), ["note"]);
    await deleteSelection(store, defaultCoalescer(), ko);
    expect(confirmDialog).not.toHaveBeenCalled();
    expect(store.getState().doc.nodes.some((n) => n.id === "note")).toBe(false);
  });
});

describe("RibbonEdit Delete", () => {
  let root: Root | null = null;
  let container: HTMLDivElement | null = null;
  let probe: DiagramStore | null = null;
  function StoreProbe() {
    probe = useDiagramStore();
    return null;
  }

  beforeEach(() => {
    _resetDiagramSharedStoreForTests();
    vi.mocked(messageDialog).mockClear();
    vi.mocked(confirmDialog).mockReset();
    vi.mocked(confirmDialog).mockResolvedValue(false);
  });

  afterEach(async () => {
    if (root) await unmountReactRoot(root);
    container?.remove();
    root = null;
    _resetDiagramSharedStoreForTests();
  });

  it("prompts like keyboard Delete and keeps the doc on cancel", async () => {
    const doc = lifecycleDoc();
    const ephemeral = { ...createInitialEphemeral(), selection: { nodes: new Set(["queued"]), edges: new Set<string>() } };
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    act(() => {
      root!.render(
        <LocaleContext.Provider value={{ locale: "ko", setLocale: () => {}, t: ko }}>
          <DiagramStoreProvider initial={{ doc, ephemeral }} storeKey="ribbon-delete-test">
            <StoreProbe />
            <RibbonEdit />
          </DiagramStoreProvider>
        </LocaleContext.Provider>,
      );
    });
    const before = probe!.getState().doc;
    const button = container.querySelector<HTMLButtonElement>(`button[aria-label="${ko("diagram.toolbar.delete")}"]`)!;
    await act(async () => {
      button.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    expect(confirmDialog).toHaveBeenCalledTimes(1);
    expect(probe!.getState().doc).toBe(before);
  });
});
