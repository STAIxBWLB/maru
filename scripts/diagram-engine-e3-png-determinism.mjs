// Validate pinned PNG receipts across native hosts and the same test-featured WASM build.
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { pathToFileURL, fileURLToPath } from "node:url";

export const REQUIRED_RECEIPTS = ["native-linux", "native-macos", "native-windows", "wasm-linux"];
export const REQUIRED_SCENES = [
  "architecture-light", "architecture-dark",
  "dataflow-light", "dataflow-dark",
  "lifecycle-light", "lifecycle-dark",
  "sequence-light", "sequence-dark",
  "workflow-light", "workflow-dark",
  "bench-1000-light", "bench-1000-dark",
];
const SHA256 = /^[a-f0-9]{64}$/;

function requireHash(value, label, field) {
  if (typeof value !== "string" || !SHA256.test(value)) {
    throw new Error(`${label} has a missing or malformed ${field}; rerun the native or WASM PNG manifest job from the current pinned sources.`);
  }
}

export function parseManifest(contents, label = "PNG report") {
  let report;
  try {
    report = JSON.parse(contents);
  } catch (error) {
    throw new Error(`${label} is not valid JSON: ${error}; rerun its manifest job and preserve the complete output file.`);
  }
  if (report?.error) {
    const cause = report.error.message ?? "WASM PNG corpus generation failed";
    const fix = report.error.fix ?? "inspect the engine diagnostic and rebuild the matching test-featured WASM";
    throw new Error(`${label} failed: ${cause}; ${fix}`);
  }
  validateManifest(report, label);
  return report;
}

export function validateManifest(report, label = "PNG report") {
  if (!report || report.schemaVersion !== 1 || report.scope !== "pinned-png-raster-determinism") {
    throw new Error(`${label} has an unsupported or missing PNG manifest contract; regenerate it with the E3 PNG harness.`);
  }
  if (report.sceneCount !== REQUIRED_SCENES.length || !Array.isArray(report.scenes) || report.scenes.length !== REQUIRED_SCENES.length) {
    throw new Error(`${label} has ${report?.scenes?.length ?? 0} scene records, expected ${REQUIRED_SCENES.length}; regenerate all five fixtures in both themes and the 1000-node scene.`);
  }
  const pins = report.fontPin;
  for (const weight of ["400", "700"]) {
    const pin = pins?.[weight];
    if (!pin || pin.weight !== Number(weight) || typeof pin.id !== "string" || !pin.id || typeof pin.revision !== "string" || !pin.revision) {
      throw new Error(`${label} has no pinned font identity for weight ${weight}; repair the metrics font pin before rasterizing.`);
    }
    requireHash(pin.fontSha256, label, `fontPin.${weight}.fontSha256`);
  }
  const names = report.scenes.map((scene) => scene?.name);
  if (names.some((name) => typeof name !== "string") || new Set(names).size !== names.length) {
    throw new Error(`${label} contains a missing or duplicate scene name; restore the fixed 12-scene manifest order.`);
  }
  for (let index = 0; index < REQUIRED_SCENES.length; index += 1) {
    const scene = report.scenes[index];
    const expected = REQUIRED_SCENES[index];
    if (scene.name !== expected || scene.theme !== expected.slice(expected.lastIndexOf("-") + 1)) {
      throw new Error(`${label} scene ${index + 1} is ${scene.name ?? "unnamed"}, expected ${expected}; regenerate records in canonical fixture/theme order.`);
    }
    requireHash(scene.sceneInputSha256, label, `${expected}.sceneInputSha256`);
    requireHash(scene.pngSha256, label, `${expected}.pngSha256`);
    requireHash(scene.pixelsSha256, label, `${expected}.pixelsSha256`);
    requireHash(scene.svgSha256, label, `${expected}.svgSha256`);
    if (scene.repeatByteEqual !== true) {
      throw new Error(`${label} ${expected} did not reproduce identical PNG bytes; inspect the rasterizer/font state and rerun after fixing nondeterministic input.`);
    }
    if (!Number.isSafeInteger(scene.pngBytes) || scene.pngBytes <= 0
        || !Number.isSafeInteger(scene.width) || scene.width <= 0
        || !Number.isSafeInteger(scene.height) || scene.height <= 0) {
      throw new Error(`${label} ${expected} has invalid PNG byte count or dimensions; rerun the bounded rasterizer and inspect its diagnostic.`);
    }
  }
}

