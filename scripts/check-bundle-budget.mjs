import { readdirSync, readFileSync } from "node:fs";
import { gzipSync } from "node:zlib";

const assetsDir = new URL("../dist/assets/", import.meta.url);
const files = readdirSync(assetsDir);

function largestMatching(pattern) {
  const matches = files.filter((file) => pattern.test(file));
  if (matches.length === 0) throw new Error(`bundle-budget: no asset matched ${pattern}`);
  return matches
    .map((file) => ({ file, bytes: readFileSync(new URL(file, assetsDir)) }))
    .sort((a, b) => b.bytes.length - a.bytes.length)[0];
}

function check(label, asset, maxGzipBytes) {
  const gzipBytes = gzipSync(asset.bytes).length;
  if (gzipBytes > maxGzipBytes) {
    throw new Error(
      `bundle-budget: ${label} ${asset.file} is ${(gzipBytes / 1024).toFixed(1)} KiB gzip, budget ${(maxGzipBytes / 1024).toFixed(0)} KiB`,
    );
  }
  process.stdout.write(
    `bundle-budget: ${label} ${(gzipBytes / 1024).toFixed(1)} KiB gzip <= ${(maxGzipBytes / 1024).toFixed(0)} KiB\n`,
  );
}

// Lowered from 500 KiB after the i18n dictionaries moved to lazy chunks
// (issue #201): the entry measured 284 KiB gzip, leaving ~12% headroom.
check("initial JS", largestMatching(/^index-.*\.js$/), 320 * 1024);
check("initial CSS", largestMatching(/^index-.*\.css$/), 70 * 1024);

if (!files.some((file) => /^GraphView-.*\.js$/.test(file))) {
  throw new Error("bundle-budget: GraphView must remain a lazy chunk");
}
if (!files.some((file) => /^RichMarkdownEditor-.*\.js$/.test(file))) {
  throw new Error("bundle-budget: RichMarkdownEditor must remain a lazy chunk");
}
if (!files.some((file) => /^PkmModeAdapter-.*\.js$/.test(file))) {
  throw new Error("bundle-budget: PkmModeAdapter must remain a lazy chunk");
}
if (!files.some((file) => /^E2EFlowModeAdapter-.*\.js$/.test(file))) {
  throw new Error("bundle-budget: E2EFlowModeAdapter must remain a lazy chunk");
}
const modeRegistrySource = readFileSync(new URL("../src/lib/modeRegistry.tsx", import.meta.url), "utf8");
if (!modeRegistrySource.includes('import("./modeAdapters/PkmModeAdapter")')) {
  throw new Error("bundle-budget: PKM adapter must use a dynamic registry import");
}
if (!modeRegistrySource.includes('import("./modeAdapters/E2EFlowModeAdapter")')) {
  throw new Error("bundle-budget: E2E adapter must use a dynamic registry import");
}
const appSource = readFileSync(new URL("../src/App.tsx", import.meta.url), "utf8");
if (appSource.includes('from "./lib/modeAdapters/PkmModeAdapter"')) {
  throw new Error("bundle-budget: App must not eagerly import the PKM adapter");
}
if (appSource.includes('from "./lib/modeAdapters/E2EFlowModeAdapter"')) {
  throw new Error("bundle-budget: App must not eagerly import the E2E adapter");
}
if (!files.some((file) => /^ko-.*\.js$/.test(file)) || !files.some((file) => /^en-.*\.js$/.test(file))) {
  throw new Error("bundle-budget: i18n dictionaries must remain lazy chunks");
}
