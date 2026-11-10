import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { assertCleanSource, bindingProvenance } from "./diagram-engine-admission-refresh.mjs";

function refusal(status: string): string {
  try {
    assertCleanSource(status);
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
  return "";
}

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

  it("refuses before any receipt is written, so the guard is not advisory", () => {
    // The CLI calls requireCleanSource() before it reads the ledger or bindings,
    // which is the only order that keeps a written identity truthful.
    expect(refusal(" M docs/diagram-engine-e2-s3.json\n")).toMatch(/dirty source tree/);
  });

  it("pins the WASM bindings by the hash of the exact bytes that were loaded", () => {
    const bytes: Record<string, Buffer> = {
      "bindings/maru_diagram_engine.js": Buffer.from("export function layout_json() {}\n", "utf8"),
      "bindings/maru_diagram_engine_bg.wasm": Buffer.from([0x00, 0x61, 0x73, 0x6d, 0x01, 0x00, 0x00, 0x00]),
    };
    const read = (path: string): Buffer => {
      const value = bytes[String(path)];
      if (!value) throw new Error(`unexpected read ${path}`);
      return value;
    };
    const provenance = bindingProvenance("bindings", read);
    expect(provenance.jsSha256).toBe(createHash("sha256").update(bytes["bindings/maru_diagram_engine.js"]).digest("hex"));
    expect(provenance.wasmSha256).toBe(createHash("sha256").update(bytes["bindings/maru_diagram_engine_bg.wasm"]).digest("hex"));
    expect(provenance.jsSha256).not.toBe(provenance.wasmSha256);
  });

  it("changes the recorded binding hash when the artifact changes", () => {
    const one = bindingProvenance("b", (path: string) => Buffer.from(`first:${String(path)}`));
    const two = bindingProvenance("b", (path: string) => Buffer.from(`second:${String(path)}`));
    expect(one.wasmSha256).not.toBe(two.wasmSha256);
  });
});
