import { describe, expect, it } from "vitest";

import {
  ARCHIFY_ENGINE,
  archifySpecToDataset,
  collectArchifyIds,
  datasetToArchifySpec,
  parseArchifySpec,
  toArchifyId,
} from "./archifyCodec";
import { SEMANTIC_FIXTURES } from "./__fixtures__/semantic";
import { codecForFilename, getCodec } from "./codecs";
import { deserializeDoc, serializeDoc } from "./persistence";
import { SEMANTIC_DIAGRAM_TYPES, validateSemanticSpec, type SemanticDiagramType } from "./reportTypes";
import { SEMANTIC_TYPES, mintRelationIds, sequenceOrder, validateSemanticContent } from "./semantic";

const ARCH_SPEC = {
  schema_version: 1,
  diagram_type: "architecture",
  meta: { title: "Shop", output: "shop.html" },
  components: [
    { id: "web", type: "frontend", label: "Web" },
    { id: "api", type: "backend", label: "API" },
  ],
  connections: [{ from: "web", to: "api", label: "HTTPS" }],
};

describe("toArchifyId", () => {
  it("passes valid ids through and sanitizes invalid ones deterministically", () => {
    const taken = new Set<string>();
    expect(toArchifyId("web-1", taken)).toBe("web-1");
    // ':'-containing Maru member ids sanitize and remain valid
    const member = toArchifyId("ds:m0", taken);
    expect(member).toMatch(/^[a-zA-Z][a-zA-Z0-9_-]*$/);
    expect(member).toBe("ds_x3a_m0");
    // leading digits get a letter prefix
    expect(toArchifyId("9lives", taken)).toBe("n9lives");
    // collisions suffix deterministically
    expect(toArchifyId("ds:m0", taken)).toBe("ds_x3a_m0-2");
  });
});

describe("archifySpecToDataset", () => {
  it("wraps a spec with an identity id map and engine pin", () => {
    const { dataset, diagnostics } = archifySpecToDataset("architecture", ARCH_SPEC);
    expect(dataset.kind).toBe("semanticSpec");
    expect(dataset.diagramType).toBe("architecture");
    expect(dataset.name).toBe("Shop");
    expect(dataset.engine).toEqual(ARCHIFY_ENGINE);
    // The id-less connection gets a minted id at ingest.
    expect(dataset.idMap).toEqual({ web: "web", api: "api", conn1: "conn1" });
    expect(dataset.spec.connections).toEqual([{ id: "conn1", from: "web", to: "api", label: "HTTPS" }]);
    expect(dataset.preservedExtensions).toBeUndefined();
    expect(diagnostics).toEqual([{ key: "diagram.archify.relationIdsAssigned", params: { count: 1 } }]);
    expect(validateSemanticSpec(dataset).ok).toBe(true);
  });

  it("preserves unsupported top-level fields verbatim with a fidelity diagnostic", () => {
    const spec = { ...ARCH_SPEC, futureExtension: { nested: true } };
    const { dataset, diagnostics } = archifySpecToDataset("architecture", spec);
    expect(dataset.preservedExtensions).toEqual({ futureExtension: { nested: true } });
    expect(dataset.spec.futureExtension).toBeUndefined();
    expect(diagnostics).toContainEqual({
      key: "diagram.archify.unsupportedField",
      params: { field: "futureExtension", diagramType: "architecture" },
    });
    // export never re-emits the preserved extension as if supported
    expect(datasetToArchifySpec(dataset).futureExtension).toBeUndefined();
  });

  it("collects ids across all id-bearing arrays", () => {
    const spec = {
      ...ARCH_SPEC,
      boundaries: [{ id: "region-1", kind: "region", label: "R", wraps: ["web"] }],
      connections: [{ id: "c1", from: "web", to: "api" }],
    };
    expect(collectArchifyIds("architecture", spec)).toEqual(["web", "api", "c1", "region-1"]);
  });
});

