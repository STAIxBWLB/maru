import { describe, expect, it } from "vitest";
import { existsSync, readFileSync } from "node:fs";

// E6 (maru#554): the Archify oracle is frozen into parity.json and the sidecar
// is gone, so these verdicts are the oracle now. No test may rerun Archify.
const corpus = JSON.parse(readFileSync("src-tauri/crates/maru-diagram-engine/testdata/parity.json", "utf8"));
const all = [...corpus.cases, ...corpus.boundaryCases];
const ORACLE_LABEL = { source: "archify-oracle" };

describe("E6 frozen oracle corpus", () => {
  it("names the retired oracle pin that recorded the verdicts", () => {
    expect(corpus.frozenOracle).toMatchObject({ id: "archify", version: "3.0.0", revision: corpus.oracle.revision });
    expect(corpus.frozenOracle.revision).toMatch(/^[a-f0-9]{40}$/);
    expect(corpus.frozenOracle.pinSha256).toMatch(/^[a-f0-9]{64}$/);
  });

  it("labels every recorded case with where its verdict came from", () => {
    expect(all.length).toBeGreaterThanOrEqual(620);
    for (const item of all) {
      if (item.label?.source === "maru-engine") expect(item.label.reviewedIn, item.id).toMatch(/^#\d+$/);
      else expect(item.label, item.id).toEqual(ORACLE_LABEL);
    }
  });

  it("records no host-specific staging path in a frozen verdict", () => {
    const text = JSON.stringify(all);
    expect(text).not.toMatch(/\/(?:var\/folders|Users|home|tmp)\/[^"]*archify-validate-/);
  });

  it("ships without the sidecar the verdicts were recorded from", () => {
    expect(existsSync("sidecars/archify")).toBe(false);
  });
});
