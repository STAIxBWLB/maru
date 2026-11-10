import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { assertCleanSource, bindingProvenance, nativeIdentityScope } from "./diagram-engine-admission-refresh.mjs";

function refusal(status: string): string {
  try {
    assertCleanSource(status);
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
  return "";
}

const identity = {
  engineSourceCommit: "a".repeat(40),
  sdkTree: "b".repeat(40),
  engineCrateTree: "c".repeat(40),
};

describe("admission refresh provenance", () => {
  it("accepts a clean tracked tree", () => {
    expect(() => assertCleanSource("")).not.toThrow();
    expect(() => assertCleanSource("\n   \n")).not.toThrow();
  });

  it("refuses a dirty tracked tree and names every path", () => {
    const message = refusal(" M src-tauri/crates/maru-diagram-engine/src/metrics/wrap.rs\nM  scripts/diagram-engine-admission-refresh.mjs\n");
    expect(message).toContain("Refusing to stamp HEAD over a dirty source tree");
    expect(message).toContain("src-tauri/crates/maru-diagram-engine/src/metrics/wrap.rs");
    expect(message).toContain("scripts/diagram-engine-admission-refresh.mjs");
    expect(message).toContain("commit or stash");
  });

  it("refuses a dirty receipt path too, so the guard is not advisory", () => {
    // The refresh writes docs/diagram-engine-e2-s3.json and the ledger, so a
    // modification to either is a dirty tree the stamped commit cannot describe.
    expect(refusal(" M docs/diagram-engine-e2-s3.json\n")).toMatch(/dirty source tree/);
  });

  it("pins the WASM bindings by the hash of the bytes that were initialized with", () => {
    const js = Buffer.from("export function layout_json() {}\n", "utf8");
    const wasm = Buffer.from([0x00, 0x61, 0x73, 0x6d, 0x01, 0x00, 0x00, 0x00]);
    const provenance = bindingProvenance({ js, wasm });
    expect(provenance.jsSha256).toBe(createHash("sha256").update(js).digest("hex"));
    expect(provenance.wasmSha256).toBe(createHash("sha256").update(wasm).digest("hex"));
    expect(provenance.jsSha256).not.toBe(provenance.wasmSha256);
  });

  it("changes the recorded binding hash when the artifact changes", () => {
    const one = bindingProvenance({ js: "first", wasm: "first-wasm" });
    const two = bindingProvenance({ js: "second", wasm: "second-wasm" });
    expect(one.wasmSha256).not.toBe(two.wasmSha256);
  });

  it("does not claim a same-head cross-check for the identity-less native report the runner emits", () => {
    // geometry-foundation-hashes reports corpus, case and work data only; it has
    // no sourceCommit, sdkTree or engineCrateTree to compare against.
    const nativeReport = {
      apiVersion: 1,
      scope: "whole-scene-geometry",
      repeatCheck: true,
      corpusSha256: "d".repeat(64),
      corpusCaseCount: 623,
      cases: [],
    };
    expect(nativeIdentityScope(nativeReport, identity)).toBe("recorded-hashes-only");
    expect(nativeIdentityScope(null, identity)).toBe("recorded-hashes-only");
  });

  it("claims the cross-check only when all three identity fields are present and equal", () => {
    const full = {
      apiVersion: 1,
      sourceCommit: identity.engineSourceCommit,
      sdkTree: identity.sdkTree,
      engineCrateTree: identity.engineCrateTree,
    };
    expect(nativeIdentityScope(full, identity)).toBe("cross-checked-against-same-head-native-corpus-report");
    // A partial identity still proves nothing about the other two fields.
    expect(nativeIdentityScope({ sdkTree: identity.sdkTree }, identity)).toBe("recorded-hashes-only");
  });

  it("refuses a native report whose identity contradicts the current head", () => {
    const stale = { sourceCommit: "e".repeat(40), sdkTree: identity.sdkTree, engineCrateTree: identity.engineCrateTree };
    expect(() => nativeIdentityScope(stale, identity)).toThrow(/sourceCommit does not match the current committed engine source/);
  });
});