describe("parseArchifySpec", () => {
  it("accepts a valid spec and records provenance", () => {
    const outcome = parseArchifySpec(JSON.stringify(ARCH_SPEC), {
      provenance: { origin: "gallery-copy", sourcePath: "dev/x/docs/a.architecture.json" },
    });
    if (!outcome.ok) throw new Error("expected ok");
    expect(outcome.result.dataset.provenance?.origin).toBe("gallery-copy");
    expect(outcome.result.diagnostics).toEqual([
      { key: "diagram.archify.relationIdsAssigned", params: { count: 1 } },
    ]);
  });

  it("rejects unsupported schema versions and missing or malformed components", () => {
    for (const spec of [
      { ...ARCH_SPEC, schema_version: 2 },
      { ...ARCH_SPEC, components: undefined },
      { ...ARCH_SPEC, components: [{ id: "web" }] },
    ]) expect(parseArchifySpec(JSON.stringify(spec)).ok).toBe(false);
    expect(parseArchifySpec(JSON.stringify({
      ...ARCH_SPEC, meta: { title: "Shop", output: "docs/SHOP.HTML" },
    })).ok).toBe(true);
  });

  it("refuses unknown diagram types, broken meta, and invalid JSON", () => {
    const badType = parseArchifySpec(JSON.stringify({ ...ARCH_SPEC, diagram_type: "gantt" }));
    expect(badType.ok).toBe(false);
    const badMeta = parseArchifySpec(
      JSON.stringify({ ...ARCH_SPEC, meta: { title: "x", output: "../escape.html" } }),
    );
    expect(badMeta.ok).toBe(false);
    if (!badMeta.ok) {
      expect(badMeta.diagnostics.map((d) => d.params?.field)).toContain("meta.output");
    }
    const notJson = parseArchifySpec("{nope");
    expect(notJson.ok).toBe(false);
    if (!notJson.ok) {
      expect(notJson.diagnostics[0]?.key).toBe("diagram.archify.invalidJson");
    }
  });
});

describe("archify-json codec registration", () => {
  it("resolves compound extensions before generic .json", () => {
    expect(codecForFilename("shop.architecture.json")?.id).toBe("archify-json");
    expect(codecForFilename("flow.workflow.json")?.id).toBe("archify-json");
    expect(codecForFilename("login.sequence.json")?.id).toBe("archify-json");
    expect(codecForFilename("events.DATAFLOW.json")?.id).toBe("archify-json");
    expect(codecForFilename("run.lifecycle.json")?.id).toBe("archify-json");
    expect(codecForFilename("plain.json")?.id).toBe("maru-json");
    expect(codecForFilename("doc.cmd.json")?.id).toBe("maru-json");
  });

  it("imports a spec file into a doc carrying the semantic dataset", () => {
    const codec = getCodec("archify-json");
    const outcome = codec?.parse?.(JSON.stringify(ARCH_SPEC), "shop.architecture.json");
    if (!outcome || outcome.result.kind !== "doc") throw new Error("expected doc result");
    expect(outcome.result.doc.datasets).toHaveLength(1);
    expect(outcome.result.doc.docTitle).toBe("Shop");
    expect(outcome.fidelity).toBe("structural");
  });

  it("export round-trips the spec through the codec", async () => {
    const codec = getCodec("archify-json");
    const imported = codec?.parse?.(JSON.stringify(ARCH_SPEC), "shop.architecture.json");
    if (!imported || imported.result.kind !== "doc") throw new Error("expected doc result");
    const serialized = await codec?.serialize?.({ doc: imported.result.doc });
    if (!serialized || typeof serialized.bytes !== "string") throw new Error("expected text bytes");
    expect(JSON.parse(serialized.bytes)).toEqual({
      ...ARCH_SPEC,
      connections: [{ id: "conn1", ...ARCH_SPEC.connections[0] }],
    });
    expect(serialized.warnings.map((w: { key: string }) => w.key)).toContain("diagram.archify.semanticOnly");
  });

  it("import refuses an invalid spec with a thrown diagnostic", () => {
    const codec = getCodec("archify-json");
    expect(() => codec?.parse?.("{}", "bad.architecture.json")).toThrow(/diagram\./);
  });
});

