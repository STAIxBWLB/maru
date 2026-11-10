import { describe, expect, it, vi } from "vitest";

import { SEMANTIC_FIXTURES } from "./__fixtures__/semantic";
import { undo } from "./actions";
import { archifySpecToDataset } from "./archifyCodec";
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

    const duplicateRefusal = await applyValidatedSemanticEdit(
      store,
      dataset.id,
      setSpecField("components", 1, "id", "a"),
      engineHost,
    );
    expect(duplicateRefusal.status).toBe("invalid");
    if (duplicateRefusal.status !== "invalid") throw new Error("Expected duplicate id refusal");
    expect(duplicateRefusal.diagnostics).toContainEqual(expect.objectContaining({ key: "diagram.semantic.duplicateId" }));
    expect(store.getState().doc).toBe(before);
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
