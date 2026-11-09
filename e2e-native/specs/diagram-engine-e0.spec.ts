// Real Tauri IPC round trips, debug native-e2e binary; no product engine wiring.
import assert from "node:assert/strict";
import type {} from "webdriverio";

interface Measurement {
  transport: string;
  coldMs: number;
  samples: Array<{ nodes: number; bytes: number; durationsMs: number[] }>;
  pngSamples: Array<{
    name: string;
    nodes: number;
    requestBytes: number;
    responseJsonBytes: number;
    outputBytes: number;
    durationMs: number;
    width: number;
    height: number;
    outputSha256: string;
  }>;
  error?: string;
}
describe("E0 engine IPC measurement", () => {
  it("validates and rasterizes the 50 and 1000 component fixtures through the plugin", async () => {
    // The 1000-node native SVG+PNG request can exceed WebKit's default 30s
    // async-script timeout. Keep the request bounded below the Mocha timeout.
    await browser.setTimeout({ script: 110_000 });
    const result = await browser.executeAsync((done: (value: Measurement) => void) => {
      const deadline = Date.now() + 20000;
      const tick = () => {
        const bridge = window.__MARU_NATIVE_E2E__ as unknown as { diagramEngineMeasurement(): Promise<Measurement>; readAppState(): { booting: boolean; settingsLoaded: boolean; catalogReady: boolean } | null } | undefined;
        const state = bridge?.readAppState();
        if (bridge && state && !state.booting && state.settingsLoaded && state.catalogReady) {
          bridge.diagramEngineMeasurement().then(done).catch((error: unknown) => done({ transport: "ipc", coldMs: 0, samples: [], pngSamples: [], error: String(error) }));
        } else if (Date.now() >= deadline) done({ transport: "ipc", coldMs: 0, samples: [], pngSamples: [], error: "Native bridge/startup did not become ready; rebuild with make test-e2e-native and inspect fixture startup diagnostics." });
        else setTimeout(tick, 100);
      };
      tick();
    }) as Measurement;
    assert.equal(result.error, undefined, `IPC measurement failed: ${result.error}; inspect plugin permissions and rebuild native-e2e.`);
    assert.deepEqual(result.samples.map((sample) => sample.nodes), [50, 1000]);
    for (const sample of result.samples) {
      assert.equal(sample.durationsMs.length, 30);
      assert.ok(sample.durationsMs.every((value) => Number.isFinite(value) && value >= 0));
    }
    assert.deepEqual(result.pngSamples.map((sample) => sample.name), ["typical", "1000"]);
    assert.deepEqual(result.pngSamples.map((sample) => sample.nodes), [2, 1000]);
    for (const sample of result.pngSamples) {
      assert.ok(Number.isFinite(sample.durationMs) && sample.durationMs >= 0);
      assert.ok(sample.requestBytes > 0 && sample.responseJsonBytes > 0 && sample.outputBytes > 0);
      assert.ok(sample.width > 0 && sample.height > 0);
      assert.match(sample.outputSha256, /^[a-f0-9]{64}$/);
    }
    console.log(`ENGINE_E0_IPC ${JSON.stringify(result)}`);
  }).timeout(120_000);
});
