import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  copyFileSync,
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { inflateSync } from "node:zlib";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const brandRoot = join(repoRoot, "src", "assets", "brand");
const nativeOutput = join(repoRoot, "src-tauri", "icons");
const publicRoot = join(repoRoot, "public");
const webIconOutput = join(publicRoot, "icons");
const checkOnly = process.argv.includes("--check");
const unknownArguments = process.argv.slice(2).filter((argument) => argument !== "--check");

if (unknownArguments.length > 0) {
  throw new Error(`unknown argument(s): ${unknownArguments.join(", ")}`);
}

const sources = {
  manifest: join(brandRoot, "icon-manifest.json"),
  full: join(brandRoot, "maru-seal.svg"),
  micro: join(brandRoot, "maru-seal-micro.svg"),
  maskable: join(brandRoot, "maru-seal-maskable.svg"),
  foreground: join(brandRoot, "maru-seal-foreground.svg"),
  monochrome: join(brandRoot, "maru-seal-monochrome.svg"),
};

const requiredNativeFiles = [
  "32x32.png",
  "64x64.png",
  "128x128.png",
  "128x128@2x.png",
  "icon.png",
  "icon.icns",
  "icon.ico",
  "StoreLogo.png",
  "Square30x30Logo.png",
  "Square44x44Logo.png",
  "Square71x71Logo.png",
  "Square89x89Logo.png",
  "Square107x107Logo.png",
  "Square142x142Logo.png",
  "Square150x150Logo.png",
  "Square284x284Logo.png",
  "Square310x310Logo.png",
];

const webDimensions = new Map([
  ["icons/favicon-16x16.png", 16],
  ["icons/favicon-32x32.png", 32],
  ["icons/favicon-48x48.png", 48],
  ["apple-touch-icon.png", 180],
  ["icons/icon-192.png", 192],
  ["icons/icon-512.png", 512],
  ["icons/maskable-icon-192.png", 192],
  ["icons/maskable-icon-512.png", 512],
]);

function displayPath(path) {
  return relative(repoRoot, path).split(sep).join("/");
}

function assertFile(path) {
  if (!existsSync(path) || !statSync(path).isFile()) {
    throw new Error(`required icon file is missing: ${displayPath(path)}`);
  }
}

function validateSources() {
  for (const source of Object.values(sources)) assertFile(source);
  for (const source of [
    sources.full,
    sources.micro,
    sources.maskable,
    sources.foreground,
    sources.monochrome,
  ]) {
    const svg = readFileSync(source, "utf8");
    if (!svg.includes('viewBox="0 0 1024 1024"')) {
      throw new Error(`${displayPath(source)} must use the canonical 1024 square viewBox`);
    }
    if (/<text\b/i.test(svg)) {
      throw new Error(`${displayPath(source)} must contain outlined geometry, not runtime text`);
    }
  }
}

function runTauriIcon(input, output, pngSizes) {
  mkdirSync(output, { recursive: true });
  const executable = process.platform === "win32" ? "pnpm.cmd" : "pnpm";
  const args = ["exec", "tauri", "icon", input, "--output", output];
  if (pngSizes) args.push("--png", pngSizes.join(","));
  execFileSync(executable, args, { cwd: repoRoot, stdio: "inherit" });
}

function listFiles(root) {
  if (!existsSync(root)) return [];
  const files = [];
  const visit = (directory) => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) visit(path);
      else if (entry.isFile()) files.push(relative(root, path).split(sep).join("/"));
    }
  };
  visit(root);
  return files.sort();
}

function pngDimensions(path) {
  const bytes = readFileSync(path);
  if (bytes.length < 24 || bytes.subarray(1, 4).toString("ascii") !== "PNG") {
    throw new Error(`invalid PNG: ${displayPath(path)}`);
  }
  return { width: bytes.readUInt32BE(16), height: bytes.readUInt32BE(20) };
}

function validatePng(path, expectedSize) {
  const { width, height } = pngDimensions(path);
  if (width !== height || (expectedSize && width !== expectedSize)) {
    throw new Error(
      `unexpected PNG dimensions for ${displayPath(path)}: ${width}x${height}` +
        (expectedSize ? `, expected ${expectedSize}x${expectedSize}` : ""),
    );
  }
}

