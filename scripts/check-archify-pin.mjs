// Archify engine pin guard (issue #433, P0): sidecars/archify is a vendored,
// pinned copy of the upstream Archify skill (MIT) that the Diagram generation
// pipeline invokes as the validation/render engine. The product renderer must
// be a fixed, hash-verified tree — never the user-mutable installed skill —
// so this guard fails the build when the vendored tree drifts from
// sidecars/archify/PIN.json, when the MIT notices go missing, or when the pin
// metadata itself is incomplete.
//
// What is checked:
//   1. PIN.json carries version, repository, a 40-hex revision, license: MIT.
//   2. LICENSE exists and mentions MIT; THIRD_PARTY_NOTICES.md exists.
//   3. Every file listed in PIN.json fileHashes exists with a matching
//      SHA-256, and no unlisted file (other than PIN.json) sits in the tree.
//
// Refresh after a deliberate engine update: regenerate the manifest with the
// snippet in docs/diagram.md ("Archify engine pin") and review the diff.
import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const engineRoot = process.argv[2] ?? join(repoRoot, "sidecars", "archify");

const violations = [];

function listFiles(dir) {
  const out = [];
  for (const entry of readdirSync(dir).sort()) {
    const path = join(dir, entry);
    if (statSync(path).isDirectory()) out.push(...listFiles(path));
    else out.push(path);
  }
  return out;
}

if (!existsSync(engineRoot)) {
  console.error(`archify-pin: ${engineRoot} does not exist — the vendored engine is required`);
  process.exit(1);
}

const pinPath = join(engineRoot, "PIN.json");
if (!existsSync(pinPath)) {
  console.error("archify-pin: sidecars/archify/PIN.json is missing — the engine must carry pin evidence");
  process.exit(1);
}

const pin = JSON.parse(readFileSync(pinPath, "utf8"));
if (typeof pin.version !== "string" || pin.version.length === 0) violations.push("PIN.json: version missing");
if (pin.repository !== "https://github.com/tt-a1i/archify") {
  violations.push(`PIN.json: unexpected repository "${pin.repository}"`);
}
if (typeof pin.revision !== "string" || !/^[0-9a-f]{40}$/.test(pin.revision)) {
  violations.push("PIN.json: revision must be a 40-hex commit");
}
if (pin.license !== "MIT") violations.push(`PIN.json: license must be MIT, got "${pin.license}"`);
if (!pin.fileHashes || typeof pin.fileHashes !== "object" || Object.keys(pin.fileHashes).length === 0) {
  violations.push("PIN.json: fileHashes manifest missing or empty");
}

const licensePath = join(engineRoot, "LICENSE");
if (!existsSync(licensePath)) {
  violations.push("LICENSE missing from the vendored tree (MIT notice required)");
} else if (!readFileSync(licensePath, "utf8").includes("MIT License")) {
  violations.push("LICENSE does not contain the MIT License text");
}
if (!existsSync(join(engineRoot, "THIRD_PARTY_NOTICES.md"))) {
  violations.push("THIRD_PARTY_NOTICES.md missing from the vendored tree");
}

if (!violations.some((v) => v.startsWith("PIN.json: fileHashes"))) {
  const listed = new Map(Object.entries(pin.fileHashes ?? {}));
  const actual = listFiles(engineRoot)
    .map((path) => relative(engineRoot, path).split("\\").join("/"))
    .filter((path) => path !== "PIN.json");
  for (const path of actual) {
    if (!listed.has(path)) {
      violations.push(`unlisted file in vendored tree: ${path} — refresh PIN.json or remove it`);
    }
  }
  for (const [path, expected] of listed) {
    const full = join(engineRoot, path);
    if (!existsSync(full)) {
      violations.push(`pinned file missing: ${path}`);
      continue;
    }
    const actual = createHash("sha256").update(readFileSync(full)).digest("hex");
    if (actual !== expected) {
      violations.push(`hash drift: ${path} — vendored engine no longer matches the pin`);
    }
  }
}

if (violations.length > 0) {
  console.error(`archify-pin: vendored Archify engine failed the pin check:\n  ${violations.join("\n  ")}`);
  process.exit(1);
}
console.log(
  `archify-pin: sidecars/archify matches PIN.json (archify ${pin.version} @ ${pin.revision.slice(0, 12)}, ${Object.keys(pin.fileHashes).length} files, MIT)`,
);
