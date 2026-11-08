// Independent validator measurement: no Node engine host override is installed on this page.
import { test, expect } from "@playwright/test";
import { readFileSync } from "node:fs";

const enabled = process.env.MARU_ENGINE_E0 === "1";
test.describe("independent engine WebAssembly spike", () => {
  test.skip(!enabled, "Build the isolated WASM spike with node scripts/diagram-engine-e0.mjs wasm and set MARU_ENGINE_E0=1.");
  test("lays out all families repeatably and retains pins in actual lazy WASM", async ({ page }) => {
    const specs = ["architecture", "workflow", "sequence", "dataflow", "lifecycle"].map((kind) => JSON.parse(readFileSync(`src-tauri/crates/maru-diagram-engine/testdata/valid-${kind}.json`, "utf8")) as { diagram_type: string; schema_version: number; meta: { title: string } });
    specs.push({ ...specs[1]!, schema_version: 2 }, { ...specs[4]!, schema_version: 2 });
    const blockedSpec = JSON.parse(readFileSync("src-tauri/crates/maru-diagram-engine/testdata/partial-route.json", "utf8"));
    await page.goto("/");
    const proof = await page.evaluate(async ({ specs, blockedSpec }) => {
      type Scene = { nodes: Array<{ id: string; bounds: { x: number; y: number }; positionSource: string }>; routes: Array<{ id?: string; points: Array<{ x: number; y: number }> }>; labels: unknown[] };
      type Report = { ok: boolean; geometry?: Scene; diagnostics: Array<{ code: string; path: string; message: string; fix: string }>; receipt: { inputSpecSha256: string } };
      const modulePath = "/.engine-e0/browser/engine-e0.js";
      const { loadGeometryEngine } = await import(/* @vite-ignore */ modulePath) as { loadGeometryEngine(): Promise<{ layout(input: unknown): Report }> };
      const engine = await loadGeometryEngine();
      const proof = [];
      for (const spec of specs) {
        const original = JSON.stringify(spec);
        const first = engine.layout({ specJson: original });
        if (!first.ok || !first.geometry) throw new Error(`Layout failed for ${spec.diagram_type}: ${JSON.stringify(first.diagnostics)}; inspect the SDK layout fixture.`);
        const again = engine.layout({ specJson: original });
        if (JSON.stringify(first.geometry) !== JSON.stringify(again.geometry)) throw new Error("Unchanged scene layout differed; inspect stable ordering and fixed arithmetic.");
        const selected = first.geometry.nodes[0]!;
        const edited = structuredClone(spec); edited.meta.title = "Unrelated title edit";
        const retained = engine.layout({ specJson: JSON.stringify(edited), pinSet: { sourceSpecSha256: first.receipt.inputSpecSha256, pins: [{ targetId: selected.id, targetKind: "node", position: { x: selected.bounds.x, y: selected.bounds.y } }] } });
        if (!retained.ok || !retained.geometry) throw new Error(`Pinned scene failed: ${JSON.stringify(retained.diagnostics)}; inspect pin resolution before changing the fixture.`);
        const node = retained.geometry.nodes.find((node) => node.id === selected.id)!;
        if (node.bounds.x !== selected.bounds.x || node.bounds.y !== selected.bounds.y || node.positionSource !== "plannedPin") throw new Error("A surviving member pin moved after an unrelated edit; repair pin precedence.");
        const orthogonal = retained.geometry.routes.every((route) => route.points.every((point, index, points) => index === 0 || point.x === points[index - 1]!.x || point.y === points[index - 1]!.y));
        proof.push({ type: spec.diagram_type, version: spec.schema_version, nodes: retained.geometry.nodes.length, routes: retained.geometry.routes.length, orthogonal });
      }
      const invalid = engine.layout({ specJson: "[]" });
      if (invalid.ok || invalid.geometry) throw new Error("Invalid spec returned scene geometry; keep the E1 gate before placement.");
      const partial = engine.layout({ specJson: JSON.stringify(blockedSpec) });
      if (partial.ok || !partial.geometry || partial.geometry.nodes.length !== 5 || partial.diagnostics.length !== 1
          || partial.diagnostics[0]!.path !== "/connections/0"
          || partial.geometry.routes.find((edge) => edge.id === "blocked")?.points.length !== 0
          || (partial.geometry.routes.find((edge) => edge.id === "clear")?.points.length ?? 0) < 2) {
        throw new Error("An unroutable edge erased placed geometry or stopped a clear edge; preserve partial scenes and return one edge diagnostic.");
      }
      return proof;
    }, { specs, blockedSpec });
    expect(proof).toHaveLength(7);
    expect(proof.every((item) => item.nodes > 0 && item.orthogonal)).toBe(true);
    console.log(`ENGINE_E2_LAYOUT ${JSON.stringify({ scope: "functional lazy WASM scene/pin/repeat proof, no performance claim", proof })}`);
  });
  test("loads cold and gates the 50/1000 component fixtures without Node IPC", async ({ page }) => {
    const fixtures = [50, 1000].map((count) => JSON.parse(readFileSync(`src-tauri/crates/maru-diagram-engine/testdata/bench-${count}.json`, "utf8")) as { components: unknown[] });
    const documents = ["architecture", "workflow", "sequence", "dataflow", "lifecycle"].map((kind) =>
      JSON.parse(readFileSync(`src-tauri/crates/maru-diagram-engine/testdata/valid-${kind}.json`, "utf8")) as { diagram_type: string; schema_version: number });
    documents.push({ ...documents[1]!, schema_version: 2 }, { ...documents[4]!, schema_version: 2 });
    const loadedChunks: string[] = [];
    page.on("request", (request) => { if (request.url().includes("/.engine-e0/browser/")) loadedChunks.push(request.url()); });
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
      const ordered = [...sample.durationsMs].sort((a, b) => a - b);
      expect(ordered[Math.ceil(ordered.length * 0.95) - 1], "Validation p95 exceeded 50 ms; inspect the static payload and decoder before adding geometry dependencies").toBeLessThan(50);
    }
    expect(loadedChunks.some((url) => url.includes("engineGeometry"))).toBe(false);
    const foundation = await page.evaluate(async () => {
      const modulePath = "/.engine-e0/browser/engine-e0.js";
      const { loadGeometryFoundation } = await import(/* @vite-ignore */ modulePath) as {
        loadGeometryFoundation(): Promise<{ measureText(text: string, weight: 400 | 700, size: number): {
          advance: number; replacements: number; font: { weight: number };
          glyphs: Array<{ glyphId: number; ignored: boolean; advance: number; ink: { width: number; height: number } }>;
          diagnostics: Array<{ code: string }>;
        } }>;
      };
      const metrics = await loadGeometryFoundation();
      const text = "Latin 한글 日本語 漢字";
      const covered = [400, 700].map((weight) => metrics.measureText(text, weight as 400 | 700, 14 * 64));
      const fallbacks = [400, 700].flatMap((weight) => ["🚀", "😀", "✔", "⚠️", "👩‍💻"].map((sample) => ({
        text: sample, weight, measured: metrics.measureText(sample, weight as 400 | 700, 14 * 64),
      })));
      return { covered, fallbacks };
    });
    expect(loadedChunks.some((url) => url.includes("engineGeometry"))).toBe(true);
    expect(foundation.covered.map((item) => item.font.weight)).toEqual([400, 700]);
    expect(foundation.covered.every((item) => item.advance > 0 && item.replacements === 0 && item.glyphs.length > 0)).toBe(true);
    for (const { text, measured } of foundation.fallbacks) {
      expect(measured.replacements).toBe(measured.glyphs.filter((glyph) => !glyph.ignored && glyph.glyphId === 0).length);
      if (measured.replacements > 0) expect(measured.diagnostics.some((item) => item.code === "document/font-replacement-notice")).toBe(true);
      const ignored = measured.glyphs.filter((glyph) => glyph.ignored);
      for (const glyph of ignored) {
        expect([glyph.advance, glyph.ink.width, glyph.ink.height]).toEqual([0, 0, 0]);
      }
      if (text === "⚠️" || text === "👩‍💻") expect(ignored).toHaveLength(1);
      else expect(measured.replacements).toBe(1);
      if (text === "👩‍💻") expect(measured.replacements).toBe(2);
    }
    console.log(`ENGINE_E2_FOUNDATION ${JSON.stringify({ scope: "lazy text metrics only, not scene layout", foundation: foundation.covered, fallbacks: foundation.fallbacks })}`);
    console.log(`ENGINE_E0_WASM ${JSON.stringify(result)}`);
    await test.info().attach("engine-e0-wasm.json", { body: JSON.stringify(result, null, 2), contentType: "application/json" });
  });
});
