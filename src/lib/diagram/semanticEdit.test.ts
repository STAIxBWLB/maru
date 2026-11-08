import { describe, expect, it } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";

import { SEMANTIC_FIXTURES } from "./__fixtures__/semantic";
import { defaultCoalescer, undo, withSnapshot } from "./actions";
import { archifySpecToDataset } from "./archifyCodec";
import type { SemanticDiagramType, SemanticSpecDataset } from "./reportTypes";
import { projectSemanticDocument, sequenceOrder, validateSemanticContent } from "./semantic";
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

const additions: Record<SemanticDiagramType, { field: string; entry: Record<string, unknown> }> = {
  architecture: { field: "components", entry: { type: "backend", label: "Cache", row: 1, col: 0 } },
  workflow: { field: "nodes", entry: { lane: "author", col: 3, type: "backend", label: "Deploy" } },
  sequence: { field: "participants", entry: { type: "backend", label: "Cache" } },
  dataflow: { field: "nodes", entry: { type: "database", label: "Queue", stage: 0, row: 1 } },
  lifecycle: { field: "states", entry: { type: "active", label: "Paused", lane: "main", col: 3 } },
};

const removalTarget: Record<SemanticDiagramType, { field: string; index: number }> = {
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
  it.each(Object.keys(additions) as SemanticDiagramType[])("adds and removes valid %s entries through one undo", (type) => {
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

  it("supports boundary membership and lets engine validation reject minimum-count violations", () => {
    const source = structuredClone(SEMANTIC_FIXTURES.architecture);
    const next = setBoundaryMembership(0, ["web"])(source)!.spec;
    expect((next.boundaries as Record<string, unknown>[])[0]!.wraps).toEqual(["web"]);
    const lastLane = structuredClone(SEMANTIC_FIXTURES.lifecycle);
    const removal = removeSemanticEntries("lifecycle", lastLane, [{ field: "lanes", index: 0 }]);
    expect(removal.transform(lastLane)!.spec.lanes).toEqual([]);
    expect(validateSemanticContent("lifecycle", removal.transform(lastLane)!.spec).length).toBeGreaterThan(0);
  });

  it("rejects engine-invalid minimum collection removals without mutating state", () => {
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
      expect(apply(store, transform).status).toBe("invalid");
      expect(JSON.stringify(store.getState().doc)).toBe(before);
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
});
