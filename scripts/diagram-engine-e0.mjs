// Host-only reproducible E0 build/measurement orchestration. Never imported by the SDK.
import { spawnSync } from "node:child_process";
import { readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { createHash } from "node:crypto";
import { resolve, join, relative } from "node:path";
import { payloadReport } from "./diagram-engine-payload.mjs";
import {
  canReuseWasmAssets,
  hasDirtySdkInputs,
  makeWasmAssetsManifest,
  WASM_ASSET_OUTPUTS,
} from "./diagram-engine-e0-cache.mjs";
import { isE0SelectedPath } from "./diagram-engine-e0-paths.mjs";
import { fileURLToPath } from "node:url";
const root = resolve(fileURLToPath(new URL("..", import.meta.url)));
const sdk = join(root, "src-tauri/crates");
const output = join(root, "src/lib/diagram/__generated__/engine-e0");
const scratch = join(root, ".engine-e0");
const wasmCacheManifest = join(scratch, "wasm-assets-manifest.json");
const cargoTargetDirectory = process.env.CARGO_TARGET_DIR ? resolve(root, process.env.CARGO_TARGET_DIR) : join(sdk, "target");
const wasmArtifact = join(cargoTargetDirectory, "wasm32-unknown-unknown/release/maru_diagram_engine.wasm");
mkdirSync(scratch, { recursive: true });
function run(command, args, options = {}) {
  const result = spawnSync(command, args, { cwd: root, env: { ...process.env, CARGO_BUILD_JOBS: "2" }, encoding: "utf8", stdio: "pipe", ...options });
  if (result.status !== 0) throw new Error(`E0 ${command} failed (${result.status ?? result.error?.message}): ${result.stderr?.trim()}; inspect the SDK toolchain and rerun this step.`);
  return result.stdout;
}
// cargo's manifest option belongs after its subcommand.
function sdkCargo(command, args) { return run("cargo", [command, "--manifest-path", join(sdk, "Cargo.toml"), ...args]); }
function sha256(bytes) { return createHash("sha256").update(bytes).digest("hex"); }
function optionalFileHash(path) {
  return existsSync(path) ? sha256(readFileSync(path)) : null;
}
function wasmArtifactHashes() {
  const hashes = {};
  for (const path of WASM_ASSET_OUTPUTS) {
    const absolute = join(root, path);
    if (!existsSync(absolute)) return null;
    hashes[path] = optionalFileHash(absolute);
  }
  return hashes;
}
function readManifest() {
  try { return JSON.parse(readFileSync(wasmCacheManifest, "utf8")); }
  catch { return null; }
}
function sdkSnapshot() {
  const trackedChanges = run("git", ["status", "--porcelain", "--untracked-files=no", "--", "src-tauri/crates"]);
  const untrackedFiles = run("git", ["ls-files", "--others", "--exclude-standard", "--directory", "--", "src-tauri/crates"])
    .split("\n").filter(Boolean);
  const targetRelative = relative(root, cargoTargetDirectory).replaceAll("\\", "/");
  return {
    originCommit: run("git", ["rev-parse", "HEAD"]).trim(),
    sdkTree: run("git", ["rev-parse", "HEAD:src-tauri/crates"]).trim(),
    clean: !hasDirtySdkInputs({ trackedChanges, untrackedFiles, targetDirectories: targetRelative.startsWith("../") ? [] : [targetRelative] }),
    untrackedFiles,
  };
}
function buildFingerprint(snapshot, revision) {
  const cargoHome = process.env.CARGO_HOME
    ? resolve(root, process.env.CARGO_HOME)
    : process.env.HOME || process.env.USERPROFILE
      ? join(process.env.HOME || process.env.USERPROFILE, ".cargo")
      : null;
  const buildScripts = [
    "scripts/diagram-engine-e0.mjs",
    "scripts/diagram-engine-e0-cache.mjs",
    "scripts/diagram-engine-e2-wasm-hashes.mjs",
    "rust-toolchain.toml",
    ".cargo/config",
    ".cargo/config.toml",
    "src-tauri/.cargo/config",
    "src-tauri/.cargo/config.toml",
    "src-tauri/crates/.cargo/config",
    "src-tauri/crates/.cargo/config.toml",
    ...(cargoHome ? [join(cargoHome, "config"), join(cargoHome, "config.toml")] : []),
  ].map((path) => ({ path: path.startsWith(root) ? path.slice(root.length + 1) : path, sha256: optionalFileHash(resolve(root, path)) }));
  const envNames = [...new Set([
    "CARGO_BUILD_JOBS", "CARGO_BUILD_TARGET", "CARGO_ENCODED_RUSTFLAGS", "CARGO_PROFILE_RELEASE_CODEGEN_UNITS",
    "CARGO_PROFILE_RELEASE_DEBUG", "CARGO_PROFILE_RELEASE_INCREMENTAL", "CARGO_PROFILE_RELEASE_LTO",
    "CARGO_PROFILE_RELEASE_OPT_LEVEL", "CARGO_PROFILE_RELEASE_OVERFLOW_CHECKS", "CARGO_PROFILE_RELEASE_PANIC",
    "CARGO_PROFILE_RELEASE_SPLIT_DEBUGINFO", "CARGO_PROFILE_RELEASE_STRIP", "CARGO_TARGET_DIR", "CARGO_HOME",
    "CARGO_BUILD_RUSTC", "MARU_DIAGRAM_ENGINE_REVISION", "RUSTFLAGS", "RUSTC", "RUSTC_WRAPPER",
    "RUSTC_WORKSPACE_WRAPPER", "RUSTUP_HOME", "RUSTUP_TOOLCHAIN", "SOURCE_DATE_EPOCH",
    ...Object.keys(process.env).filter((name) => name.startsWith("CARGO_PROFILE_RELEASE_")),
  ])].sort();
  const env = Object.fromEntries(envNames.map((name) => [name, name === "CARGO_BUILD_JOBS" ? "2" : process.env[name] ?? null]));
  const fingerprintInputs = {
    sdkTree: snapshot.sdkTree,
    buildScripts,
    env: { ...env, MARU_DIAGRAM_ENGINE_REVISION: revision },
    toolchain: {
      rustc: run("rustc", ["--version", "--verbose"]).trim(),
      cargo: run("cargo", ["--version"]).trim(),
      node: process.version,
      platform: process.platform,
      arch: process.arch,
      target: "wasm32-unknown-unknown",
      features: ["wasm", "wasm-layout", "wasm-render", "bindgen-web"],
      release: true,
      cargoTargetDirectory,
    },
  };
  return sha256(JSON.stringify(fingerprintInputs));
}
function assetCacheState() {
  const snapshot = sdkSnapshot();
  const revision = process.env.MARU_DIAGRAM_ENGINE_REVISION
    ?? `${snapshot.sdkTree}${snapshot.clean ? "" : "-dirty"}`;
  process.env.MARU_DIAGRAM_ENGINE_REVISION = revision;
  const fingerprint = buildFingerprint(snapshot, revision);
  const manifest = readManifest();
  const artifactHashes = wasmArtifactHashes();
  return {
    snapshot,
    revision,
    fingerprint,
    manifest,
    artifactHashes,
    hit: artifactHashes !== null && canReuseWasmAssets({
      manifest,
      sdkTree: snapshot.sdkTree,
      fingerprint,
      clean: snapshot.clean,
      artifactHashes,
    }),
  };
}
function saveAssetCacheManifest(before) {
  if (!before.snapshot.clean) return false;
  const after = assetCacheState();
  if (!after.snapshot.clean || after.snapshot.sdkTree !== before.snapshot.sdkTree
      || after.fingerprint !== before.fingerprint) {
    throw new Error("The diagram SDK or its build inputs changed while WASM artifacts were being generated; rerun node scripts/diagram-engine-e0.mjs wasm before using the assets.");
  }
  if (!after.artifactHashes) throw new Error("Generated WASM outputs are incomplete; rerun node scripts/diagram-engine-e0.mjs wasm before caching them.");
  const manifest = makeWasmAssetsManifest({
    originCommit: before.snapshot.originCommit,
    sdkTree: before.snapshot.sdkTree,
    fingerprint: before.fingerprint,
    artifactHashes: after.artifactHashes,
  });
  writeFileSync(wasmCacheManifest, `${JSON.stringify(manifest, null, 2)}\n`);
  return true;
}
const action = process.argv[2];
if (action === "types") {
  const actual = sdkCargo("run", ["--locked", "-p", "maru-diagram-engine", "--features", "typegen,geometry", "--bin", "export-types"]);
  const filename = join(sdk, "maru-diagram-engine/bindings/engine.ts");
  if (process.argv.includes("--write")) writeFileSync(filename, actual);
  else if (readFileSync(filename, "utf8") !== actual) throw new Error("Rust/TS engine types drifted; run node scripts/diagram-engine-e0.mjs types --write and commit the generated binding.");
  console.log("E0 Rust-to-TypeScript bindings match");
} else if (action === "wasm") {
  const before = performance.now();
  const cache = assetCacheState();
  const shouldRecordWasmCache = !cache.hit && cache.snapshot.clean;
  if (cache.hit) {
    console.log(`ENGINE_E0_WASM_ASSET_CACHE hit originCommit=${cache.manifest.originCommit} sdkTree=${cache.snapshot.sdkTree}`);
  } else {
    if (!cache.snapshot.clean) {
      console.log(`ENGINE_E0_WASM_ASSET_CACHE bypass dirty SDK inputs; default engine revision=${cache.revision}`);
    }
    sdkCargo("build", ["--locked", "--lib", "--release", "-p", "maru-diagram-engine", "--features", "wasm", "--target", "wasm32-unknown-unknown"]);
    sdkCargo("run", ["--locked", "-p", "maru-diagram-engine", "--features", "bindgen-web", "--bin", "bindgen-web", "--", wasmArtifact, output]);
    // A second WASM artifact includes metric tables. Only its dynamic TS module
    // references these URLs, so validation cannot inline or fetch them eagerly.
    sdkCargo("build", ["--locked", "--lib", "--release", "-p", "maru-diagram-engine", "--features", "wasm-layout", "--target", "wasm32-unknown-unknown"]);
    sdkCargo("run", ["--locked", "-p", "maru-diagram-engine", "--features", "bindgen-web", "--bin", "bindgen-web", "--", wasmArtifact, join(root, "src/lib/diagram/__generated__/engine-geometry")]);
    // Corpus hashing belongs only to the dedicated CI test build, never the
    // normal layout artifact whose bytes and cold load the browser measures.
    sdkCargo("build", ["--locked", "--lib", "--release", "-p", "maru-diagram-engine", "--features", "wasm-render", "--target", "wasm32-unknown-unknown"]);
    sdkCargo("run", ["--locked", "-p", "maru-diagram-engine", "--features", "bindgen-web", "--bin", "bindgen-web", "--", wasmArtifact, join(root, "src/lib/diagram/__generated__/engine-render")]);
  }
  // Verify product isolation after a build or a cache hit.
  run(process.execPath, [join(root, "scripts/diagram-engine-e2-wasm-hashes.mjs"), "--assert-product", join(root, "src/lib/diagram/__generated__/engine-geometry")]);
  if (shouldRecordWasmCache && saveAssetCacheManifest(cache)) {
    console.log(`ENGINE_E0_WASM_ASSET_CACHE recorded originCommit=${cache.snapshot.originCommit} sdkTree=${cache.snapshot.sdkTree}`);
  }
  if (process.argv.includes("--assets-only")) {
    console.log("Generated product validation, layout and text-SVG WebAssembly assets.");
    process.exit(0);
  }
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
    needed = paths.some(isE0SelectedPath);
  }
  if (process.env.GITHUB_OUTPUT) {
    const { appendFileSync } = await import("node:fs"); appendFileSync(process.env.GITHUB_OUTPUT, `needed=${needed}\n`);
  }
  console.log(`E0 selected=${needed}`);
} else if (action === "measurements") {
  if (!existsSync(join(scratch, "wasm-build.json"))) throw new Error("E0 build receipt is missing; run the wasm step on the same runner first.");
  console.log(readFileSync(join(scratch, "wasm-build.json"), "utf8"));
} else throw new Error("Unknown E0 step; choose types, wasm, needed or measurements.");
