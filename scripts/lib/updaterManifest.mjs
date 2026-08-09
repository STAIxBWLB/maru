/**
 * Pure construction and validation for the Tauri updater manifest.
 *
 * GitHub release metadata and signature downloads live in
 * `scripts/publish-updater-manifest.mjs`. Keeping this module free of process,
 * filesystem, and network access makes the release contract easy to exercise
 * in unit tests.
 */

// Maru's release checker and workflows intentionally publish only stable
// vX.Y.Z tags. Pre-release/build suffixes are not valid updater feed inputs.
const SEMVER_TAG = /^v\d+\.\d+\.\d+$/;

export const DEFAULT_RELEASE_REPOSITORY = "STAIxBWLB/maru";

/**
 * The assets that must exist before latest.json is generated. The two CLI
 * checksum files and the two macOS DMGs are intentionally included here even
 * though they are not updater payloads: a manifest must never publish while a
 * release is only partially assembled.
 */
export const REQUIRED_ASSET_GROUPS = Object.freeze({
  cli: Object.freeze([
    (version) => `maru-cli_${version}_darwin_aarch64.tar.gz`,
    (version) => `maru-cli_${version}_darwin_aarch64.tar.gz.sha256`,
    (version) => `maru-cli_${version}_darwin_x86_64.tar.gz`,
    (version) => `maru-cli_${version}_darwin_x86_64.tar.gz.sha256`,
  ]),
  mac: Object.freeze([
    (version) => `Maru_${version}_darwin_aarch64_app.app.tar.gz`,
    (version) => `Maru_${version}_darwin_aarch64_app.app.tar.gz.sig`,
    (version) => `Maru_${version}_darwin_aarch64_dmg.dmg`,
    (version) => `Maru_${version}_darwin_x64_app.app.tar.gz`,
    (version) => `Maru_${version}_darwin_x64_app.app.tar.gz.sig`,
    (version) => `Maru_${version}_darwin_x64_dmg.dmg`,
  ]),
  linux: Object.freeze([
    (version) => `Maru_${version}_linux_amd64_appimage.AppImage`,
    (version) => `Maru_${version}_linux_amd64_appimage.AppImage.sig`,
    (version) => `Maru_${version}_linux_amd64_deb.deb`,
    (version) => `Maru_${version}_linux_amd64_deb.deb.sig`,
    (version) => `Maru_${version}_linux_x86_64_rpm.rpm`,
    (version) => `Maru_${version}_linux_x86_64_rpm.rpm.sig`,
  ]),
  windows: Object.freeze([
    (version) => `Maru_${version}_windows_x64_msi.msi`,
    (version) => `Maru_${version}_windows_x64_msi.msi.sig`,
    (version) => `Maru_${version}_windows_x64_nsis.exe`,
    (version) => `Maru_${version}_windows_x64_nsis.exe.sig`,
  ]),
});

/**
 * The seven payload/signature pairs produced by Tauri. Each pair fans out to
 * one or more platform keys below. Keep this list separate from the full
 * release asset list so the pre-manifest completeness check remains obvious.
 */
export const UPDATER_ASSET_PAIRS = Object.freeze([
  Object.freeze({
    payload: (version) => `Maru_${version}_darwin_aarch64_app.app.tar.gz`,
    signature: (version) => `Maru_${version}_darwin_aarch64_app.app.tar.gz.sig`,
  }),
  Object.freeze({
    payload: (version) => `Maru_${version}_darwin_x64_app.app.tar.gz`,
    signature: (version) => `Maru_${version}_darwin_x64_app.app.tar.gz.sig`,
  }),
  Object.freeze({
    payload: (version) => `Maru_${version}_linux_amd64_appimage.AppImage`,
    signature: (version) => `Maru_${version}_linux_amd64_appimage.AppImage.sig`,
  }),
  Object.freeze({
    payload: (version) => `Maru_${version}_linux_amd64_deb.deb`,
    signature: (version) => `Maru_${version}_linux_amd64_deb.deb.sig`,
  }),
  Object.freeze({
    payload: (version) => `Maru_${version}_linux_x86_64_rpm.rpm`,
    signature: (version) => `Maru_${version}_linux_x86_64_rpm.rpm.sig`,
  }),
  Object.freeze({
    payload: (version) => `Maru_${version}_windows_x64_msi.msi`,
    signature: (version) => `Maru_${version}_windows_x64_msi.msi.sig`,
  }),
  Object.freeze({
    payload: (version) => `Maru_${version}_windows_x64_nsis.exe`,
    signature: (version) => `Maru_${version}_windows_x64_nsis.exe.sig`,
  }),
]);

