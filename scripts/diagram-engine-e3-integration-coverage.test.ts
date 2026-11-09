import { describe, expect, it } from "vitest";
import {
  assertExecutedCoverage,
  assertSvgSuiteCount,
  EXPECTED_SVG_SUITE_COUNT,
  parseCargoTestSummary,
} from "./diagram-engine-e3-integration-coverage.mjs";

const svgSuites = Array.from({ length: EXPECTED_SVG_SUITE_COUNT }, (_, index) => `svg_suite_${index}`);

describe("hosted SVG integration coverage gate", () => {
  it("requires the current 17 unique svg_ targets", () => {
    const filenames = svgSuites.map((suite) => `${suite}.rs`);
    expect(assertSvgSuiteCount(filenames)).toHaveLength(EXPECTED_SVG_SUITE_COUNT);
    expect(() => assertSvgSuiteCount(filenames.slice(1))).toThrow(/Expected 17 unique svg_\*\.rs/);
    expect(() => assertSvgSuiteCount([...filenames, "svg_extra.rs"])).toThrow(/Expected 17 unique svg_\*\.rs/);
    expect(() => assertSvgSuiteCount([...filenames.slice(1), filenames[1]])).toThrow(/Expected 17 unique svg_\*\.rs/);
  });

  it("requires a successful nonzero Cargo test result for each executed target", () => {
    expect(parseCargoTestSummary(
      "running 2 tests\ntest case::one ... ok\ntest case::two ... ok\ntest result: ok. 2 passed; 0 failed; 0 ignored; 0 measured; 0 filtered out; finished in 0.01s",
      "svg_artifact",
    )).toMatchObject({ passed: 2, failed: 0, executed: 2 });
    expect(() => parseCargoTestSummary("Finished test profile", "svg_missing")).toThrow(/produced 0 Cargo test summaries/);
    expect(() => parseCargoTestSummary(
      "test result: ok. 0 passed; 0 failed; 3 ignored; 0 measured; 0 filtered out; finished in 0.00s",
      "svg_cfg_empty",
    )).toThrow(/executed no passing or failing test cases/);
    expect(() => parseCargoTestSummary(
      "test result: FAILED. 1 passed; 1 failed; 0 ignored; 0 measured; 0 filtered out; finished in 0.01s",
      "svg_failing",
    )).toThrow(/Cargo result is FAILED/);
  });

  it("fails closed if any SVG suite or the PNG integration contract is absent", () => {
    const completed = [...svgSuites, "png_contract"];
    expect(assertExecutedCoverage(svgSuites, completed)).toEqual({
      svgSuiteCount: EXPECTED_SVG_SUITE_COUNT,
      pngContractExecuted: true,
    });
    expect(() => assertExecutedCoverage(svgSuites, completed.slice(1))).toThrow(/Expected completed coverage/);
    expect(() => assertExecutedCoverage(svgSuites, [...completed, "png_contract"])).toThrow(/Expected completed coverage/);
  });
});
