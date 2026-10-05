import { describe, expect, it } from "vitest";

import {
  ARCHIFY_ENGINE,
  archifySpecToDataset,
  collectArchifyIds,
  datasetToArchifySpec,
  parseArchifySpec,
  toArchifyId,
} from "./archifyCodec";
import { codecForFilename, getCodec } from "./codecs";
import { validateSemanticSpec } from "./reportTypes";

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
    expect(dataset.idMap).toEqual({ web: "web", api: "api" });
    expect(dataset.preservedExtensions).toBeUndefined();
    expect(diagnostics).toEqual([]);
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
    expect(outcome.result.diagnostics).toEqual([]);
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
    const badType = parseArchifySpec(JSON.stringify({ ...ARCH_SPEC, diagram_type: "sequence" }));
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
    expect(JSON.parse(serialized.bytes)).toEqual(ARCH_SPEC);
    expect(serialized.warnings.map((w: { key: string }) => w.key)).toContain("diagram.archify.semanticOnly");
  });

  it("import refuses an invalid spec with a thrown diagnostic", () => {
    const codec = getCodec("archify-json");
    expect(() => codec?.parse?.("{}", "bad.architecture.json")).toThrow(/diagram\./);
  });
});
