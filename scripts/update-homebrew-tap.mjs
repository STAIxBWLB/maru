#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { assertReleaseTag, findRelease } from "./lib/releaseApi.mjs";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const releaseRepo = process.env.MARU_RELEASE_REPO ?? "STAIxBWLB/maru";
const tapRepo = process.env.MARU_HOMEBREW_TAP ?? "STAIxBWLB/homebrew-cask";
const [tag, tapDirArg, ...options] = process.argv.slice(2);
const shouldCommit = options.includes("--commit");
const shouldPush = options.includes("--push");
const unknownOptions = options.filter((option) => option !== "--commit" && option !== "--push");

if (!tag || !tapDirArg || unknownOptions.length > 0) {
  console.error("usage: node scripts/update-homebrew-tap.mjs <tag> <tap-dir> [--commit] [--push]");
  console.error("example: node scripts/update-homebrew-tap.mjs v0.2.12 ../homebrew-cask --commit");
  process.exit(2);
}

const version = tag.replace(/^v/, "");
const tapDir = resolve(tapDirArg);

assertReleaseTag(tag);
const release = findRelease(tag, releaseRepo);
if (release.draft !== false || release.prerelease !== false) {
  throw new Error("Homebrew requires a published stable release; finish draft verification and publication before retrying the tap update");
}

function sha256For(name) {
  const asset = release.assets.find((candidate) => candidate.name === name);
  if (!asset) {
    throw new Error(`release asset not found: ${name}`);
  }
  if (!asset.digest?.startsWith("sha256:")) {
    throw new Error(`release asset has no sha256 digest: ${name}`);
  }
  return asset.digest.slice("sha256:".length);
}

const replacements = {
  VERSION: version,
  APP_ARM_SHA256: sha256For(`Maru_${version}_darwin_aarch64_dmg.dmg`),
  APP_INTEL_SHA256: sha256For(`Maru_${version}_darwin_x64_dmg.dmg`),
  CLI_ARM_SHA256: sha256For(`maru-cli_${version}_darwin_aarch64.tar.gz`),
  CLI_INTEL_SHA256: sha256For(`maru-cli_${version}_darwin_x86_64.tar.gz`),
};

function renderTemplate(templatePath, outputPath) {
  let content = readFileSync(templatePath, "utf8");
  for (const [key, value] of Object.entries(replacements)) {
    content = content.replaceAll(`{{${key}}}`, value);
  }
  mkdirSync(dirname(outputPath), { recursive: true });
  writeFileSync(outputPath, content);
  console.log(`wrote ${outputPath}`);
}

const appCaskPath = resolve(tapDir, "Casks/maru-workspace.rb");
// Pre-M0 anchor-era artifacts, removed one-time on the first Maru release
// (DR-024 §6; mirrors the earlier anchor.rb → anchor-workspace.rb migration).
const legacyPaths = ["Casks/anchor.rb", "Casks/anchor-workspace.rb", "Formula/anchor-cli.rb"];
const removedLegacy = [];

renderTemplate(
  resolve(repoRoot, "packaging/homebrew/Casks/maru-workspace.rb.template"),
  appCaskPath,
);
for (const legacyRel of legacyPaths) {
  const legacyPath = resolve(tapDir, legacyRel);
  if (existsSync(legacyPath)) {
    unlinkSync(legacyPath);
    removedLegacy.push(legacyRel);
    console.log(`removed ${legacyPath}`);
  }
}
renderTemplate(
  resolve(repoRoot, "packaging/homebrew/Formula/maru-cli.rb.template"),
  resolve(tapDir, "Formula/maru-cli.rb"),
);

if (shouldCommit || shouldPush) {
  const pathsToStage = [
    ...removedLegacy,
    "Casks/maru-workspace.rb",
    "Formula/maru-cli.rb",
  ];
  execFileSync("git", ["-C", tapDir, "add", "--all", ...pathsToStage], {
    stdio: "inherit",
  });
}

if (shouldCommit && execFileSync("git", ["-C", tapDir, "diff", "--cached", "--name-only", "--", ...removedLegacy,
  "Casks/maru-workspace.rb", "Formula/maru-cli.rb"], { encoding: "utf8" }).trim()) {
  execFileSync("git", ["-C", tapDir, "commit", "-m", `maru: update to ${tag}`, "--", ...removedLegacy,
    "Casks/maru-workspace.rb", "Formula/maru-cli.rb"], {
    stdio: "inherit",
  });
}

// The tap audits publish/** and merges it into main itself; main takes no direct
// pushes. Force so a re-run of the same release replaces a failed attempt.
const publishBranch = `publish/maru-${tag}`;
if (shouldPush) {
  execFileSync(
    "git",
    ["-C", tapDir, "push", "--force", "origin", `HEAD:refs/heads/${publishBranch}`],
    { stdio: "inherit" },
  );
}

console.log("");
console.log(`Homebrew tap target: ${tapRepo}`);
console.log("Next:");
console.log(`  cd ${tapDir}`);
console.log("  brew audit --cask staixbwlb/cask/maru-workspace");
console.log("  brew audit --formula staixbwlb/cask/maru-cli");
if (!shouldCommit) {
  const pathsForNextSteps = [
    ...removedLegacy,
    "Casks/maru-workspace.rb",
    "Formula/maru-cli.rb",
  ].join(" ");
  console.log(`  git diff -- ${pathsForNextSteps}`);
  console.log(
    `  git add --all ${pathsForNextSteps} && git commit -m "maru: update to ${tag}"`,
  );
}
