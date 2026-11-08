import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { hasPrivateText, withoutRepositoryEvidence } from "./diagram-engine-e0-corpus.mjs";
import { generatedCases, equivalentCodes, PRIMARY, TYPES } from "./diagram-engine-e1-cases.mjs";

describe("E0 public corpus intake", () => {
  it("recognizes local paths and contact data with optional private terms", () => {
    expect(hasPrivateText("/Users/fixture/work")).toBe(true);
    expect(hasPrivateText("reader@example.test")).toBe(true);
    expect(hasPrivateText("Fixture Person", ["fixture person"])).toBe(true);
    expect(hasPrivateText("https://github.com/example/home")).toBe(false);
  });
  it("keeps separate document-validity verdicts for all eight public blobs", () => {
    const corpus = JSON.parse(readFileSync("src-tauri/crates/maru-diagram-engine/testdata/parity.json", "utf8"));
    const publicCases = corpus.cases.filter((item: { origin: { kind: string } }) => item.origin.kind === "public");
    expect(publicCases).toHaveLength(8);
    for (const item of publicCases) {
      expect(item.oracle.codes).toContain("repository-evidence/root-required");
      expect(item.validityOracle.ok).toBe(true);
      expect(item.validityOracle.codes).toEqual([]);
      expect(item.validityOracle.inputSha256).not.toBe(item.inputSha256);
    }
  });
  it("strips only evidence for the additional validity verdict without changing the original spec", () => {
    const input = { meta: { title: "Example", repository: { revision: "fixture" } }, components: [{ id: "a", sources: ["file.ts"], label: "A" }], connections: [] };
    const clean = withoutRepositoryEvidence(input, "architecture");
    expect(clean.meta).toEqual({ title: "Example" });
    expect(clean.components).toEqual([{ id: "a", label: "A" }]);
    expect(input.components[0].sources).toEqual(["file.ts"]);
    expect(input.meta.repository.revision).toBe("fixture");
  });
});


describe("E1 object-boundary mutation catalog", () => {
  it("retains positional-array negatives at every shared object boundary without a waiver", () => {
    // Invalid fixture data intentionally cannot use the valid SDK input types.
    type InvalidSpec = Record<string, any>;
    const boundaries: Array<{ suffix: string; read: (spec: InvalidSpec, type: string) => unknown }> = [
      { suffix: "meta-array", read: (spec) => spec.meta },
      { suffix: "brand-array", read: (spec, type) => spec[PRIMARY[type]][0].brand },
      { suffix: "primary-item-array", read: (spec, type) => spec[PRIMARY[type]][0] },
      { suffix: "source-item-array", read: (spec, type) => spec[PRIMARY[type]][0].sources[0] },
      { suffix: "card-item-array", read: (spec) => spec.cards[0] },
      { suffix: "view-item-array", read: (spec) => spec.meta.views[0] },
      { suffix: "repository-array", read: (spec) => spec.meta.repository },
      { suffix: "legend-array", read: (spec) => spec.meta.legend },
      { suffix: "legend-entry-array", read: (spec) => Object.values(spec.meta.legend.entries)[0] },
    ];
    const cases = generatedCases();
    for (const type of TYPES) {
      for (const boundary of boundaries) {
        const fixture = cases.find((item) => item.id === `e1-${type}-shape-${boundary.suffix}`);
        expect(fixture, `${type}/${boundary.suffix}`).toBeDefined();
        expect(Array.isArray(boundary.read(fixture!.spec, type))).toBe(true);
        expect(fixture!.expectedEngineCode).toBe(`${type}/shape`);
        expect(fixture!.currentScope).toBeUndefined();
      }
    }
    expect(cases.find((item) => item.id === "e1-architecture-shape-layout-array")?.spec.layout).toEqual(["grid"]);
    expect(cases.find((item) => item.id === "e1-workflow-shape-required-edge-array")?.spec.semanticChecks.requiredEdges[0]).toEqual(["a", "b"]);
    expect(cases.find((item) => item.id === "e1-workflow-shape-required-path-array")?.spec.semanticChecks.requiredPaths[0]).toEqual(["a", "c"]);
  });

  it("accepts only an observed shape refusal for the positional-array expectation", () => {
    const fixture = generatedCases().find((item) => item.id === "e1-architecture-shape-meta-array")!;
    expect(equivalentCodes(fixture, { codes: ["schema/type"], diagnostics: [{ code: "schema/type", subject: { path: "/meta" }, evidence: { type: "object" } }] })).toEqual(["architecture/shape"]);
    expect(() => equivalentCodes(fixture, { codes: ["engineering/deployment-owner-missing"], diagnostics: [{ code: "engineering/deployment-owner-missing" }] })).toThrow("does not map to expected rule");
  });
});
