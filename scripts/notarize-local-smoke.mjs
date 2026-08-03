#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { homedir, tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  appleSecretsDir,
  readSecretFrom as readSecretFromDir,
  resolveNotaryCredentials,
} from "./lib/appleNotary.mjs";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const secretsDir = appleSecretsDir();
const userArgs = process.argv.slice(2);
const target = userArgs.find((arg) => !arg.startsWith("--")) ?? process.env.MARU_NOTARIZE_TARGET ?? "aarch64-apple-darwin";
const checkOnly = process.argv.includes("--check");

const secretFileCandidates = {
  certificatePassword: ["certificate-password", "APPLE_CERTIFICATE_PASSWORD"],
  keychainPassword: ["keychain-password", "KEYCHAIN_PASSWORD"],
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
  return readSecretFromDir(secretsDir, names);
}

function requireFile(path, label, missing) {
  if (existsSync(path)) {
    return path;
  }
  missing.push(label);
  return null;
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

  const downloaded = join(tmpdir(), `maru-devidg2-${process.pid}.der`);
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

const notary = resolveNotaryCredentials(secretsDir);
const missing = [...notary.missing];
const { apiKeyPath, apiIssuerId, apiKeyId } = notary;
const p12Path = requireFile(join(secretsDir, "DeveloperIDApplication.p12"), "DeveloperIDApplication.p12", missing);
const certificatePassword = readSecretFrom(secretFileCandidates.certificatePassword);
if (!certificatePassword) {
  missing.push("certificate-password");
}
const keychainPassword = ensureKeychainPassword(missing);
const updaterKey = updaterSecret("maru-updater.key", "TAURI_SIGNING_PRIVATE_KEY");
const updaterKeyPassword = updaterSecret("maru-updater.key.password", "TAURI_SIGNING_PRIVATE_KEY_PASSWORD");
if (!updaterKey) {
  missing.push("~/.tauri/maru-updater.key or TAURI_SIGNING_PRIVATE_KEY");
}
if (!updaterKeyPassword) {
  missing.push("~/.tauri/maru-updater.key.password or TAURI_SIGNING_PRIVATE_KEY_PASSWORD");
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

const keychainPath = join(tmpdir(), `maru-notary-${process.pid}.keychain-db`);
const originalKeychains = parseKeychainList(outputOf("security", ["list-keychains", "-d", "user"]));
const originalDefaultKeychain = outputOf("security", ["default-keychain", "-d", "user"]).trim().replace(/^"|"$/g, "");

function cleanup() {
  if (process.env.MARU_KEEP_NOTARY_KEYCHAIN === "1") {
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

  runStep("build, sign, notarize, and bundle Maru", "pnpm", ["tauri", "build", "--target", target], { env });
  console.log("\n[ok] local notarized Tauri build completed");
} catch (error) {
  console.error(`\n[error] ${error.message}`);
  process.exitCode = 1;
} finally {
  cleanup();
}
