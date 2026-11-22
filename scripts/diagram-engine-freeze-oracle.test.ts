import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { normalizeStagingPaths } from "./diagram-engine-e0-corpus.mjs";
import { FREEZE_COMMAND, ORACLE_LABEL, verdictDifferences } from "./diagram-engine-freeze-oracle.mjs";

const corpus = JSON.parse(readFileSync("src-tauri/crates/maru-diagram-engine/testdata/parity.json", "utf8"));
const all = [...corpus.cases, ...corpus.boundaryCases];

describe("E6 T1 frozen oracle corpus", () => {
  it("names the pinned oracle and the command that recorded it", () => {
    const pin = JSON.parse(readFileSync("sidecars/archify/PIN.json", "utf8"));
    expect(corpus.frozenOracle).toMatchObject({ id: pin.name, version: pin.version, revision: pin.revision, command: FREEZE_COMMAND });
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

  it("normalizes the whole staging directory, with spaces and Windows separators", () => {
    const json = (path: string) => JSON.stringify({ subject: { input: `${path}/specification.snapshot.json` } });
    const staged = JSON.stringify({ subject: { input: "<oracle-staging>/specification.snapshot.json" } });
    expect(normalizeStagingPaths(json("/tmp/oracle tmp/archify-validate-Ab_1"), "/tmp/oracle tmp")).toBe(staged);
    expect(normalizeStagingPaths(json("/tmp/oracle tmp/archify-validate-Ab_1"), "/tmp/oracle tmp/")).toBe(staged);
    expect(normalizeStagingPaths(json("/private/var/folders/x/T/archify-validate-Q9"), "/var/folders/x/T")).toBe(staged);
    const windows = String.raw`C:\Users\Some One\AppData\Local\Temp`;
    const windowsInput = JSON.stringify({ subject: { input: String.raw`${windows}\archify-validate-Zz9\specification.snapshot.json` } });
    expect(normalizeStagingPaths(windowsInput, windows)).toBe(JSON.stringify({ subject: { input: String.raw`<oracle-staging>/specification.snapshot.json` } }));
    expect(normalizeStagingPaths(windowsInput, windows)).not.toContain("Some One");
    // An unrelated path that merely contains the marker is left alone.
    expect(normalizeStagingPaths(json("/elsewhere/archify-validate-X"), "/tmp/oracle tmp")).toBe(json("/elsewhere/archify-validate-X"));
  });

  it("reports exactly the verdict fields that differ", () => {
    const item = { oracle: { ok: true, codes: [], diagnostics: [] }, schemaOracle: { ok: false, codes: ["x"], diagnostics: [{ code: "x" }] } };
    expect(verdictDifferences(item, { oracle: { ok: true, codes: [], diagnostics: [] }, schemaOracle: item.schemaOracle })).toEqual([]);
    expect(verdictDifferences(item, { oracle: { ok: false, codes: ["y"], diagnostics: [{ code: "y" }] }, schemaOracle: item.schemaOracle })).toEqual(["oracle"]);
  });
});