describe("P2 semantic types (issue #433)", () => {
  const fixtureText = (type: SemanticDiagramType, mutate?: (spec: Record<string, unknown>) => void) => {
    const spec = structuredClone(SEMANTIC_FIXTURES[type]);
    mutate?.(spec);
    return JSON.stringify(spec);
  };
  const refusalKeys = (text: string) => {
    const outcome = parseArchifySpec(text);
    return outcome.ok ? [] : outcome.diagnostics.map((d) => d.key);
  };

  it("parses the sequence, dataflow and lifecycle fixtures", () => {
    for (const type of ["sequence", "dataflow", "lifecycle"] as const) {
      const outcome = parseArchifySpec(fixtureText(type));
      if (!outcome.ok) throw new Error(`${type}: ${JSON.stringify(outcome.diagnostics)}`);
      expect(outcome.result.dataset.diagramType).toBe(type);
    }
  });

  it("refuses broken references with diagram.semantic diagnostics", () => {
    const messages = (spec: Record<string, unknown>) => spec.messages as Record<string, unknown>[];
    expect(refusalKeys(fixtureText("sequence", (s) => { messages(s)[0]!.to = "ghost"; }))).toContain(
      "diagram.semantic.danglingReference",
    );
    expect(refusalKeys(fixtureText("sequence", (s) => { messages(s)[0]!.to = "web"; }))).toContain(
      "diagram.semantic.selfMessage",
    );
    expect(
      refusalKeys(fixtureText("lifecycle", (s) => { (s.states as Record<string, unknown>[])[0]!.lane = "side"; })),
    ).toContain("diagram.semantic.danglingReference");
    expect(
      refusalKeys(fixtureText("dataflow", (s) => { (s.nodes as Record<string, unknown>[])[0]!.stage = 5; })),
    ).toContain("diagram.semantic.danglingReference");
    expect(
      refusalKeys(
        fixtureText("lifecycle", (s) => {
          s.transitions = [
            { id: "t", from: "queued", to: "running" },
            { id: "t", from: "running", to: "done" },
          ];
        }),
      ),
    ).toContain("diagram.semantic.duplicateId");
  });

  it("preserves and reports an unknown top-level field for each new type", () => {
    for (const type of ["sequence", "dataflow", "lifecycle"] as const) {
      const outcome = parseArchifySpec(fixtureText(type, (s) => { s.futureField = { keep: true }; }));
      if (!outcome.ok) throw new Error(`${type}: ${JSON.stringify(outcome.diagnostics)}`);
      expect(outcome.result.dataset.preservedExtensions).toEqual({ futureField: { keep: true } });
      expect(outcome.result.diagnostics).toContainEqual({
        key: "diagram.archify.unsupportedField",
        params: { field: "futureField", diagramType: type },
      });
    }
  });

  it("round-trips every type through import, save and export (minted ids only)", async () => {
    const codec = getCodec("archify-json")!;
    for (const type of SEMANTIC_DIAGRAM_TYPES) {
      const input = SEMANTIC_FIXTURES[type];
      const imported = codec.parse!(JSON.stringify(input), `x.${type}.json`);
      if (imported.result.kind !== "doc") throw new Error("expected doc");
      const reloaded = deserializeDoc(serializeDoc(imported.result.doc));
      const exported = await codec.serialize!({ doc: reloaded });
      const spec = JSON.parse(exported.bytes as string) as Record<string, unknown>;
      expect(spec).toEqual(mintRelationIds(type, input).spec);
      expect(validateSemanticContent(type, spec)).toEqual([]);
      // Minting is idempotent across the round trip.
      expect(mintRelationIds(type, spec).minted).toBe(0);
      const entities = SEMANTIC_TYPES[type].entities;
      expect((spec[entities] as { id: string }[]).map((e) => e.id)).toEqual(
        (input[entities] as { id: string }[]).map((e) => e.id),
      );
    }
    const sequence = SEMANTIC_FIXTURES.sequence.messages as { label: string }[];
    const lifecycleTypes = (SEMANTIC_FIXTURES.lifecycle.states as { type: string }[]).map((s) => s.type);
    const reimported = codecRoundTrip("sequence");
    expect(sequenceOrder(reimported).map((i) => (reimported.messages as { label: string }[])[i]!.label)).toEqual(
      sequence.map((m) => m.label),
    );
    expect((codecRoundTrip("lifecycle").states as { type: string }[]).map((s) => s.type)).toEqual(lifecycleTypes);
  });

  function codecRoundTrip(type: SemanticDiagramType): Record<string, unknown> {
    const codec = getCodec("archify-json")!;
    const imported = codec.parse!(JSON.stringify(SEMANTIC_FIXTURES[type]), `x.${type}.json`);
    if (imported.result.kind !== "doc") throw new Error("expected doc");
    const doc = deserializeDoc(serializeDoc(imported.result.doc));
    const dataset = doc.datasets!.find((d) => d.kind === "semanticSpec") as { spec: Record<string, unknown> };
    return dataset.spec;
  }

  it("projects members and containers on archify-json import", () => {
    const outcome = getCodec("archify-json")!.parse!(JSON.stringify(SEMANTIC_FIXTURES.lifecycle), "run.lifecycle.json");
    if (outcome.result.kind !== "doc") throw new Error("expected doc");
    const { doc } = outcome.result;
    const datasetId = doc.datasets![0]!.id;
    expect(doc.nodes.map((n) => n.id)).toEqual([`${datasetId}:lane:main`, "queued", "running", "done"]);
    expect(doc.edges.map((e) => e.id)).toEqual(["tr1", "tr2"]);
  });
});
