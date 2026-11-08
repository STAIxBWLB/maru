// Font input binaries are fetched/parsed only by the remote Linux toolchain.
// Only the derived integer tables, provenance manifest and OFL notices are
// checked in. This script never installs or queries a system font.
import { readFileSync, mkdirSync, existsSync, writeFileSync, readdirSync } from "node:fs";
import { resolve, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";

const revision = "f8d157532fbfaeda587e826d4cd5b21a49186f7c";
const source = `https://raw.githubusercontent.com/notofonts/noto-cjk/${revision}`;
const root = resolve(fileURLToPath(new URL("..", import.meta.url)));
const cache = join(root, ".engine-e2/fonts", revision);
const committed = join(root, "src-tauri/crates/maru-diagram-engine/src/metrics/data");
const check = process.argv.includes("--check");
const output = check ? join(root, ".engine-e2/metrics-check") : committed;
const hash = (bytes) => createHash("sha256").update(bytes).digest("hex");
if (process.platform !== "linux") throw new Error("Font generation is remote-only; run node scripts/diagram-engine-e2-fonts.mjs through the workspace remote-dev runner.");
mkdirSync(cache, { recursive: true });
const old = existsSync(join(committed, "manifest.json")) ? JSON.parse(readFileSync(join(committed, "manifest.json"), "utf8")) : null;
async function cached(filename, url, expected) {
  const target = join(cache, filename);
  if (!existsSync(target)) {
    const response = await fetch(url);
    if (!response.ok) throw new Error(`Pinned font download failed (${response.status}) for ${filename}; verify the pinned source URL and retry remotely.`);
    writeFileSync(target, new Uint8Array(await response.arrayBuffer()));
  }
  const bytes = readFileSync(target);
  if (expected && hash(bytes) !== expected) throw new Error(`Pinned font cache hash mismatch for ${filename}; remove that remote cache file and download the pinned revision again.`);
  return target;
}
const regular = await cached("NotoSansCJKkr-Regular.otf", `${source}/Sans/OTF/Korean/NotoSansCJKkr-Regular.otf`, old?.fonts?.find((font) => font.weight === 400)?.sourceSha256);
const bold = await cached("NotoSansCJKkr-Bold.otf", `${source}/Sans/OTF/Korean/NotoSansCJKkr-Bold.otf`, old?.fonts?.find((font) => font.weight === 700)?.sourceSha256);
const license = await cached("LICENSE", `${source}/Sans/LICENSE`, old?.license?.sha256);
const result = spawnSync("cargo", ["run", "--manifest-path", join(root, "src-tauri/crates/Cargo.toml"), "--locked", "--release", "-p", "maru-diagram-engine", "--features", "font-tools", "--bin", "build-font-metrics", "--", regular, bold, license, output], {
  cwd: root, env: { ...process.env, CARGO_BUILD_JOBS: "2" }, encoding: "utf8", stdio: "inherit",
});
if (result.status !== 0) throw new Error(`Font metric generator failed (${result.status ?? result.error?.message}); inspect the remote Rust diagnostics and regenerate the pinned tables.`);
if (check) {
  for (const filename of readdirSync(output)) {
    const expected = join(committed, filename);
    if (!existsSync(expected) || !readFileSync(expected).equals(readFileSync(join(output, filename)))) throw new Error(`Derived font metric drift in ${filename}; regenerate and commit the pinned metric tables and manifest.`);
  }
  console.log("Pinned derived font metrics match the committed data.");
}
