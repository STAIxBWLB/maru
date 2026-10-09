import { describe, expect, it } from "vitest";

import { SEMANTIC_FIXTURES } from "./__fixtures__/semantic";
import { defaultCoalescer, undo, withSnapshot } from "./actions";
import { archifySpecToDataset } from "./archifyCodec";
import type { SemanticDiagramType, SemanticSpecDataset } from "./reportTypes";
import { projectSemanticDocument, sequenceOrder } from "./semantic";
import {
  detachSemanticDatasetAction,
  moveMessage,
  planSemanticEdit,
  setClassification,
  setLane,
  setStage,
  setStateType,
  type SpecTransform,
} from "./semanticEdit";
import { createDiagramStore } from "./state";
import { createInitialEphemeral, type DiagramStateRoot } from "./types";

function storeOf(type: SemanticDiagramType, spec: Record<string, unknown> = SEMANTIC_FIXTURES[type]) {
  const { dataset } = archifySpecToDataset(type, structuredClone(spec), { id: "ds" });
  return createDiagramStore({ doc: projectSemanticDocument(dataset).doc, ephemeral: createInitialEphemeral() });
}

type Store = ReturnType<typeof storeOf>;

const specOf = (state: DiagramStateRoot) =>
  (state.doc.datasets!.find((d) => d.id === "ds") as SemanticSpecDataset).spec as Record<string, Record<string, unknown>[]>;

function apply(store: Store, transform: SpecTransform) {
  const outcome = planSemanticEdit(store.getState(), "ds", transform);
  if (outcome.status === "applied") store.setState(withSnapshot(outcome.transformer, defaultCoalescer()));
  return outcome;
}

const messageLabelsInOrder = (state: DiagramStateRoot) => {
  const spec = specOf(state);
  return sequenceOrder(spec).map((i) => spec.messages![i]!.label);
};

describe("moveMessage", () => {
  it("reorders a message and one undo restores the exact prior doc JSON", () => {
    const store = storeOf("sequence");
    const before = JSON.stringify(store.getState().doc);
    const outcome = apply(store, moveMessage(2, -1));
    expect(outcome).toMatchObject({ status: "applied", warnings: [] });
    expect(messageLabelsInOrder(store.getState())).toEqual(["POST /login", "row", "find user", "200 OK"]);
    expect(specOf(store.getState()).messages!.map((m) => m.y)).toEqual([180, 230, 280, 330]);
    const edges = new Map(store.getState().doc.edges.map((e) => [e.id, e.midOff]));
    expect([edges.get("msg3"), edges.get("msg2")]).toEqual([72, 104]);
    expect(store.getState().ephemeral.history.past).toHaveLength(1);

    store.setState(undo());
    expect(JSON.stringify(store.getState().doc)).toBe(before);
  });

  it("is a no-op at the ends", () => {
    const store = storeOf("sequence");
    expect(apply(store, moveMessage(0, -1))).toEqual({ status: "unchanged" });
    expect(apply(store, moveMessage(3, 1))).toEqual({ status: "unchanged" });
  });

  it("warns when a segment or activation range covers a moved message", () => {
    const store = storeOf("sequence", {
      ...SEMANTIC_FIXTURES.sequence,
      segments: [{ from: 170, to: 240, label: "auth" }],
    });
    expect(apply(store, moveMessage(1, 1))).toMatchObject({
      status: "applied",
      warnings: [{ key: "diagram.semantic.sequenceRangesKept" }],
    });
  });
});

describe("field edits", () => {
  it("changes a lifecycle state type and its node kind", () => {
    const store = storeOf("lifecycle");
    apply(store, setStateType(1, "decision"));
    expect(specOf(store.getState()).states![1]!.type).toBe("decision");
    expect(store.getState().doc.nodes.find((n) => n.id === "running")?.kind).toBe("diamond");
  });

  it("sets and clears a dataflow classification", () => {
    const store = storeOf("dataflow");
    apply(store, setClassification(0, "internal"));
    expect(specOf(store.getState()).flows![0]!.classification).toBe("internal");
    apply(store, setClassification(0, ""));
    expect(specOf(store.getState()).flows![0]).not.toHaveProperty("classification");
  });

  it("refuses an edit on a locked member", () => {
    const store = storeOf("lifecycle");
    store.setState((s) => ({
      ...s,
      doc: { ...s.doc, nodes: s.doc.nodes.map((n) => (n.id === "running" ? { ...n, locked: true } : n)) },
    }));
    const outcome = planSemanticEdit(store.getState(), "ds", setStateType(1, "decision"));
    expect(outcome).toEqual({
      status: "invalid",
      diagnostics: [{ key: "diagram.proposal.lockedNode", params: { id: "running" } }],
    });
  });

  it("refuses an edit that breaks the spec content", () => {
    const store = storeOf("lifecycle");
    const outcome = planSemanticEdit(store.getState(), "ds", setLane("states", 0, "nowhere"));
    expect(outcome.status).toBe("invalid");
  });

  it("keeps canvas drift on untouched members", () => {
    const store = storeOf("lifecycle");
    store.setState((s) => ({
      ...s,
      doc: { ...s.doc, nodes: s.doc.nodes.map((n) => (n.id === "queued" ? { ...n, title: "Drifted" } : n)) },
    }));
    apply(store, setStateType(1, "waiting"));
    expect(store.getState().doc.nodes.find((n) => n.id === "queued")?.title).toBe("Drifted");
  });

  it("moves a member by its slot delta on lane and stage changes", () => {
    const lifecycle = storeOf("lifecycle", {
      ...SEMANTIC_FIXTURES.lifecycle,
      lanes: [...(SEMANTIC_FIXTURES.lifecycle.lanes as unknown[]), { id: "side", label: "Side" }],
    });
    const done = lifecycle.getState().doc.nodes.find((n) => n.id === "done")!;
    apply(lifecycle, setLane("states", 2, "side"));
    const moved = lifecycle.getState().doc.nodes.find((n) => n.id === "done")!;
    expect([moved.x, moved.y - done.y]).toEqual([done.x, 128]);

    const dataflow = storeOf("dataflow");
    const [app, wh] = ["app", "wh"].map((id) => dataflow.getState().doc.nodes.find((n) => n.id === id)!);
    apply(dataflow, setStage(0, 1));
    // app joins stage 1 ahead of wh (same row, lower index); wh shifts one slot down.
    const after = dataflow.getState().doc.nodes;
    expect(after.find((n) => n.id === "app")).toMatchObject({ x: app!.x + 200, y: app!.y });
    expect(after.find((n) => n.id === "wh")).toMatchObject({ x: wh!.x, y: wh!.y + 80 });
  });
});

describe("detachSemanticDatasetAction", () => {
  it("detaches to freeform and is undoable", () => {
    const store = storeOf("dataflow");
    const before = JSON.stringify(store.getState().doc);
    store.setState(withSnapshot(detachSemanticDatasetAction("ds"), defaultCoalescer()));
    const { doc } = store.getState();
    expect(doc.datasets).toEqual([]);
    expect(doc.nodes).toHaveLength(4);
    expect(doc.nodes.some((n) => n.meta?.memberId !== undefined)).toBe(false);
    store.setState(undo());
    expect(JSON.stringify(store.getState().doc)).toBe(before);
  });
});
