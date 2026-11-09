// Host-only actual adapter/lazy-asset measurement. PNG remains in Rust/WASM.
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { extname, join, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { gzipSync } from "node:zlib";
import { chromium } from "@playwright/test";
import { build } from "vite";

const root = resolve(fileURLToPath(new URL("..", import.meta.url)));
const outputDirectory = join(root, ".engine-e0/png-browser");
mkdirSync(outputDirectory, { recursive: true });

await build({
  configFile: false,
  root,
  logLevel: "warn",
  define: { "import.meta.env.VITE_ENGINE_GEOMETRY_TEST": JSON.stringify("1") },
  build: {
    outDir: outputDirectory,
    emptyOutDir: true,
    minify: true,
    lib: {
      entry: join(root, "src/lib/diagram/engineArtifactForTest.ts"),
      formats: ["es"],
      fileName: () => "engine-png-test.js",
    },
  },
});

function measureChunks() {
  return readdirSync(outputDirectory)
    .filter((name) => name.endsWith(".js"))
    .map((name) => {
      const bytes = readFileSync(join(outputDirectory, name));
      return {
        name,
        bytes: bytes.length,
        gzipBytes: gzipSync(bytes, { level: 9 }).length,
      };
    });
}

function serveOutputDirectory() {
  return createServer((request, response) => {
    const url = new URL(request.url ?? "/", "http://localhost");
    if (url.pathname === "/") {
      response.setHeader("Content-Type", "text/html");
      response.end("<!doctype html><meta charset=\"utf-8\"><title>PNG transport probe</title>");
      return;
    }

    const relativePath = url.pathname.slice(1);
    const filename = resolve(outputDirectory, relativePath);
    if (!filename.startsWith(outputDirectory + sep) || !existsSync(filename)) {
      response.statusCode = 404;
      response.end();
      return;
    }

    const extension = extname(filename);
    response.setHeader(
      "Content-Type",
      extension === ".js"
        ? "text/javascript"
        : extension === ".wasm"
          ? "application/wasm"
          : "application/octet-stream",
    );
    response.end(readFileSync(filename));
  });
}

async function listen(server) {
  await new Promise((resolveListen, rejectListen) => {
    server.once("error", rejectListen);
    server.listen(0, "127.0.0.1", () => resolveListen(undefined));
  });
  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error("PNG probe server has no TCP address; bind a local TCP port and retry");
  }
  return address;
}

async function measureInBrowser(page, fixtures) {
  return page.evaluate(async (scenes) => {
    const begin = performance.now();
    const modulePath = "/engine-png-test.js";
    const api = await import(modulePath);
    const imported = performance.now();
    const host = await api.prepareEngineArtifactForTest("png");
    const loaded = performance.now();
    const results = [];

    for (const [name, specJson] of scenes) {
      const request = { specJson, format: "png", theme: "light", pixelRatio: 1 };
      const start = performance.now();
      const first = await api.renderEngineArtifactForTest(request, host);
      const coldMs = performance.now() - start;
      if (!first.ok) throw new Error(JSON.stringify(first.diagnostics));

      const warmMs = [];
      for (let iteration = 0; iteration < 3; iteration += 1) {
        const at = performance.now();
        const repeat = await api.renderEngineArtifactForTest(request, host);
        warmMs.push(performance.now() - at);
        if (!repeat.ok
            || repeat.receipt.outputSha256 !== first.receipt.outputSha256
            || repeat.pixelsSha256 !== first.pixelsSha256) {
          throw new Error("PNG warm repeat mismatch; inspect rasterizer state");
        }
      }

      results.push({
        name,
        width: first.width,
        height: first.height,
        pngBytes: first.bytes.length,
        svgBytes: new TextEncoder().encode(first.svg).length,
        requestBytes: new TextEncoder().encode(JSON.stringify(request)).length,
        responseBytes: new TextEncoder().encode(JSON.stringify(first)).length,
        pngSha256: first.receipt.outputSha256,
        pixelsSha256: first.pixelsSha256,
        svgSha256: first.receipt.engineOutputSha256,
        coldRenderMs: coldMs,
        warmRenderMs: warmMs,
      });
    }

    return {
      adapterImportMs: imported - begin,
      wasmInitMs: loaded - imported,
      coldLoadMs: loaded - begin,
      scenes: results,
    };
  }, fixtures);
}

const chunks = measureChunks();
const typical = readFileSync(
  join(root, "src-tauri/crates/maru-diagram-engine/testdata/valid-architecture.json"),
  "utf8",
);
const dense = readFileSync(
  join(root, "src-tauri/crates/maru-diagram-engine/testdata/bench-1000.json"),
  "utf8",
);
const server = serveOutputDirectory();
let browser;

try {
  const address = await listen(server);
  browser = await chromium.launch({ headless: true });
  const page = await browser.newPage();
  await page.goto(`http://127.0.0.1:${address.port}/`);
  const data = await measureInBrowser(page, [["typical", typical], ["1000", dense]]);
  const wasm = readFileSync(join(
    root,
    "src/lib/diagram/__generated__/engine-png/maru_diagram_engine_bg.wasm",
  ));
  const report = {
    scope: "actual isolated Vite ES adapter; PNG/WASM pinned full fonts; cold import/init followed by source layout+SVG gate+PNG encode+decode+JSON report",
    chunks,
    lazyGzipBytes: chunks.reduce((total, chunk) => total + chunk.gzipBytes, 0),
    wasmBytes: wasm.length,
    wasmGzipBytes: gzipSync(wasm, { level: 9 }).length,
    ...data,
  };
  writeFileSync(
    join(root, ".engine-e0/png-transport.json"),
    `${JSON.stringify(report, null, 2)}\n`,
  );
  console.log(`ENGINE_E3_PNG_MEASURE ${JSON.stringify(report)}`);
} finally {
  await browser?.close();
  await new Promise((resolveClose) => server.close(resolveClose));
  server.closeAllConnections();
}
