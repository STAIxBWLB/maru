// Independent validator measurement: no Node engine host override is installed on this page.
import { test, expect, type Browser } from "@playwright/test";
import { readFileSync, readdirSync, realpathSync } from "node:fs";
import { createServer } from "node:http";
import { dirname, join, resolve } from "node:path";

/** Read-only loopback fixture: exact emitted bytes, with no Vite rewriting. */
async function startEngineArtifactServer(directory: string) {
  const prefix = "/.engine-e0/browser/";
  const files = new Map<string, { body: Buffer; contentType: string }>();
  const byteLengths: Record<string, number> = {};
  try {
    const root = realpathSync(resolve(directory));
    for (const entry of readdirSync(root, { withFileTypes: true })) {
      if (!entry.isFile() || !/^[A-Za-z0-9._-]+[.](?:js|wasm)$/.test(entry.name)) continue;
      const filename = realpathSync(join(root, entry.name));
      if (dirname(filename) !== root) continue;
      const body = readFileSync(filename);
      files.set(entry.name, { body, contentType: entry.name.endsWith(".wasm") ? "application/wasm" : "application/javascript; charset=utf-8" });
      byteLengths[entry.name] = body.byteLength;
    }
  } catch (error) {
    throw new Error(`Cannot read the emitted engine artifacts: ${error instanceof Error ? error.message : String(error)}; run node scripts/diagram-engine-e0.mjs wasm and check artifact file permissions before the probe.`);
  }
  if (!files.has("engine-e0.js")) throw new Error("The emitted engine measurement entry is missing; run node scripts/diagram-engine-e0.mjs wasm before the Chromium probe.");
  const blank = Buffer.from('<!doctype html><html><head><meta charset="utf-8"><title>Engine artifact measurement</title></head><body></body></html>');
  let origin = "http://127.0.0.1";
  const server = createServer((request, response) => {
    const reply = (status: number, body: Buffer, contentType: string) => {
      response.writeHead(status, { "Content-Type": contentType, "Content-Length": body.byteLength, "Content-Encoding": "identity", "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff" });
      response.end(request.method === "HEAD" ? undefined : body);
    };
    if (request.method !== "GET" && request.method !== "HEAD") {
      reply(405, Buffer.from("Measurement assets are read-only; use GET or HEAD for an emitted file."), "text/plain; charset=utf-8");
      return;
    }
    let url: URL;
    try { url = new URL(request.url ?? "/", origin); }
    catch {
      reply(400, Buffer.from("The measurement URL is invalid; request the blank page or an emitted asset basename."), "text/plain; charset=utf-8");
      return;
    }
    if (url.origin === origin && url.pathname === "/") { reply(200, blank, "text/html; charset=utf-8"); return; }
    const basename = url.pathname.startsWith(prefix) ? url.pathname.slice(prefix.length) : "";
    const file = /^[A-Za-z0-9._-]+[.](?:js|wasm)$/.test(basename) ? files.get(basename) : undefined;
    if (url.origin !== origin || !file) {
      reply(404, Buffer.from("The emitted measurement asset is unavailable; rebuild engine-e0 wasm and request a whitelisted artifact basename."), "text/plain; charset=utf-8");
      return;
    }
    reply(200, file.body, file.contentType);
  });
  await new Promise<void>((ready, reject) => {
    server.once("error", (error) => reject(new Error(`Cannot start the isolated artifact server: ${error.message}; release local test ports or file handles and rerun the probe.`)));
    server.listen(0, "127.0.0.1", ready);
  });
  const address = server.address();
  if (!address || typeof address === "string") {
    await new Promise<void>((closed) => { server.close(() => closed()); server.closeAllConnections(); });
    throw new Error("The isolated artifact server did not acquire an IP port; restart the Chromium probe with an available loopback socket.");
  }
  origin = `http://127.0.0.1:${address.port}`;
  return {
    origin, byteLengths,
    close: () => new Promise<void>((closed, reject) => {
      server.close((error) => error ? reject(new Error(`Cannot close the isolated artifact server: ${error.message}; stop this test server before rerunning the probe.`)) : closed());
      server.closeAllConnections();
    }),
  };
}

