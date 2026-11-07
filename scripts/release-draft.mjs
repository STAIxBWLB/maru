#!/usr/bin/env node
import { appendFileSync } from "node:fs";
import { basename, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { isDeepStrictEqual } from "node:util";
import { verifyReleaseWorkflowsForSha } from "./check-release-workflows.mjs";
import { downloadUpdaterSignatures } from "./publish-updater-manifest.mjs";
import { buildUpdaterManifest, validateReleaseAssets, UPDATER_ASSET_PAIRS } from "./lib/updaterManifest.mjs";
import { assertDraft, assertReleaseTag, assetText, checkTagTarget, findRelease,
  getRelease, ghJson, ghText, releaseMetadata, uploadDraftAsset, validateReleaseAssetFile } from "./lib/releaseApi.mjs";

export function parseDryRun(value = "false") {
  if (value !== "true" && value !== "false") {
    throw new Error("dry_run must be true or false; correct the dispatch input before retrying Release Bundles");
  }
  return value === "true";
}

/** Keep the release-name factories shared with final manifest validation.
 * The pinned action reports a raw .app directory as well as its signed archive;
 * only the archive/signature pair is a release upload.
 */
export function planTauriUploads(paths, { tag, platform, target = "", appVersion }) {
  assertReleaseTag(tag);
  const version = tag.slice(1);
  if (appVersion !== version) {
    throw new Error("Tauri build version differs from the admitted tag; inspect appVersion and rebuild the matching release before upload");
  }
  /** @type {[string, number][]} */
  let bundles;
  if (platform === "macos-26" && ["aarch64-apple-darwin", "x86_64-apple-darwin"].includes(target)) {
    bundles = [["Maru.app.tar.gz", target === "aarch64-apple-darwin" ? 0 : 1]];
  } else if (platform === "windows-latest" && !target) {
    bundles = [[`Maru_${version}_x64_en-US.msi`, 5], [`Maru_${version}_x64-setup.exe`, 6]];
  } else if (platform === "ubuntu-22.04" && !target) {
    bundles = [[`Maru_${version}_amd64.AppImage`, 2], [`Maru_${version}_amd64.deb`, 3], [`Maru-${version}-1.x86_64.rpm`, 4]];
  } else {
    throw new Error("Tauri upload platform/target is unsupported; align the release matrix and artifact mapping before retrying Release Bundles");
  }
  if (!Array.isArray(paths) || paths.length === 0 || paths.some((file) => typeof file !== "string" || !file)) {
    throw new Error("Tauri build did not report artifact paths; inspect the build output and rerun Release Bundles");
  }
  const uploads = new Map();
  for (const file of paths) {
    const leaf = basename(file.replaceAll("\\", "/"));
    if (platform === "macos-26" && leaf === "Maru.app") continue;
    const signature = leaf.endsWith(".sig");
    const payload = signature ? leaf.slice(0, -4) : leaf;
    const bundle = bundles.find(([expected]) => payload === expected);
    if (!bundle) {
      throw new Error("Tauri build reported an unexpected artifact name/version; inspect artifactPaths and rebuild the admitted version, or review an intentional bundle-format change before retrying Release Bundles");
    }
    const pair = UPDATER_ASSET_PAIRS[bundle[1]];
    const name = signature ? pair.signature(version) : pair.payload(version);
    if (uploads.has(name)) {
      throw new Error("Tauri build reported duplicate release assets; inspect artifactPaths and rebuild one production bundle per name before retrying");
    }
    uploads.set(name, { file, name });
  }
  const expected = bundles.flatMap(([, index]) => {
    const pair = UPDATER_ASSET_PAIRS[index];
    return [pair.payload(version), pair.signature(version)];
  });
  if (uploads.size !== expected.length || expected.some((name) => !uploads.has(name))) {
    throw new Error("Tauri build is missing a bundle or signature; inspect artifactPaths and rebuild complete signed pairs before retrying Release Bundles");
  }
  return [...uploads.values()];
}

export function uploadTauriArtifacts(paths, { tag, id, sha, repo, dryRun = false, runGh = ghText,
  platform, target = "", appVersion }) {
  const uploads = planTauriUploads(paths, { tag, platform, target, appVersion });
  // Reject a bad later artifact before any earlier asset is replaced. Keep
  // the shared per-file check too, since files can change after preflight.
  for (const { file, name } of uploads) validateReleaseAssetFile(file, { tag, name });
  // The release may have changed while the action built. Every shared upload
  // re-fetches/asserts the ID immediately before any asset deletion or write.
  for (const { file, name } of uploads) {
    uploadDraftAsset(file, { tag, id, sha, repo, dryRun, name, runGh });
  }
  return uploads;
}

export async function prepareDraft(tag, { repo = undefined, dryRun = false, runGh = ghText,
  verify = verifyReleaseWorkflowsForSha, report = console.log } = {}) {
  const draft = findRelease(tag, repo, runGh);
  const sha = assertDraft(draft, { tag, dryRun });
  const commits = ghJson(["api", "--method", "GET", `repos/${repo}/commits`,
    "-f", `sha=${sha}`, "-f", "per_page=1"], runGh);
  if (!Array.isArray(commits) || commits[0]?.sha !== sha) {
    throw new Error("draft target did not resolve to its exact SHA in this repository; correct --target and retry Release Bundles");
  }
  checkTagTarget(tag, sha, repo, runGh);
  if (await verify(tag, repo, sha) !== sha) {
    throw new Error("workflow admission returned a different SHA; inspect the release gate and rerun Release Bundles");
  }
  // Admission may wait 50 minutes. Do not build a retargeted or published draft.
  assertDraft(getRelease(draft.id, repo, runGh), { tag, id: draft.id, sha, dryRun });
  checkTagTarget(tag, sha, repo, runGh);
  report(`Admitted draft ${draft.id} for ${tag} at ${sha}`);
  return { tag, id: draft.id, sha };
}

function assetSnapshot(assets) {
  return assets.map(({ id, name, size, digest, state }) => ({ id, name, size, digest, state }))
    .sort((a, b) => a.name.localeCompare(b.name));
}

export function verifyCompletedDraft(release, { tag, id, sha, repo, dryRun = false, runGh = ghText }) {
  assertDraft(release, { tag, id, sha, dryRun });
  let byName;
  try { byName = validateReleaseAssets(release, tag); } catch (error) {
    throw new Error(`${error.message}; rebuild the missing draft assets and retry Release Bundles`);
  }
  if (release.assets.length !== 21 || !byName.has("latest.json") || release.assets.some((asset) =>
    asset.state !== "uploaded" || !Number.isSafeInteger(asset.size) || asset.size <= 0
    || !/^sha256:[a-f0-9]{64}(?![\s\S])/.test(asset.digest ?? ""))) {
    throw new Error("draft must contain exactly 21 non-empty uploaded assets with SHA-256 digests; rebuild incomplete assets and retry Release Bundles");
  }
  const signatures = downloadUpdaterSignatures({ tag, repo, metadata: release, runGh });
  const expected = buildUpdaterManifest({ tag, release: releaseMetadata(release), signatures, repo });
  let actual;
  try { actual = JSON.parse(assetText(byName.get("latest.json"), repo, runGh)); } catch (error) {
    throw new Error(`draft latest.json could not be read as JSON; regenerate it with Release Bundles before publication. Cause: ${error.message}`);
  }
  if (!isDeepStrictEqual(actual, expected)) {
    throw new Error("draft latest.json does not match its release assets and signatures; regenerate it through Release Bundles before publication");
  }
  return expected;
}

export function finalizeDraft(tag, id, sha, { repo = undefined, dryRun = false, runGh = ghText, report = console.log } = {}) {
  const draft = getRelease(id, repo, runGh);
  verifyCompletedDraft(draft, { tag, id, sha, repo, dryRun, runGh });
  const fresh = getRelease(id, repo, runGh);
  assertDraft(fresh, { tag, id, sha, dryRun });
  if (fresh.body !== draft.body || fresh.created_at !== draft.created_at
    || !isDeepStrictEqual(assetSnapshot(fresh.assets), assetSnapshot(draft.assets))) {
    throw new Error("draft changed during asset verification; rerun Release Bundles against a settled draft before publishing");
  }
  checkTagTarget(tag, sha, repo, runGh);
  if (dryRun) {
    report(`Verified 21 draft assets for ${tag}; dry_run keeps draft ${id} private and skips Homebrew.`);
    return { published: false };
  }
  let published;
  try {
    published = ghJson(["api", "--method", "PATCH", `repos/${repo}/releases/${id}`, "--input", "-"],
      runGh, { input: JSON.stringify({ draft: false, make_latest: "true", tag_name: tag, target_commitish: sha }) });
  } catch (error) {
    const cause = error.message.split(";")[0];
    throw new Error(`release publication could not be confirmed (${cause}); inspect the release state before retrying. If still draft, retry Release Bundles; if public, use the documented tap-only recovery`);
  }
  if (published.id !== Number(id) || published.draft !== false || published.tag_name !== tag) {
    throw new Error("release publication response did not confirm the admitted release; inspect its state before any tap-only recovery");
  }
  try { checkTagTarget(tag, sha, repo, runGh, true); } catch (error) {
    const cause = error.message.split(";")[0];
    throw new Error(`release is public but tag confirmation failed (${cause}); inspect its tag and admitted SHA before the documented tap-only recovery, without rebuilding public assets`);
  }
  report(`Published completed release ${tag}: https://github.com/${repo}/releases/tag/${tag}`);
  return { published: true };
}

function output(values) {
  if (!process.env.GITHUB_OUTPUT) return;
  try {
    appendFileSync(process.env.GITHUB_OUTPUT, Object.entries(values).map(([key, value]) => `${key}=${value}\n`).join(""));
  } catch {
    throw new Error("release outputs could not be recorded; check runner file permissions and retry Release Bundles");
  }
}

export async function main(args = process.argv.slice(2), environment = process.env) {
  const [command, tag, id, sha, ...files] = args;
  const repo = environment.GITHUB_REPOSITORY;
  const dryRun = parseDryRun(environment.DRY_RUN);
  const options = { repo, dryRun };
  assertReleaseTag(tag);
  if (command === "prepare" && args.length === 2) {
    const admitted = await prepareDraft(tag, options);
    output(admitted);
    return admitted;
  }
  if (command === "assert" && args.length === 4) {
    assertDraft(getRelease(id, repo), { tag, id, sha, dryRun });
    checkTagTarget(tag, sha, repo);
    return;
  }
  if (command === "upload" && files.length > 0) {
    if (files.length === 1 && files[0] === "--tauri-artifacts") {
      let paths;
      try { paths = JSON.parse(environment.TAURI_ARTIFACT_PATHS ?? ""); } catch {
        throw new Error("Tauri artifactPaths output is not valid JSON; inspect the build step outputs and retry Release Bundles");
      }
      return uploadTauriArtifacts(paths, { ...options, tag, id, sha,
        platform: environment.TAURI_PLATFORM, target: environment.TAURI_TARGET,
        appVersion: environment.TAURI_APP_VERSION });
    }
    if (files.some((file) => file.startsWith("--"))) {
      throw new Error("unknown draft upload option; use artifact file paths or only --tauri-artifacts and retry Release Bundles");
    }
    for (const file of files) uploadDraftAsset(file, { ...options, tag, id, sha });
    return;
  }
  if (command === "finalize" && args.length === 4) {
    const result = finalizeDraft(tag, id, sha, options);
    output(result);
    return result;
  }
  throw new Error("release-draft usage: prepare <tag>, or assert/finalize/upload <tag> <id> <sha> [files|--tauri-artifacts]; correct the arguments and retry Release Bundles");
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  try { await main(); } catch (error) {
    console.error(`::error::${error.message}`);
    process.exitCode = 1;
  }
}