function hash(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

function paethPredictor(left, above, upperLeft) {
  const prediction = left + above - upperLeft;
  const leftDistance = Math.abs(prediction - left);
  const aboveDistance = Math.abs(prediction - above);
  const upperLeftDistance = Math.abs(prediction - upperLeft);
  if (leftDistance <= aboveDistance && leftDistance <= upperLeftDistance) return left;
  if (aboveDistance <= upperLeftDistance) return above;
  return upperLeft;
}

function unfilterPngScanlines(ihdr, compressed) {
  const width = ihdr.readUInt32BE(0);
  const height = ihdr.readUInt32BE(4);
  const bitDepth = ihdr[8];
  const colorType = ihdr[9];
  const channels = new Map([
    [0, 1],
    [2, 3],
    [4, 2],
    [6, 4],
  ]).get(colorType);
  if (bitDepth !== 8 || !channels) {
    throw new Error(`unsupported ICNS PNG format: bitDepth=${bitDepth}, colorType=${colorType}`);
  }
  const bytesPerPixel = channels;
  const rowBytes = width * bytesPerPixel;
  const filtered = inflateSync(compressed);
  if (filtered.length !== (rowBytes + 1) * height) {
    throw new Error("unexpected ICNS PNG scanline length");
  }
  const pixels = Buffer.alloc(rowBytes * height);
  let sourceOffset = 0;
  for (let row = 0; row < height; row += 1) {
    const filter = filtered[sourceOffset];
    sourceOffset += 1;
    const destinationOffset = row * rowBytes;
    for (let column = 0; column < rowBytes; column += 1) {
      const raw = filtered[sourceOffset + column];
      const left = column >= bytesPerPixel ? pixels[destinationOffset + column - bytesPerPixel] : 0;
      const above = row > 0 ? pixels[destinationOffset - rowBytes + column] : 0;
      const upperLeft =
        row > 0 && column >= bytesPerPixel
          ? pixels[destinationOffset - rowBytes + column - bytesPerPixel]
          : 0;
      const predictor =
        filter === 0
          ? 0
          : filter === 1
            ? left
            : filter === 2
              ? above
              : filter === 3
                ? Math.floor((left + above) / 2)
                : filter === 4
                  ? paethPredictor(left, above, upperLeft)
                  : null;
      if (predictor === null) throw new Error(`unsupported ICNS PNG filter: ${filter}`);
      pixels[destinationOffset + column] = (raw + predictor) & 0xff;
    }
    sourceOffset += rowBytes;
  }
  return { width, height, bitDepth, colorType, pixels };
}

function pngFingerprint(bytes) {
  if (bytes.length < 24 || bytes.subarray(1, 4).toString("ascii") !== "PNG") {
    throw new Error("ICNS entry is not a valid PNG payload");
  }
  const idat = [];
  let ihdr = null;
  let offset = 8;
  while (offset + 12 <= bytes.length) {
    const length = bytes.readUInt32BE(offset);
    const type = bytes.subarray(offset + 4, offset + 8).toString("ascii");
    const payload = bytes.subarray(offset + 8, offset + 8 + length);
    if (type === "IHDR") ihdr = payload;
    if (type === "IDAT") idat.push(payload);
    offset += length + 12;
    if (type === "IEND") break;
  }
  if (!ihdr || idat.length === 0) throw new Error("ICNS PNG payload is missing IHDR or IDAT");
  const decoded = unfilterPngScanlines(ihdr, Buffer.concat(idat));
  return `${decoded.width}x${decoded.height}:${decoded.bitDepth}:${decoded.colorType}:${hash(decoded.pixels)}`;
}

function icnsFingerprint(path) {
  const bytes = readFileSync(path);
  if (bytes.length < 8 || bytes.subarray(0, 4).toString("ascii") !== "icns") {
    throw new Error(`invalid ICNS container: ${displayPath(path)}`);
  }
  if (bytes.readUInt32BE(4) !== bytes.length) {
    throw new Error(`invalid ICNS length: ${displayPath(path)}`);
  }
  const entries = [];
  let offset = 8;
  while (offset + 8 <= bytes.length) {
    const type = bytes.subarray(offset, offset + 4).toString("ascii");
    const length = bytes.readUInt32BE(offset + 4);
    if (length < 8 || offset + length > bytes.length) {
      throw new Error(`invalid ICNS entry ${type}: ${displayPath(path)}`);
    }
    const payload = bytes.subarray(offset + 8, offset + length);
    const fingerprint =
      payload.length >= 8 && payload.subarray(1, 4).toString("ascii") === "PNG"
        ? pngFingerprint(payload)
        : hash(payload);
    entries.push(`${type}:${fingerprint}`);
    offset += length;
  }
  return entries.sort().join("|");
}

function assertMatchingFile(expected, actual) {
  assertFile(expected);
  assertFile(actual);
  if (expected.endsWith(".icns") && actual.endsWith(".icns")) {
    if (icnsFingerprint(expected) !== icnsFingerprint(actual)) {
      throw new Error(`generated ICNS pixels are stale: ${displayPath(actual)}`);
    }
    return;
  }
  if (!readFileSync(expected).equals(readFileSync(actual))) {
    throw new Error(`generated icon is stale: ${displayPath(actual)}`);
  }
}

function assertMatchingDirectory(expected, actual) {
  const expectedFiles = listFiles(expected);
  const actualFiles = listFiles(actual);
  if (expectedFiles.join("\n") !== actualFiles.join("\n")) {
    throw new Error(
      `generated icon inventory is stale for ${displayPath(actual)}\n` +
        `expected: ${expectedFiles.join(", ")}\nactual: ${actualFiles.join(", ")}`,
    );
  }
  for (const file of expectedFiles) {
    assertMatchingFile(join(expected, file), join(actual, file));
  }
}

validateSources();

const temporaryRoot = mkdtempSync(join(tmpdir(), "maru-icons-"));

try {
  const generatedNative = join(temporaryRoot, "native");
  const generatedMicro = join(temporaryRoot, "micro");
  const generatedFull = join(temporaryRoot, "full");
  const generatedMaskable = join(temporaryRoot, "maskable");
  const generatedPublic = join(temporaryRoot, "public");
  const generatedWebIcons = join(generatedPublic, "icons");

  runTauriIcon(sources.manifest, generatedNative);
  runTauriIcon(sources.micro, generatedMicro, [16, 32, 48]);
  runTauriIcon(sources.full, generatedFull, [192, 512]);
  runTauriIcon(sources.maskable, generatedMaskable, [180, 192, 512]);

  mkdirSync(generatedWebIcons, { recursive: true });
  copyFileSync(sources.micro, join(generatedPublic, "favicon.svg"));
  copyFileSync(join(generatedNative, "icon.ico"), join(generatedPublic, "favicon.ico"));
  copyFileSync(sources.monochrome, join(generatedPublic, "safari-pinned-tab.svg"));
  copyFileSync(join(generatedMicro, "16x16.png"), join(generatedWebIcons, "favicon-16x16.png"));
  copyFileSync(join(generatedMicro, "32x32.png"), join(generatedWebIcons, "favicon-32x32.png"));
  copyFileSync(join(generatedMicro, "48x48.png"), join(generatedWebIcons, "favicon-48x48.png"));
  copyFileSync(join(generatedMaskable, "180x180.png"), join(generatedPublic, "apple-touch-icon.png"));
  copyFileSync(join(generatedFull, "192x192.png"), join(generatedWebIcons, "icon-192.png"));
  copyFileSync(join(generatedFull, "512x512.png"), join(generatedWebIcons, "icon-512.png"));
  copyFileSync(
    join(generatedMaskable, "192x192.png"),
    join(generatedWebIcons, "maskable-icon-192.png"),
  );
  copyFileSync(
    join(generatedMaskable, "512x512.png"),
    join(generatedWebIcons, "maskable-icon-512.png"),
  );

  for (const file of requiredNativeFiles) assertFile(join(generatedNative, file));
  for (const directory of ["android", "ios"]) {
    if (!existsSync(join(generatedNative, directory))) {
      throw new Error(`Tauri did not generate the ${directory} icon set`);
    }
  }
  for (const file of listFiles(generatedNative).filter((file) => file.endsWith(".png"))) {
    validatePng(join(generatedNative, file));
  }
  for (const [file, size] of webDimensions) {
    validatePng(join(generatedPublic, file), size);
  }

  if (checkOnly) {
    assertMatchingDirectory(generatedNative, nativeOutput);
    assertMatchingDirectory(generatedWebIcons, webIconOutput);
    for (const file of ["favicon.svg", "favicon.ico", "safari-pinned-tab.svg", "apple-touch-icon.png"]) {
      assertMatchingFile(join(generatedPublic, file), join(publicRoot, file));
    }
    console.log("Maru icon assets are complete and up to date.");
  } else {
    rmSync(nativeOutput, { recursive: true, force: true });
    cpSync(generatedNative, nativeOutput, { recursive: true });
    rmSync(webIconOutput, { recursive: true, force: true });
    cpSync(generatedWebIcons, webIconOutput, { recursive: true });
    mkdirSync(publicRoot, { recursive: true });
    for (const file of ["favicon.svg", "favicon.ico", "safari-pinned-tab.svg", "apple-touch-icon.png"]) {
      copyFileSync(join(generatedPublic, file), join(publicRoot, file));
    }
    console.log("Generated Maru native and web icon assets.");
  }
} finally {
  rmSync(temporaryRoot, { recursive: true, force: true });
}
