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

check("initial JS", largestMatching(/^index-.*\.js$/), 500 * 1024);
check("initial CSS", largestMatching(/^index-.*\.css$/), 70 * 1024);

if (!files.some((file) => /^GraphView-.*\.js$/.test(file))) {
  throw new Error("bundle-budget: GraphView must remain a lazy chunk");
}
if (!files.some((file) => /^RichMarkdownEditor-.*\.js$/.test(file))) {
  throw new Error("bundle-budget: RichMarkdownEditor must remain a lazy chunk");
}
