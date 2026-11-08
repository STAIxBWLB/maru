import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { compareManifests, corpusContract, REQUIRED_RECEIPTS } from "./diagram-engine-e2-determinism.mjs";

const corpusText = JSON.stringify({
  schemaVersion: 1,
  cases: [{ id: "arch-one" }, { id: "arch-two" }, { id: "flow-one" }, { id: "sequence-one" }],
});
const corpus = corpusContract(corpusText);
const report = (caseIds = corpus.caseIds, extra = {}) => ({
  apiVersion: 1,
  scope: "whole-scene-geometry",
  repeatCheck: true,
  corpusSha256: corpus.corpusSha256,
  corpusCaseCount: caseIds.length,
  fontManifestSha256: "font-manifest",
  cases: caseIds.map((id) => ({ id, hash: createHash("sha256").update(id).digest("hex") })),
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

  it("fails closed for malformed corpus JSON and malformed report records", () => {
    expect(() => corpusContract("{")).toThrow("Parity corpus JSON is invalid");
    expect(() => compareManifests([{}, {}, {}, {}], corpus, REQUIRED_RECEIPTS)).toThrow("empty or incompatible");
    const noHash = report(); noHash.cases[0]!.hash = "";
    expect(() => compare([noHash, noHash, noHash, noHash])).toThrow("case hash is missing");
    expect(() => corpusContract(JSON.stringify({ cases: [{ id: "duplicate" }, { id: "duplicate" }] }))).toThrow("duplicate case IDs");
  });
});
