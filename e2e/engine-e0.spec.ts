// E0 only: no Node engine host override is installed on this page.
import { test, expect } from "@playwright/test";
import { readFileSync } from "node:fs";

const enabled = process.env.MARU_ENGINE_E0 === "1";
test.describe("independent engine WebAssembly spike", () => {
  test.skip(!enabled, "Build the isolated WASM spike with node scripts/diagram-engine-e0.mjs wasm and set MARU_ENGINE_E0=1.");
  test("loads cold and gates the 50/1000 component fixtures without Node IPC", async ({ page }) => {
    const fixtures = [50, 1000].map((count) => JSON.parse(readFileSync(`src-tauri/crates/maru-diagram-engine/testdata/bench-${count}.json`, "utf8")) as { components: unknown[] });
    await page.goto("/");
    const result = await page.evaluate(async (inputs) => {
      const modulePath = "/src/lib/diagram/engine.ts";
      const coldStart = performance.now();
      const { loadWasmEngine } = await import(/* @vite-ignore */ modulePath) as { loadWasmEngine(): Promise<{ validate(input: string): Promise<{ ok: boolean; diagnostics: unknown[]; receipt: { engine: unknown } }> }> };
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
      const invalid = structuredClone(inputs[0]) as { components: unknown[]; connections?: Array<{ from: string; to: string }> };
      invalid.connections = [{ from: "missing", to: "node-0" }];
      const refused = await engine.validate(JSON.stringify(invalid));
      return { transport: "wasm", coldMs, samples, refusesInvalid: !refused.ok, engine: first.receipt.engine };
    }, fixtures);
    expect(result.refusesInvalid).toBe(true);
    expect(result.samples.map((sample) => sample.nodes)).toEqual([50, 1000]);
    for (const sample of result.samples) expect(sample.durationsMs).toHaveLength(30);
    console.log(`ENGINE_E0_WASM ${JSON.stringify(result)}`);
    await test.info().attach("engine-e0-wasm.json", { body: JSON.stringify(result, null, 2), contentType: "application/json" });
  });
});
