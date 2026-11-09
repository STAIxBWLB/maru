// Fetch and parse pinned fonts only on remote Linux; source OTFs remain ignored.
import { readFileSync, mkdirSync, existsSync, writeFileSync } from "node:fs";
import { resolve, join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";

const revision = "f8d157532fbfaeda587e826d4cd5b21a49186f7c";
const source = `https://raw.githubusercontent.com/notofonts/noto-cjk/${revision}`;
const root = resolve(fileURLToPath(new URL("..", import.meta.url)));
const cache = join(root, ".engine-e2/fonts", revision);
const metrics = join(root, "src-tauri/crates/maru-diagram-engine/src/metrics/data/manifest.json");
const committed = join(root, "src-tauri/crates/maru-diagram-engine/src/render/notdef.json");
const check = process.argv.includes("--check");
const output = check ? join(root, ".engine-e2/notdef-check.json") : committed;
const hash = (bytes) => createHash("sha256").update(bytes).digest("hex");

if (process.platform !== "linux") {
  throw new Error("Font generation is remote-only; run node scripts/diagram-engine-e3-fonts.mjs through the workspace remote-dev runner.");
}
const manifest = JSON.parse(readFileSync(metrics, "utf8"));
if (manifest.sourceRevision !== revision) throw new Error("Pinned font manifest revision mismatch; restore the E2 pinned manifest before exporting .notdef outlines.");
mkdirSync(cache, { recursive: true });

async function cached(filename, url, expected) {
  const target = join(cache, filename);
  if (!existsSync(target)) {
    const response = await fetch(url);
    if (!response.ok) throw new Error(`Pinned font download failed (${response.status}) for ${filename}; verify the pinned source URL and retry remotely.`);
    writeFileSync(target, new Uint8Array(await response.arrayBuffer()));
  }
  const bytes = readFileSync(target);
  if (hash(bytes) !== expected) throw new Error(`Pinned font cache hash mismatch for ${filename}; remove that remote cache file and download the pinned revision again.`);
  return target;
}

const regularEntry = manifest.fonts.find((font) => font.weight === 400);
const boldEntry = manifest.fonts.find((font) => font.weight === 700);
if (!regularEntry || !boldEntry) throw new Error("Pinned font manifest lacks regular-400 or bold-700; restore the E2 pinned manifest.");
const regular = await cached("NotoSansCJKkr-Regular.otf", `${source}/Sans/OTF/Korean/NotoSansCJKkr-Regular.otf`, regularEntry.sourceSha256);
const bold = await cached("NotoSansCJKkr-Bold.otf", `${source}/Sans/OTF/Korean/NotoSansCJKkr-Bold.otf`, boldEntry.sourceSha256);
const result = spawnSync("cargo", [
  "run", "--manifest-path", join(root, "src-tauri/crates/Cargo.toml"), "--locked", "--release",
  "-p", "maru-diagram-engine", "--features", "font-tools", "--bin", "export-notdef", "--", regular, bold,
], { cwd: root, env: { ...process.env, CARGO_BUILD_JOBS: "2" }, encoding: "utf8" });
if (result.status !== 0) {
  if (result.stderr) process.stderr.write(result.stderr);
  throw new Error(`Pinned .notdef outline export failed (${result.status ?? result.error?.message}); inspect the remote Rust diagnostics and retry.`);
}
const generated = Buffer.from(result.stdout);
try {
  JSON.parse(generated.toString("utf8"));
} catch (error) {
  throw new Error(`.notdef exporter did not return valid JSON (${error.message}); inspect the remote Rust stdout.`);
}
if (check) {
  if (!existsSync(committed) || !readFileSync(committed).equals(generated)) {
    throw new Error("Derived .notdef outline drift; regenerate and commit src-tauri/crates/maru-diagram-engine/src/render/notdef.json.");
  }
  console.log("Pinned .notdef outlines match the committed JSON.");
} else {
  mkdirSync(dirname(output), { recursive: true });
  writeFileSync(output, generated);
  console.log(`Wrote ${output.slice(root.length + 1)}.`);
}
