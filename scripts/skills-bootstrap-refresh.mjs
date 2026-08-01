#!/usr/bin/env node
// Refresh the app-embedded skills bootstrap snapshot from the OTA channel.
//
//   node scripts/skills-bootstrap-refresh.mjs refresh
//   node scripts/skills-bootstrap-refresh.mjs verify
//
// refresh: download the newest signed bundle from the skills repo's
// `skills-channel` prerelease, verify both minisign signatures against the
// updater pubkey embedded in src-tauri/tauri.conf.json, verify the archive
// sha256/size and the per-file inventory, then replace
// src-tauri/skills-bootstrap/ with the bundle contents. Run this when
// cutting an app release so first-run/offline installs ship current skills.
//
// verify: sanity-check the current bootstrap snapshot (manifest keys, one
// SKILL.md with matching frontmatter per manifest entry, no symlinks).
//
// minisign verification is implemented locally (node:crypto Ed25519 +
// BLAKE2b-512) so this script has no external binary dependency. The wire
// formats are the minisign public-key and signature file formats; only the
// untrusted-comment payloads are parsed, which is all verification needs.

import { execFileSync } from "node:child_process";
import { createHash, createPublicKey, verify as edVerify } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, lstatSync, writeFileSync, chmodSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const bootstrapDir = join(repoRoot, "src-tauri", "skills-bootstrap");
const REPO_SLUG = "STAIxBWLB/skills";
const CHANNEL_TAG = "skills-channel";

function fail(message) {
  console.error(`skills-bootstrap-refresh: ${message}`);
  process.exit(1);
}

function sha256(buffer) {
  return createHash("sha256").update(buffer).digest("hex");
}

function updaterPubkeyB64() {
  const conf = JSON.parse(readFileSync(join(repoRoot, "src-tauri", "tauri.conf.json"), "utf8"));
  const pubkey = conf?.plugins?.updater?.pubkey;
  if (!pubkey) fail("no /plugins/updater/pubkey in src-tauri/tauri.conf.json");
  return pubkey;
}

// --- minisign wire formats ------------------------------------------------

// Public key file (what tauri.conf.json embeds, base64'd):
//   untrusted comment: ...
//   <base64 of 42 bytes: 2B alg "Ed" | 8B keynum | 32B raw Ed25519 key>
function parseMinisignPubkey(fileB64) {
  const text = Buffer.from(fileB64, "base64").toString("utf8");
  const lines = text.split("\n").filter((l) => l.trim() !== "");
  const raw = Buffer.from(lines[lines.length - 1], "base64");
  if (raw.length !== 42 || raw.toString("latin1", 0, 2) !== "Ed") {
    fail("unexpected minisign public key format");
  }
  return { keynum: raw.subarray(2, 10), rawKey: raw.subarray(10, 42) };
}

// Signature file:
//   untrusted comment: ...
//   <base64 of 74 bytes: 2B alg ("Ed" pure | "ED" prehashed) | 8B keynum | 64B sig>
//   trusted comment: ...
//   <base64 of 72 bytes: global signature (not needed here)>
function parseMinisignSig(fileB64) {
  const text = Buffer.from(fileB64, "base64").toString("utf8");
  const lines = text.split("\n").filter((l) => l.trim() !== "");
  if (lines.length < 2) fail("minisign signature file too short");
  const raw = Buffer.from(lines[1], "base64");
  if (raw.length !== 74) fail("unexpected minisign signature payload length");
  const alg = raw.toString("latin1", 0, 2);
  if (alg !== "Ed" && alg !== "ED") fail(`unexpected minisign signature algorithm: ${alg}`);
  return { prehashed: alg === "ED", keynum: raw.subarray(2, 10), sig: raw.subarray(10, 74) };
}

