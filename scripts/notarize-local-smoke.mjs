#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { homedir, tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const defaultSecretsDir = resolve(homedir(), "workspace/work/.secrets/apple");
const secretsDir = resolve(process.env.ANCHOR_APPLE_SECRETS_DIR ?? defaultSecretsDir);
const userArgs = process.argv.slice(2);
const target = userArgs.find((arg) => !arg.startsWith("--")) ?? process.env.ANCHOR_NOTARIZE_TARGET ?? "aarch64-apple-darwin";
const checkOnly = process.argv.includes("--check");

const secretFileCandidates = {
  certificatePassword: ["certificate-password", "APPLE_CERTIFICATE_PASSWORD"],
  keychainPassword: ["keychain-password", "KEYCHAIN_PASSWORD"],
  apiIssuerId: ["api-issuer-id", "APPLE_API_ISSUER_ID"],
  apiKeyId: ["api-key-id", "APPLE_API_KEY_ID"],
};

function usage() {
  console.log(`usage: node scripts/notarize-local-smoke.mjs [target] [--check]

Runs a local signed + notarized Tauri build using Apple credentials from:
  ${secretsDir}

Required secret files:
  DeveloperIDApplication.p12
  AuthKey_<APPLE_API_KEY_ID>.p8
  certificate-password
  api-issuer-id

Optional secret files:
  api-key-id          defaults to the AuthKey_<id>.p8 filename
  keychain-password  generated locally if missing
`);
}

if (process.argv.includes("--help")) {
  usage();
  process.exit(0);
}

if (process.platform !== "darwin") {
  console.error("local notarization requires macOS");
  process.exit(1);
}

function readSecretFrom(names) {
  for (const name of names) {
    const path = join(secretsDir, name);
    if (existsSync(path)) {
      return readFileSync(path, "utf8").trim();
    }
  }
  return null;
}

function requireFile(path, label, missing) {
  if (existsSync(path)) {
    return path;
  }
  missing.push(label);
  return null;
}

function firstApiKeyPath() {
  if (process.env.APPLE_API_KEY_PATH && existsSync(process.env.APPLE_API_KEY_PATH)) {
    return process.env.APPLE_API_KEY_PATH;
  }
  if (!existsSync(secretsDir)) {
    return null;
  }
  const matches = readdirSync(secretsDir)
    .filter((name) => /^AuthKey_[A-Z0-9]+\.p8$/.test(name))
    .sort();
  return matches.length > 0 ? join(secretsDir, matches[0]) : null;
}

function apiKeyIdFromPath(path) {
  return basename(path).match(/^AuthKey_([A-Z0-9]+)\.p8$/)?.[1] ?? null;
}

function ensureKeychainPassword(missing) {
  const existing = readSecretFrom(secretFileCandidates.keychainPassword);
  if (existing) {
    return existing;
  }
  try {
    mkdirSync(secretsDir, { recursive: true, mode: 0o700 });
    const generated = randomBytes(32).toString("base64url");
    const path = join(secretsDir, "keychain-password");
    writeFileSync(path, `${generated}\n`, { mode: 0o600 });
    chmodSync(path, 0o600);
    console.log(`[ok] generated ${path}`);
    return generated;
  } catch (error) {
    missing.push(`keychain-password (could not generate: ${error.message})`);
    return null;
  }
}

function runStep(label, command, args, options = {}) {
  console.log(`\n==> ${label}`);
  const result = spawnSync(command, args, {
    cwd: repoRoot,
    stdio: options.stdio ?? "inherit",
    encoding: options.encoding,
    env: options.env ?? process.env,
  });
  if (result.error) {
    throw new Error(`${label} failed to start: ${result.error.message}`);
  }
  if (result.status !== 0) {
    throw new Error(`${label} failed with exit code ${result.status}`);
  }
  return result;
}

function ensureDeveloperIdIntermediate() {
  const cached = join(secretsDir, "devidg2.der");
  if (existsSync(cached)) {
    return cached;
  }

  const downloaded = join(tmpdir(), `anchor-devidg2-${process.pid}.der`);
  runStep("download Apple Developer ID G2 intermediate", "curl", [
    "-fsSL",
    "http://certs.apple.com/devidg2.der",
    "-o",
    downloaded,
  ]);
  return downloaded;
}

function outputOf(command, args) {
  const result = spawnSync(command, args, {
    cwd: repoRoot,
    encoding: "utf8",
  });
  if (result.error || result.status !== 0) {
    return "";
  }
  return result.stdout;
}

function parseKeychainList(output) {
  return output
    .split("\n")
    .map((line) => line.trim().replace(/^"|"$/g, ""))
    .filter(Boolean);
}

function updaterSecret(name, envName) {
  if (process.env[envName]) {
    return process.env[envName];
  }
  const path = resolve(homedir(), ".tauri", name);
  if (!existsSync(path)) {
    return null;
  }
  return readFileSync(path, "utf8").trim();
}

