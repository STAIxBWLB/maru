import { describe, expect, it } from "vitest";

import { SEMANTIC_FIXTURES } from "./__fixtures__/semantic";
import { archifySpecToDataset } from "./archifyCodec";
import { deserializeDoc, serializeDoc } from "./persistence";
import { ENGINE_DIAGRAM_TYPES, validateSemanticSpec, type EngineDiagramType, type SemanticSpecDataset } from "./reportTypes";
import { createEmptyDoc } from "./types";
import { validateEngineSpecPreCheck } from "./validation";

const ENTITY_FIELDS: Record<EngineDiagramType, string> = {
  architecture: "components",
  workflow: "nodes",
  sequence: "participants",
  dataflow: "nodes",
  lifecycle: "states",
};

function datasetFor(type: EngineDiagramType, id: string, refused: boolean): SemanticSpecDataset & Record<string, unknown> {
  const base = archifySpecToDataset(type, structuredClone(SEMANTIC_FIXTURES[type]), { id }).dataset;
  const spec = structuredClone(base.spec);
  const entities = spec[ENTITY_FIELDS[type]] as Record<string, unknown>[];
  if (refused) {
    // Valid JSON with a semantic reference/shape the engine rejects. This test
    // checks storage preservation, not SDK execution; the real col-9 malformed-
    // component refusal remains covered by the native/WASM E2E gate.
    if (type === "architecture") entities[0] = { id: "broken", label: "Broken", type: "future-kind" };
    else if (type === "workflow") entities[0] = { ...entities[0], lane: "missing-lane" };
    else if (type === "sequence") {
      const messages = spec.messages as Record<string, unknown>[];
      messages[0] = { ...messages[0], from: "missing-participant" };
    } else if (type === "dataflow") {
      const flows = spec.flows as Record<string, unknown>[];
      flows[0] = { ...flows[0], from: "missing-node" };
    } else {
      const transitions = spec.transitions as Record<string, unknown>[];
      transitions[0] = { ...transitions[0], from: "missing-state" };
    }
  }
  const preservedSpec = {
    ...spec,
    futureSpecField: { owner: "source", revision: 12 },
  };
  return {
    ...base,
    spec: preservedSpec,
    futureDatasetField: { owner: "existing-doc", opaque: [1, "two", { keep: true }] },
    preservedExtensions: {
      ...base.preservedExtensions,
      futureExtension: { keep: "verbatim" },
    },
  };
}

function existingDocument(type: EngineDiagramType, version: number, refused: boolean) {
  const dataset = datasetFor(type, `existing-${version}-${type}-${refused ? "refused" : "valid"}`, refused);
  const doc = createEmptyDoc(`doc-${version}-${type}-${refused ? "refused" : "valid"}`, 1_700_000_000_000);
  const withPayload = {
    ...doc,
    docTitle: `${type} v${version}`,
    nodes: [{
      id: "canvas-node",
      kind: "simple" as const,
      x: 20,
      y: 30,
      w: 140,
      h: 60,
      meta: { futureNodeField: { retain: true, sequence: [3, 1, 4] } },
    }],
    datasets: [dataset],
    meta: { author: "legacy author", tags: ["preserve"], futureEnvelopeField: { keep: true } } as unknown as typeof doc.meta,
  };
  const raw = JSON.parse(serializeDoc(withPayload)) as Record<string, unknown>;
  raw.v = version;
  return { raw, dataset };
}

describe("existing semantic document persistence across v7-v9", () => {
  for (const version of [7, 8, 9]) {
    for (const type of ENGINE_DIAGRAM_TYPES) {
      it(`preserves ${type} source and unknown metadata from v${version}`, () => {
        const { raw, dataset } = existingDocument(type, version, false);
        const opened = deserializeDoc(JSON.stringify(raw), () => 1_800_000_000_000);
        expect(opened.v).toBe(9);
        expect(opened.docTitle).toBe(`${type} v${version}`);
        expect(opened.datasets).toEqual([dataset]);
        expect(opened.meta).toMatchObject({
          author: "legacy author",
          tags: ["preserve"],
          futureEnvelopeField: { keep: true },
        });
        expect(opened.nodes[0]?.meta?.futureNodeField).toEqual({ retain: true, sequence: [3, 1, 4] });
        expect((opened.datasets![0] as SemanticSpecDataset).spec.futureSpecField).toEqual({
          owner: "source",
          revision: 12,
        });
        expect((opened.datasets![0] as SemanticSpecDataset & Record<string, unknown>).futureDatasetField)
          .toEqual({ owner: "existing-doc", opaque: [1, "two", { keep: true }] });

        const saved = serializeDoc(opened);
        const reloaded = deserializeDoc(saved, () => 1_900_000_000_000);
        expect(reloaded.datasets).toEqual([dataset]);
        expect(reloaded.meta).toMatchObject({ futureEnvelopeField: { keep: true } });
        expect(reloaded.nodes[0]?.meta?.futureNodeField).toEqual({ retain: true, sequence: [3, 1, 4] });
        expect(serializeDoc(reloaded)).toBe(saved);
      });

      it(`retains syntactically valid ${type} JSON with engine-refused content from v${version}`, () => {
        const { raw, dataset } = existingDocument(type, version, true);
        const sourceJson = JSON.stringify(dataset.spec);
        expect(() => JSON.parse(sourceJson)).not.toThrow();

        const opened = deserializeDoc(JSON.stringify(raw), () => 1_800_000_000_000);
        expect(opened.datasets).toEqual([dataset]);
        expect(JSON.stringify((opened.datasets![0] as SemanticSpecDataset).spec)).toBe(sourceJson);

        const reloaded = deserializeDoc(serializeDoc(opened), () => 1_900_000_000_000);
        expect(reloaded.datasets).toEqual([dataset]);
        expect(JSON.stringify((reloaded.datasets![0] as SemanticSpecDataset).spec)).toBe(sourceJson);
      });
    }
  }

  it.each([7, 8, 9])("loads and retains a v%d spec missing required collections and metadata", (version) => {
    const { raw, dataset } = existingDocument("architecture", version, false);
    const spec = { ...dataset.spec, futureSpecField: { keep: true } };
    delete spec.components;
    delete spec.meta;
    const missingSource = { ...dataset, spec };
    raw.datasets = [missingSource];
    const exactSourceJson = JSON.stringify(spec);

    const opened = deserializeDoc(JSON.stringify(raw), () => 1_800_000_000_000);
    expect(opened.v).toBe(9);
    expect(opened.datasets).toEqual([missingSource]);
    expect(JSON.stringify((opened.datasets![0] as SemanticSpecDataset).spec)).toBe(exactSourceJson);
    expect(validateSemanticSpec(missingSource).ok).toBe(true);

    const enginePrecheck = validateEngineSpecPreCheck("architecture", spec);
    expect(enginePrecheck.ok).toBe(false);
    expect(enginePrecheck.diagnostics.map((diagnostic) => diagnostic.params?.field)).toEqual(
      expect.arrayContaining(["components", "meta.title", "meta.output"]),
    );

    const reloaded = deserializeDoc(serializeDoc(opened), () => 1_900_000_000_000);
    expect(reloaded.datasets).toEqual([missingSource]);
    expect(JSON.stringify((reloaded.datasets![0] as SemanticSpecDataset).spec)).toBe(exactSourceJson);
  });
});
