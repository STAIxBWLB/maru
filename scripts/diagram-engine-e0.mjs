// Host-only reproducible E0 build/measurement orchestration. Never imported by the SDK.
import { spawnSync } from "node:child_process";
import { readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
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
  if (result.status !== 0) throw new Error(`E0 ${command} failed (${result.status ?? result.error?.code}): ${result.stderr?.trim()}; inspect the SDK toolchain and rerun this step.`);
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
  process.env.MARU_DIAGRAM_ENGINE_REVISION = run("git", ["rev-parse", "HEAD:src-tauri/crates"]).trim();
  sdkCargo("build", ["--locked", "--release", "-p", "maru-diagram-engine", "--features", "wasm", "--target", "wasm32-unknown-unknown"]);
  sdkCargo("run", ["--locked", "-p", "maru-diagram-engine", "--features", "bindgen-web", "--bin", "bindgen-web", "--", join(sdk, "target/wasm32-unknown-unknown/release/maru_diagram_engine.wasm"), output]);
  const files = ["maru_diagram_engine.js", "maru_diagram_engine_bg.wasm"];
  const sizes = files.map((name) => { const bytes = readFileSync(join(output, name)); return { name, bytes: bytes.length, gzipBytes: gzipSync(bytes, { level: 9 }).length }; });
  // The facade is delivered as part of the host's existing Vite chunk. Include its source
  // gzip as a conservative separately-attributed cost; browser harness measures real load.
  const facade = readFileSync(join(root, "src/lib/diagram/engine.ts"));
  sizes.push({ name: "host-facade-source", bytes: facade.length, gzipBytes: gzipSync(facade, { level: 9 }).length });
  const report = { scope: "release wasm + generated web JS + facade source, gzip level9, additive files", buildMs: performance.now() - before, platform: process.platform, arch: process.arch, sizes, gzipBytes: sizes.reduce((sum, file) => sum + file.gzipBytes, 0) };
  writeFileSync(join(scratch, "wasm-build.json"), `${JSON.stringify(report, null, 2)}\n`);
  console.log(`ENGINE_E0_BUILD ${JSON.stringify(report)}`);
} else if (action === "needed") {
  // A shallow PR checkout fetches only its base commit; no history scan/index required.
  const base = process.env.BASE_SHA;
  let needed = true;
  if (base && !/^0+$/.test(base)) {
    if (spawnSync("git", ["cat-file", "-e", `${base}^{commit}`]).status !== 0) run("git", ["fetch", "--no-tags", "--depth=1", "origin", base]);
    const paths = run("git", ["diff", "--name-only", base, "HEAD"]).trim().split("\n");
    needed = paths.some((name) => /^(src-tauri\/crates\/|scripts\/(?:check-diagram-engine|diagram-engine-e0)|src\/lib\/diagram\/engine\.ts|e2e\/engine-e0|e2e-native\/specs\/diagram-engine-e0|\.github\/workflows\/ci.yml)/.test(name));
  }
  if (process.env.GITHUB_OUTPUT) {
    const { appendFileSync } = await import("node:fs"); appendFileSync(process.env.GITHUB_OUTPUT, `needed=${needed}\n`);
  }
  console.log(`E0 selected=${needed}`);
} else if (action === "measurements") {
  if (!existsSync(join(scratch, "wasm-build.json"))) throw new Error("E0 build receipt is missing; run the wasm step on the same runner first.");
  console.log(readFileSync(join(scratch, "wasm-build.json"), "utf8"));
} else throw new Error("Unknown E0 step; choose types, wasm, needed or measurements.");
