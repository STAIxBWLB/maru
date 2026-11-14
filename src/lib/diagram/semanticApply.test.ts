import { describe, expect, it, vi } from "vitest";

import { FLOORPLAN_FIXTURE } from "./__fixtures__/floorplan";
import { SEMANTIC_FIXTURES } from "./__fixtures__/semantic";
import { undo } from "./actions";
import { archifySpecToDataset } from "./archifyCodec";
import { floorplanSpecToDataset } from "./floorplanCodec";
import { pinnedEngineHost as engineHost } from "./__fixtures__/engineHost";
import type { SemanticDiagramType, SemanticSpecDataset } from "./reportTypes";
import { projectSemanticDocument } from "./semantic";
import { applyValidatedSemanticEdit } from "./semanticApply";
import { addSemanticEntry, removeSemanticEntries, setSpecField } from "./semanticEdit";
import { createDiagramStore } from "./state";
import { createInitialEphemeral } from "./types";

function storeOf(type: SemanticDiagramType, spec = structuredClone(SEMANTIC_FIXTURES[type])) {
  const dataset = archifySpecToDataset(type, spec, { id: "ds" }).dataset;
  const store = createDiagramStore({ doc: projectSemanticDocument(dataset).doc, ephemeral: createInitialEphemeral() });
  return { store, dataset };
}