/**
 * Exact platform aliases consumed by the Tauri updater. The aliases are kept
 * in the same order as the v0.4.47-compatible manifest so serialized output is
 * stable and reviewable.
 */
export const UPDATER_PLATFORM_MAPPINGS = Object.freeze([
  Object.freeze({ key: "darwin-aarch64", pair: 0 }),
  Object.freeze({ key: "darwin-aarch64-app", pair: 0 }),
  Object.freeze({ key: "darwin-x86_64", pair: 1 }),
  Object.freeze({ key: "darwin-x86_64-app", pair: 1 }),
  Object.freeze({ key: "linux-x86_64", pair: 2 }),
  Object.freeze({ key: "linux-x86_64-appimage", pair: 2 }),
  Object.freeze({ key: "linux-x86_64-deb", pair: 3 }),
  Object.freeze({ key: "linux-x86_64-rpm", pair: 4 }),
  Object.freeze({ key: "windows-x86_64", pair: 5 }),
  Object.freeze({ key: "windows-x86_64-msi", pair: 5 }),
  Object.freeze({ key: "windows-x86_64-nsis", pair: 6 }),
]);

export const REQUIRED_PLATFORM_KEYS = Object.freeze(
  UPDATER_PLATFORM_MAPPINGS.map(({ key }) => key),
);

function versionFromInput(versionOrTag) {
  if (typeof versionOrTag !== "string" || versionOrTag.length === 0) {
    throw new TypeError("release version/tag must be a non-empty string");
  }

  if (versionOrTag.startsWith("v")) {
    return parseReleaseTag(versionOrTag).version;
  }

  if (!SEMVER_TAG.test(`v${versionOrTag}`)) {
    throw new Error(`malformed release version: ${versionOrTag}`);
  }
  return versionOrTag;
}

/**
 * Parse and validate a release tag before it is used in asset names or a gh
 * invocation. This is deliberately a semver-shaped allow-list, not a loose
 * `startsWith("v")` check, so malformed input cannot publish a partial feed.
 */
export function parseReleaseTag(tag) {
  if (typeof tag !== "string" || !SEMVER_TAG.test(tag)) {
    throw new Error(
      `malformed release tag: ${String(tag)} (expected vMAJOR.MINOR.PATCH)`,
    );
  }

  return Object.freeze({ tag, version: tag.slice(1) });
}

/**
 * Return the complete pre-manifest asset name set for a release version.
 */
export function requiredReleaseAssetNames(versionOrTag) {
  const version = versionFromInput(versionOrTag);
  return Object.freeze(
    Object.values(REQUIRED_ASSET_GROUPS).flatMap((group) => group.map((name) => name(version))),
  );
}

function releaseAssetsFrom(input) {
  if (Array.isArray(input)) return input;
  if (input && Array.isArray(input.assets)) return input.assets;
  throw new TypeError("release metadata must contain an assets array");
}

/**
 * Validate release asset identity and completeness. The returned map is a
 * fresh map, so callers cannot mutate the release metadata while a manifest is
 * being built.
 */
export function validateReleaseAssets(input, versionOrTag) {
  const assets = releaseAssetsFrom(input);
  const version = versionFromInput(versionOrTag);
  const byName = new Map();

  for (const asset of assets) {
    if (!asset || typeof asset.name !== "string" || asset.name.length === 0) {
      throw new Error("release asset is missing a name");
    }
    if (byName.has(asset.name)) {
      throw new Error(`duplicate release asset: ${asset.name}`);
    }
    byName.set(asset.name, asset);
  }

  const missing = requiredReleaseAssetNames(version)
    .filter((name) => !byName.has(name));
  if (missing.length > 0) {
    throw new Error(`missing release asset(s): ${missing.join(", ")}`);
  }

  return byName;
}

function normalizeSignatureEntries(signatures) {
  if (signatures instanceof Map) return [...signatures.entries()];
  if (Array.isArray(signatures)) {
    return signatures.map((entry) => {
      if (Array.isArray(entry) && entry.length === 2) return entry;
      if (!entry || typeof entry.name !== "string") {
        throw new Error("signature entry is missing a name");
      }
      return [entry.name, entry.content ?? entry.signature];
    });
  }
  if (signatures && typeof signatures === "object") return Object.entries(signatures);
  throw new TypeError("signatures must be a Map, object, or entry array");
}

