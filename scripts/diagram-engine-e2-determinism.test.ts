import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { compareManifests, corpusContract, REQUIRED_RECEIPTS } from "./diagram-engine-e2-determinism.mjs";

const corpusText = JSON.stringify({
  schemaVersion: 1,
  cases: [{ id: "arch-one" }, { id: "arch-two" }, { id: "flow-one" }, { id: "sequence-one" }],
});
const corpus = corpusContract(corpusText);
// Mirrors the six counters work.rs::WorkStats::total sums, plus the masked A*
// subset it never adds again: 2 + 999 + 3000 + 0 + 0 + 4 = 4005.
const benchmarkWork = () => ({
  fixtureSha256: "a".repeat(64),
  nodes: 1000,
  routes: 999,
  stats: {
    astarExpandedStates: 2,
    routeEvaluations: 999,
    constraintEvaluations: 3000,
    endpointMaskEvaluations: 0,
    endpointClearanceEvaluations: 0,
    textScalarMeasurements: 4,
    maskedAstarExpandedStates: 0,
  },
  total: 4005,
});
const report = (caseIds = corpus.caseIds, extra = {}) => ({
  apiVersion: 1,
  scope: "whole-scene-geometry",
  svgHashVersion: 1,
  repeatCheck: true,
  corpusSha256: corpus.corpusSha256,
  corpusCaseCount: caseIds.length,
  fontManifestSha256: "font-manifest",
  benchmarkWork: benchmarkWork(),
  cases: caseIds.map((id) => ({ id, ok: true, geometryRetained: true, hash: createHash("sha256").update(id).digest("hex"), svg: {light: {hash:"c".repeat(64),bytes:10,artifactGate:true},dark: {hash:"d".repeat(64),bytes:11,artifactGate:true}} })),
  ...extra,
});
const four = () => [report(), report(), report(), report()];
const compare = (reports: ReturnType<typeof report>[]) => compareManifests(reports, corpus, REQUIRED_RECEIPTS);

describe("cross-platform whole-scene receipt comparison", () => {
  it("requires the three native OS receipts plus the actual WASM receipt", () => {
    expect(compare(four())).toBe(corpus.caseCount);
    expect(() => compare([report(), report(), report()])).toThrow("missing platform or WASM job");
    expect(() => compareManifests(four(), corpus, ["native-linux", "native-macos", "native-windows", "native-linux"]))
      .toThrow("wasm-linux");
    expect(() => compareManifests(four(), corpus, undefined)).toThrow("provenance is incomplete");
  });

  it("requires matching corpus hash, count, IDs, and order on every report", () => {
    const wrongHash = report(); wrongHash.corpusSha256 = "wrong-corpus";
    expect(() => compare([report(), report(), report(), wrongHash])).toThrow("corpus SHA-256");
    const wrongCount = report(); wrongCount.corpusCaseCount -= 1;
    expect(() => compare([report(), wrongCount, report(), report()])).toThrow("corpus has 4");
    const reordered = report([...corpus.caseIds].reverse());
    expect(() => compare([report(), report(), reordered, report()])).toThrow("case order/IDs");
  });

  it("rejects identical truncated reports and old foundation-only reports", () => {
    const truncated = report(corpus.caseIds.slice(0, 3));
    expect(() => compare([truncated, truncated, truncated, truncated])).toThrow("corpus has 4");
    const foundation = report(undefined, { scope: "foundation-text-metrics-not-scene-layout" });
    expect(() => compare([foundation, foundation, foundation, foundation])).toThrow("empty or incompatible");
  });

  it("compares every native/WASM case hash and report metadata", () => {
    const altered = report(); altered.cases[0]!.hash = "b".repeat(64);
    expect(() => compare([report(), report(), report(), altered])).toThrow("arch-one");
    const other = report(undefined, { fontManifestSha256: "other" });
    expect(() => compare([report(), other, report(), report()])).toThrow("manifest metadata");
  });

  it("requires identical native and WASM logical work and refuses missing counters", () => {
    const missing = report(undefined, { benchmarkWork: undefined });
    expect(() => compare([report(), report(), report(), missing])).toThrow("work receipt");
    const changed = report();
    changed.benchmarkWork.stats.constraintEvaluations += 1;
    changed.benchmarkWork.total += 1;
    expect(() => compare([report(), changed, report(), report()])).toThrow("manifest metadata");
  });

  it("refuses a total that leaves the text scalar counter out", () => {
    // The pre-version-3 receipt: the total covered A*, route and constraint
    // work only, so a wrapping measurer that records scalars still "added up".
    const threeCounters = report();
    threeCounters.benchmarkWork.total =
      threeCounters.benchmarkWork.stats.astarExpandedStates
      + threeCounters.benchmarkWork.stats.routeEvaluations
      + threeCounters.benchmarkWork.stats.constraintEvaluations;
    expect(() => compare([threeCounters, report(), report(), report()])).toThrow("counter sum");
    const droppedCounter = report();
    delete (droppedCounter.benchmarkWork.stats as Partial<ReturnType<typeof benchmarkWork>["stats"]>).textScalarMeasurements;
    droppedCounter.benchmarkWork.total = 4001;
    expect(() => compare([report(), droppedCounter, report(), report()])).toThrow("textScalarMeasurements");
    // Masked A* expansions prove a subset of the expansions and are never a
    // seventh addend, so counting them again breaks the total.
    const doubleCounted = report();
    doubleCounted.benchmarkWork.stats.maskedAstarExpandedStates = 1;
    doubleCounted.benchmarkWork.total = 4006;
    expect(() => compare([doubleCounted, report(), report(), report()])).toThrow("counter sum");
  });

  it("requires both per-theme SVG hashes and successful artifact gates", () => {
    const missing = report();
    missing.cases[0]!.svg.light.hash = "";
    expect(() => compare([missing, report(), report(), report()])).toThrow("SVG hash");
    const refused = report();
    refused.cases[0]!.ok = false;
    // Refusal is not a reason to drop a retained scene's SVG.
    Object.assign(refused.cases[0]!, { svg: null });
    expect(() => compare([refused, report(), report(), report()])).toThrow("retained geometry");
    const changed = report();
    changed.cases[0]!.svg.dark.hash = "e".repeat(64);
    expect(() => compare([report(), changed, report(), report()])).toThrow("arch-one");
  });

  it("fails closed for malformed corpus JSON and malformed report records", () => {
    expect(() => corpusContract("{")).toThrow("Parity corpus JSON is invalid");
    expect(() => compareManifests([{}, {}, {}, {}], corpus, REQUIRED_RECEIPTS)).toThrow("empty or incompatible");
    const noHash = report(); noHash.cases[0]!.hash = "";
    expect(() => compare([noHash, noHash, noHash, noHash])).toThrow("case hash is missing");
    expect(() => corpusContract(JSON.stringify({ cases: [{ id: "duplicate" }, { id: "duplicate" }] }))).toThrow("duplicate case IDs");
  });
});