describe("engine admission before semantic apply", () => {
  it("commits an engine-approved edit as one undo step", async () => {
    const { store } = storeOf("lifecycle");
    const before = store.getState().doc;
    const result = await applyValidatedSemanticEdit(store, "ds", addSemanticEntry("lifecycle", "states", { type: "active", label: "Extra", lane: "main", col: 3 }), engineHost);
    expect(result.status).toBe("applied");
    expect(store.getState().ephemeral.history.past).toHaveLength(1);
    store.setState(undo());
    expect(store.getState().doc).toEqual(before);
  });

  it("admits a node and edge sharing an id, edits and undoes it, while same-collection duplicates remain refused", async () => {
    const source = structuredClone(SEMANTIC_FIXTURES.architecture);
    const originalComponents = source.components as Record<string, unknown>[];
    const spec = {
      ...source,
      components: [
        { ...originalComponents[0], id: "a", row: 0, col: 0 },
        { ...originalComponents[1], id: "b", row: 0, col: 1 },
      ],
      boundaries: [],
      connections: [{ id: "a", from: "a", to: "b", label: "Call" }],
    };
    const dataset: SemanticSpecDataset = {
      id: "ds-shared-id",
      kind: "semanticSpec",
      name: "Shared identifier namespaces",
      diagramType: "architecture",
      spec,
      idMap: { a: "a", b: "b" },
      engine: { name: "maru-diagram-engine", version: "test" },
    };
    const doc = projectSemanticDocument(dataset).doc;
    const store = createDiagramStore({ doc, ephemeral: createInitialEphemeral() });
    const before = store.getState().doc;

    const admitted = await engineHost.validateCandidate("architecture", spec);
    expect(admitted.ok).toBe(true);
    const edited = await applyValidatedSemanticEdit(
      store,
      dataset.id,
      setSpecField("components", 0, "label", "Updated API"),
      engineHost,
    );
    expect(edited.status).toBe("applied");
    expect(store.getState().ephemeral.history.past).toHaveLength(1);
    store.setState(undo());
    expect(store.getState().doc).toEqual(before);

    const beforeDuplicate = store.getState().doc;
    const duplicateRefusal = await applyValidatedSemanticEdit(
      store,
      dataset.id,
      setSpecField("components", 1, "id", "a"),
      engineHost,
    );
    expect(duplicateRefusal.status).toBe("invalid");
    if (duplicateRefusal.status !== "invalid") throw new Error("Expected duplicate id refusal");
    expect(duplicateRefusal.diagnostics).toContainEqual(expect.objectContaining({ key: "diagram.semantic.duplicateId" }));
    expect(store.getState().doc).toBe(beforeDuplicate);
    expect(store.getState().ephemeral.history.past).toHaveLength(0);
  });

  it("refuses new workflow roots outside the surviving allowlist", async () => {
    const spec = { ...structuredClone(SEMANTIC_FIXTURES.workflow), semanticChecks: { allowedRoots: ["draft"], allowedTerminals: ["merge"] } };
    expect((await engineHost.validateCandidate("workflow", spec)).ok).toBe(true);
    const { store, dataset } = storeOf("workflow", spec);
    const before = store.getState().doc;
    const removal = removeSemanticEntries("workflow", dataset.spec, [{ field: "nodes", index: 0 }]);
    const result = await applyValidatedSemanticEdit(store, "ds", removal.transform, engineHost);
    expect(result.status).toBe("invalid");
    if (result.status !== "invalid") throw new Error("Expected engine refusal");
    expect(JSON.stringify(result.diagnostics)).toMatch(/root/i);
    expect(store.getState().doc).toBe(before);
    expect(store.getState().ephemeral.history.past).toHaveLength(0);
  });

  it.each(["architecture", "dataflow"] as const)("refuses renderer-only %s limits without committing", async (type) => {
    const spec = structuredClone(SEMANTIC_FIXTURES[type]);
    if (type === "architecture") spec.layout = { mode: "grid", cols: 4 };
    else spec.stages = [{ label: "One" }, { label: "Two" }, { label: "Three" }, { label: "Four" }];
    expect((await engineHost.validateCandidate(type, spec)).ok).toBe(true);
    const { store } = storeOf(type, spec);
    const before = store.getState().doc;
    const transform = type === "architecture"
      ? addSemanticEntry(type, "components", { type: "backend", label: "Outside", row: 0, col: 4 })
      : addSemanticEntry(type, "stages", { label: "Five" });
    const result = await applyValidatedSemanticEdit(store, "ds", transform, engineHost);
    expect(result.status).toBe("invalid");
    if (result.status !== "invalid") throw new Error("Expected engine refusal");
    expect(result.diagnostics.some((item) => item.key === "diagram.semantic.engineRejected")).toBe(true);
    expect(store.getState().doc).toBe(before);
    expect(store.getState().ephemeral.history.past).toHaveLength(0);
  });

  it("fails closed on unavailable engine and a document changed during validation", async () => {
    const { store } = storeOf("lifecycle");
    const before = store.getState().doc;
    const transform = addSemanticEntry("lifecycle", "states", { type: "active", label: "Extra", lane: "main", col: 3 });
    const failed = await applyValidatedSemanticEdit(store, "ds", transform, { validateCandidate: async () => { throw new Error("engine unavailable"); } });
    expect(failed.status).toBe("invalid");
    expect(store.getState().doc).toBe(before);
    let settle!: (value: { ok: boolean; errors: string[]; warnings: string[] }) => void;
    const validateCandidate = vi.fn(() => new Promise<{ ok: boolean; errors: string[]; warnings: string[] }>((resolve) => { settle = resolve; }));
    const pending = applyValidatedSemanticEdit(store, "ds", transform, { validateCandidate });
    store.setState((state) => ({ ...state, doc: { ...state.doc, docTitle: "Changed during validation" } }));
    const changed = store.getState().doc;
    settle({ ok: true, errors: [], warnings: [] });
    expect(await pending).toMatchObject({ status: "invalid", diagnostics: [{ key: "diagram.semantic.editStale" }] });
    expect(store.getState().doc).toBe(changed);
    expect(store.getState().ephemeral.history.past).toHaveLength(0);
  });
});

/** A parent chain `levels` deep; 65 is the deepest a Floorplan map may nest. */
function floorplanChain(levels: number): Record<string, unknown> {
  const nodes = Array.from({ length: levels }, (_, index) => ({
    id: `n${index}`,
    label: `Level ${index}`,
    kind: "feature",
    ...(index > 0 ? { parent: `n${index - 1}` } : {}),
  }));
  return { $schema: "floorplan/architecture@1", project: { name: "Nesting chain" }, nodes, edges: [] };
}