function minisignVerify(pubkeyFileB64, sigFileB64, content) {
  const pub = parseMinisignPubkey(pubkeyFileB64);
  const sig = parseMinisignSig(sigFileB64);
  if (!pub.keynum.equals(sig.keynum)) return false;
  // Ed25519 SubjectPublicKeyInfo DER prefix + raw 32-byte key.
  const spki = Buffer.concat([Buffer.from("302a300506032b6570032100", "hex"), pub.rawKey]);
  const key = createPublicKey({ key: spki, format: "der", type: "spki" });
  const message = sig.prehashed ? createHash("blake2b512").update(content).digest() : content;
  return edVerify(null, message, key, sig.sig);
}

// --- github ---------------------------------------------------------------

async function fetchJson(url) {
  const res = await fetch(url, { headers: { "user-agent": "maru-skills-bootstrap-refresh" } });
  if (!res.ok) fail(`GET ${url} -> ${res.status}`);
  return res.json();
}

async function fetchBuffer(url) {
  const res = await fetch(url, { headers: { "user-agent": "maru-skills-bootstrap-refresh" } });
  if (!res.ok) fail(`GET ${url} -> ${res.status}`);
  return Buffer.from(await res.arrayBuffer());
}

function assetRevision(name) {
  const match = /^maru-skills-r(\d+)-[0-9a-f]+(-dirty)?\.json$/.exec(name);
  return match ? Number.parseInt(match[1], 10) : null;
}

async function newestBundle() {
  const release = await fetchJson(`https://api.github.com/repos/${REPO_SLUG}/releases/tags/${CHANNEL_TAG}`);
  let best = null;
  for (const asset of release.assets ?? []) {
    const revision = assetRevision(asset.name);
    if (revision !== null && (best === null || revision > best.revision)) {
      best = { revision, asset };
    }
  }
  if (!best) fail(`no maru-skills-r*.json asset on ${REPO_SLUG}@${CHANNEL_TAG}`);
  const byName = new Map((release.assets ?? []).map((a) => [a.name, a]));
  const base = best.asset.name.replace(/\.json$/, "");
  for (const required of [`${base}.zip`, `${base}.zip.sig`, `${base}.json.sig`]) {
    if (!byName.has(required)) fail(`incomplete bundle on channel: missing ${required}`);
  }
  return { revision: best.revision, base, byName };
}

// --- commands -------------------------------------------------------------

async function refresh() {
  const pubkey = updaterPubkeyB64();
  const { revision, base, byName } = await newestBundle();

  const metaBuf = await fetchBuffer(byName.get(`${base}.json`).browser_download_url);
  const metaSigBuf = await fetchBuffer(byName.get(`${base}.json.sig`).browser_download_url);
  if (!minisignVerify(pubkey, metaSigBuf.toString("utf8"), metaBuf)) {
    fail("metadata signature verification failed");
  }
  const metadata = JSON.parse(metaBuf.toString("utf8"));

  const zipBuf = await fetchBuffer(byName.get(`${base}.zip`).browser_download_url);
  const zipSigBuf = await fetchBuffer(byName.get(`${base}.zip.sig`).browser_download_url);
  if (!minisignVerify(pubkey, zipSigBuf.toString("utf8"), zipBuf)) {
    fail("archive signature verification failed");
  }
  if (zipBuf.length !== metadata.archive.size || sha256(zipBuf) !== metadata.archive.sha256) {
    fail("archive sha256/size does not match signed metadata");
  }

  const staging = mkdtempSync(join(tmpdir(), "maru-bootstrap-"));
  try {
    const zipPath = join(staging, "bundle.zip");
    writeFileSync(zipPath, zipBuf);
    const outDir = join(staging, "tree");
    mkdirSync(outDir);
    // python3 zipfile: the system unzip mangles UTF-8 names on macOS.
    execFileSync("python3", ["-c", "import sys, zipfile; zipfile.ZipFile(sys.argv[1]).extractall(sys.argv[2])", zipPath, outDir]);

    // Per-file inventory from the signed metadata is the ground truth.
    for (const entry of metadata.files) {
      const abs = join(outDir, entry.path);
      let buffer;
      try {
        buffer = readFileSync(abs);
      } catch {
        fail(`archive is missing ${entry.path}`);
      }
      if (sha256(buffer) !== entry.sha256) fail(`sha256 mismatch for ${entry.path}`);
      const mode = buffer.length >= 2 && buffer[0] === 0x23 && buffer[1] === 0x21 ? "755" : "644";
      if (mode !== entry.mode) fail(`mode mismatch for ${entry.path}`);
      chmodSync(abs, mode === "755" ? 0o755 : 0o644);
    }

    // Swap in the new snapshot. Deleting only after every check passed keeps
    // a failed refresh from leaving an empty bootstrap behind.
    for (const entry of readdirSync(bootstrapDir)) {
      rmSync(join(bootstrapDir, entry), { recursive: true, force: true });
    }
    execFileSync("cp", ["-R", `${outDir}/`, bootstrapDir]);
    writeFileSync(
      join(bootstrapDir, "README.md"),
      [
        "# Skills bootstrap snapshot",
        "",
        `Copied from OTA bundle \`${base}\` (revision ${revision}, ${REPO_SLUG}@${CHANNEL_TAG})`,
        "by `make skills-bootstrap-refresh`. Refresh this snapshot when cutting an",
        "app release; it is the first-run/offline fallback embedded via include_dir.",
        "",
      ].join("\n"),
    );
    console.log(`skills-bootstrap-refresh ok: revision ${revision}, ${metadata.files.length} files -> src-tauri/skills-bootstrap/`);
  } finally {
    rmSync(staging, { recursive: true, force: true });
  }
}

