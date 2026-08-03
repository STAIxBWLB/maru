#!/usr/bin/env node
import { execFileSync, spawnSync } from "node:child_process";
import {
  chmodSync,
  copyFileSync,
  existsSync,
  readFileSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { dirname, resolve } from "node:path";
import { homedir } from "node:os";
import { fileURLToPath } from "node:url";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const profileValue = process.env.MARU_MACOS_PROVISIONING_PROFILE?.trim();
const identity = process.env.APPLE_SIGNING_IDENTITY?.trim();
const stagedProfile = resolve(repoRoot, "src-tauri/Passkeys.provisionprofile");
const appPath = resolve(repoRoot, "src-tauri/target/release/bundle/macos/Maru.app");

function abort(message) {
  console.error(`[error] ${message}`);
  process.exit(1);
}

function run(command, args) {
  execFileSync(command, args, { cwd: repoRoot, env: process.env, stdio: "inherit" });
}

function commandOutput(command, args) {
  const result = spawnSync(command, args, { cwd: repoRoot, encoding: "utf8" });
  if (result.status !== 0) {
    throw new Error(`${command} ${args.join(" ")} failed: ${result.stderr || result.stdout}`);
  }
  return `${result.stdout ?? ""}${result.stderr ?? ""}`;
}

if (process.platform !== "darwin") {
  abort("browser-passkey bundles can only be built on macOS");
}
if (!profileValue) {
  abort("MARU_MACOS_PROVISIONING_PROFILE must point to an approved Developer ID profile");
}
if (!identity || identity === "-") {
  abort("APPLE_SIGNING_IDENTITY must name a Developer ID Application identity");
}

if (!process.env.TAURI_SIGNING_PRIVATE_KEY) {
  const updaterKeyPath = resolve(homedir(), ".tauri/maru-updater.key");
  if (!existsSync(updaterKeyPath)) {
    abort("TAURI_SIGNING_PRIVATE_KEY is unset and ~/.tauri/maru-updater.key is missing");
  }
  process.env.TAURI_SIGNING_PRIVATE_KEY = readFileSync(updaterKeyPath, "utf8").trim();
}
if (!process.env.TAURI_SIGNING_PRIVATE_KEY_PASSWORD) {
  const updaterPasswordPath = resolve(homedir(), ".tauri/maru-updater.key.password");
  if (existsSync(updaterPasswordPath)) {
    process.env.TAURI_SIGNING_PRIVATE_KEY_PASSWORD = readFileSync(updaterPasswordPath, "utf8").trim();
  }
}

const profilePath = resolve(profileValue);
if (!existsSync(profilePath)) {
  abort(`provisioning profile does not exist: ${profilePath}`);
}

const previousProfile = existsSync(stagedProfile)
  ? { bytes: readFileSync(stagedProfile), mode: statSync(stagedProfile).mode }
  : null;

try {
  if (profilePath !== stagedProfile) {
    copyFileSync(profilePath, stagedProfile);
  }
  chmodSync(stagedProfile, 0o600);

  run("node", [
    "scripts/check-macos-direct-distribution.mjs",
    "--passkeys",
    "--require-local-identity",
  ]);
  run("pnpm", ["clean:tauri-bundles"]);
  run("pnpm", [
    "exec",
    "tauri",
    "build",
    "--bundles",
    "app",
    "--config",
    "src-tauri/tauri.passkeys.conf.json",
  ]);

  const bundledProfile = resolve(appPath, "Contents/embedded.provisionprofile");
  const wrapperPath = resolve(appPath, "Contents/Resources/maru-cli");
  const forbiddenCliPath = resolve(appPath, "Contents/MacOS/maru-cli");
  const mainPath = resolve(appPath, "Contents/MacOS/maru");
  if (!existsSync(bundledProfile) || !readFileSync(bundledProfile).equals(readFileSync(profilePath))) {
    throw new Error("built app does not contain the requested embedded.provisionprofile");
  }
  if (!existsSync(wrapperPath) || !readFileSync(wrapperPath, "utf8").startsWith("#!/bin/sh\n")) {
    throw new Error("built app does not contain the safe maru-cli shell wrapper");
  }
  if ((statSync(wrapperPath).mode & 0o111) === 0) {
    throw new Error("bundled maru-cli wrapper is not executable");
  }
  if (existsSync(forbiddenCliPath)) {
    throw new Error("built app contains the standalone maru-cli Mach-O");
  }
  const mainMagic = readFileSync(mainPath).subarray(0, 4).toString("hex");
  if (!["feedface", "feedfacf", "cefaedfe", "cffaedfe", "cafebabe", "bebafeca"].includes(mainMagic)) {
    throw new Error("built app main executable is not Mach-O");
  }
  run("codesign", ["--verify", "--deep", "--strict", "--verbose=4", appPath]);
  const entitlements = commandOutput("codesign", ["-d", "--entitlements", ":-", appPath]);
  if (!/com\.apple\.developer\.web-browser\.public-key-credential<\/key>\s*<true\s*\/>/.test(entitlements)) {
    throw new Error("built app signature does not contain the browser-passkey entitlement");
  }
  console.log(`[ok] provisioned browser-passkey app built at ${appPath}`);
} finally {
  if (previousProfile) {
    writeFileSync(stagedProfile, previousProfile.bytes, { mode: previousProfile.mode });
    chmodSync(stagedProfile, previousProfile.mode);
  } else if (existsSync(stagedProfile)) {
    unlinkSync(stagedProfile);
  }
}
