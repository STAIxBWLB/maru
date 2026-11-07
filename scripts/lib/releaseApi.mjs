import { execFileSync } from "node:child_process";
import { basename } from "node:path";
import { accessSync, constants, statSync } from "node:fs";
import { RELEASE_TAG_PATTERN } from "./releaseVersion.mjs";
import { requiredReleaseAssetNames } from "./updaterManifest.mjs";

export function assertReleaseTag(tag) {
  if (!RELEASE_TAG_PATTERN.test(tag ?? "")) {
    throw new Error("release tag must be stable vX.Y.Z; use the version from the verified commit and retry Release Bundles");
  }
}

export function assertRepository(repo) {
  if (!/^[A-Za-z0-9][A-Za-z0-9_.-]*\/[A-Za-z0-9][A-Za-z0-9_.-]*(?![\s\S])/.test(repo ?? "")) {
    throw new Error("release repository must be owner/name; correct GITHUB_REPOSITORY and retry Release Bundles");
  }
}

export function releaseId(value) {
  if (!/^[1-9][0-9]*(?![\s\S])/.test(String(value)) || !Number.isSafeInteger(Number(value))) {
    throw new Error("release ID is invalid; resolve the intended draft again before retrying Release Bundles");
  }
  return Number(value);
}

/** gh authenticates through its private environment, never an argv token.
 * @param {string[]} args
 * @param {{input?: string}} [options]
 */
export function ghText(args, options = {}) {
  try {
    return execFileSync("gh", args, {
      encoding: "utf8", stdio: ["pipe", "pipe", "pipe"],
      timeout: 60_000, maxBuffer: 64 * 1024 * 1024, ...options,
    });
  } catch (error) {
    const httpStatus = Number(error?.stderr?.toString().match(/HTTP (\d{3})/)?.[1]) || undefined;
    const cause = httpStatus ? `HTTP ${httpStatus}` : `gh ${error?.code ?? error?.status ?? "failure"}`;
    throw Object.assign(new Error(`GitHub release operation failed (${cause}); check gh availability/authentication, repository permissions and the draft, then retry Release Bundles`), { httpStatus });
  }
}

export function ghJson(args, runGh = ghText, options = {}) {
  try {
    return JSON.parse(runGh(args, options));
  } catch (error) {
    if (error instanceof SyntaxError) {
      throw new Error("GitHub returned malformed release JSON; inspect the API response and retry Release Bundles");
    }
    throw error;
  }
}

export function getRelease(id, repo, runGh = ghText) {
  assertRepository(repo);
  const value = ghJson(["api", "--method", "GET", `repos/${repo}/releases/${releaseId(id)}`], runGh);
  if (value?.id !== releaseId(id) || typeof value.draft !== "boolean" || typeof value.prerelease !== "boolean"
    || !Array.isArray(value.assets) || value.assets.some((asset) => !asset || typeof asset.name !== "string")) {
    throw new Error("release response is missing identity, state or asset data; resolve the draft again and retry Release Bundles");
  }
  return value;
}

export function findRelease(tag, repo, runGh = ghText) {
  assertReleaseTag(tag);
  assertRepository(repo);
  // REST's tag endpoint omits drafts. List every page, then use the immutable
  // ID. gh does not allow --jq together with --slurp; filter identities here.
  const pages = ghJson(["api", "--method", "GET", `repos/${repo}/releases?per_page=100`,
    "--paginate", "--slurp"], runGh);
  if (!Array.isArray(pages)) throw new Error("release listing is malformed; inspect the API response and retry Release Bundles");
  const entries = pages.flat().map((entry) => ({ id: entry?.id, tag_name: entry?.tag_name }));
  const matches = entries.filter((entry) => entry?.tag_name === tag);
  if (matches.length !== 1) {
    throw new Error(`expected one release for ${tag}, found ${matches.length}; check release visibility, create or select one unambiguous draft with --target <full SHA>, then retry Release Bundles`);
  }
  const release = getRelease(matches[0].id, repo, runGh);
  if (release.tag_name !== tag) {
    throw new Error("release tag changed after listing; resolve the intended draft again and retry Release Bundles");
  }
  return release;
}

