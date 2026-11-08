import { describe, expect, it } from "vitest";
import { compareManifests } from "./diagram-engine-e2-determinism.mjs";
const report = () => ({ apiVersion: 1, scope: "foundation-text-metrics", cases: [{ id: "fixture", hash: "same" }] });
describe("cross-platform engine receipt comparison", () => {
  it("requires every platform and rejects an empty corpus", () => {
    expect(() => compareManifests([report(), report()])).toThrow("missing platform");
    expect(() => compareManifests([{}, {}, {}])).toThrow("empty/incompatible");
  });
  it("compares metadata, case ordering and every per-case hash", () => {
    expect(compareManifests([report(), report(), report()])).toBe(1);
    const altered = report(); altered.cases[0]!.hash = "different";
    expect(() => compareManifests([report(), altered, report()])).toThrow("fixture");
    const other = { ...report(), scope: "other" };
    expect(() => compareManifests([report(), other, report()])).toThrow("metadata");
  });
});
