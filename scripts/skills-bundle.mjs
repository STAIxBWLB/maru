#!/usr/bin/env node
// Skills bundle verifier + packager for the skills-channel OTA pipeline.
//
//   node scripts/skills-bundle.mjs verify
//   node scripts/skills-bundle.mjs package --revision <n> [--out dist-skills]
//
// verify: manifest/directory agreement, SKILL.md frontmatter, duplicate
// names, tracked-file inventory (no symlinks, no deleted-but-tracked files).
// package: verify + zip of exactly the git-tracked skills/ files + signed-ready
// metadata JSON (revision, commit, minAppVersion, envHash, archive sha/size,
// per-file path/sha256/mode). Signing happens in CI via `tauri signer sign`.
//
// Mode rule matches the runtime materializer (set_builtin_file_mode): files
// starting with "#!" are 755, everything else 644. The git executable bit is
// deliberately ignored so metadata and runtime never disagree.

import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, rmSync, statSync, writeFileSync, existsSync, readdirSync, lstatSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const skillsRoot = join(repoRoot, "skills");

function fail(message) {
  console.error(`skills-bundle: ${message}`);
  process.exit(1);
}

function sha256(buffer) {
  return createHash("sha256").update(buffer).digest("hex");
}

function git(args) {
  return execFileSync("git", args, { cwd: repoRoot, encoding: "utf8" });
}

function trackedFiles() {
  const out = git(["ls-files", "-z", "--", "skills"]);
  return out.split("\0").filter(Boolean).sort();
}

function parseFrontmatter(content) {
  if (!content.startsWith("---\n")) return null;
  const end = content.indexOf("\n---", 4);
  if (end === -1) return null;
  const body = content.slice(4, end);
  const keys = new Map();
  for (const line of body.split("\n")) {
    const match = /^([A-Za-z0-9_-]+):\s*(.*)$/.exec(line);
    if (match) keys.set(match[1], match[2].trim());
  }
  return keys;
}

function fileMode(buffer) {
  return buffer.length >= 2 && buffer[0] === 0x23 && buffer[1] === 0x21 ? "755" : "644";
}

function loadManifest() {
  let manifest;
  try {
    manifest = JSON.parse(readFileSync(join(skillsRoot, "manifest.json"), "utf8"));
  } catch (err) {
    fail(`skills/manifest.json unreadable: ${err.message}`);
  }
  for (const key of ["version", "repoSlug", "channelTag", "minAppVersion", "skillsSubdir", "skills"]) {
    if (manifest[key] === undefined) fail(`manifest.json missing required key: ${key}`);
  }
  if (!/^\d+\.\d+\.\d+$/.test(manifest.minAppVersion)) {
    fail(`manifest.json minAppVersion is not semver: ${manifest.minAppVersion}`);
  }
  if (!Array.isArray(manifest.skills) || manifest.skills.length === 0) {
    fail("manifest.json skills[] is empty");
  }
  return manifest;
}