const missing = [];
const p12Path = requireFile(join(secretsDir, "DeveloperIDApplication.p12"), "DeveloperIDApplication.p12", missing);
const apiKeyPath = firstApiKeyPath();
if (!apiKeyPath) {
  missing.push("AuthKey_<APPLE_API_KEY_ID>.p8");
}
const certificatePassword = readSecretFrom(secretFileCandidates.certificatePassword);
if (!certificatePassword) {
  missing.push("certificate-password");
}
const apiIssuerId = readSecretFrom(secretFileCandidates.apiIssuerId);
if (!apiIssuerId) {
  missing.push("api-issuer-id");
}
const apiKeyId = readSecretFrom(secretFileCandidates.apiKeyId) ?? (apiKeyPath ? apiKeyIdFromPath(apiKeyPath) : null);
if (!apiKeyId) {
  missing.push("api-key-id");
}
const keychainPassword = ensureKeychainPassword(missing);
const updaterKey = updaterSecret("anchor-updater.key", "TAURI_SIGNING_PRIVATE_KEY");
const updaterKeyPassword = updaterSecret("anchor-updater.key.password", "TAURI_SIGNING_PRIVATE_KEY_PASSWORD");
if (!updaterKey) {
  missing.push("~/.tauri/anchor-updater.key or TAURI_SIGNING_PRIVATE_KEY");
}
if (!updaterKeyPassword) {
  missing.push("~/.tauri/anchor-updater.key.password or TAURI_SIGNING_PRIVATE_KEY_PASSWORD");
}

if (missing.length > 0) {
  console.error("missing local notarization inputs:");
  for (const item of missing) {
    console.error(`  - ${item}`);
  }
  usage();
  process.exit(1);
}

console.log(`[ok] using Apple secrets directory: ${secretsDir}`);
console.log(`[ok] using API key file: ${basename(apiKeyPath)}`);
console.log(`[ok] target: ${target}`);

if (checkOnly) {
  console.log("[ok] local notarization inputs are present");
  process.exit(0);
}

const keychainPath = join(tmpdir(), `anchor-notary-${process.pid}.keychain-db`);
const originalKeychains = parseKeychainList(outputOf("security", ["list-keychains", "-d", "user"]));
const originalDefaultKeychain = outputOf("security", ["default-keychain", "-d", "user"]).trim().replace(/^"|"$/g, "");

function cleanup() {
  if (process.env.ANCHOR_KEEP_NOTARY_KEYCHAIN === "1") {
    console.log(`[warn] keeping temporary keychain: ${keychainPath}`);
    return;
  }
  if (originalKeychains.length > 0) {
    spawnSync("security", ["list-keychains", "-d", "user", "-s", ...originalKeychains], { stdio: "ignore" });
  }
  if (originalDefaultKeychain) {
    spawnSync("security", ["default-keychain", "-d", "user", "-s", originalDefaultKeychain], { stdio: "ignore" });
  }
  spawnSync("security", ["delete-keychain", keychainPath], { stdio: "ignore" });
  rmSync(keychainPath, { force: true });
}

try {
  runStep("create temporary keychain", "security", ["create-keychain", "-p", keychainPassword, keychainPath]);
  runStep("add temporary keychain to search list", "security", ["list-keychains", "-d", "user", "-s", keychainPath, ...originalKeychains]);
  runStep("make temporary keychain default", "security", ["default-keychain", "-d", "user", "-s", keychainPath]);
  runStep("unlock temporary keychain", "security", ["unlock-keychain", "-p", keychainPassword, keychainPath]);
  runStep("set temporary keychain timeout", "security", ["set-keychain-settings", "-lut", "21600", keychainPath]);
  runStep("import Developer ID certificate", "security", [
    "import",
    p12Path,
    "-k",
    keychainPath,
    "-P",
    certificatePassword,
    "-T",
    "/usr/bin/codesign",
  ]);
  runStep("import Apple Developer ID G2 intermediate", "security", [
    "import",
    ensureDeveloperIdIntermediate(),
    "-k",
    keychainPath,
    "-T",
    "/usr/bin/codesign",
  ]);
  runStep("allow codesign to use imported key", "security", [
    "set-key-partition-list",
    "-S",
    "apple-tool:,apple:,codesign:",
    "-s",
    "-k",
    keychainPassword,
    keychainPath,
  ]);

  const identities = outputOf("security", ["find-identity", "-v", "-p", "codesigning", keychainPath]);
  const identity = identities.match(/"([^"]*Developer ID Application[^"]*)"/)?.[1];
  if (!identity) {
    throw new Error("Developer ID Application identity was not found after import");
  }
  console.log(`[ok] imported signing identity: ${identity}`);

  runStep("check App Store Connect notary credentials", "xcrun", [
    "notarytool",
    "history",
    "--key",
    apiKeyPath,
    "--key-id",
    apiKeyId,
    "--issuer",
    apiIssuerId,
  ]);

  const env = {
    ...process.env,
    APPLE_API_ISSUER: apiIssuerId,
    APPLE_API_KEY: apiKeyId,
    APPLE_API_KEY_PATH: apiKeyPath,
    APPLE_SIGNING_IDENTITY: identity,
    TAURI_SIGNING_PRIVATE_KEY: updaterKey,
    TAURI_SIGNING_PRIVATE_KEY_PASSWORD: updaterKeyPassword,
  };

  runStep("build, sign, notarize, and bundle Anchor", "pnpm", ["tauri", "build", "--target", target], { env });
  console.log("\n[ok] local notarized Tauri build completed");
} catch (error) {
  console.error(`\n[error] ${error.message}`);
  process.exitCode = 1;
} finally {
  cleanup();
}
