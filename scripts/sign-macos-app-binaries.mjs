#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");

if (process.env.TAURI_ENV_PLATFORM !== "darwin") {
  process.exit(0);
}

const identity = process.env.APPLE_SIGNING_IDENTITY || "-";
const arch = process.env.TAURI_ENV_ARCH || process.arch;
const targetTriple =
  arch === "x86_64" || arch === "x64"
    ? "x86_64-apple-darwin"
    : arch === "aarch64" || arch === "arm64"
      ? "aarch64-apple-darwin"
      : null;

const candidatePaths = [
  targetTriple
    ? resolve(repoRoot, "src-tauri", "target", targetTriple, "release", "anchor-cli")
    : null,
  resolve(repoRoot, "src-tauri", "target", "release", "anchor-cli"),
].filter(Boolean);

const binaries = [...new Set(candidatePaths)].filter((path) => existsSync(path));

if (binaries.length === 0) {
  console.log("[sign-macos-app-binaries] no anchor-cli binary found; skipping");
  process.exit(0);
}

for (const binary of binaries) {
  const args = ["--force", "--sign", identity];
  if (identity !== "-") {
    args.push("--options", "runtime", "--timestamp");
  }
  args.push(binary);

  console.log(`[sign-macos-app-binaries] signing ${binary}`);
  const result = spawnSync("codesign", args, { stdio: "inherit" });
  if (result.status !== 0) {
    process.exit(result.status ?? 1);
  }
}