function normalizeSignatures(signatures) {
  const byName = new Map();
  for (const [name, value] of normalizeSignatureEntries(signatures)) {
    if (typeof name !== "string" || name.length === 0) {
      throw new Error("signature entry is missing a name");
    }
    if (byName.has(name)) {
      throw new Error(`duplicate signature content: ${name}`);
    }
    if (typeof value !== "string" && !Buffer.isBuffer(value)) {
      throw new Error(`missing signature content: ${name}`);
    }
    const content = String(value).trim();
    if (content.length === 0) {
      throw new Error(`missing signature content: ${name}`);
    }
    byName.set(name, content);
  }
  return byName;
}

function signatureFor(signatures, payloadName, signatureName) {
  // Accepting a payload-name key is useful to callers that associate a
  // downloaded signature directly with its payload. The normal path uses the
  // actual `.sig` asset name and is what the publisher returns.
  const value = signatures.get(signatureName) ?? signatures.get(payloadName);
  if (value === undefined) {
    throw new Error(`missing signature content: ${signatureName}`);
  }
  return value;
}

function repositoryParts(repo) {
  if (typeof repo !== "string" || !/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repo)) {
    throw new Error(`malformed GitHub repository: ${String(repo)}`);
  }
  return repo.split("/");
}

function downloadUrl(asset, { tag, repo }) {
  const candidate = asset?.url ?? asset?.browser_download_url;
  if (candidate !== undefined) {
    if (typeof candidate !== "string" || candidate.length === 0) {
      throw new Error(`release asset has an invalid download URL: ${asset?.name ?? "unknown"}`);
    }
    let parsed;
    try {
      parsed = new URL(candidate);
    } catch {
      throw new Error(`release asset has an invalid download URL: ${asset?.name ?? "unknown"}`);
    }
    if (parsed.protocol !== "https:" && parsed.protocol !== "http:") {
      throw new Error(`release asset has an invalid download URL: ${asset.name}`);
    }
    return candidate;
  }

  const [owner, name] = repositoryParts(repo);
  return (
    `https://github.com/${encodeURIComponent(owner)}/${encodeURIComponent(name)}/releases/download/` +
    `${encodeURIComponent(tag)}/${encodeURIComponent(asset.name)}`
  );
}

function releaseMetadataFrom(input) {
  if (input && input.release && typeof input.release === "object") return input.release;
  return input;
}

/**
 * Build a complete, deterministic Tauri updater manifest.
 *
 * `signatures` is intentionally supplied by the caller. The publisher owns
 * downloading `.sig` files; this function only validates and composes values,
 * making it pure and network-free.
 */
export function buildUpdaterManifest({
  tag,
  release,
  assets,
  body,
  publishedAt,
  tagName,
  signatures,
  signatureByAssetName,
  repo = DEFAULT_RELEASE_REPOSITORY,
} = {}) {
  const metadata = releaseMetadataFrom(
    release ?? { tagName: tagName ?? tag, assets, body, publishedAt },
  );
  const resolvedTag = tag ?? metadata?.tagName;
  const parsedTag = parseReleaseTag(resolvedTag);

  if (typeof metadata?.tagName !== "string") {
    throw new Error("release metadata is missing tagName");
  }
  if (metadata.tagName !== parsedTag.tag) {
    throw new Error(
      `release metadata tag mismatch: expected ${parsedTag.tag}, got ${metadata.tagName}`,
    );
  }

  const byName = validateReleaseAssets(metadata ?? { assets }, parsedTag.version);
  const signatureMap = normalizeSignatures(signatureByAssetName ?? signatures);
  const resolvedRepo = repo ?? DEFAULT_RELEASE_REPOSITORY;
  repositoryParts(resolvedRepo);

  if (typeof metadata?.publishedAt !== "string" || Number.isNaN(Date.parse(metadata.publishedAt))) {
    throw new Error("release metadata is missing a valid publishedAt timestamp");
  }

  const platforms = {};
  for (const mapping of UPDATER_PLATFORM_MAPPINGS) {
    const pair = UPDATER_ASSET_PAIRS[mapping.pair];
    const payloadName = pair.payload(parsedTag.version);
    const signatureName = pair.signature(parsedTag.version);
    const payload = byName.get(payloadName);
    const signature = signatureFor(signatureMap, payloadName, signatureName);
    platforms[mapping.key] = {
      signature,
      url: downloadUrl(payload, { tag: parsedTag.tag, repo: resolvedRepo }),
    };
  }

  return {
    version: parsedTag.version,
    notes: typeof metadata?.body === "string" ? metadata.body : "",
    pub_date: metadata.publishedAt,
    platforms,
  };
}

// A short alias is convenient for scripts and preserves a natural name for
// callers that do not need to mention the Tauri-specific format.
export const buildManifest = buildUpdaterManifest;
