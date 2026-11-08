// Independent validator measurement: no Node engine host override is installed on this page.
import { test, expect } from "@playwright/test";
import { readFileSync } from "node:fs";

const enabled = process.env.MARU_ENGINE_E0 === "1";
test.describe("independent engine WebAssembly spike", () => {
  test.skip(!enabled, "Build the isolated WASM spike with node scripts/diagram-engine-e0.mjs wasm and set MARU_ENGINE_E0=1.");
  test("loads cold and gates the 50/1000 component fixtures without Node IPC", async ({ page }) => {
    const fixtures = [50, 1000].map((count) => JSON.parse(readFileSync(`src-tauri/crates/maru-diagram-engine/testdata/bench-${count}.json`, "utf8")) as { components: unknown[] });
    const documents = ["architecture", "workflow", "sequence", "dataflow", "lifecycle"].map((kind) =>
      JSON.parse(readFileSync(`src-tauri/crates/maru-diagram-engine/testdata/valid-${kind}.json`, "utf8")) as { diagram_type: string; schema_version: number });
    documents.push({ ...documents[1]!, schema_version: 2 }, { ...documents[4]!, schema_version: 2 });
    await page.goto("/");
    const result = await page.evaluate(async ({ inputs, documents }) => {
      const modulePath = "/.engine-e0/browser/engine-e0.js";
      const coldStart = performance.now();
      const { loadWasmEngine } = await import(/* @vite-ignore */ modulePath) as { loadWasmEngine(): Promise<{ validate(input: string): Promise<{ ok: boolean; diagnostics: unknown[]; receipt: { engine: unknown; diagramType?: string | null } }> }> };
      const engine = await loadWasmEngine();
      const first = await engine.validate(JSON.stringify(inputs[0]));
      if (!first.ok) throw new Error("WASM seed validation failed; inspect the engine diagnostics and rebuild the spike.");
      const coldMs = performance.now() - coldStart;
      const samples = [];
      for (const fixture of inputs) {
        const input = JSON.stringify(fixture);
        const durationsMs = [];
        for (let i = 0; i < 30; i++) {
          const start = performance.now();
          const report = await engine.validate(input);
          durationsMs.push(performance.now() - start);
          if (!report.ok) throw new Error("WASM fixture rejected; inspect the independent SDK fixture and retry.");
        }
        samples.push({ nodes: fixture.components.length, bytes: new TextEncoder().encode(input).length, durationsMs });
      }
      const dispatched = [];
      for (const document of documents) {
        const report = await engine.validate(JSON.stringify(document));
        if (!report.ok || report.receipt.diagramType !== document.diagram_type) {
          throw new Error(`The generic WASM dispatcher rejected ${document.diagram_type}; inspect the SDK differential diagnostics and rebuild the engine.`);
        }
        dispatched.push(`${report.receipt.diagramType}@${document.schema_version}`);
      }
      const invalid = structuredClone(inputs[0]) as { components: unknown[]; connections?: Array<{ from: string; to: string }> };
      invalid.connections = [{ from: "missing", to: "node-0" }];
      const refused = await engine.validate(JSON.stringify(invalid));
      return { transport: "wasm", scope: "pre-serialized spec string; wasm call, core validation/hash and report JSON parse; 30 warm samples", coldMs, samples, dispatched, refusesInvalid: !refused.ok, engine: first.receipt.engine };
    }, { inputs: fixtures, documents });
    expect(result.refusesInvalid).toBe(true);
    expect(result.dispatched).toEqual(["architecture@1", "workflow@1", "sequence@1", "dataflow@1", "lifecycle@1", "workflow@2", "lifecycle@2"]);
    expect(result.samples.map((sample) => sample.nodes)).toEqual([50, 1000]);
    expect(Number.isFinite(result.coldMs) && result.coldMs >= 0).toBe(true);
    for (const sample of result.samples) {
      expect(sample.durationsMs).toHaveLength(30);
      expect(sample.durationsMs.every((value) => Number.isFinite(value) && value >= 0)).toBe(true);
    }
    console.log(`ENGINE_E0_WASM ${JSON.stringify(result)}`);
    await test.info().attach("engine-e0-wasm.json", { body: JSON.stringify(result, null, 2), contentType: "application/json" });
  });
});
