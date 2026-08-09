import { describe, expect, it } from "vitest";
import {
  UPDATER_ASSET_PAIRS,
  REQUIRED_PLATFORM_KEYS,
  buildUpdaterManifest,
  requiredReleaseAssetNames,
} from "./updaterManifest.mjs";

const TAG = "v0.4.47";
const VERSION = "0.4.47";
const PUBLISHED_AT = "2026-08-08T10:27:51Z";

function releaseAssets() {
  return requiredReleaseAssetNames(TAG).map((name) => ({
    name,
    url: `https://github.com/STAIxBWLB/maru/releases/download/${TAG}/${name}`,
  }));
}

function signatureEntries() {
  return UPDATER_ASSET_PAIRS.map(({ signature }) => {
    const name = signature(VERSION);
    return [name, `signature-for-${name}`];
  });
}

function fixture(overrides = {}) {
  const release = {
    tagName: TAG,
    body: "Measured performance and safer releases.",
    publishedAt: PUBLISHED_AT,
    assets: releaseAssets(),
    ...overrides.release,
  };
  return {
    tag: TAG,
    release,
    signatures: new Map(signatureEntries()),
    ...overrides,
    release,
  };
}

describe("buildUpdaterManifest", () => {
  it("builds the exact 11 v0.4.47-compatible platform keys", () => {
    const manifest = buildUpdaterManifest(fixture());

    expect(manifest).toEqual({
      version: VERSION,
      notes: "Measured performance and safer releases.",
      pub_date: PUBLISHED_AT,
      platforms: expect.any(Object),
    });
    expect(Object.keys(manifest.platforms)).toEqual(REQUIRED_PLATFORM_KEYS);
    expect(Object.keys(manifest.platforms)).toHaveLength(11);

    expect(manifest.platforms["darwin-aarch64"]).toEqual(
      manifest.platforms["darwin-aarch64-app"],
    );
    expect(manifest.platforms["darwin-x86_64"]).toEqual(
      manifest.platforms["darwin-x86_64-app"],
    );
    expect(manifest.platforms["linux-x86_64"]).toEqual(
      manifest.platforms["linux-x86_64-appimage"],
    );
    expect(manifest.platforms["windows-x86_64"]).toEqual(
      manifest.platforms["windows-x86_64-msi"],
    );

    expect(manifest.platforms["linux-x86_64-deb"].url).toContain(
      "Maru_0.4.47_linux_amd64_deb.deb",
    );
    expect(manifest.platforms["linux-x86_64-rpm"].url).toContain(
      "Maru_0.4.47_linux_x86_64_rpm.rpm",
    );
    expect(manifest.platforms["windows-x86_64-nsis"].url).toContain(
      "Maru_0.4.47_windows_x64_nsis.exe",
    );
  });

  it("trims downloaded signature text while preserving release notes and date", () => {
    const values = signatureEntries();
    values[0][1] = `\n${values[0][1]}\n`;
    const manifest = buildUpdaterManifest(fixture({ signatures: new Map(values) }));

    expect(manifest.notes).toBe("Measured performance and safer releases.");
    expect(manifest.pub_date).toBe(PUBLISHED_AT);
    expect(manifest.platforms["darwin-aarch64"].signature).toBe(
      `signature-for-${values[0][0]}`,
    );
  });

  it("accepts the flat metadata shape used by small callers", () => {
    const base = fixture();
    const manifest = buildUpdaterManifest({
      tag: TAG,
      tagName: TAG,
      body: base.release.body,
      publishedAt: base.release.publishedAt,
      assets: base.release.assets,
      signatures: base.signatures,
    });
    expect(manifest.version).toBe(VERSION);
    expect(Object.keys(manifest.platforms)).toHaveLength(11);
  });

  it("fails closed when a pre-manifest asset is missing", () => {
    const assets = releaseAssets().slice(1);
    expect(() => buildUpdaterManifest(fixture({ release: { assets } }))).toThrow(
      /missing release asset.*maru-cli_0\.4\.47_darwin_aarch64\.tar\.gz/,
    );
  });

  it("fails closed when a release asset name is duplicated", () => {
    const assets = releaseAssets();
    assets.push({ ...assets[0] });
    expect(() => buildUpdaterManifest(fixture({ release: { assets } }))).toThrow(
      /duplicate release asset.*maru-cli_0\.4\.47_darwin_aarch64\.tar\.gz/,
    );
  });

  it("fails closed when a required signature is absent", () => {
    const signatures = new Map(signatureEntries());
    signatures.delete("Maru_0.4.47_windows_x64_nsis.exe.sig");
    expect(() => buildUpdaterManifest(fixture({ signatures }))).toThrow(
      /missing signature content.*Maru_0\.4\.47_windows_x64_nsis\.exe\.sig/,
    );
  });

  it("fails closed when duplicate signature entries are supplied", () => {
    const entries = signatureEntries();
    entries.push(entries[0]);
    expect(() => buildUpdaterManifest(fixture({ signatures: entries }))).toThrow(
      /duplicate signature content.*Maru_0\.4\.47_darwin_aarch64_app\.app\.tar\.gz\.sig/,
    );
  });

  it.each(["v0.4.47/evil", "v0.4.47-beta.1", "0.4.47", "v0.4.47\n"])(
    "rejects malformed release tags before asset processing (%s)",
    (tag) => {
      expect(() => buildUpdaterManifest(fixture({ tag }))).toThrow(/malformed release tag/);
    },
  );
});