describe("floorplan edits pass the engine before they commit (#553 E5 T4)", () => {
  function floorplanStore(spec: Record<string, unknown> = structuredClone(FLOORPLAN_FIXTURE)) {
    const dataset = floorplanSpecToDataset(spec, { id: "ds" }).dataset;
    return { store: createDiagramStore({ doc: projectSemanticDocument(dataset).doc, ephemeral: createInitialEphemeral() }) };
  }
  it("sends a floorplan edit to the engine gate instead of a local-only check", async () => {
    const { store } = floorplanStore();
    const validateCandidate = vi.fn(engineHost.validateCandidate);
    const result = await applyValidatedSemanticEdit(
      store,
      "ds",
      addSemanticEntry("floorplan", "nodes", { id: "probe", label: "Probe", kind: "library" }),
      { validateCandidate },
    );
    expect(result.status).toBe("applied");
    expect(validateCandidate).toHaveBeenCalledTimes(1);
    expect(validateCandidate.mock.calls[0]?.[0]).toBe("floorplan");
    expect(store.getState().ephemeral.history.past).toHaveLength(1);
  });

  it("commits an engine-approved floorplan edit as one undo step", async () => {
    const { store } = floorplanStore();
    const before = store.getState().doc;
    const result = await applyValidatedSemanticEdit(
      store,
      "ds",
      addSemanticEntry("floorplan", "nodes", { id: "probe", label: "Probe", kind: "library" }),
      engineHost,
    );
    expect(result.status).toBe("applied");
    store.setState(undo());
    expect(store.getState().doc).toEqual(before);
  });

  it("refuses an edit only the engine catches, naming cause and next step, with no doc or history commit", async () => {
    // The local floor has no nesting limit, so a 66th level reaches the engine,
    // whose floorplan/nesting-depth rule refuses it.
    const { store } = floorplanStore(floorplanChain(65));
    const before = store.getState().doc;
    const result = await applyValidatedSemanticEdit(
      store,
      "ds",
      addSemanticEntry("floorplan", "nodes", { id: "n65", label: "Too deep", kind: "feature", parent: "n64" }),
      engineHost,
    );
    expect(result.status).toBe("invalid");
    if (result.status !== "invalid") throw new Error("Expected engine refusal");
    const [diagnostic] = result.diagnostics;
    expect(diagnostic?.key).toBe("diagram.semantic.engineRejected");
    const message = String(diagnostic?.params?.message);
    expect(message).toContain("floorplan/nesting-depth");
    expect(message).toMatch(/64 levels/);
    expect(message).toMatch(/flatten the deepest frames/);
    expect(store.getState().doc).toBe(before);
    expect(store.getState().ephemeral.history.past).toHaveLength(0);
  });

  it("keeps the local floor's field-named refusal ahead of the engine call", async () => {
    const { store } = floorplanStore();
    const before = store.getState().doc;
    const validateCandidate = vi.fn(engineHost.validateCandidate);
    const result = await applyValidatedSemanticEdit(
      store,
      "ds",
      addSemanticEntry("floorplan", "nodes", { id: "bad", label: "Bad kind", kind: "not-a-kind" }),
      { validateCandidate },
    );
    expect(result.status).toBe("invalid");
    if (result.status !== "invalid") throw new Error("Expected refusal");
    expect(result.diagnostics).toContainEqual(expect.objectContaining({ key: "diagram.validation.specMeta", params: expect.objectContaining({ field: expect.stringMatching(/\.kind$/) }) }));
    expect(validateCandidate).not.toHaveBeenCalled();
    expect(store.getState().doc).toBe(before);
    expect(store.getState().ephemeral.history.past).toHaveLength(0);
  });

  it("fails closed for floorplan when the engine is unavailable or the document changes during validation", async () => {
    const { store } = floorplanStore();
    const before = store.getState().doc;
    const transform = addSemanticEntry("floorplan", "nodes", { id: "probe", label: "Probe", kind: "library" });
    const failed = await applyValidatedSemanticEdit(store, "ds", transform, {
      validateCandidate: async () => { throw new Error("engine unavailable"); },
    });
    expect(failed).toMatchObject({ status: "invalid", diagnostics: [{ key: "diagram.semantic.engineValidationFailed" }] });
    expect(store.getState().doc).toBe(before);
    expect(store.getState().ephemeral.history.past).toHaveLength(0);

    let settle!: (value: { ok: boolean; errors: string[]; warnings: string[] }) => void;
    const pending = applyValidatedSemanticEdit(store, "ds", transform, {
      validateCandidate: () => new Promise((resolve) => { settle = resolve; }),
    });
    store.setState((state) => ({ ...state, doc: { ...state.doc, docTitle: "Changed during validation" } }));
    const changed = store.getState().doc;
    settle({ ok: true, errors: [], warnings: [] });
    expect(await pending).toMatchObject({ status: "invalid", diagnostics: [{ key: "diagram.semantic.editStale" }] });
    expect(store.getState().doc).toBe(changed);
    expect(store.getState().ephemeral.history.past).toHaveLength(0);
  });
});