export function assertDraft(release, { tag, id = release?.id, sha = release?.target_commitish, dryRun = false }) {
  assertReleaseTag(tag);
  if (!/^[a-f0-9]{40}(?![\s\S])/.test(sha ?? "")) {
    throw new Error("draft requires an immutable target SHA; create it with --draft --target <full SHA> and retry Release Bundles");
  }
  if (release?.id !== releaseId(id) || release.tag_name !== tag || release.target_commitish !== sha) {
    throw new Error("draft ID, tag or immutable target SHA changed; restore the admitted draft target and retry Release Bundles");
  }
  if (release.draft !== true) {
    throw new Error("release is already public; use a new unpublished version draft for builds, or the documented tap-only recovery after publication");
  }
  if (release.prerelease && !dryRun) {
    throw new Error("prerelease drafts cannot be published by the stable release flow; use dry_run for a rehearsal or select the intended stable draft");
  }
  return sha;
}

export function checkTagTarget(tag, sha, repo, runGh = ghText, required = false) {
  assertReleaseTag(tag);
  assertRepository(repo);
  let commits;
  try {
    commits = ghJson(["api", "--method", "GET", `repos/${repo}/commits`,
      "-f", `sha=refs/tags/${tag}`, "-f", "per_page=1"], runGh);
  } catch (error) {
    if (error.httpStatus === 404 && !required) return;
    throw error;
  }
  if (!Array.isArray(commits) || commits[0]?.sha !== sha) {
    throw new Error(`tag ${tag} does not point to the admitted SHA; inspect the tag and draft target before retrying Release Bundles`);
  }
}

export function releaseMetadata(release) {
  const timestamp = release.published_at ?? release.created_at;
  if (typeof timestamp !== "string" || Number.isNaN(Date.parse(timestamp))) {
    throw new Error("release creation/publication timestamp is missing or invalid; inspect the release metadata and retry Release Bundles");
  }
  return {
    ...release, tagName: release.tag_name,
    // Drafts have no publication time; creation time is stable across retries.
    publishedAt: timestamp,
  };
}

export function assetText(asset, repo, runGh = ghText) {
  assertRepository(repo);
  return runGh(["api", "--method", "GET", `repos/${repo}/releases/assets/${releaseId(asset?.id)}`,
    "-H", "Accept: application/octet-stream"]);
}

export function validateReleaseAssetFile(file, { tag, name = basename(file) }) {
  let info;
  try { info = statSync(file); } catch {
    throw new Error(`release asset ${name} is unreadable; rebuild the required file and retry Release Bundles`);
  }
  if (![...requiredReleaseAssetNames(tag), "latest.json"].includes(name) || !info.isFile() || info.size <= 0) {
    throw new Error(`invalid or empty release asset ${name}; rebuild the required bundle/signature and retry Release Bundles`);
  }
  try { accessSync(file, constants.R_OK); } catch {
    throw new Error(`release asset ${name} is unreadable; rebuild the required file and retry Release Bundles`);
  }
}

export function uploadDraftAsset(file, { tag, id, sha, repo, dryRun = false, name = basename(file), runGh = ghText }) {
  const release = getRelease(id, repo, runGh);
  assertDraft(release, { tag, id, sha, dryRun });
  validateReleaseAssetFile(file, { tag, name });
  for (const existing of release.assets.filter((asset) => asset.name === name)) {
    runGh(["api", "--method", "DELETE", `repos/${repo}/releases/assets/${releaseId(existing.id)}`]);
  }
  return ghJson(["api", "--method", "POST",
    `https://uploads.github.com/repos/${repo}/releases/${releaseId(id)}/assets?name=${name}`,
    "-H", "Content-Type: application/octet-stream", "--input", file], runGh);
}
