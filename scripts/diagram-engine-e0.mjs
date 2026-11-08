// Host-only reproducible E0 build/measurement orchestration. Never imported by the SDK.
import { spawnSync } from "node:child_process";
import { readFileSync, writeFileSync, mkdirSync, existsSync, readdirSync } from "node:fs";
import { resolve, join } from "node:path";
import { gzipSync } from "node:zlib";
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
  const actual = sdkCargo("run", ["--locked", "-p", "maru-diagram-engine", "--features", "typegen", "--bin", "export-types"]);
  const filename = join(sdk, "maru-diagram-engine/bindings/engine.ts");
  if (process.argv.includes("--write")) writeFileSync(filename, actual);
  else if (readFileSync(filename, "utf8") !== actual) throw new Error("Rust/TS engine types drifted; run node scripts/diagram-engine-e0.mjs types --write and commit the generated binding.");
  console.log("E0 Rust-to-TypeScript bindings match");
} else if (action === "wasm") {
  const before = performance.now();
  process.env.MARU_DIAGRAM_ENGINE_REVISION ||= run("git", ["rev-parse", "HEAD:src-tauri/crates"]).trim();
  sdkCargo("build", ["--locked", "--release", "-p", "maru-diagram-engine", "--features", "wasm", "--target", "wasm32-unknown-unknown"]);
  sdkCargo("run", ["--locked", "-p", "maru-diagram-engine", "--features", "bindgen-web", "--bin", "bindgen-web", "--", join(sdk, "target/wasm32-unknown-unknown/release/maru_diagram_engine.wasm"), output]);
  // Build the real browser facade, including generated assets, with Vite's
  // library pipeline. Its output is the artifact the browser measurement loads.
  const { build } = await import("vite");
  const browserOutput = join(scratch, "browser");
  await build({ configFile: false, root, logLevel: "warn", build: {
    outDir: browserOutput, emptyOutDir: true, minify: true,
    lib: { entry: join(root, "src/lib/diagram/engine.ts"), formats: ["es"], fileName: () => "engine-e0.js" },
  } });
  const sizes = readdirSync(browserOutput).filter((name) => name.endsWith(".js")).map((name) => {
    const bytes = readFileSync(join(browserOutput, name));
    return { name, bytes: bytes.length, gzipBytes: gzipSync(bytes, { level: 9 }).length };
  });
  const report = { scope: "actual ES browser library output (Vite retains ES library whitespace), assets inlined, gzip level9 per emitted JS file (both transports included)", buildMs: performance.now() - before, platform: process.platform, arch: process.arch, sizes, gzipBytes: sizes.reduce((sum, file) => sum + file.gzipBytes, 0) };
  writeFileSync(join(scratch, "wasm-build.json"), `${JSON.stringify(report, null, 2)}\n`);
  console.log(`ENGINE_E0_BUILD ${JSON.stringify(report)}`);
} else if (action === "needed") {
  // A shallow PR checkout fetches only its base commit; no history scan/index required.
  const base = process.env.BASE_SHA;
  let needed = true;
  if (base && !/^0+$/.test(base)) {
    if (spawnSync("git", ["cat-file", "-e", `${base}^{commit}`]).status !== 0) run("git", ["fetch", "--no-tags", "--depth=1", "origin", base]);
    const paths = run("git", ["diff", "--name-only", base, "HEAD"]).trim().split("\n");
    needed = paths.some((name) => /^(src-tauri\/crates\/|src-tauri\/src\/diagram_engine_e0\.rs|src\/lib\/nativeE2eBridge\.ts|rust-toolchain\.toml|scripts\/(?:check-diagram-engine|diagram-engine-e0)|src\/lib\/diagram\/engine\.ts|e2e\/engine-e0|e2e-native\/specs\/diagram-engine-e0|\.github\/workflows\/ci.yml)/.test(name));
  }
  if (process.env.GITHUB_OUTPUT) {
    const { appendFileSync } = await import("node:fs"); appendFileSync(process.env.GITHUB_OUTPUT, `needed=${needed}\n`);
  }
  console.log(`E0 selected=${needed}`);
} else if (action === "measurements") {
  if (!existsSync(join(scratch, "wasm-build.json"))) throw new Error("E0 build receipt is missing; run the wasm step on the same runner first.");
  console.log(readFileSync(join(scratch, "wasm-build.json"), "utf8"));
} else throw new Error("Unknown E0 step; choose types, wasm, needed or measurements.");