function verify() {
  const manifest = loadManifest();
  const errors = [];
  const tracked = trackedFiles();
  const trackedSet = new Set(tracked.map((p) => p.replace(/^skills\//, "")));

  // Tracked inventory: every tracked path exists on disk, is a regular file,
  // and has a name safe for the line-based packaging protocol and zip names.
  for (const rel of tracked) {
    if (/[\n\r\0]/.test(rel)) {
      errors.push(`control character in tracked filename: ${JSON.stringify(rel)}`);
      continue;
    }
    // NFC only: mixed Unicode normalization (macOS tools often emit NFD)
    // makes the same Korean filename hash as two different bundle paths.
    if (rel !== rel.normalize("NFC")) {
      errors.push(`filename is not NFC-normalized: ${rel}`);
    }
    // The app's dirty gate ignores these names as runtime junk, so a bundle
    // must never legitimately ship them (their drift would be invisible).
    if (/(^|\/)(__pycache__|\.pytest_cache|node_modules|\.venv)(\/|$)|\.pyc$|(^|\/)\.DS_Store$/.test(rel)) {
      errors.push(`runtime-junk path must not be tracked in the bundle: ${rel}`);
    }
    // Mirror the app's extraction path rules: names the updater would reject
    // must fail CI instead of shipping an unappliable bundle.
    if (/[:<>"|?*\x00-\x1f]/.test(rel)) {
      errors.push(`character invalid on Windows: ${rel}`);
    }
    for (const segment of rel.split("/")) {
      const stem = (segment.split(".")[0] ?? "").toUpperCase();
      const reserved =
        ["CON", "PRN", "AUX", "NUL"].includes(stem) ||
        (/^(COM|LPT)\d$/.test(stem));
      if (reserved || segment.endsWith(".") || segment.endsWith(" ")) {
        errors.push(`path segment invalid on Windows: ${rel}`);
        break;
      }
    }
    const abs = join(repoRoot, rel);
    let st;
    try {
      st = lstatSync(abs);
    } catch {
      errors.push(`tracked file missing on disk: ${rel}`);
      continue;
    }
    if (st.isSymbolicLink()) errors.push(`symlink not allowed in bundle: ${rel}`);
    else if (!st.isFile()) errors.push(`not a regular file: ${rel}`);
  }

  // Manifest <-> directory agreement.
  const names = new Set();
  for (const entry of manifest.skills) {
    if (!entry.name || !entry.path) {
      errors.push(`manifest entry missing name/path: ${JSON.stringify(entry)}`);
      continue;
    }
    if (names.has(entry.name)) errors.push(`duplicate skill name in manifest: ${entry.name}`);
    names.add(entry.name);
    if (entry.path !== `${manifest.skillsSubdir}/${entry.name}`) {
      errors.push(`manifest path mismatch for ${entry.name}: ${entry.path}`);
    }
    const skillMd = `${entry.path}/SKILL.md`;
    if (!trackedSet.has(skillMd)) {
      errors.push(`SKILL.md not tracked for ${entry.name}: skills/${skillMd}`);
      continue;
    }
    const content = readFileSync(join(skillsRoot, skillMd), "utf8");
    const fm = parseFrontmatter(content);
    if (!fm) {
      errors.push(`missing frontmatter: skills/${skillMd}`);
      continue;
    }
    if (!fm.get("name")) errors.push(`frontmatter name missing: skills/${skillMd}`);
    else if (fm.get("name") !== entry.name) {
      errors.push(`frontmatter name "${fm.get("name")}" != directory "${entry.name}"`);
    }
    if (!fm.has("description")) errors.push(`frontmatter description missing: skills/${skillMd}`);
  }

  // Every skill directory on disk is listed in the manifest.
  const skillsDir = join(skillsRoot, manifest.skillsSubdir);
  for (const dirent of readdirSync(skillsDir, { withFileTypes: true })) {
    if (!dirent.isDirectory()) continue;
    if (!names.has(dirent.name)) {
      // Only flag directories that carry tracked content; untracked scratch
      // dirs never enter the bundle.
      const prefix = `${manifest.skillsSubdir}/${dirent.name}/`;
      if ([...trackedSet].some((p) => p.startsWith(prefix))) {
        errors.push(`skill directory not in manifest: skills/${prefix}`);
      }
    }
  }

  if (errors.length > 0) {
    for (const error of errors) console.error(`skills-bundle: ${error}`);
    process.exit(1);
  }
  console.log(`skills-verify ok: ${manifest.skills.length} skills, ${tracked.length} tracked files`);
  return { manifest, tracked };
}

function envHash(fileEntries) {
  // Matches the Rust-side digest: sorted "rel\0sha\0" over envs/** with
  // '/'-normalized paths relative to the bundle root.
  const hasher = createHash("sha256");
  for (const entry of fileEntries.filter((f) => f.path.startsWith("envs/"))) {
    hasher.update(entry.path);
    hasher.update("\0");
    hasher.update(entry.sha256);
    hasher.update("\0");
  }
  return hasher.digest("hex");
}

function packageBundle(args) {
  const revision = Number.parseInt(args.revision ?? "0", 10);
  if (!Number.isSafeInteger(revision) || revision < 0) fail(`invalid --revision: ${args.revision}`);
  const outDir = resolve(repoRoot, args.out ?? "dist-skills");
  const { manifest, tracked } = verify();

  let commit = git(["rev-parse", "HEAD"]).trim();
  const shortSha = commit.slice(0, 7);
  // Bytes come from the working tree; do not attribute uncommitted skill
  // content to HEAD (local QA builds only — CI checkouts are always clean).
  if (git(["status", "--porcelain", "--", "skills"]).trim() !== "") {
    commit = `${commit}-dirty`;
  }
  const baseName = `maru-skills-r${revision}-${shortSha}`;

  const fileEntries = tracked.map((relRepo) => {
    const rel = relRepo.replace(/^skills\//, "");
    const buffer = readFileSync(join(repoRoot, relRepo));
    return { path: rel, sha256: sha256(buffer), size: buffer.length, mode: fileMode(buffer) };
  });

  // Never recursively delete a caller-supplied path (--out . would be fatal);
  // clear only our own artifact names inside it.
  mkdirSync(outDir, { recursive: true });
  for (const entry of readdirSync(outDir)) {
    if (/^maru-skills-r\d+-[0-9a-f]+(-dirty)?\.(zip|json)(\.sig)?$/.test(entry)) {
      rmSync(join(outDir, entry), { force: true });
    }
  }
  const zipPath = join(outDir, `${baseName}.zip`);
  // python3 zipfile instead of the zip CLI: macOS zip stores non-ASCII names
  // without the UTF-8 flag (mojibake for the Korean HWPX templates). Fixed
  // 1980 timestamps + mode rule make the archive deterministic per content.
  const zipWriter = `
import sys, zipfile
zip_path, root = sys.argv[1], sys.argv[2]
with zipfile.ZipFile(zip_path, "w", zipfile.ZIP_DEFLATED) as zf:
    for line in sys.stdin.read().splitlines():
        rel, mode = line.rsplit("\\t", 1)
        info = zipfile.ZipInfo(rel, date_time=(1980, 1, 1, 0, 0, 0))
        info.external_attr = (0o100000 | int(mode, 8)) << 16
        info.compress_type = zipfile.ZIP_DEFLATED
        with open(f"{root}/{rel}", "rb") as fh:
            zf.writestr(info, fh.read())
`;
  execFileSync("python3", ["-c", zipWriter, zipPath, skillsRoot], {
    input: fileEntries.map((f) => `${f.path}\t${f.mode}`).join("\n"),
  });

  const zipBuffer = readFileSync(zipPath);
  const metadata = {
    schema: 1,
    revision,
    displayVersion: `r${revision}`,
    commit,
    publishedAt: new Date().toISOString(),
    minAppVersion: manifest.minAppVersion,
    channelTag: manifest.channelTag,
    envHash: envHash(fileEntries),
    archive: { name: `${baseName}.zip`, sha256: sha256(zipBuffer), size: zipBuffer.length },
    files: fileEntries.map(({ path, sha256, mode }) => ({ path, sha256, mode })),
  };
  const metadataPath = join(outDir, `${baseName}.json`);
  writeFileSync(metadataPath, `${JSON.stringify(metadata, null, 2)}\n`);

  // Re-verify the archive listing against the metadata inventory. Info-ZIP's
  // unzip mangles UTF-8 names on macOS; python3's zipfile module does not.
  const listing = execFileSync(
    "python3",
    ["-c", "import sys, zipfile; sys.stdout.write('\\n'.join(zipfile.ZipFile(sys.argv[1]).namelist()))", zipPath],
    { encoding: "utf8" },
  )
    .split("\n")
    .filter(Boolean)
    .sort();
  const expected = fileEntries.map((f) => f.path).sort();
  if (listing.join("\n") !== expected.join("\n")) {
    fail("archive listing does not match tracked inventory");
  }

  console.log(`skills-package ok: ${zipPath} (${zipBuffer.length} bytes, revision ${revision})`);
  console.log(metadataPath);
  return { zipPath, metadataPath };
}

function parseArgs(argv) {
  const args = {};
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === "--revision") args.revision = argv[++i];
    else if (argv[i] === "--out") args.out = argv[++i];
    else fail(`unknown option: ${argv[i]}`);
  }
  return args;
}

const [command, ...rest] = process.argv.slice(2);
if (command === "verify") {
  if (rest.length > 0) fail(`verify takes no options`);
  verify();
} else if (command === "package") {
  packageBundle(parseArgs(rest));
} else {
  fail("usage: skills-bundle.mjs verify | package --revision <n> [--out <dir>]");
}
