import { describe, expect, it } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";

import { SEMANTIC_FIXTURES } from "./__fixtures__/semantic";
import { pinnedEngineHost } from "./__fixtures__/engineHost";
import { defaultCoalescer, undo, withSnapshot } from "./actions";
import { archifySpecToDataset } from "./archifyCodec";
import { applyValidatedSemanticEdit } from "./semanticApply";
import type { ArchifyDiagramType, SemanticDiagramType, SemanticSpecDataset } from "./reportTypes";
import { projectSemanticDataset, projectSemanticDocument, semanticContainerId, sequenceOrder } from "./semantic";
import {
  detachSemanticDatasetAction,
  addSemanticEntry,
  moveMessage,
  planSemanticEdit,
  removeSemanticEntries,
  setBoundaryMembership,
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

const additions: Record<ArchifyDiagramType, { field: string; entry: Record<string, unknown> }> = {
  architecture: { field: "components", entry: { type: "backend", label: "Cache", row: 1, col: 0 } },
  workflow: { field: "nodes", entry: { lane: "author", col: 3, type: "backend", label: "Deploy" } },
  sequence: { field: "participants", entry: { type: "backend", label: "Cache" } },
  dataflow: { field: "nodes", entry: { type: "database", label: "Queue", stage: 0, row: 1 } },
  lifecycle: { field: "states", entry: { type: "active", label: "Paused", lane: "main", col: 3 } },
};

const removalTarget: Record<ArchifyDiagramType, { field: string; index: number }> = {
  architecture: { field: "components", index: 0 },
  workflow: { field: "nodes", index: 0 },
  sequence: { field: "participants", index: 0 },
  dataflow: { field: "nodes", index: 0 },
  lifecycle: { field: "states", index: 0 },
};

function validateWithPinnedArchify(type: SemanticDiagramType, spec: Record<string, unknown>) {
  const dir = mkdtempSync(join(tmpdir(), "maru-semantic-edit-"));
  try {
    const path = join(dir, "candidate.json");
    writeFileSync(path, JSON.stringify(spec));
    const result = spawnSync("node", ["sidecars/archify/bin/archify.mjs", "validate", type, path, "--json"], {
      cwd: process.cwd(), encoding: "utf8", timeout: 10_000,
    });
    expect(result.error, result.stderr).toBeUndefined();
    expect(result.status, result.stdout || result.stderr).toBe(0);
    const receipt = JSON.parse(result.stdout) as { ok: boolean; errors?: string[] };
    expect(receipt.ok, JSON.stringify(receipt.errors)).toBe(true);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

describe("semantic structural edits", () => {
  it.each(Object.keys(additions) as ArchifyDiagramType[])("adds and removes valid %s entries through one undo", (type) => {
    const store = storeOf(type);
    const before = JSON.stringify(store.getState().doc);
    const { field, entry } = additions[type];
    const added = apply(store, addSemanticEntry(type, field, entry));
    expect(added.status, JSON.stringify(added)).toBe("applied");
    expect(store.getState().ephemeral.history.past).toHaveLength(1);
    let current = specOf(store.getState()) as Record<string, unknown>;
    validateWithPinnedArchify(type, current);
    const addedEntry = (current[field] as Record<string, unknown>[]).at(-1)!;
    expect(addedEntry.id).toEqual(expect.any(String));

    const target = removalTarget[type];
    const remove = removeSemanticEntries(type, current, [target]);
    expect(remove.effects.some((effect) => effect.field === target.field && effect.index === target.index)).toBe(true);
    const removed = apply(store, remove.transform);
    expect(removed.status).toBe("applied");
    current = specOf(store.getState()) as Record<string, unknown>;
    validateWithPinnedArchify(type, current);
    const shiftedEntity = (SEMANTIC_FIXTURES[type][field] as Record<string, unknown>[])[1];
    if (typeof shiftedEntity?.id === "string") {
      const dataset = store.getState().doc.datasets!.find((item) => item.id === "ds") as SemanticSpecDataset;
      const canvasId = dataset.idMap[shiftedEntity.id] ?? shiftedEntity.id;
      expect(store.getState().doc.nodes.find((node) => node.id === canvasId)?.meta?.memberId).toBe("ds:m0");
    }
    expect(store.getState().ephemeral.history.past).toHaveLength(2);
    store.setState(undo());
    store.setState(undo());
    expect(JSON.stringify(store.getState().doc)).toBe(before);
  });

  it("cascades relation, boundary, workflow-reference and sequence-range dependencies", () => {
    const architecture = structuredClone(SEMANTIC_FIXTURES.architecture);
    const archRemoval = removeSemanticEntries("architecture", architecture, [{ field: "components", index: 1 }]);
    expect(archRemoval.effects).toContainEqual(expect.objectContaining({ field: "connections", action: "remove" }));
    expect(archRemoval.effects).toContainEqual(expect.objectContaining({ field: "boundaries", action: "unlink" }));
    const archNext = archRemoval.transform(architecture)!.spec;
    expect(archNext.connections).toHaveLength(0);
    expect((archNext.boundaries as Record<string, unknown>[])[0]!.wraps).toEqual(["db"]);
    const selectedBoundary = removeSemanticEntries("architecture", architecture, [{ field: "boundaries", index: 0 }]);
    expect(selectedBoundary.effects).not.toContainEqual(expect.objectContaining({ field: "boundaries", action: "unlink" }));

    const workflow = { ...structuredClone(SEMANTIC_FIXTURES.workflow), mainPath: ["draft", "review"], semanticChecks: { allowedRoots: ["draft"], requiredPaths: [{ from: "draft", to: "review" }] } };
    const wfRemoval = removeSemanticEntries("workflow", workflow, [{ field: "nodes", index: 0 }]);
    const wfNext = wfRemoval.transform(workflow)!.spec;
    expect(wfNext).not.toHaveProperty("mainPath");
    expect(wfRemoval.effects).toContainEqual({ field: "mainPath", index: -1, label: "mainPath", action: "remove" });
    expect((wfNext.semanticChecks as Record<string, unknown>).allowedRoots).toEqual([]);
    expect((wfNext.semanticChecks as Record<string, unknown>).requiredPaths).toEqual([]);

    const sequence = { ...structuredClone(SEMANTIC_FIXTURES.sequence), segments: [{ from: 170, to: 250, label: "request" }], activations: [{ participant: "web", from: 180, to: 230 }] };
    const seqNext = removeSemanticEntries("sequence", sequence, [{ field: "messages", index: 1 }]).transform(sequence)!.spec;
    expect((seqNext.messages as Record<string, unknown>[]).map((message) => message.y)).toEqual([180, 230, 280]);
    expect((seqNext.segments as Record<string, unknown>[])[0]!.to).toBeGreaterThan((seqNext.segments as Record<string, unknown>[])[0]!.from as number);
    const participantRemoval = removeSemanticEntries("sequence", sequence, [{ field: "participants", index: 0 }]);
    expect(participantRemoval.effects).toContainEqual(expect.objectContaining({ field: "activations", action: "remove" }));
    expect(participantRemoval.effects).not.toContainEqual(expect.objectContaining({ field: "activations", action: "unlink" }));

    const dataflow = structuredClone(SEMANTIC_FIXTURES.dataflow);
    const stageRemoval = removeSemanticEntries("dataflow", dataflow, [{ field: "stages", index: 0 }]);
    expect(stageRemoval.effects).toContainEqual(expect.objectContaining({ field: "nodes", index: 1, action: "unlink" }));
    expect(stageRemoval.effects).not.toContainEqual(expect.objectContaining({ field: "nodes", index: 0, action: "unlink" }));
  });

  it("drops invalid workflow main paths after node or relation removal", () => {
    const source = {
      ...structuredClone(SEMANTIC_FIXTURES.workflow),
      mainPath: ["draft", "review", "merge"],
    };
    validateWithPinnedArchify("workflow", source);

    for (const target of [
      { field: "nodes", index: 1 },
      { field: "edges", index: 0 },
    ]) {
      const store = storeOf("workflow", source);
      const removal = removeSemanticEntries("workflow", specOf(store.getState()), [target]);
      expect(removal.effects).toContainEqual({ field: "mainPath", index: -1, label: "mainPath", action: "remove" });
      expect(apply(store, removal.transform).status).toBe("applied");
      const next = specOf(store.getState()) as Record<string, unknown>;
      expect(next).not.toHaveProperty("mainPath");
      validateWithPinnedArchify("workflow", next);
    }
  });

  it("drops broken workflow semantic checks after relation removal and preserves root/terminal allowlists", () => {
    const source = {
      ...structuredClone(SEMANTIC_FIXTURES.workflow),
      semanticChecks: {
        allowedRoots: ["draft", "review"],
        allowedTerminals: ["draft", "merge"],
        requiredEdges: [{ from: "draft", to: "review" }],
        requiredPaths: [{ from: "draft", to: "merge" }],
      },
    };
    validateWithPinnedArchify("workflow", source);
    const removal = removeSemanticEntries("workflow", source, [{ field: "edges", index: 0 }]);
    expect(removal.effects).toContainEqual({ field: "semanticChecks.requiredEdges", index: 0, label: "requiredEdges", action: "remove" });
    expect(removal.effects).toContainEqual({ field: "semanticChecks.requiredPaths", index: 0, label: "requiredPaths", action: "remove" });
    const next = removal.transform(source)!.spec;
    expect(next.semanticChecks).toEqual({
      allowedRoots: ["draft", "review"],
      allowedTerminals: ["draft", "merge"],
      requiredEdges: [],
      requiredPaths: [],
    });
    validateWithPinnedArchify("workflow", next);
  });

  it("refuses removal of lifecycle lane main even when other lanes remain", () => {
    const source = structuredClone(SEMANTIC_FIXTURES.lifecycle);
    source.lanes = [...(source.lanes as Record<string, unknown>[]), { id: "side", label: "Side" }];
    source.states = [...(source.states as Record<string, unknown>[]), { id: "paused", type: "waiting", label: "Paused", lane: "side", col: 0 }];
    const store = storeOf("lifecycle", source);
    const before = JSON.stringify(store.getState().doc);
    const { transform } = removeSemanticEntries("lifecycle", specOf(store.getState()), [{ field: "lanes", index: 0 }]);
    expect(apply(store, transform)).toEqual({
      status: "invalid",
      diagnostics: [{ key: "diagram.semantic.reservedMainLane" }],
    });
    expect(JSON.stringify(store.getState().doc)).toBe(before);
  });

  it("remaps sequence ranges when a message is inserted and prevents applying a stale capture", () => {
    const source = { ...structuredClone(SEMANTIC_FIXTURES.sequence), segments: [{ from: 170, to: 250, label: "request" }] };
    const transform = addSemanticEntry("sequence", "messages", { from: "web", to: "db", label: "cache lookup" }, 1);
    const changed = transform(source)!;
    expect((changed.spec.messages as Record<string, unknown>[]).map((message) => message.y)).toEqual([180, 230, 280, 330, 380]);
    const removal = removeSemanticEntries("sequence", source, [{ field: "messages", index: 0 }]);
    expect(removal.transform({ ...source })).toBeNull();
  });

  it("widens a narrow spread sequence canvas before participant columns overflow", () => {
    let spec = { ...structuredClone(SEMANTIC_FIXTURES.sequence), meta: { title: "Login", output: "login.html", locale: "en", column_fit: "spread", viewBox: [250, 760] } };
    for (let index = 0; index < 6; index++) {
      spec = addSemanticEntry("sequence", "participants", { type: "backend", label: `Worker ${index}` })(spec)!.spec as typeof spec;
    }
    expect((spec.meta.viewBox as number[])[0]).toBeGreaterThanOrEqual(188 + 8 * 108);
    validateWithPinnedArchify("sequence", spec);
  });

  it("grows a valid ten-message showcase canvas before adding the eleventh message", () => {
    const source = {
      ...structuredClone(SEMANTIC_FIXTURES.sequence),
      meta: { title: "Calls", output: "calls.html", locale: "en", quality_profile: "showcase", viewBox: [920, 760] },
      messages: Array.from({ length: 10 }, (_, index) => ({ from: "web", to: "api", y: 180 + index * 50, label: `Call ${index + 1}` })),
    };
    validateWithPinnedArchify("sequence", source);
    const next = addSemanticEntry("sequence", "messages", { from: "web", to: "api", label: "Call 11" })(source)!.spec;
    expect(((next.meta as Record<string, unknown>).viewBox as number[])[1]).toBeGreaterThanOrEqual(784);
    expect((next.messages as Record<string, unknown>[]).at(-1)!.y).toBe(680);
    validateWithPinnedArchify("sequence", next);
  });

  it("leaves renderer clearance for showcase legends, late activations, and wrapped labels", () => {
    let source = {
      ...structuredClone(SEMANTIC_FIXTURES.sequence),
      meta: {
        title: "Login", output: "login.html", locale: "en", quality_profile: "showcase", viewBox: [920, 760],
        legend: { mode: "all", entries: Object.fromEntries(["default", "return", "emphasis", "security", "dashed"].map((kind) => [kind, { label: "Long custom legend label ".repeat(3).slice(0, 80), visible: true }])) },
      },
      messages: [...(structuredClone(SEMANTIC_FIXTURES.sequence).messages as Record<string, unknown>[])],
    };
    while (source.messages.length < 10) {
      const y = 180 + source.messages.length * 50;
      source = addSemanticEntry("sequence", "messages", { from: "web", to: "api", y, label: `Call ${source.messages.length}` })(source)!.spec as typeof source;
    }
    source = addSemanticEntry("sequence", "messages", { from: "web", to: "api", label: "Late call" })(source)!.spec as typeof source;
    expect(source.messages.at(-1)!.y).toBe(680);
    source = addSemanticEntry("sequence", "activations", { participant: "api", from: 730, to: 770 })(source)!.spec as typeof source;
    expect(source.meta.viewBox[1]).toBeGreaterThanOrEqual(956);
    validateWithPinnedArchify("sequence", source);
  });

  it("uses nearest surviving anchor segments below, between, and above the timeline", () => {
    const source = { ...structuredClone(SEMANTIC_FIXTURES.sequence),
      activations: [
        { participant: "api", from: 100, to: 140 },
        { participant: "api", from: 200, to: 220 },
        { participant: "api", from: 400, to: 450 },
      ],
      segments: [{ from: 400, to: 450, label: "Tail" }],
    };
    validateWithPinnedArchify("sequence", source);
    const next = removeSemanticEntries("sequence", source, [{ field: "messages", index: 1 }]).transform(source)!.spec;
    const activations = next.activations as Array<{ from: number; to: number }>;
    expect(activations.map(({ from, to }) => [from, to])).toEqual([[140, 160], [190, 200], [350, 400]]);
    expect(activations[2]!.to - activations[2]!.from).toBe(50);
    expect(next.segments).toEqual([{ from: 350, to: 400, label: "Tail" }]);
    validateWithPinnedArchify("sequence", next);
  });

  it("shifts stage references on index insertion and keeps both old stage memberships", () => {
    const store = storeOf("dataflow");
    const before = JSON.stringify(store.getState().doc);
    const oldStageA = semanticContainerId("ds", "stage", "0");
    store.setState((state) => ({ ...state, doc: { ...state.doc, edges: [...state.doc.edges,
      { id: "stage-note", fromNode: oldStageA, fromPort: "e", toNode: "app", toPort: "w", label: "Stage A" },
    ] } }));
    const annotated = JSON.stringify(store.getState().doc);
    const result = apply(store, addSemanticEntry("dataflow", "stages", { label: "Before collect" }, 0));
    expect(result.status).toBe("applied");
    const next = specOf(store.getState());
    expect(next.nodes!.map((node) => [node.id, node.stage])).toEqual([["app", 1], ["wh", 2]]);
    expect(next.stages!.map((stage) => stage.label)).toEqual(["Before collect", "Collect", "Store"]);
    expect(store.getState().doc.edges.find((edge) => edge.id === "stage-note")?.fromNode).toBe(semanticContainerId("ds", "stage", "1"));
    expect(store.getState().ephemeral.history.past).toHaveLength(1);
    validateWithPinnedArchify("dataflow", next);
    store.setState(undo());
    expect(JSON.stringify(store.getState().doc)).toBe(annotated);
    expect(before).not.toBe(annotated);
  });

  it("keeps a surviving segment within engine bounds after removing a leading message block", () => {
    const source = { ...structuredClone(SEMANTIC_FIXTURES.sequence), segments: [{ from: 170, to: 340, label: "Exchange" }] };
    const store = storeOf("sequence", source);
    const spec = specOf(store.getState());
    const removal = removeSemanticEntries("sequence", spec, [0, 1, 2].map((index) => ({ field: "messages", index })));
    expect(apply(store, removal.transform).status).toBe("applied");
    const next = specOf(store.getState());
    expect(next.segments![0]!.from).toBe(72);
    expect(next.messages!.map((message) => message.y)).toEqual([180]);
    validateWithPinnedArchify("sequence", next);
  });

  it("supports boundary membership and lets asynchronous engine validation reject minimum-count violations", async () => {
    const source = structuredClone(SEMANTIC_FIXTURES.architecture);
    const next = setBoundaryMembership(0, ["web"])(source)!.spec;
    expect((next.boundaries as Record<string, unknown>[])[0]!.wraps).toEqual(["web"]);
    const lastLane = structuredClone(SEMANTIC_FIXTURES.lifecycle);
    const store = storeOf("lifecycle", lastLane);
    const before = JSON.stringify(store.getState().doc);
    const original = specOf(store.getState());
    const removal = removeSemanticEntries("lifecycle", original, [{ field: "lanes", index: 0 }]);
    const draft = removal.transform(original)!.spec;
    expect(draft.lanes).toEqual([]);
    expect((await pinnedEngineHost.validateCandidate("lifecycle", draft)).ok).toBe(false);
    expect(planSemanticEdit(store.getState(), "ds", removal.transform).status).not.toBe("unchanged");
    const outcome = await applyValidatedSemanticEdit(store, "ds", removal.transform, pinnedEngineHost);
    expect(outcome.status).toBe("invalid");
    expect(JSON.stringify(store.getState().doc)).toBe(before);
    expect(store.getState().ephemeral.history.past).toHaveLength(0);
  });

  it("rejects engine-invalid minimum collection removals asynchronously without mutating state", async () => {
    const architecture = structuredClone(SEMANTIC_FIXTURES.architecture);
    architecture.components = [(architecture.components as unknown[])[0]];
    architecture.boundaries = [];
    architecture.connections = [];
    const dataflow = structuredClone(SEMANTIC_FIXTURES.dataflow);
    dataflow.stages = [(dataflow.stages as unknown[])[0]];
    dataflow.nodes = [(dataflow.nodes as unknown[])[0]];
    dataflow.flows = [];
    const lifecycle = structuredClone(SEMANTIC_FIXTURES.lifecycle);
    lifecycle.lanes = [(lifecycle.lanes as unknown[])[0]];
    lifecycle.states = [(lifecycle.states as unknown[])[0]];
    lifecycle.transitions = [];
    const cases: Array<[SemanticDiagramType, Record<string, unknown>, { field: string; index: number }]> = [
      ["architecture", architecture, { field: "components", index: 0 }],
      ["dataflow", dataflow, { field: "stages", index: 0 }],
      ["lifecycle", lifecycle, { field: "lanes", index: 0 }],
    ];
    for (const [type, source, target] of cases) {
      const store = storeOf(type, source);
      const before = JSON.stringify(store.getState().doc);
      const { transform } = removeSemanticEntries(type, specOf(store.getState()), [target]);
      const draft = transform(specOf(store.getState()))!.spec;
      expect((await pinnedEngineHost.validateCandidate(type, draft)).ok).toBe(false);
      expect(planSemanticEdit(store.getState(), "ds", transform).status).not.toBe("unchanged");
      expect((await applyValidatedSemanticEdit(store, "ds", transform, pinnedEngineHost)).status).toBe("invalid");
      expect(JSON.stringify(store.getState().doc)).toBe(before);
      expect(store.getState().ephemeral.history.past).toHaveLength(0);
    }
  });

  it("does not repair dependent content when no target resolves", () => {
    const source = { ...structuredClone(SEMANTIC_FIXTURES.workflow), groups: [{ id: "empty", label: "Empty", lane: "author", fromCol: 3, toCol: 4 }] };
    const removal = removeSemanticEntries("workflow", source, [{ field: "nodes", index: 99 }]);
    expect(removal.effects).toEqual([]);
    expect(removal.transform(source)).toBeNull();
  });

  it("adds and removes each secondary container collection", () => {
    const cases: Array<[SemanticDiagramType, string, Record<string, unknown>]> = [
      ["architecture", "boundaries", { kind: "region", label: "Private", wraps: ["web"] }],
      ["workflow", "phases", { id: "phase-extra", label: "Ship", fromCol: 3, toCol: 3 }],
      ["workflow", "groups", { id: "group-extra", label: "Review group", lane: "reviewer", fromCol: 1, toCol: 1 }],
      ["sequence", "segments", { label: "Auth", from: 160, to: 210 }],
      ["sequence", "activations", { participant: "web", from: 180, to: 230 }],
      ["dataflow", "stages", { label: "Publish" }],
      ["lifecycle", "lanes", { id: "lane-extra", label: "Recovery" }],
    ];
    for (const [type, field, entry] of cases) {
      const source = structuredClone(SEMANTIC_FIXTURES[type]);
      const transform = addSemanticEntry(type, field, entry);
      const added = transform(source)!;
      const oldEntries = Array.isArray(source[field]) ? source[field] as unknown[] : [];
      expect((added.spec[field] as unknown[])).toHaveLength(oldEntries.length + 1);
      const remove = removeSemanticEntries(type, added.spec, [{ field, index: (added.spec[field] as unknown[]).length - 1 }]);
      expect(remove.effects).toContainEqual(expect.objectContaining({ field, action: "remove" }));
      expect(remove.transform(added.spec)!.spec[field]).toHaveLength(oldEntries.length);
    }
  });

  it("deleting index container zero preserves the next container, its annotation, drift, selection, and one undo", () => {
    const source = {
      ...structuredClone(SEMANTIC_FIXTURES.architecture),
      boundaries: [
        { kind: "region", label: "Boundary A", wraps: ["web"] },
        { kind: "region", label: "Boundary B", wraps: ["api", "db"] },
      ],
    };
    const store = storeOf("architecture", source);
    const oldA = semanticContainerId("ds", "boundary", "0");
    const oldB = semanticContainerId("ds", "boundary", "1");
    const newB = semanticContainerId("ds", "boundary", "0");
    store.setState((state) => ({
      ...state,
      doc: {
        ...state.doc,
        nodes: state.doc.nodes.map((node) => node.id === oldB ? { ...node, x: node.x + 17, y: node.y + 9 } : node),
        edges: [
          ...state.doc.edges,
          { id: "annotation-a", fromNode: oldA, fromPort: "e" as const, toNode: "web", toPort: "w" as const, label: "A annotation" },
          { id: "annotation-b", fromNode: oldB, fromPort: "e" as const, toNode: "api", toPort: "w" as const, label: "B annotation" },
        ],
      },
      ephemeral: { ...state.ephemeral, selection: { nodes: new Set([oldA, oldB]), edges: new Set() } },
    }));
    const before = JSON.stringify(store.getState().doc);
    const dataset = store.getState().doc.datasets!.find((item) => item.id === "ds") as SemanticSpecDataset;
    const oldProjection = projectSemanticDataset(dataset, { containers: true, doc: store.getState().doc });
    const removal = removeSemanticEntries("architecture", dataset.spec, [{ field: "boundaries", index: 0 }]);
    const transformed = removal.transform(dataset.spec)!;
    expect(transformed.containerIndexRemaps).toContainEqual({ field: "boundaries", role: "boundary", oldIndex: 0, newIndex: null });
    expect(transformed.containerIndexRemaps).toContainEqual({ field: "boundaries", role: "boundary", oldIndex: 1, newIndex: 0 });
    const nextDataset = { ...dataset, spec: transformed.spec };
    const newProjection = projectSemanticDataset(nextDataset, { containers: true, doc: store.getState().doc });
    const priorB = oldProjection.nodes.find((node) => node.id === oldB)!;
    const nextB = newProjection.nodes.find((node) => node.id === newB)!;
    const currentB = store.getState().doc.nodes.find((node) => node.id === oldB)!;
    const outcome = planSemanticEdit(store.getState(), "ds", removal.transform);
    expect(outcome.status).toBe("applied");
    if (outcome.status !== "applied") return;
    store.setState(withSnapshot(outcome.transformer, defaultCoalescer()));
    const after = store.getState();
    const survivor = after.doc.nodes.find((node) => node.id === newB)!;
    expect(survivor.title).toBe("Boundary B");
    expect([survivor.x, survivor.y, survivor.w, survivor.h]).toEqual([
      currentB.x + nextB.x - priorB.x,
      currentB.y + nextB.y - priorB.y,
      currentB.w + nextB.w - priorB.w,
      currentB.h + nextB.h - priorB.h,
    ]);
    expect(after.doc.nodes.find((node) => node.id === oldA)?.title).toBe("Boundary B");
    expect(after.doc.edges.some((edge) => edge.id === "annotation-a")).toBe(false);
    expect(after.doc.edges.find((edge) => edge.id === "annotation-b")?.fromNode).toBe(newB);
    expect(after.ephemeral.selection.nodes).toEqual(new Set([newB]));
    expect(after.ephemeral.history.past).toHaveLength(1);
    store.setState(undo());
    expect(JSON.stringify(store.getState().doc)).toBe(before);
  });

  it("refuses an index-container rekey that would overwrite a foreign target id", () => {
    const source = {
      ...structuredClone(SEMANTIC_FIXTURES.architecture),
      boundaries: [
        { kind: "region", label: "Boundary A", wraps: ["web"] },
        { kind: "region", label: "Boundary B", wraps: ["api", "db"] },
      ],
    };
    const { dataset } = archifySpecToDataset("architecture", source, { id: "ds" });
    const projected = projectSemanticDocument(dataset).doc;
    const doc = {
      ...projected,
      nodes: [
        ...projected.nodes.filter((node) => node.meta?.semanticContainer === undefined),
        { id: semanticContainerId("ds", "boundary", "0"), kind: "text" as const, x: 20, y: 20, w: 40, h: 20, title: "Foreign" },
      ],
    };
    const store = createDiagramStore({ doc, ephemeral: createInitialEphemeral() });
    const outcome = apply(store, removeSemanticEntries("architecture", dataset.spec, [{ field: "boundaries", index: 0 }]).transform);
    expect(outcome).toEqual({ status: "invalid", diagnostics: [{ key: "diagram.proposal.idCollision", params: { id: semanticContainerId("ds", "boundary", "0") } }] });
    expect(store.getState().doc).toBe(doc);
  });

  it("keeps lock checks on a deleted-container tombstone and reports the original id", () => {
    const source = {
      ...structuredClone(SEMANTIC_FIXTURES.architecture),
      boundaries: [
        { kind: "region", label: "Boundary A", wraps: ["web"] },
        { kind: "region", label: "Boundary B", wraps: ["api", "db"] },
      ],
    };
    const store = storeOf("architecture", source);
    const oldA = semanticContainerId("ds", "boundary", "0");
    store.setState((state) => ({ ...state, doc: { ...state.doc, nodes: state.doc.nodes.map((node) => node.id === oldA ? { ...node, locked: true } : node) } }));
    const before = store.getState().doc;
    const outcome = apply(store, removeSemanticEntries("architecture", specOf(store.getState()) as Record<string, unknown>, [{ field: "boundaries", index: 0 }]).transform);
    expect(outcome).toEqual({ status: "invalid", diagnostics: [{ key: "diagram.proposal.lockedNode", params: { id: oldA } }] });
    expect(store.getState().doc).toBe(before);
  });

  it("remaps index-keyed container ids when inserting before existing entries", () => {
    const source = {
      ...structuredClone(SEMANTIC_FIXTURES.architecture),
      boundaries: [
        { kind: "region", label: "Boundary A", wraps: ["web"] },
        { kind: "region", label: "Boundary B", wraps: ["api", "db"] },
      ],
    };
    const store = storeOf("architecture", source);
    const inserted = apply(store, addSemanticEntry("architecture", "boundaries", { kind: "region", label: "Inserted", wraps: ["api"] }, 0));
    expect(inserted.status).toBe("applied");
    expect(store.getState().doc.nodes.find((node) => node.id === semanticContainerId("ds", "boundary", "1"))?.title).toBe("Boundary A");
    expect(store.getState().doc.nodes.find((node) => node.id === semanticContainerId("ds", "boundary", "2"))?.title).toBe("Boundary B");
    expect(store.getState().doc.nodes.find((node) => node.id === semanticContainerId("ds", "boundary", "0"))?.title).toBe("Inserted");
  });

  it.each([
    {
      type: "dataflow" as const,
      field: "stages",
      role: "stage" as const,
      spec: {
        ...structuredClone(SEMANTIC_FIXTURES.dataflow),
        stages: [{ label: "Stage A" }, { label: "Stage B" }, { label: "Stage C" }],
        nodes: [
          ...(structuredClone(SEMANTIC_FIXTURES.dataflow).nodes as Record<string, unknown>[]),
          { id: "queue", type: "backend", label: "Queue", stage: 2, row: 0 },
        ],
        flows: [
          ...(structuredClone(SEMANTIC_FIXTURES.dataflow).flows as Record<string, unknown>[]),
          { from: "wh", to: "queue", label: "publish" },
        ],
      },
      survivor: "Stage B",
      annotationEnd: "wh",
    },
    {
      type: "sequence" as const,
      field: "segments",
      role: "segment" as const,
      spec: {
        ...structuredClone(SEMANTIC_FIXTURES.sequence),
        segments: [{ from: 160, to: 210, label: "Segment A" }, { from: 220, to: 270, label: "Segment B" }],
      },
      survivor: "Segment B",
      annotationEnd: "api",
    },
    {
      type: "sequence" as const,
      field: "activations",
      role: "activation" as const,
      spec: {
        ...structuredClone(SEMANTIC_FIXTURES.sequence),
        activations: [{ participant: "web", from: 170, to: 200 }, { participant: "api", from: 230, to: 260 }],
      },
      survivor: "API",
      annotationEnd: "api",
    },
  ])("rekeys surviving $field containers and their annotations", ({ type, field, role, spec, survivor, annotationEnd }) => {
    const store = storeOf(type, spec);
    const oldA = semanticContainerId("ds", role, "0");
    const oldB = semanticContainerId("ds", role, "1");
    const newB = semanticContainerId("ds", role, "0");
    store.setState((state) => ({
      ...state,
      doc: {
        ...state.doc,
        edges: [
          ...state.doc.edges,
          { id: "annotation-a", fromNode: oldA, fromPort: "e" as const, toNode: type === "dataflow" ? "app" : "web", toPort: "w" as const },
          { id: "annotation-b", fromNode: oldB, fromPort: "e" as const, toNode: annotationEnd, toPort: "w" as const },
        ],
      },
    }));
    const result = apply(store, removeSemanticEntries(type, specOf(store.getState()), [{ field, index: 0 }]).transform);
    expect(result.status, JSON.stringify(result)).toBe("applied");
    expect(store.getState().doc.nodes.find((node) => node.id === newB)?.title).toBe(survivor);
    expect(store.getState().doc.edges.some((edge) => edge.id === "annotation-a")).toBe(false);
    expect(store.getState().doc.edges.find((edge) => edge.id === "annotation-b")?.fromNode).toBe(newB);
  });
});
