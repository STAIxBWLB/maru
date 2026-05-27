#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const releaseRepo = process.env.ANCHOR_RELEASE_REPO ?? "STAIxBWLB/anchor";
const tapRepo = process.env.ANCHOR_HOMEBREW_TAP ?? "STAIxBWLB/homebrew-cask";
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

const release = JSON.parse(
  execFileSync("gh", ["release", "view", tag, "--repo", releaseRepo, "--json", "assets"], {
    encoding: "utf8",
  }),
);

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
  APP_ARM_SHA256: sha256For(`Anchor_${version}_darwin_aarch64_dmg.dmg`),
  APP_INTEL_SHA256: sha256For(`Anchor_${version}_darwin_x64_dmg.dmg`),
  CLI_ARM_SHA256: sha256For(`anchor-cli_${version}_darwin_aarch64.tar.gz`),
  CLI_INTEL_SHA256: sha256For(`anchor-cli_${version}_darwin_x86_64.tar.gz`),
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

const appCaskPath = resolve(tapDir, "Casks/anchor-workspace.rb");
const legacyAppCaskPath = resolve(tapDir, "Casks/anchor.rb");
const hadLegacyAppCask = existsSync(legacyAppCaskPath);

renderTemplate(
  resolve(repoRoot, "packaging/homebrew/Casks/anchor-workspace.rb.template"),
  appCaskPath,
);
if (hadLegacyAppCask) {
  unlinkSync(legacyAppCaskPath);
  console.log(`removed ${legacyAppCaskPath}`);
}
renderTemplate(
  resolve(repoRoot, "packaging/homebrew/Formula/anchor-cli.rb.template"),
  resolve(tapDir, "Formula/anchor-cli.rb"),
);

if (shouldCommit || shouldPush) {
  const pathsToStage = ["Casks/anchor-workspace.rb", "Formula/anchor-cli.rb"];
  if (hadLegacyAppCask) {
    pathsToStage.unshift("Casks/anchor.rb");
  }
  execFileSync("git", ["-C", tapDir, "add", "--all", ...pathsToStage], {
    stdio: "inherit",
  });
}

if (shouldCommit) {
  execFileSync("git", ["-C", tapDir, "commit", "-m", `anchor: update to ${tag}`], {
    stdio: "inherit",
  });
}

if (shouldPush) {
  execFileSync("git", ["-C", tapDir, "push"], { stdio: "inherit" });
}

console.log("");
console.log(`Homebrew tap target: ${tapRepo}`);
console.log("Next:");
console.log(`  cd ${tapDir}`);
console.log("  brew audit --cask anchor-workspace");
console.log("  brew audit --formula anchor-cli");
if (!shouldCommit) {
  const pathsForNextSteps = hadLegacyAppCask
    ? "Casks/anchor.rb Casks/anchor-workspace.rb Formula/anchor-cli.rb"
    : "Casks/anchor-workspace.rb Formula/anchor-cli.rb";
  console.log(`  git diff -- ${pathsForNextSteps}`);
  console.log(
    `  git add --all ${pathsForNextSteps} && git commit -m "anchor: update to ${tag}"`,
  );
}