const enabled = process.env.MARU_ENGINE_E0 === "1";
test.describe("independent engine WebAssembly spike", () => {
  // A timing regression must fail the gate instead of passing on a retry.
  test.describe.configure({ retries: 0 });
  test.skip(!enabled, "Build the isolated WASM spike with node scripts/diagram-engine-e0.mjs wasm and set MARU_ENGINE_E0=1.");
  test("lays out all families repeatably and retains pins in actual lazy WASM", async ({ page }) => {
    const specs = ["architecture", "workflow", "sequence", "dataflow", "lifecycle"].map((kind) => JSON.parse(readFileSync(`src-tauri/crates/maru-diagram-engine/testdata/valid-${kind}.json`, "utf8")) as { diagram_type: string; schema_version: number; meta: { title: string } });
    specs.push({ ...specs[1]!, schema_version: 2 }, { ...specs[4]!, schema_version: 2 });
    const blockedSpec = JSON.parse(readFileSync("src-tauri/crates/maru-diagram-engine/testdata/partial-route.json", "utf8"));
    await page.goto("/");
    const proof = await page.evaluate(async ({ specs, blockedSpec }) => {
      type Scene = { nodes: Array<{ id: string; bounds: { x: number; y: number }; positionSource: string }>; routes: Array<{ id?: string; points: Array<{ x: number; y: number }> }>; labels: unknown[]; page: { contentOffset?: { x: number; y: number } | null } };
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
        // A pin is an authored source position while the scene is emitted below
        // the page's header band, so convert through `page.contentOffset`
        // instead of writing the emitted canvas position back (maru#561).
        const offset = first.geometry.page.contentOffset ?? { x: 0, y: 0 };
        const pin = { x: selected.bounds.x - offset.x, y: selected.bounds.y - offset.y };
        const edited = structuredClone(spec); edited.meta.title = "Unrelated title edit";
        const retained = engine.layout({ specJson: JSON.stringify(edited), pinSet: { sourceSpecSha256: first.receipt.inputSpecSha256, pins: [{ targetId: selected.id, targetKind: "node", position: pin }] } });
        if (!retained.ok || !retained.geometry) throw new Error(`Pinned scene failed: ${JSON.stringify(retained.diagnostics)}; inspect pin resolution before changing the fixture.`);
        const node = retained.geometry.nodes.find((node) => node.id === selected.id)!;
        const after = retained.geometry.page.contentOffset ?? { x: 0, y: 0 };
        if (node.bounds.x !== pin.x + after.x || node.bounds.y !== pin.y + after.y || node.positionSource !== "plannedPin") throw new Error("A surviving member pin moved after an unrelated edit; repair pin precedence.");
        const orthogonal = retained.geometry.routes.every((route) => route.points.every((point, index, points) => index === 0 || point.x === points[index - 1]!.x || point.y === points[index - 1]!.y));
        proof.push({ type: spec.diagram_type, version: spec.schema_version, nodes: retained.geometry.nodes.length, routes: retained.geometry.routes.length, orthogonal, offsetY: offset.y, pinY: pin.y });
      }
      const invalid = engine.layout({ specJson: "[]" });
      if (invalid.ok || invalid.geometry) throw new Error("Invalid spec returned scene geometry; keep the E1 gate before placement.");
      const partial = engine.layout({ specJson: JSON.stringify(blockedSpec) });
      if (partial.ok || !partial.geometry || partial.geometry.nodes.length !== 5 || partial.diagnostics.length !== 2
          || partial.diagnostics[0]!.path !== "/connections/0"
          || partial.diagnostics[1]!.code !== "architecture/geometry-node-overlap"
          || partial.diagnostics[1]!.path !== "/components/2"
          || partial.geometry.routes.find((edge) => edge.id === "blocked")?.points.length !== 0
          || (partial.geometry.routes.find((edge) => edge.id === "clear")?.points.length ?? 0) < 2) {
        throw new Error("An unroutable edge erased placed geometry or stopped a clear edge; preserve partial scenes, one edge diagnostic and the overlapping-wall diagnostic.");
      }
      return proof;
    }, { specs, blockedSpec });
    expect(proof).toHaveLength(7);
    expect(proof.every((item) => item.nodes > 0 && item.orthogonal)).toBe(true);
    console.log(`ENGINE_E2_LAYOUT ${JSON.stringify({ scope: "functional lazy WASM scene/pin/repeat proof, no performance claim", proof })}`);
  });
  test("measures production lazy load and 1000-node layout with real routed edges", async ({ playwright, browserName }) => {
    test.setTimeout(180_000);
    test.skip(browserName !== "chromium", "Cold-load proof uses Chromium cache control; run this measurement with the Chromium project.");
    const benchmark = JSON.parse(readFileSync("src-tauri/crates/maru-diagram-engine/testdata/bench-1000.json", "utf8")) as {
      components: Array<{ label: string }>; connections: unknown[]; meta: Record<string, unknown>;
    };
    benchmark.meta.viewBox = [5000, 16000];
    benchmark.meta.title = "Geometry 1000-node routed chain";
    const artifactServer = await startEngineArtifactServer(".engine-e0/browser");
    let coldBrowser: Browser | undefined;
    try {
      // A separate process avoids reusing V8's compiled WASM from the earlier
      // functional probe; browser startup itself stays outside the interval.
      coldBrowser = await playwright.chromium.launch();
      const page = await coldBrowser.newPage();
      const cdp = await page.context().newCDPSession(page);
      await cdp.send("Network.enable");
      await cdp.send("Network.setCacheDisabled", { cacheDisabled: true });
      await page.goto(artifactServer.origin);
      const measured = await page.evaluate(async (spec) => {
        type Point = { x: number; y: number };
        type Report = { ok: boolean; diagnostics: Array<{ code: string; message: string; fix: string }>; geometry?: { nodes: unknown[]; routes: Array<{ points: Point[] }> } };
        const modulePath = "/.engine-e0/browser/engine-e0.js";
        const entry = await import(/* @vite-ignore */ modulePath) as {
          loadGeometryEngine(): Promise<{ layout(input: { specJson: string }): Report }>;
        };
        const before = performance.getEntriesByType("resource").filter((item) => item.name.startsWith(`${location.origin}/.engine-e0/browser/`) && item.name.includes("engineGeometry"));
        if (before.length !== 0) throw new Error("Geometry was already loaded before the cold interval; preserve the lazy boundary and use a fresh measurement page.");
        performance.clearResourceTimings();
        const coldStart = performance.now();
        const engine = await entry.loadGeometryEngine();
        const coldLoadMs = performance.now() - coldStart;
        const resources = (performance.getEntriesByType("resource") as PerformanceResourceTiming[])
          .filter((item) => item.name.startsWith(`${location.origin}/.engine-e0/browser/`) && item.name.includes("engineGeometry"))
          .map((item) => ({ path: new URL(item.name).pathname, durationMs: item.duration, transferBytes: item.transferSize, encodedBodyBytes: item.encodedBodySize, decodedBodyBytes: item.decodedBodySize }));
        // No external fonts, Node oracle or corpus-harness WASM export is loaded by this
        // production factory. The cold interval includes module fetch/parse and
        // WASM compile/instantiate, but excludes first text/layout initialization.
        const input = { specJson: JSON.stringify(spec) };
        const firstStart = performance.now();
        const first = engine.layout(input);
        const firstLayoutMs = performance.now() - firstStart;
        const check = (report: Report, count = 1000) => {
          if (!report.ok || !report.geometry) throw new Error(`The routed benchmark was refused: ${JSON.stringify(report.diagnostics)}; fix the geometry fixture or engine before reporting latency.`);
          if (report.geometry.nodes.length !== count || report.geometry.routes.length !== count - 1
              || report.geometry.routes.some((route) => route.points.length < 2
                || route.points.some((point, index, points) => index > 0 && point.x !== points[index - 1]!.x && point.y !== points[index - 1]!.y))) {
            throw new Error("The layout benchmark omitted nodes, routes or orthogonal geometry; restore every node and relationship in the measured chain before measuring.");
          }
        };
        check(first);
        const durationsMs = [];
        for (let index = 0; index < 20; index += 1) {
          const started = performance.now();
          const report = engine.layout(input);
          durationsMs.push(performance.now() - started);
          check(report);
        }
        const sorted = [...durationsMs].sort((a, b) => a - b);
        const medianMs = (sorted[9]! + sorted[10]!) / 2;
        const p95Ms = sorted[Math.ceil(sorted.length * 0.95) - 1]!;
        const typicalSamples = [];
        for (const count of [50, 200]) {
          const smallSpec = { ...spec, components: spec.components.slice(0, count), connections: spec.connections.slice(0, count - 1) };
          const smallInput = { specJson: JSON.stringify(smallSpec) };
          check(engine.layout(smallInput), count);
          const samples = [];
          for (let index = 0; index < 20; index += 1) {
            const started = performance.now();
            const report = engine.layout(smallInput);
            samples.push(performance.now() - started);
            check(report, count);
          }
          const ordered = [...samples].sort((a, b) => a - b);
          typicalSamples.push({ nodes: count, edges: count - 1, durationsMs: samples,
            medianMs: (ordered[9]! + ordered[10]!) / 2,
            p95Ms: ordered[Math.ceil(ordered.length * 0.95) - 1]!, maxMs: ordered.at(-1)! });
        }
        return {
          cold: { scope: "fresh Chromium process; exact emitted production entry already imported; cache-disabled geometry artifact HTTP fetch/parse plus bindings import and WASM compile/instantiate; no Vite transform or first layout in interval", network: "same-origin loopback Node HTTP server; exact emitted artifact bytes, identity transfer without gzip or rewriting, no artificial throttling", coldLoadMs, resources },
          layout: { scope: "production wasm-layout; pre-serialized request; facade request serialization, layout+routing and scene JSON parse; validation included; 20 warm samples after one first layout", nodes: 1000, edges: 999, firstLayoutMs, durationsMs, medianMs, p95Ms, maxMs: sorted[sorted.length - 1]!, targetMs: 200, targetMet: p95Ms < 200, targetScope: "E4 requirement before the canvas switch", budgetMs: 400, budgetMet: p95Ms < 400, typicalSamples },
        };
      }, benchmark);
      await cdp.detach();
      expect(measured.cold.resources.length).toBeGreaterThan(0);
      expect(measured.cold.resources.some((item) => item.transferBytes > 0 && item.decodedBodyBytes > 0), "The supposedly cold geometry chunk was not fetched; disable browser cache and rerun the isolated Chromium measurement").toBe(true);
      expect(Number.isFinite(measured.cold.coldLoadMs) && measured.cold.coldLoadMs >= 0).toBe(true);
      expect(measured.layout.durationsMs).toHaveLength(20);
      expect(measured.layout.durationsMs.every((duration) => Number.isFinite(duration) && duration >= 0)).toBe(true);
      const resources = measured.cold.resources.map((resource) => {
        const name = resource.path.split("/").at(-1)!;
        const emittedFileBytes = artifactServer.byteLengths[name];
        expect(emittedFileBytes, `Geometry response ${name} was not an emitted artifact; serve only the compiled output before measuring cold load`).toBeGreaterThan(0);
        expect(resource.decodedBodyBytes, `Geometry response ${name} was rewritten; serve the exact emitted bytes rather than a Vite transform`).toBe(emittedFileBytes);
        expect(resource.encodedBodyBytes, `Geometry response ${name} was not identity encoded; disable compression on the isolated artifact server`).toBe(emittedFileBytes);
        return { ...resource, emittedFileBytes };
      });
      const receipt = { ...measured, cold: { ...measured.cold, resources } };
      // Keep the owner-approved 400ms E2 budget status in the performance
      // receipt; the sub-200ms E4 target remains separately reported.
      console.log(`ENGINE_E2_COLD ${JSON.stringify(receipt.cold)}`);
      console.log(`ENGINE_E2_PERF ${JSON.stringify(measured.layout)}`);
      await test.info().attach("engine-e2-performance.json", { body: JSON.stringify(receipt, null, 2), contentType: "application/json" });
      expect(measured.layout.typicalSamples.map((sample) => sample.nodes)).toEqual([50, 200]);
    } finally {
      try { await coldBrowser?.close(); } finally { await artifactServer.close(); }
    }
  });

  test("uses explicit current canvas pins and consumes engine geometry in an isolated preview", async ({ page }) => {
    const spec = JSON.parse(readFileSync("src-tauri/crates/maru-diagram-engine/testdata/valid-architecture.json", "utf8"));
    spec.meta.viewBox = [1400, 900];
    await page.goto("/");
    const proof = await page.evaluate(async (spec) => {
      type Box = { id: string; sourceId: string; x: number; y: number; w: number; h: number };
      type Preview = { report: { ok: boolean; diagnostics: unknown[] }; nodes: Box[]; containers: Box[]; labels: Box[]; routes: Array<{ id: string; points: Array<{ x: number; y: number }> }>; page: { x: number; y: number; w: number; h: number } | null };
      const testModulePath = "/.engine-e0/browser-test/engine-e0.js";
      let entry: { loadGeometryEngine(): Promise<{ layoutCanvasForTest(doc: unknown, dataset: string): Promise<Preview> }> };
      try { entry = await import(/* @vite-ignore */ testModulePath); }
      catch { throw new Error("The isolated canvas test library is missing; rebuild engine-e0 browser-test with VITE_ENGINE_GEOMETRY_TEST=1 before running this probe."); }
      const engine = await entry.loadGeometryEngine();
      const dataset = { id: "adapter", kind: "semanticSpec", name: "Adapter fixture", diagramType: "architecture", engine: { name: "archify", version: "3.0.0" }, spec, idMap: { a: "canvas-a", b: "canvas-b" } };
      const other = { ...structuredClone(dataset), id: "other", idMap: { a: "other-a", b: "other-b" } };
      const doc = {
        v: 9, id: "isolated-canvas", docTitle: "Isolated preview", createdAt: 1, updatedAt: 1, edges: [], layers: [], datasets: [dataset, other],
        nodes: [
          { id: "canvas-a", kind: "simple", x: 620.25, y: 300.5, w: 180, h: 72, meta: { memberId: "adapter:m0", pinned: true } },
          { id: "canvas-b", kind: "simple", x: -50, y: -50, w: 180, h: 72, meta: { memberId: "adapter:m1" } },
          { id: "other-a", kind: "simple", x: 1200, y: 300, w: 180, h: 72, meta: { memberId: "other:m0", pinned: true } },
        ],
      };
      const saved = JSON.stringify(doc);
      const first = await engine.layoutCanvasForTest(doc, "adapter");
      if (!first.report.ok || !first.page) throw new Error(`Engine canvas preview failed: ${JSON.stringify(first.report.diagnostics)}; repair the isolated adapter fixture or engine.`);
      if (JSON.stringify(doc) !== saved) throw new Error("Engine canvas preview mutated the document; keep the test adapter read-only and outside history/apply paths.");
      const pinned = first.nodes.find((node) => node.sourceId === "a");
      const automatic = first.nodes.find((node) => node.sourceId === "b");
      if (!pinned || pinned.id !== "canvas-a" || pinned.x !== 620.25 || pinned.y !== 300.5
          || !automatic || automatic.id !== "canvas-b" || automatic.x === -50 || automatic.y === -50
          || first.nodes.length !== 2) {
        throw new Error("The adapter used stale, automatic or other-dataset positions as pins; bind only explicit current canvas members and divide engine coordinates by 64.");
      }
      dataset.spec.meta.title = "Unrelated edited title";
      const editedSnapshot = JSON.stringify(doc);
      const edited = await engine.layoutCanvasForTest(doc, "adapter");
      const retained = edited.nodes.find((node) => node.sourceId === "a");
      if (!edited.report.ok || retained?.x !== pinned.x || retained.y !== pinned.y || JSON.stringify(doc) !== editedSnapshot) {
        throw new Error("An unrelated spec edit moved the current canvas pin or mutated the document; repair adapter member identity and pin precedence.");
      }
      const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
      svg.setAttribute("data-testid", "engine-geometry-test-canvas");
      svg.setAttribute("viewBox", `${first.page.x} ${first.page.y} ${first.page.w} ${first.page.h}`);
      for (const route of first.routes) {
        const path = document.createElementNS("http://www.w3.org/2000/svg", "path");
        path.setAttribute("data-engine-route", route.id);
        path.setAttribute("d", route.points.map((point, index) => `${index ? "L" : "M"}${point.x} ${point.y}`).join(" "));
        path.setAttribute("fill", "none"); path.setAttribute("stroke", "black"); svg.append(path);
      }
      for (const node of first.nodes) {
        const rect = document.createElementNS("http://www.w3.org/2000/svg", "rect");
        rect.setAttribute("data-engine-source", node.sourceId); rect.setAttribute("data-canvas-node", node.id);
        rect.setAttribute("x", String(node.x)); rect.setAttribute("y", String(node.y)); rect.setAttribute("width", String(node.w)); rect.setAttribute("height", String(node.h));
        rect.setAttribute("fill", "none"); rect.setAttribute("stroke", "black"); svg.append(rect);
      }
      document.body.append(svg);
      return { nodes: first.nodes.length, routedEdges: first.routes.filter((route) => route.points.length >= 2).length, pinnedSource: pinned.sourceId, x: svg.querySelector('rect[data-engine-source="a"]')?.getAttribute("x"), y: svg.querySelector('rect[data-engine-source="a"]')?.getAttribute("y"), retained: retained?.x === pinned.x && retained.y === pinned.y, mutationFree: true, scope: "test-only coordinate preview, not DiagramMode/history or the E3 artifact renderer" };
    }, spec);
    expect(proof.nodes).toBe(2);
    expect(proof.routedEdges).toBeGreaterThan(0);
    expect([proof.x, proof.y]).toEqual(["620.25", "300.5"]);
    expect(proof.retained && proof.mutationFree).toBe(true);
    await expect(page.getByTestId("engine-geometry-test-canvas")).toBeAttached();
    console.log(`ENGINE_E2_CANVAS ${JSON.stringify(proof)}`);
    await test.info().attach("engine-e2-canvas.json", { body: JSON.stringify(proof, null, 2), contentType: "application/json" });
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