export function compareManifests(manifests, labels = REQUIRED_RECEIPTS) {
  if (!Array.isArray(manifests) || manifests.length !== REQUIRED_RECEIPTS.length) {
    throw new Error(`Expected four PNG receipts (three native and WASM), found ${manifests?.length ?? 0}; inspect workflow artifacts and rerun each missing platform.`);
  }
  if (!Array.isArray(labels) || labels.length !== REQUIRED_RECEIPTS.length
      || new Set(labels).size !== REQUIRED_RECEIPTS.length
      || REQUIRED_RECEIPTS.some((label) => !labels.includes(label))) {
    throw new Error("PNG receipt provenance is incomplete; provide native-linux, native-macos, native-windows, and wasm-linux reports.");
  }
  manifests.forEach((report, index) => validateManifest(report, labels[index]));
  const baseline = manifests[0];
  for (let reportIndex = 1; reportIndex < manifests.length; reportIndex += 1) {
    const candidate = manifests[reportIndex];
    for (const weight of ["400", "700"]) {
      if (JSON.stringify(candidate.fontPin[weight]) !== JSON.stringify(baseline.fontPin[weight])) {
        throw new Error(`Pinned font identity differs between ${labels[0]} and ${labels[reportIndex]} at weight ${weight}; compare metric pins and regenerate all four reports from the same revision.`);
      }
    }
    for (let sceneIndex = 0; sceneIndex < REQUIRED_SCENES.length; sceneIndex += 1) {
      const expected = baseline.scenes[sceneIndex];
      const actual = candidate.scenes[sceneIndex];
      for (const field of ["sceneInputSha256", "pngSha256", "pixelsSha256", "svgSha256", "pngBytes", "width", "height", "repeatByteEqual"]) {
        if (expected[field] !== actual[field]) {
          throw new Error(`PNG determinism differs at ${expected.name}.${field} between ${labels[0]} and ${labels[reportIndex]}; compare pinned fonts, SVG output, fixed arithmetic, and rasterizer behavior, then regenerate all four reports. No image tolerance is applied.`);
        }
      }
    }
  }
  return REQUIRED_SCENES.length;
}

function reportFiles(directory) {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name);
    return entry.isDirectory() ? reportFiles(path) : entry.name.endsWith(".json") ? [path] : [];
  });
}

async function writeWasmReport(outputPath, bindingsDirectory) {
  const bindingsPath = resolve(bindingsDirectory);
  let bindings;
  try {
    bindings = await import(pathToFileURL(join(bindingsPath, "maru_diagram_engine.js")).href);
  } catch (error) {
    throw new Error(`Cannot import test-featured WASM PNG bindings from ${bindingsPath}: ${error}; build wasm-png and generate the separate bindgen test directory.`);
  }
  if (typeof bindings.default !== "function" || typeof bindings.png_corpus_manifest !== "function") {
    throw new Error("WASM PNG manifest export is missing; rebuild the test-featured wasm-png artifact and regenerate its bindings.");
  }
  await bindings.default({ module_or_path: readFileSync(join(bindingsPath, "maru_diagram_engine_bg.wasm")) });
  const contents = bindings.png_corpus_manifest();
  if (typeof contents !== "string") {
    throw new Error("WASM PNG manifest export did not return JSON text; align the wrapper with the PNG corpus API and rebuild.");
  }
  const report = parseManifest(contents, "WASM PNG report");
  const output = resolve(outputPath);
  mkdirSync(dirname(output), { recursive: true });
  writeFileSync(output, `${JSON.stringify(report)}\n`);
  console.log(`ENGINE_E3_PNG_WASM ${JSON.stringify({ scenes: report.sceneCount, report: output })}`);
}

async function run() {
  const args = process.argv.slice(2);
  if (args[0] === "--wasm" && args.length === 3) {
    await writeWasmReport(args[1], args[2]);
    return;
  }
  if (args.length > 1) throw new Error("Usage: node diagram-engine-e3-png-determinism.mjs [REPORT_DIR], or --wasm OUTPUT_JSON BINDINGS_DIR; provide the four matrix manifests or the generated WASM test bindings.");
  const directory = resolve(args[0] ?? ".engine-e3/png");
  let files;
  try {
    files = reportFiles(directory).sort();
  } catch (error) {
    throw new Error(`Cannot read PNG receipts in ${directory}: ${error}; download all three native and the WASM manifest artifacts.`);
  }
  const labels = files.map((filename) => filename.split(/[\\/]/).at(-1)?.replace(/\.json$/, ""));
  const manifests = files.map((filename, index) => {
    try {
      return parseManifest(readFileSync(filename, "utf8"), labels[index] ?? filename);
    } catch (error) {
      throw new Error(`${filename}: ${error instanceof Error ? error.message : String(error)}`);
    }
  });
  const sceneCount = compareManifests(manifests, labels);
  console.log(`PNG determinism PASS: ${sceneCount} pinned scenes are byte-identical across native Linux/macOS/Windows and WASM, with identical decoded RGBA pixel hashes.`);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  run().catch((error) => {
    console.error(`PNG determinism comparison failed: ${error instanceof Error ? error.message : String(error)}; resolve the stated cause before accepting cross-platform raster output.`);
    process.exitCode = 1;
  });
}
