#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const releaseRepo = process.env.ANCHOR_RELEASE_REPO ?? "STAIxBWLB/anchor";
const expectedBundleId = process.env.ANCHOR_MACOS_BUNDLE_ID ?? "kr.anchor.desktop";
const args = new Set(process.argv.slice(2));
const allowedArgs = new Set(["--github-secrets", "--require-local-identity", "--help"]);

if (args.has("--help")) {
  console.log(`usage: node scripts/check-macos-direct-distribution.mjs [--github-secrets] [--require-local-identity]

Checks Anchor's minimum macOS direct-distribution setup.

Options:
  --github-secrets          require all GitHub Actions secrets used for signed/notarized releases
  --require-local-identity  require a local Developer ID Application signing identity
`);
  process.exit(0);
}

const unknownArgs = [...args].filter((arg) => !allowedArgs.has(arg));
if (unknownArgs.length > 0) {
  console.error(`unknown option(s): ${unknownArgs.join(", ")}`);
  process.exit(2);
}

const requireGitHubSecrets = args.has("--github-secrets");
const requireLocalIdentity = args.has("--require-local-identity");
const errors = [];
const warnings = [];
const successes = [];

function ok(message) {
  successes.push(message);
}

function warn(message) {
  warnings.push(message);
}

function fail(message) {
  errors.push(message);
}

function readJson(relativePath) {
  const path = resolve(repoRoot, relativePath);
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch (error) {
    fail(`${relativePath} is not readable JSON: ${error.message}`);
    return null;
  }
}

function readText(relativePath) {
  const path = resolve(repoRoot, relativePath);
  if (!existsSync(path)) {
    fail(`${relativePath} is missing`);
    return "";
  }
  return readFileSync(path, "utf8");
}

function firstCargoPackageVersion(cargoToml) {
  const packageSection = cargoToml.split(/\n\[/)[0];
  const match = packageSection.match(/^version\s*=\s*"([^"]+)"/m);
  return match?.[1] ?? null;
}

const packageJson = readJson("package.json");
const tauriConfig = readJson("src-tauri/tauri.conf.json");
const cargoToml = readText("src-tauri/Cargo.toml");
const workflow = readText(".github/workflows/release-bundles.yml");

if (packageJson && tauriConfig) {
  const cargoVersion = firstCargoPackageVersion(cargoToml);
  const versions = [
    ["package.json", packageJson.version],
    ["src-tauri/tauri.conf.json", tauriConfig.version],
    ["src-tauri/Cargo.toml", cargoVersion],
  ];
  const uniqueVersions = new Set(versions.map(([, version]) => version).filter(Boolean));
  if (uniqueVersions.size === 1 && uniqueVersions.has(packageJson.version)) {
    ok(`version surfaces are synced at ${packageJson.version}`);
  } else {
    fail(`version surfaces are not synced: ${versions.map(([name, version]) => `${name}=${version ?? "missing"}`).join(", ")}`);
  }

  if (tauriConfig.identifier === expectedBundleId) {
    ok(`bundle identifier is ${expectedBundleId}`);
  } else {
    fail(`bundle identifier is ${tauriConfig.identifier ?? "missing"}; expected ${expectedBundleId}`);
  }

  if (tauriConfig.productName === "Anchor") {
    ok("productName is Anchor");
  } else {
    warn(`productName is ${tauriConfig.productName ?? "missing"}; expected Anchor for release assets`);
  }

  if (tauriConfig.bundle?.active === true) {
    ok("Tauri bundling is active");
  } else {
    fail("Tauri bundling is not active");
  }

  if (tauriConfig.bundle?.createUpdaterArtifacts === true) {
    ok("Tauri updater artifacts are enabled");
  } else {
    fail("Tauri updater artifacts are not enabled");
  }

  if (typeof tauriConfig.plugins?.updater?.pubkey === "string" && tauriConfig.plugins.updater.pubkey.length > 0) {
    ok("updater public key is configured");
  } else {
    fail("updater public key is missing");
  }

  if (tauriConfig.bundle?.macOS?.signingIdentity === "-") {
    ok("repo default macOS signing identity is explicit ad-hoc fallback");
  } else {
    warn("repo default macOS signing identity is not '-' ; verify APPLE_SIGNING_IDENTITY still controls CI Developer ID signing");
  }
}

