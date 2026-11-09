import { expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { geometryComparisonFor } from "./diagram-engine-e2-comparison.mjs";

it("binds geometry refusal mappings to the observed oracle cause rather than the probe name", () => {
  const item = { id: "probe", diagramType: "dataflow", geometryRule: "dataflow/fixed-row-slots",
    comparison: { inputJson: "{}", accepted: true },
    oracle: { ok: false, diagnostics: [{ message: 'Node "a" uses invalid row 5' }] } };
  expect(geometryComparisonFor(item)).toMatchObject({ accepted: false, geometryExpected: true, equivalentCodes: ["dataflow/fixed-row-slots"] });
  expect(() => geometryComparisonFor({ ...item, oracle: { ok: false, diagnostics: [{ message: "Something unrelated failed" }] } })).toThrow("does not produce its claimed renderer cause");
});
it("keeps document and geometry layers distinct and preserves the three deferred renderer verdicts", () => {
  const corpus = JSON.parse(readFileSync("src-tauri/crates/maru-diagram-engine/testdata/parity.json", "utf8"));
  const deferred = corpus.cases.filter((item: { currentScope?: { kind: string } }) => item.currentScope?.kind === "e2-geometry");
  expect(deferred).toHaveLength(3);
  for (const item of deferred) {
    expect(item.comparison.accepted).toBe(true);
    expect(item.geometryComparison.accepted).toBe(false);
    expect(item.geometryComparison.geometryExpected).toBe(true);
    expect(item.geometryComparison.equivalentCodes.length).toBeGreaterThan(0);
  }
  for (const item of corpus.cases) expect(geometryComparisonFor(item)).toEqual(item.geometryComparison);
});

it("never maps another family's label overlap to sequence message spacing or a loose alias",()=>{
  const item={id:"lifecycle-overlap",diagramType:"lifecycle",comparison:{inputJson:"{}",accepted:true},oracle:{ok:false,codes:["layout/constraint"],diagnostics:[{message:'Labels "One" and "Two" overlap'}]}};
  expect(geometryComparisonFor(item).equivalentCodes).toEqual(["lifecycle/geometry-label-overlap"]);
  expect(geometryComparisonFor({...item,geometryRule:"lifecycle/geometry-label-overlap"}).equivalentCodes).toEqual(["lifecycle/geometry-label-overlap"]);
});
