#!/usr/bin/env node

import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
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

const GH_COMMAND = "gh";

function repositoryFromEnvironment(environment = process.env) {
  return (
    environment.MARU_RELEASE_REPO ||
    environment.GITHUB_REPOSITORY ||
    DEFAULT_RELEASE_REPOSITORY
  );
}

function assertRepository(repo) {
  if (typeof repo !== "string" || !/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repo)) {
    throw new Error(`malformed GitHub repository: ${String(repo)}`);
  }
  return repo;
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

function runGhJson(args) {
  try {
    return execFileSync(GH_COMMAND, args, {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    });
  } catch {
    // Never echo gh's stderr: the CLI may include request details or an
    // environment-specific credential hint. The command has no token in its
    // argument vector, and gh reads GH_TOKEN from its private environment.
    throw new Error("gh command failed while reading release metadata");
  }
}

/**
 * Query only the release fields needed to construct latest.json. Keeping this
 * command centralized makes it difficult for a future caller to accidentally
 * use a token-bearing URL or a broad API response.
 */
export function queryReleaseMetadata(tag, repo, runGh = runGhJson) {
  parseReleaseTag(tag);
  assertRepository(repo);
  const output = runGh([
    "release",
    "view",
    tag,
    "--repo",
    repo,
    "--json",
    "assets,body,publishedAt,tagName",
  ]);
  try {
    const metadata = JSON.parse(output);
    if (!metadata || typeof metadata !== "object" || !Array.isArray(metadata.assets)) {
      throw new Error("release metadata does not contain an assets array");
    }
    return metadata;
  } catch (error) {
    if (error instanceof SyntaxError) {
      throw new Error("gh returned malformed release metadata JSON");
    }
    throw error;
  }
}

function signatureAssetNames(version) {
  return UPDATER_ASSET_PAIRS.map(({ signature }) => signature(version));
}

function runGhDownload(args) {
  try {
    execFileSync(GH_COMMAND, args, {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    });
  } catch {
    // Do not print the original error or stderr. In particular, do not expose
    // GH_TOKEN through a verbose command failure path.
    throw new Error("gh command failed while downloading release signatures");
  }
}

/**
 * Download each signature directly into a caller-owned temporary path. `gh`
 * performs authenticated access using GH_TOKEN without the token appearing in
 * a URL, command argument, or log line.
 *
 * @param {{ tag?: string, repo?: string, version?: string, directory?: string, runGh?: (args: string[]) => void }} [options]
 */
export function downloadUpdaterSignatures({
  tag,
  repo,
  version = parseReleaseTag(tag).version,
  directory,
  runGh = runGhDownload,
} = {}) {
  parseReleaseTag(tag);
  assertRepository(repo);
  if (typeof directory !== "string" || directory.length === 0) {
    throw new TypeError("signature download directory must be provided");
  }

  const signatures = new Map();
  for (const name of signatureAssetNames(version)) {
    const outputPath = resolve(directory, name);
    runGh([
      "release",
      "download",
      tag,
      "--repo",
      repo,
      "--pattern",
      name,
      "--output",
      outputPath,
    ]);
    if (!existsSync(outputPath)) {
      throw new Error(`downloaded signature file is missing: ${name}`);
    }
    const content = readFileSync(outputPath, "utf8").trim();
    if (content.length === 0) {
      throw new Error(`downloaded signature file is empty: ${name}`);
    }
    signatures.set(name, content);
  }
  return signatures;
}

function writeManifest(directory, manifest) {
  const outputPath = join(directory, "latest.json");
  writeFileSync(outputPath, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
  return outputPath;
}

function uploadLatestJson(tag, repo, manifestPath) {
  try {
    execFileSync(
      GH_COMMAND,
      ["release", "upload", tag, manifestPath, "--repo", repo, "--clobber"],
      { stdio: "inherit" },
    );
  } catch {
    throw new Error("gh command failed while uploading latest.json");
  }
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
    runView = queryReleaseMetadata,
    runDownload = downloadUpdaterSignatures,
    runUpload = uploadLatestJson,
  } = {},
) {
  parseReleaseTag(tag);
  assertRepository(repo);
  const metadata = runView(tag, repo);
  const version = parseReleaseTag(tag).version;

  // Validate all 20 pre-manifest assets before downloading any signatures or
  // writing latest.json. This is the single-writer completeness gate.
  validateReleaseAssets(metadata, version);

  const temporaryDirectory = mkdtempSync(join(tmpdir(), "maru-updater-manifest-"));
  try {
    const signatures = runDownload({ tag, repo, version, directory: temporaryDirectory });
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
    runUpload(tag, repo, manifestPath);
    console.log(`uploaded latest.json for ${tag} to ${repo}`);
    return manifest;
  } finally {
    rmSync(temporaryDirectory, { recursive: true, force: true });
  }
}

export function main(argv = process.argv.slice(2), environment = process.env) {
  const { tag, dryRun } = parseCliArgs(argv);
  const repo = repositoryFromEnvironment(environment);
  return publishUpdaterManifest(tag, { repo, dryRun });
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