describe("a malformed engine receipt envelope blocks the commit (#137)", () => {
  it("leaves the document and history unchanged when the receipt carries an unsupported schemaVersion", async () => {
    const { store } = storeOf("lifecycle");
    const before = store.getState().doc;
    // The real pinned engine, but its layout receipt is re-stamped with an
    // envelope the app does not support: the hash still matches the source.
    const forged = {
      validateCandidate: async (type: string, spec: unknown) => {
        const { createProductDiagramEngine } = await import("./engine");
        const real = await engineHost.validateCandidate(type, spec);
        const receipt = { ...real.receipt!, schemaVersion: 2 } as typeof real.receipt;
        const engine = createProductDiagramEngine({
          validate: async () => ({ apiVersion: 1, ok: true, diagnostics: [], receipt: { ...real.receipt!, inputSpecSha256: real.candidateSha256! } }),
          layout: async () => ({ apiVersion: 1, ok: true, diagnostics: [], geometry: null, receipt: receipt! }),
          render: async () => { throw new Error("render is not expected"); },
        });
        return engine.validateCandidate(type, spec);
      },
    };
    const result = await applyValidatedSemanticEdit(
      store,
      "ds",
      addSemanticEntry("lifecycle", "states", { type: "active", label: "Extra", lane: "main", col: 3 }),
      forged,
    );
    expect(result.status).toBe("invalid");
    if (result.status !== "invalid") throw new Error("Expected refusal");
    expect(result.diagnostics[0]?.key).toBe("diagram.semantic.engineValidationFailed");
    expect(String(result.diagnostics[0]?.params?.message)).toMatch(/schemaVersion is 2, not the supported 1.*update Maru/);
    expect(store.getState().doc).toBe(before);
    expect(store.getState().ephemeral.history.past).toHaveLength(0);
  });

  for (const step of ["validation", "layout"] as const) {
    for (const status of ["failed", "not-run"]) {
      it(`refuses an ok ${step} report whose schema gate is ${status}, leaving doc and history unchanged (T137-R1)`, async () => {
        const { store } = storeOf("lifecycle");
        const before = store.getState().doc;
        const forged = {
          validateCandidate: async (type: string, spec: unknown) => {
            const { createProductDiagramEngine } = await import("./engine");
            const real = await engineHost.validateCandidate(type, spec);
            const base = { ...real.receipt!, inputSpecSha256: real.candidateSha256! };
            const stamped = { ...base, gates: { ...base.gates, schema: { status, scope: base.gates.schema.scope } } };
            const engine = createProductDiagramEngine({
              validate: async () => ({ apiVersion: 1, ok: true, diagnostics: [], receipt: step === "validation" ? stamped : base }),
              layout: async () => ({ apiVersion: 1, ok: true, diagnostics: [], geometry: null, receipt: step === "layout" ? stamped : base }),
              render: async () => { throw new Error("render is not expected"); },
            });
            return engine.validateCandidate(type, spec);
          },
        };
        const result = await applyValidatedSemanticEdit(
          store,
          "ds",
          addSemanticEntry("lifecycle", "states", { type: "active", label: "Extra", lane: "main", col: 3 }),
          forged,
        );
        expect(result).toMatchObject({ status: "invalid", diagnostics: [{ key: "diagram.semantic.engineValidationFailed" }] });
        if (result.status !== "invalid") return;
        expect(String(result.diagnostics[0]?.params?.message)).toContain(`schema gate is "${status}"`);
        expect(store.getState().doc).toBe(before);
        expect(store.getState().ephemeral.history.past).toHaveLength(0);
      });
    }
  }
});
