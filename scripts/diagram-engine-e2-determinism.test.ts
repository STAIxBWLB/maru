import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { compareManifests, corpusContract } from "./diagram-engine-e2-determinism.mjs";

const corpusText = JSON.stringify({
  schemaVersion: 1,
  cases: [
    { id: "arch-one" },
    { id: "arch-two" },
    { id: "flow-one" },
    { id: "sequence-one" },
  ],
});
const corpus = corpusContract(corpusText);
const report = (caseIds = corpus.caseIds, extra = {}) => ({
  apiVersion: 1,
  scope: "foundation-text-metrics-not-scene-layout",
  corpusSha256: corpus.corpusSha256,
  corpusCaseCount: caseIds.length,
  fontManifestSha256: "font-manifest",
  fonts: [],
  cases: caseIds.map((id) => ({ id, hash: createHash("sha256").update(id).digest("hex") })),
  ...extra,
});

describe("cross-platform engine receipt comparison", () => {
  it("requires exactly three reports matching corpus hash, count, IDs, and order", () => {
    expect(compareManifests([report(), report(), report()], corpus)).toBe(corpus.caseCount);
    expect(() => compareManifests([report(), report()], corpus)).toThrow("missing platform");

    const wrongHash = report();
    wrongHash.corpusSha256 = "wrong-corpus";
    expect(() => compareManifests([report(), wrongHash, report()], corpus)).toThrow("corpus SHA-256");

    const wrongCount = report();
    wrongCount.corpusCaseCount -= 1;
    expect(() => compareManifests([report(), wrongCount, report()], corpus)).toThrow("corpus has 4");

    const reordered = report([...corpus.caseIds].reverse());
    expect(() => compareManifests([report(), reordered, report()], corpus)).toThrow("case order/IDs");
  });

  it("rejects three identical truncated platform reports", () => {
    const truncated = report(corpus.caseIds.slice(0, 3));
    expect(() => compareManifests([truncated, truncated, truncated], corpus)).toThrow("corpus has 4");
  });

  it("compares every per-case hash and report metadata after validating corpus identity", () => {
    const altered = report();
    altered.cases[0]!.hash = "b".repeat(64);
    expect(() => compareManifests([report(), altered, report()], corpus)).toThrow("arch-one");

    const other = report(undefined, { scope: "other" });
    expect(() => compareManifests([report(), other, report()], corpus)).toThrow("manifest metadata");
  });

  it("fails closed for malformed corpus JSON and malformed report records", () => {
    expect(() => corpusContract("{")).toThrow("Parity corpus JSON is invalid");
    expect(() => compareManifests([{}, {}, {}], corpus)).toThrow("empty or incompatible");
    const noHash = report(); noHash.cases[0]!.hash = "";
    expect(() => compareManifests([noHash, noHash, noHash], corpus)).toThrow("case hash is missing");
    expect(() => corpusContract(JSON.stringify({ cases: [{ id: "duplicate" }, { id: "duplicate" }] }))).toThrow("duplicate case IDs");
  });
});
