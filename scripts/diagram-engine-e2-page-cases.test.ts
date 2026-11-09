import { readFileSync } from "node:fs";
import { expect, it } from "vitest";
import { generatedPageCases } from "./diagram-engine-e2-page-cases.mjs";
import { geometryComparisonFor } from "./diagram-engine-e2-comparison.mjs";
import { seedFor } from "./diagram-engine-e1-cases.mjs";

it("binds authored-page and stub/interior regressions to actual pinned oracle verdicts", () => {
  const corpus = JSON.parse(readFileSync("src-tauri/crates/maru-diagram-engine/testdata/parity.json", "utf8"));
  const cases = generatedPageCases(seedFor);
  expect(cases).toHaveLength(20);
  for (const generated of cases) {
    const recorded = corpus.boundaryCases.find((item: { id: string }) => item.id === generated.id);
    expect(recorded, generated.id).toBeDefined();
    expect(JSON.parse(recorded.inputJson), generated.id).toEqual(generated.spec);
    expect(recorded.oracle.ok, generated.id).toBe(generated.boundary.expectedOracleAccepted);
    expect(geometryComparisonFor(recorded), generated.id).toEqual(recorded.geometryComparison);
  }
});