for (const needle of [
  "Prepare macOS signing",
  "Developer ID Application",
  "Build and upload notarized Tauri bundles",
  "APPLE_SIGNING_IDENTITY",
  "APPLE_API_ISSUER_ID",
  "APPLE_API_KEY_ID",
  "APPLE_API_KEY",
]) {
  if (workflow.includes(needle)) {
    ok(`release workflow contains ${needle}`);
  } else {
    fail(`release workflow does not contain ${needle}`);
  }
}

if (tauriConfig?.build?.beforeBundleCommand?.includes("sign-macos-app-binaries")) {
  ok("Tauri beforeBundleCommand signs bundled macOS helper binaries");
} else {
  fail("Tauri beforeBundleCommand does not run sign-macos-app-binaries");
}

function checkLocalIdentity() {
  if (process.platform !== "darwin") {
    const message = "local Developer ID identity check requires macOS";
    if (requireLocalIdentity) {
      fail(message);
    } else {
      warn(message);
    }
    return;
  }

  let output = "";
  try {
    output = execFileSync("security", ["find-identity", "-v", "-p", "codesigning"], {
      encoding: "utf8",
    });
  } catch (error) {
    const message = `security find-identity failed: ${error.message}`;
    if (requireLocalIdentity) {
      fail(message);
    } else {
      warn(message);
    }
    return;
  }

  const identities = output
    .split("\n")
    .map((line) => line.match(/"([^"]*Developer ID Application[^"]*)"/)?.[1])
    .filter(Boolean);
  const envIdentity = process.env.APPLE_SIGNING_IDENTITY;

  if (envIdentity && !identities.includes(envIdentity)) {
    const message = `APPLE_SIGNING_IDENTITY is set but was not found as a local Developer ID Application identity: ${envIdentity}`;
    if (requireLocalIdentity) {
      fail(message);
    } else {
      warn(message);
    }
    return;
  }

  if (identities.length > 0) {
    ok(`local Developer ID Application identity found: ${envIdentity ?? identities[0]}`);
  } else {
    const message = "no local Developer ID Application identity found in Keychain";
    if (requireLocalIdentity) {
      fail(message);
    } else {
      warn(message);
    }
  }
}

function checkGitHubSecrets() {
  const requiredSecrets = [
    "APPLE_CERTIFICATE",
    "APPLE_CERTIFICATE_PASSWORD",
    "KEYCHAIN_PASSWORD",
    "APPLE_API_ISSUER_ID",
    "APPLE_API_KEY_ID",
    "APPLE_API_KEY",
    "TAURI_SIGNING_PRIVATE_KEY",
    "TAURI_SIGNING_PRIVATE_KEY_PASSWORD",
  ];

  let output = "";
  try {
    output = execFileSync("gh", ["secret", "list", "--repo", releaseRepo], {
      encoding: "utf8",
    });
  } catch (error) {
    fail(`gh secret list failed for ${releaseRepo}: ${error.message}`);
    return;
  }

  const present = new Set(
    output
      .split("\n")
      .map((line) => line.trim().split(/\s+/)[0])
      .filter(Boolean),
  );
  const missing = requiredSecrets.filter((name) => !present.has(name));
  if (missing.length > 0) {
    fail(`missing GitHub secret(s) in ${releaseRepo}: ${missing.join(", ")}`);
  } else {
    ok(`required GitHub secrets are present in ${releaseRepo}`);
  }
}

if (!requireGitHubSecrets || requireLocalIdentity) {
  checkLocalIdentity();
}
if (requireGitHubSecrets) {
  checkGitHubSecrets();
}

for (const message of successes) {
  console.log(`[ok] ${message}`);
}
for (const message of warnings) {
  console.warn(`[warn] ${message}`);
}
for (const message of errors) {
  console.error(`[error] ${message}`);
}

if (errors.length > 0) {
  process.exit(1);
}
