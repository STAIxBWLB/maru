#!/usr/bin/env node

import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import {
  DEFAULT_RELEASE_REPOSITORY,
  UPDATER_ASSET_PAIRS,
  buildUpdaterManifest,
  parseReleaseTag,
  validateReleaseAssets,
} from "./lib/updaterManifest.mjs";

import { assertDraft, assertRepository, assetText, findRelease, getRelease,
  ghText, releaseMetadata, uploadDraftAsset } from "./lib/releaseApi.mjs";

function repositoryFromEnvironment(environment = process.env) {
  return (
    environment.MARU_RELEASE_REPO ||
    environment.GITHUB_REPOSITORY ||
    DEFAULT_RELEASE_REPOSITORY
  );
}

/**
 * Parse the intentionally small CLI surface. Unknown flags fail closed so a
 * typo cannot turn a dry run into a release upload.
 */
export function parseCliArgs(argv = []) {
  let tag;
  let dryRun = false;
  for (const argument of argv) {
    if (argument === "--dry-run") {
      if (dryRun) throw new Error("duplicate --dry-run flag");
      dryRun = true;
    } else if (argument.startsWith("--")) {
      throw new Error(`unknown option: ${argument}`);
    } else if (tag === undefined) {
      tag = argument;
    } else {
      throw new Error(`unexpected argument: ${argument}`);
    }
  }

  if (tag === undefined) {
    throw new Error("usage: node scripts/publish-updater-manifest.mjs <tag> [--dry-run]");
  }
  parseReleaseTag(tag);
  return Object.freeze({ tag, dryRun });
}

/** Draft-aware metadata: lookup uses listing, then a fixed ID, never a tag endpoint. */
export function queryReleaseMetadata(tag, repo, releaseId, runGh = ghText) {
  parseReleaseTag(tag);
  const release = releaseId === undefined ? findRelease(tag, repo, runGh) : getRelease(releaseId, repo, runGh);
  if (release.tag_name !== tag) throw new Error("release ID has a different tag; resolve the intended draft and retry Release Bundles");
  return releaseMetadata(release);
}

function signatureAssetNames(version) {
  return UPDATER_ASSET_PAIRS.map(({ signature }) => signature(version));
}

/** Read signatures by immutable asset IDs, including private draft assets. */
export function downloadUpdaterSignatures({ tag, repo, version = parseReleaseTag(tag).version, metadata, runGh = ghText }) {
  const byName = validateReleaseAssets(metadata, version);
  const signatures = new Map();
  for (const name of signatureAssetNames(version)) {
    const content = assetText(byName.get(name), repo, runGh).trim();
    if (!content) throw new Error(`signature ${name} is empty; rebuild that platform and retry Release Bundles`);
    signatures.set(name, content);
  }
  return signatures;
}

function writeManifest(directory, manifest) {
  const outputPath = join(directory, "latest.json");
  writeFileSync(outputPath, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
  return outputPath;
}

function uploadLatestJson(tag, repo, manifestPath, { releaseId, sha, rehearsal }) {
  uploadDraftAsset(manifestPath, { tag, repo, id: releaseId, sha, dryRun: rehearsal });
}

/**
 * Execute one read/build/write operation. All temporary files are scoped to a
 * dedicated directory and removed after either dry-run output or upload.
 */
export function publishUpdaterManifest(
  tag,
  {
    repo = DEFAULT_RELEASE_REPOSITORY,
    dryRun = false,
    releaseId = undefined,
    sha = undefined,
    rehearsal = false,
    runView = queryReleaseMetadata,
    runDownload = downloadUpdaterSignatures,
    runUpload = uploadLatestJson,
  } = {},
) {
  parseReleaseTag(tag);
  assertRepository(repo);
  if (!dryRun && (releaseId === undefined || sha === undefined)) {
    throw new Error("manifest upload requires the admitted draft ID and SHA; run it through Release Bundles or use --dry-run for inspection");
  }
  const metadata = runView(tag, repo, releaseId);
  if (!dryRun) assertDraft(metadata, { tag, id: releaseId, sha, dryRun: rehearsal });
  const version = parseReleaseTag(tag).version;

  // Validate all 20 pre-manifest assets before downloading any signatures or
  // writing latest.json. This is the single-writer completeness gate.
  validateReleaseAssets(metadata, version);

  const temporaryDirectory = mkdtempSync(join(tmpdir(), "maru-updater-manifest-"));
  try {
    const signatures = runDownload({ tag, repo, version, metadata });
    const manifest = buildUpdaterManifest({
      tag,
      release: metadata,
      signatures,
      repo,
    });

    if (dryRun) {
      process.stdout.write(`${JSON.stringify(manifest, null, 2)}\n`);
      return manifest;
    }

    const manifestPath = writeManifest(temporaryDirectory, manifest);
    runUpload(tag, repo, manifestPath, { releaseId, sha, rehearsal });
    console.log(`uploaded latest.json for ${tag} to ${repo}`);
    return manifest;
  } finally {
    rmSync(temporaryDirectory, { recursive: true, force: true });
  }
}

export function main(argv = process.argv.slice(2), environment = process.env) {
  const { tag, dryRun } = parseCliArgs(argv);
  const repo = repositoryFromEnvironment(environment);
  if (environment.DRY_RUN !== undefined && !["true", "false"].includes(environment.DRY_RUN)) {
    throw new Error("DRY_RUN must be true or false; correct the dispatch input and retry Release Bundles");
  }
  return publishUpdaterManifest(tag, { repo, dryRun, releaseId: environment.RELEASE_ID,
    sha: environment.RELEASE_SHA, rehearsal: environment.DRY_RUN === "true" });
}

const invokedPath = process.argv[1] ? pathToFileURL(resolve(process.argv[1])).href : null;
if (invokedPath === import.meta.url) {
  try {
    main();
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
