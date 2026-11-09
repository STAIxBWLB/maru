// Corpus tooling uses an explicitly test-featured WASM build, separate from the product chunk.
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { resolve, join, dirname } from "node:path";
import { pathToFileURL } from "node:url";

async function run() {
  const args = process.argv.slice(2);
  if (args[0] === "--assert-product" && args.length === 2) {
    const directory = resolve(args[1]);
    const bindings = await import(pathToFileURL(join(directory, "maru_diagram_engine.js")).href);
    const module = await WebAssembly.compile(new Uint8Array(readFileSync(join(directory, "maru_diagram_engine_bg.wasm"))));
    if (["scene_corpus_hashes", "render_scene_svg"].some((name) => name in bindings || WebAssembly.Module.exports(module).some((item) => item.name.includes(name)))) {
      throw new Error("Product geometry WASM exposes corpus tooling; rebuild it with wasm-layout only and without geometry-corpus.");
    }
    console.log("ENGINE_E2_PRODUCT_ISOLATION corpus and SVG tooling absent from product JS and WASM exports");
    return;
  }
  if (args.length < 2 || args.length > 3) throw new Error("Expected corpus, output and optional test-bindings directory, or --assert-product <product-bindings>; supply the checked-in combined corpus and separate generated test bindings.");
  const [corpusPath, outputPath, bindingsDirectory = ".engine-e2/wasm-test"] = args;
  const directory = resolve(bindingsDirectory);
  const bindings = await import(pathToFileURL(join(directory, "maru_diagram_engine.js")).href);
  if (typeof bindings.default !== "function" || typeof bindings.scene_corpus_hashes !== "function") {
    throw new Error("Whole-scene WASM bindings are missing; build wasm-layout,geometry-corpus and generate .engine-e2/wasm-test with bindgen-web.");
  }
  await bindings.default({ module_or_path: readFileSync(join(directory, "maru_diagram_engine_bg.wasm")) });
  const input = new TextDecoder("utf-8", { fatal: true }).decode(readFileSync(resolve(corpusPath)));
  const contents = bindings.scene_corpus_hashes(input);
  if (typeof contents !== "string") throw new Error("WASM scene corpus output is not a JSON string; rebuild the compatible SDK bindings.");
  const report = JSON.parse(contents);
  if (report.error) {
    throw new Error(`${report.error.message ?? "WASM scene hashing failed"}; ${report.error.fix ?? "inspect the SDK diagnostic and regenerate the corpus"}`);
  }
  if (report.apiVersion !== 1 || report.scope !== "whole-scene-geometry" || report.repeatCheck !== true
      || !Array.isArray(report.cases) || report.cases.length !== report.corpusCaseCount || report.cases.length === 0) {
    throw new Error("WASM scene corpus report is incomplete or incompatible; rebuild the test-featured WASM and regenerate the full combined corpus report.");
  }
  const target = resolve(outputPath);
  mkdirSync(dirname(target), { recursive: true });
  writeFileSync(target, contents.endsWith("\n") ? contents : `${contents}\n`);
  console.log(`ENGINE_E2_WASM_HASHES ${JSON.stringify({ scope: report.scope, corpusCaseCount: report.corpusCaseCount, acceptedCaseCount: report.acceptedCaseCount })}`);
}
try { await run(); }
catch (error) {
  console.error(`WASM whole-scene hashing failed: ${error instanceof Error ? error.message : String(error)}; check generated WASM files, corpus input and output permissions, then rerun diagram-engine-e2-wasm-hashes.mjs.`);
  process.exitCode = 1;
}
