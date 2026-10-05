import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { createHash } from "node:crypto";
import { afterEach, expect, it } from "vitest";

const CHECKER = fileURLToPath(new URL("./check-archify-pin.mjs", import.meta.url));
const cleanups = [];
afterEach(() => {
  while (cleanups.length > 0) cleanups.pop()();
});

/** @param {{ pin?: Record<string, unknown>, files?: Record<string, string>, license?: string | null, notices?: boolean }} [opts] */
function fixture({ pin = {}, files = { "bin/archify.mjs": "x" }, license = "MIT License", notices = true } = {}) {
  const root = mkdtempSync(join(tmpdir(), "maru-archify-pin-"));
  cleanups.push(() => rmSync(root, { recursive: true, force: true }));
  const fileHashes = {};
  const track = (path, content) => {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), content);
    fileHashes[path] = createHash("sha256").update(content).digest("hex");
  };
  for (const [path, content] of Object.entries(files)) track(path, content);
  if (license !== null) track("LICENSE", license);
  if (notices) track("THIRD_PARTY_NOTICES.md", "notices");
  mkdirSync(root, { recursive: true });
  writeFileSync(
    join(root, "PIN.json"),
    JSON.stringify({
      schemaVersion: 1,
      version: "3.0.0",
      repository: "https://github.com/tt-a1i/archify",
      revision: "9286c3b9c2cef359e98586b420d769d87bcb163f",
      license: "MIT",
      fileHashes,
      ...pin,
    }),
  );
  return root;
}

function run(root) {
  return spawnSync(process.execPath, [CHECKER, root], { encoding: "utf8" });
}

it("accepts a tree that matches the pin", () => {
  const root = fixture();
  const result = run(root);
  expect(result.status).toBe(0);
  expect(result.stdout).toMatch(/matches PIN\.json/);
});

it("rejects hash drift in a pinned file", () => {
  const root = fixture();
  writeFileSync(join(root, "bin/archify.mjs"), "tampered");
  const result = run(root);
  expect(result.status).toBe(1);
  expect(result.stderr).toMatch(/hash drift: bin\/archify\.mjs/);
});

it("rejects unlisted files in the vendored tree", () => {
  const root = fixture();
  writeFileSync(join(root, "stray.html"), "<html/>");
  const result = run(root);
  expect(result.status).toBe(1);
  expect(result.stderr).toMatch(/unlisted file in vendored tree: stray\.html/);
});

it("rejects a missing pinned file", () => {
  const root = fixture({ files: { "bin/a.mjs": "a", "bin/b.mjs": "b" } });
  rmSync(join(root, "bin/b.mjs"));
  const result = run(root);
  expect(result.status).toBe(1);
  expect(result.stderr).toMatch(/pinned file missing: bin\/b\.mjs/);
});

it("rejects a missing MIT license", () => {
  const root = fixture({ license: null });
  const result = run(root);
  expect(result.status).toBe(1);
  expect(result.stderr).toMatch(/LICENSE missing/);
});

it("rejects incomplete pin metadata", () => {
  const root = fixture({ pin: { revision: "not-a-commit" } });
  const result = run(root);
  expect(result.status).toBe(1);
  expect(result.stderr).toMatch(/40-hex commit/);
});

it("the real vendored tree passes", () => {
  const result = spawnSync(process.execPath, [CHECKER], { encoding: "utf8" });
  expect(result.status).toBe(0);
});
