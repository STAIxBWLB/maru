#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, statSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { evaluateProvisioningProfile } from "./lib/provisioningProfile.mjs";
import { parseCargoPackage, validateReleaseVersions } from "./lib/releaseVersion.mjs";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const releaseRepo = process.env.MARU_RELEASE_REPO ?? "STAIxBWLB/maru";
const expectedBundleId = process.env.MARU_MACOS_BUNDLE_ID ?? "kr.maru.desktop";
const args = new Set(process.argv.slice(2));
const allowedArgs = new Set(["--github-secrets", "--require-local-identity", "--passkeys", "--help"]);

if (args.has("--help")) {
  console.log(`usage: node scripts/check-macos-direct-distribution.mjs [--github-secrets] [--require-local-identity] [--passkeys]

Checks Maru's minimum macOS direct-distribution setup.

Options:
  --github-secrets          require all GitHub Actions secrets used for signed/notarized releases
  --require-local-identity  require a local Developer ID Application signing identity
  --passkeys                validate the opt-in browser-passkey packaging prerequisites
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
const requirePasskeys = args.has("--passkeys");
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

const packageJson = readJson("package.json");
const tauriConfig = readJson("src-tauri/tauri.conf.json");
const passkeyConfig = requirePasskeys ? readJson("src-tauri/tauri.passkeys.conf.json") : null;
const cargoToml = readText("src-tauri/Cargo.toml");
const cliCargoToml = readText("src-tauri/maru-cli/Cargo.toml");
const workflow = readText(".github/workflows/release-bundles.yml");

if (packageJson && tauriConfig) {
  let cargoMetadata = null;
  try {
    cargoMetadata = JSON.parse(execFileSync(
      "cargo",
      ["metadata", "--manifest-path", "src-tauri/Cargo.toml", "--locked", "--no-deps", "--format-version", "1"],
      { cwd: repoRoot, encoding: "utf8" },
    ));
  } catch (error) {
    fail(`cargo metadata failed: ${error.message}`);
  }

  if (cargoMetadata) {
    const versionResult = validateReleaseVersions({
      packageJson,
      tauriConfig,
      rootCargoPackage: parseCargoPackage(cargoToml),
      maruCliCargoPackage: parseCargoPackage(cliCargoToml),
      cargoMetadata,
    });
    versionResult.successes.forEach(ok);
    versionResult.errors.forEach(fail);
  }

  if (tauriConfig.identifier === expectedBundleId) {
    ok(`bundle identifier is ${expectedBundleId}`);
  } else {
    fail(`bundle identifier is ${tauriConfig.identifier ?? "missing"}; expected ${expectedBundleId}`);
  }

  if (tauriConfig.productName === "Maru") {
    ok("productName is Maru");
  } else {
    warn(`productName is ${tauriConfig.productName ?? "missing"}; expected Maru for release assets`);
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

  if (tauriConfig.bundle?.macOS?.entitlements == null && tauriConfig.bundle?.macOS?.infoPlist == null) {
    ok("repo default macOS bundle has no managed passkey entitlement or browser-role metadata");
  } else {
    fail("repo default macOS bundle must not enable passkey entitlements or browser-role metadata");
  }
}

function checkCliPackaging() {
  const wrapperRelative = "src-tauri/bundle/macos/maru-cli";
  const wrapperPath = resolve(repoRoot, wrapperRelative);
  if (!existsSync(wrapperPath)) {
    fail(`${wrapperRelative} is missing`);
  } else {
    const wrapper = readFileSync(wrapperPath);
    const magic = wrapper.subarray(0, 4).toString("hex");
    const machoMagic = new Set(["feedface", "feedfacf", "cefaedfe", "cffaedfe", "cafebabe", "bebafeca"]);
    if (machoMagic.has(magic)) {
      fail("bundled maru-cli wrapper must not be a Mach-O executable");
    } else if (!wrapper.toString("utf8").startsWith("#!/bin/sh\n")) {
      fail("bundled maru-cli wrapper must be a POSIX shell script");
    } else if ((statSync(wrapperPath).mode & 0o111) === 0) {
      fail("bundled maru-cli wrapper is not executable");
    } else if (!wrapper.toString("utf8").includes('../MacOS/maru" --maru-cli "$@"')) {
      fail("bundled maru-cli wrapper does not dispatch through the GUI binary");
    } else {
      ok("bundled maru-cli is an executable non-Mach-O wrapper");
    }
  }

  if (tauriConfig?.bundle?.macOS?.files?.["Resources/maru-cli"] === "bundle/macos/maru-cli") {
    ok("default and passkey app bundles install the safe Resources maru-cli wrapper");
  } else {
    fail("default macOS bundle does not map the safe maru-cli wrapper under Resources");
  }
  if (/members\s*=\s*\[[^\]]*"maru-cli"/.test(cargoToml) && /default-members\s*=\s*\["\."\]/.test(cargoToml)) {
    ok("standalone CLI is a non-default Cargo workspace member");
  } else {
    fail("standalone CLI must be a non-default Cargo workspace member");
  }
  if (!/\[\[bin\]\][\s\S]*?name\s*=\s*"maru-cli"/.test(cargoToml)) {
    ok("root Tauri package has no maru-cli binary target");
  } else {
    fail("root Tauri package must not declare a maru-cli binary target");
  }
  if (/name\s*=\s*"maru-cli"/.test(cliCargoToml) && /package\s*=\s*"maru"[\s\S]*path\s*=\s*"\.\."/.test(cliCargoToml)) {
    ok("standalone CLI package reuses the Maru library from its workspace member");
  } else {
    fail("standalone CLI workspace package is missing or does not depend on Maru");
  }
  if (workflow.includes("-p maru-cli --bin maru-cli")) {
    ok("standalone CLI release builds its dedicated workspace package");
  } else {
    fail("standalone CLI release does not select its dedicated workspace package");
  }
  if (tauriConfig?.build?.beforeBundleCommand == null) {
    ok("Tauri app bundling does not mutate or sign standalone CLI artifacts");
  } else {
    fail("Tauri app bundling must not run a standalone CLI helper hook");
  }
}

checkCliPackaging();

function checkPasskeyPackaging() {
  const overlayMacOS = passkeyConfig?.bundle?.macOS;
  if (overlayMacOS?.entitlements === "Entitlements.plist" && overlayMacOS?.infoPlist === "Info.passkeys.plist") {
    ok("passkey overlay references the managed entitlement and browser-role metadata");
  } else {
    fail("passkey overlay does not reference Entitlements.plist and Info.passkeys.plist");
  }

  if (passkeyConfig?.bundle?.active === true) {
    ok("passkey overlay enables bundling explicitly");
  } else {
    fail("passkey overlay must enable bundling");
  }
  if (overlayMacOS?.files?.["embedded.provisionprofile"] === "Passkeys.provisionprofile") {
    ok("passkey overlay embeds the staged provisioning profile at Contents root");
  } else {
    fail("passkey overlay must map Passkeys.provisionprofile to embedded.provisionprofile");
  }

  const entitlementText = readText("src-tauri/Entitlements.plist");
  const infoText = readText("src-tauri/Info.passkeys.plist");
  if (/com\.apple\.developer\.web-browser\.public-key-credential<\/key>\s*<true\s*\/>/.test(entitlementText)) {
    ok("passkey entitlement declaration is enabled");
  } else {
    fail("passkey entitlement declaration is missing or disabled");
  }
  if (/<string>http<\/string>[\s\S]*<string>https<\/string>/.test(infoText)) {
    ok("passkey browser-role metadata declares HTTP and HTTPS");
  } else {
    fail("passkey browser-role metadata does not declare HTTP and HTTPS");
  }

  const siteViewSource = readText("src-tauri/src/site_view.rs");
  const libSource = readText("src-tauri/src/lib.rs");
  const appSource = readText("src/App.tsx");
  for (const [description, needle, source] of [
    ["opened-URL drain command", "site_view_take_opened_urls", siteViewSource],
    ["opened-URL event", "sites://open-requested", siteViewSource],
    ["HTTP/HTTPS RunEvent handler", "tauri::RunEvent::Opened { urls }", libSource],
    ["Safari passkey fallback", "site_view_open_safari", siteViewSource],
    // Apple requires a browser surface on launch; see docs/macos-passkeys.md.
    ["launch browser surface", "bootAppMode", appSource],
  ]) {
    if (source.includes(needle)) {
      ok(`passkey backend contains ${description}`);
    } else {
      fail(`passkey backend is missing ${description}`);
    }
  }

  const profileValue = process.env.MARU_MACOS_PROVISIONING_PROFILE?.trim();
  if (!profileValue) {
    fail("passkey packaging requires MARU_MACOS_PROVISIONING_PROFILE");
  } else {
    const profilePath = resolve(profileValue);
    if (!existsSync(profilePath)) {
      fail(`MARU_MACOS_PROVISIONING_PROFILE does not exist: ${profilePath}`);
    } else if (process.platform !== "darwin") {
      fail("passkey provisioning-profile validation requires macOS");
    } else {
      try {
        const decodedXml = execFileSync("security", ["cms", "-D", "-i", profilePath], {
          encoding: "utf8",
        });
        const profile = JSON.parse(execFileSync("plutil", ["-convert", "json", "-o", "-", "-"], {
          encoding: "utf8",
          input: decodedXml,
        }));
        const evaluation = evaluateProvisioningProfile(profile, {
          expectedBundleId,
          appleTeamId: process.env.APPLE_TEAM_ID ?? null,
        });
        evaluation.successes.forEach(ok);
        evaluation.warnings.forEach(warn);
        evaluation.errors.forEach(fail);

        const selectedIdentity = process.env.APPLE_SIGNING_IDENTITY?.trim();
        const certificates = Array.isArray(profile.DeveloperCertificates)
          ? profile.DeveloperCertificates
          : [];
        if (selectedIdentity && selectedIdentity !== "-") {
          const identityOutput = execFileSync("security", ["find-identity", "-v", "-p", "codesigning"], {
            encoding: "utf8",
          });
          const selectedLine = identityOutput
            .split("\n")
            .find((line) => line.includes(`"${selectedIdentity}"`));
          const selectedHash = selectedLine?.match(/\b([0-9A-F]{40})\b/i)?.[1]?.toUpperCase();
          const profileHashes = certificates.flatMap((encoded) => {
            if (typeof encoded !== "string") return [];
            try {
              const output = execFileSync(
                "openssl",
                ["x509", "-inform", "DER", "-noout", "-fingerprint", "-sha1"],
                { encoding: "utf8", input: Buffer.from(encoded, "base64") },
              );
              const hash = output.match(/Fingerprint=([0-9A-F:]+)/i)?.[1]?.replaceAll(":", "").toUpperCase();
              return hash ? [hash] : [];
            } catch {
              return [];
            }
          });
          if (!selectedHash) {
            fail("cannot resolve APPLE_SIGNING_IDENTITY fingerprint from the local Keychain");
          } else if (!profileHashes.includes(selectedHash)) {
            fail("provisioning profile DeveloperCertificates does not include APPLE_SIGNING_IDENTITY");
          } else {
            ok("provisioning profile includes the selected Developer ID certificate");
          }
        }

      } catch (error) {
        fail(`cannot decode MARU_MACOS_PROVISIONING_PROFILE: ${error.message}`);
      }
    }
  }

  if (!process.env.APPLE_SIGNING_IDENTITY || process.env.APPLE_SIGNING_IDENTITY === "-") {
    fail("passkey packaging requires APPLE_SIGNING_IDENTITY for a Developer ID Application identity");
  }
}

for (const needle of [
  "Prepare macOS signing",
  "Developer ID Application",
  "Build and upload Tauri bundles",
  "includeUpdaterJson: false",
  "max-parallel: 4",
  "scripts/publish-updater-manifest.mjs",
  "APPLE_SIGNING_IDENTITY",
  "APPLE_ID",
  "APPLE_PASSWORD",
  "APPLE_TEAM_ID",
]) {
  if (workflow.includes(needle)) {
    ok(`release workflow contains ${needle}`);
  } else {
    fail(`release workflow does not contain ${needle}`);
  }
}

const manifestPublishers = workflow.match(/node scripts\/publish-updater-manifest\.mjs/g) ?? [];
if (manifestPublishers.length === 1 && !workflow.includes("includeUpdaterJson: true")) {
  ok("release workflow has exactly one updater-manifest writer");
} else {
  fail(`release workflow must have one updater-manifest writer; found ${manifestPublishers.length}`);
}

const tauriUploadStep = workflow.indexOf("- name: Build and upload Tauri bundles");
const dmgNotarizationStep = workflow.indexOf("- name: Build, notarize, staple, and upload macOS disk image");
if (tauriUploadStep >= 0 && dmgNotarizationStep > tauriUploadStep) {
  ok("release workflow stages the DMG after the app and updater artifacts");
} else {
  fail("release workflow must stage the DMG after the app and updater artifacts");
}

for (const [description, needle] of [
  ["keep macOS DMGs out of tauri-action uploads", "--target aarch64-apple-darwin --bundles app"],
  ["keep Intel DMGs out of tauri-action uploads", "--target x86_64-apple-darwin --bundles app"],
  ["build the DMG without uploading it", "pnpm tauri bundle --target \"$TARGET\" --bundles dmg --ci"],
  ["submit the DMG to Apple notary service", "notarytool submit \"$dmg\""],
  ["staple the DMG ticket", "stapler staple \"$dmg\""],
  ["validate the stapled DMG ticket", "stapler validate \"$dmg\""],
  ["verify the DMG with Gatekeeper", "context:primary-signature \"$dmg\""],
  ["upload the DMG after validation", "gh release upload \"$RELEASE_TAG\" \"$asset\""],
]) {
  if (workflow.includes(needle)) {
    ok(`release workflow will ${description}`);
  } else {
    fail(`release workflow does not ${description}`);
  }
}

function checkLocalIdentity() {
  if (process.platform !== "darwin") {
    const message = "local Developer ID identity check requires macOS";
    if (requireLocalIdentity || requirePasskeys) {
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
    if (requireLocalIdentity || requirePasskeys) {
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
    if (requireLocalIdentity || requirePasskeys) {
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
    if (requireLocalIdentity || requirePasskeys) {
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
    "APPLE_ID",
    "APPLE_PASSWORD",
    "APPLE_TEAM_ID",
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

if (requirePasskeys) {
  checkPasskeyPackaging();
}

if (!requireGitHubSecrets || requireLocalIdentity || requirePasskeys) {
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
