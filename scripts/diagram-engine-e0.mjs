// Host-only reproducible E0 build/measurement orchestration. Never imported by the SDK.
import { spawnSync } from "node:child_process";
import { readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { resolve, join } from "node:path";
import { payloadReport } from "./diagram-engine-payload.mjs";
import { fileURLToPath } from "node:url";
const root = resolve(fileURLToPath(new URL("..", import.meta.url)));
const sdk = join(root, "src-tauri/crates");
const output = join(root, "src/lib/diagram/__generated__/engine-e0");
const scratch = join(root, ".engine-e0");
mkdirSync(scratch, { recursive: true });
function run(command, args, options = {}) {
  const result = spawnSync(command, args, { cwd: root, env: { ...process.env, CARGO_BUILD_JOBS: "2" }, encoding: "utf8", stdio: "pipe", ...options });
  if (result.status !== 0) throw new Error(`E0 ${command} failed (${result.status ?? result.error?.message}): ${result.stderr?.trim()}; inspect the SDK toolchain and rerun this step.`);
  return result.stdout;
}
// cargo's manifest option belongs after its subcommand.
function sdkCargo(command, args) { return run("cargo", [command, "--manifest-path", join(sdk, "Cargo.toml"), ...args]); }
const action = process.argv[2];
if (action === "types") {
  const actual = sdkCargo("run", ["--locked", "-p", "maru-diagram-engine", "--features", "typegen,geometry", "--bin", "export-types"]);
  const filename = join(sdk, "maru-diagram-engine/bindings/engine.ts");
  if (process.argv.includes("--write")) writeFileSync(filename, actual);
  else if (readFileSync(filename, "utf8") !== actual) throw new Error("Rust/TS engine types drifted; run node scripts/diagram-engine-e0.mjs types --write and commit the generated binding.");
  console.log("E0 Rust-to-TypeScript bindings match");
} else if (action === "wasm") {
  const before = performance.now();
  process.env.MARU_DIAGRAM_ENGINE_REVISION ||= run("git", ["rev-parse", "HEAD:src-tauri/crates"]).trim();
  sdkCargo("build", ["--locked", "--lib", "--release", "-p", "maru-diagram-engine", "--features", "wasm", "--target", "wasm32-unknown-unknown"]);
  sdkCargo("run", ["--locked", "-p", "maru-diagram-engine", "--features", "bindgen-web", "--bin", "bindgen-web", "--", join(sdk, "target/wasm32-unknown-unknown/release/maru_diagram_engine.wasm"), output]);
  // A second WASM artifact includes metric tables. Only its dynamic TS module
  // references these URLs, so validation cannot inline or fetch them eagerly.
  sdkCargo("build", ["--locked", "--lib", "--release", "-p", "maru-diagram-engine", "--features", "wasm-layout", "--target", "wasm32-unknown-unknown"]);
  sdkCargo("run", ["--locked", "-p", "maru-diagram-engine", "--features", "bindgen-web", "--bin", "bindgen-web", "--", join(sdk, "target/wasm32-unknown-unknown/release/maru_diagram_engine.wasm"), join(root, "src/lib/diagram/__generated__/engine-geometry")]);
  // Corpus hashing belongs only to the dedicated CI test build, never the
  // normal layout artifact whose bytes and cold load the browser measures.
  run(process.execPath, [join(root, "scripts/diagram-engine-e2-wasm-hashes.mjs"), "--assert-product", join(root, "src/lib/diagram/__generated__/engine-geometry")]);
  // E3 SVG is a separate test-only artifact; validation and measured normal geometry stay unchanged.
  sdkCargo("build", ["--locked", "--lib", "--release", "-p", "maru-diagram-engine", "--features", "wasm-render", "--target", "wasm32-unknown-unknown"]);
  sdkCargo("run", ["--locked", "-p", "maru-diagram-engine", "--features", "bindgen-web", "--bin", "bindgen-web", "--", join(sdk, "target/wasm32-unknown-unknown/release/maru_diagram_engine.wasm"), join(root, "src/lib/diagram/__generated__/engine-render")]);
  // Build the real browser facade, including generated assets, with Vite's
  // library pipeline. Its output is the artifact the browser measurement loads.
  const { build } = await import("vite");
  const browserOutput = join(scratch, "browser");
  const built = await build({ configFile: false, root, logLevel: "warn", define: { "import.meta.env.VITE_ENGINE_GEOMETRY_TEST": JSON.stringify("0") }, build: {
    outDir: browserOutput, emptyOutDir: true, minify: true,
    lib: { entry: join(root, "src/lib/diagram/engine.ts"), formats: ["es"], fileName: () => "engine-e0.js" },
  } });
  const outputs = (Array.isArray(built) ? built : [built]).flatMap((result) => {
    if (!("output" in result)) throw new Error("Engine build returned a watcher instead of emitted files; disable watch mode and rebuild the measurement library.");
    return result.output;
  });
  const payload = payloadReport(outputs.filter((item) => item.type === "chunk"));
  if (payload.validationGzipBytes > 400_000) throw new Error(`Validation payload is ${payload.validationGzipBytes} gzip bytes, above 400000; move geometry dependencies behind the lazy boundary before merging.`);
  if (!payload.lazyGeometryGzipBytes) throw new Error("Geometry metric chunk is missing; keep its WASM URLs inside the dynamic engineGeometry module and rebuild.");
  if (outputs.some((chunk) => chunk.type === "chunk" && (chunk.name.includes("engineGeometryCanvas") || chunk.name === "engineSvgForTest"))) throw new Error("Test canvas bridge leaked into the normal product artifact; keep its feature guard false in production.");
  const productBuildMs = performance.now() - before;
  const testBuildStarted = performance.now();
  // A separate isolated test artifact enables the adapter; its bytes are not
  // silently included in or subtracted from the measured normal product graph.
  await build({ configFile: false, root, logLevel: "warn", define: { "import.meta.env.VITE_ENGINE_GEOMETRY_TEST": JSON.stringify("1") }, build: {
    outDir: join(scratch, "browser-test"), emptyOutDir: true, minify: true,
    lib: { entry: join(root, "src/lib/diagram/engine.ts"), formats: ["es"], fileName: () => "engine-e0.js" },
  } });
  const report = { scope: "actual emitted ES graph; validation entry plus static imports, separately lazy geometry metrics and IPC transport; assets inlined; gzip level9 per file", buildMs: productBuildMs, testHarnessBuildMs: performance.now() - testBuildStarted, platform: process.platform, arch: process.arch, ...payload };
  writeFileSync(join(scratch, "wasm-build.json"), `${JSON.stringify(report, null, 2)}\n`);
  console.log(`ENGINE_E0_BUILD ${JSON.stringify(report)}`);
} else if (action === "needed") {
  // A shallow PR checkout fetches only its base commit; no history scan/index required.
  const base = process.env.BASE_SHA;
  let needed = true;
  if (base && !/^0+$/.test(base)) {
    if (spawnSync("git", ["cat-file", "-e", `${base}^{commit}`]).status !== 0) run("git", ["fetch", "--no-tags", "--depth=1", "origin", base]);
    const paths = run("git", ["diff", "--name-only", base, "HEAD"]).trim().split("\n");
    needed = paths.some((name) => /^(src-tauri\/crates\/|src-tauri\/src\/diagram_engine_e0\.rs|src\/lib\/nativeE2eBridge\.ts|rust-toolchain\.toml|scripts\/(?:check-diagram-engine|diagram-engine-e[023]|diagram-engine-payload)|src\/lib\/diagram\/engine(?:Geometry[^/]*|SvgForTest)?\.ts|e2e\/engine-e0|e2e-native\/specs\/diagram-engine-e0|\.github\/workflows\/ci.yml)/.test(name));
  }
  if (process.env.GITHUB_OUTPUT) {
    const { appendFileSync } = await import("node:fs"); appendFileSync(process.env.GITHUB_OUTPUT, `needed=${needed}\n`);
  }
  console.log(`E0 selected=${needed}`);
} else if (action === "measurements") {
  if (!existsSync(join(scratch, "wasm-build.json"))) throw new Error("E0 build receipt is missing; run the wasm step on the same runner first.");
  console.log(readFileSync(join(scratch, "wasm-build.json"), "utf8"));
} else throw new Error("Unknown E0 step; choose types, wasm, needed or measurements.");