function verify() {
  const errors = [];
  const manifestPath = join(bootstrapDir, "manifest.json");
  if (!existsSync(manifestPath)) fail("src-tauri/skills-bootstrap/manifest.json missing");
  const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
  for (const key of ["version", "repoSlug", "channelTag", "minAppVersion", "skillsSubdir", "skills"]) {
    if (manifest[key] === undefined) errors.push(`manifest.json missing required key: ${key}`);
  }
  const names = new Set();
  for (const entry of manifest.skills ?? []) {
    if (!entry.name || entry.path !== `${manifest.skillsSubdir}/${entry.name}`) {
      errors.push(`bad manifest entry: ${JSON.stringify(entry)}`);
      continue;
    }
    if (names.has(entry.name)) errors.push(`duplicate skill name: ${entry.name}`);
    names.add(entry.name);
    const skillMd = join(bootstrapDir, entry.path, "SKILL.md");
    if (!existsSync(skillMd)) {
      errors.push(`missing ${entry.path}/SKILL.md`);
      continue;
    }
    const content = readFileSync(skillMd, "utf8");
    const end = content.startsWith("---\n") ? content.indexOf("\n---", 4) : -1;
    const head = end === -1 ? "" : content.slice(4, end);
    if (!new RegExp(`^name:\\s*${entry.name}\\s*$`, "m").test(head)) {
      errors.push(`frontmatter name mismatch in ${entry.path}/SKILL.md`);
    }
    if (!/^description:\s*\S/m.test(head)) {
      errors.push(`frontmatter description missing in ${entry.path}/SKILL.md`);
    }
  }
  // No symlinks anywhere in the snapshot.
  const walk = (dir) => {
    for (const dirent of readdirSync(dir, { withFileTypes: true })) {
      const abs = join(dir, dirent.name);
      if (lstatSync(abs).isSymbolicLink()) errors.push(`symlink not allowed: ${abs}`);
      else if (dirent.isDirectory()) walk(abs);
    }
  };
  walk(bootstrapDir);
  if (errors.length > 0) {
    for (const error of errors) console.error(`skills-bootstrap-refresh: ${error}`);
    process.exit(1);
  }
  console.log(`skills-bootstrap-verify ok: ${(manifest.skills ?? []).length} skills in snapshot`);
}

const [command] = process.argv.slice(2);
if (command === "refresh") {
  await refresh();
} else if (command === "verify") {
  verify();
} else {
  fail("usage: skills-bootstrap-refresh.mjs refresh | verify");
}
