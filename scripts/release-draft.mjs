#!/usr/bin/env node
import { appendFileSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { isDeepStrictEqual } from "node:util";
import { verifyReleaseWorkflowsForSha } from "./check-release-workflows.mjs";
import { downloadUpdaterSignatures } from "./publish-updater-manifest.mjs";
import { buildUpdaterManifest, validateReleaseAssets } from "./lib/updaterManifest.mjs";
import { assertDraft, assertReleaseTag, assetText, checkTagTarget, findRelease,
  getRelease, ghJson, ghText, releaseMetadata, uploadDraftAsset } from "./lib/releaseApi.mjs";

export function parseDryRun(value = "false") {
  if (value !== "true" && value !== "false") {
    throw new Error("dry_run must be true or false; correct the dispatch input before retrying Release Bundles");
  }
  return value === "true";
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
    for (const file of files) uploadDraftAsset(file, { ...options, tag, id, sha });
    return;
  }
  if (command === "finalize" && args.length === 4) {
    const result = finalizeDraft(tag, id, sha, options);
    output(result);
    return result;
  }
  throw new Error("release-draft usage: prepare <tag>, or assert/finalize/upload <tag> <id> <sha> [files]; correct the arguments and retry Release Bundles");
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  try { await main(); } catch (error) {
    console.error(`::error::${error.message}`);
    process.exitCode = 1;
  }
}
