// Behavioral proof for the fail-first (red) half of
// check-native-e2e-isolation.mjs, which was previously only proven green
// (via build:frontend on a real clean bundle). The script resolves its own
// repoRoot from `import.meta.url`, so it is copied into a tmp tree at
// <tmp>/scripts/check-native-e2e-isolation.mjs and run there — no impl file
// is touched, only where it is invoked from.
import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, copyFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

const scriptSource = resolve(process.cwd(), "scripts/check-native-e2e-isolation.mjs");

let tmpRoot: string | null = null;

function setupTmpRepo(): string {
  tmpRoot = mkdtempSync(join(tmpdir(), "native-e2e-isolation-"));
  mkdirSync(join(tmpRoot, "scripts"), { recursive: true });
  copyFileSync(scriptSource, join(tmpRoot, "scripts", "check-native-e2e-isolation.mjs"));
  // Deliberately no src-tauri/Cargo.toml: `cargo metadata` fails on this
  // tree, exercising the "warn and skip the manifest half" branch.
  return tmpRoot;
}

function runScript(cwd: string, args: string[] = []) {
  return spawnSync(
    process.execPath,
    [join(cwd, "scripts", "check-native-e2e-isolation.mjs"), ...args],
    { cwd, encoding: "utf8" },
  );
}

afterEach(() => {
  if (tmpRoot) rmSync(tmpRoot, { recursive: true, force: true });
  tmpRoot = null;
});

describe("check-native-e2e-isolation.mjs bundle half (red/green)", () => {
  it("fails with a named message when dist/assets is missing", () => {
    const root = setupTmpRepo();
    const result = runScript(root);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("dist/assets/ does not exist");
  });

  it("is red when a bundle file contains the debug bridge namespace", () => {
    const root = setupTmpRepo();
    mkdirSync(join(root, "dist", "assets"), { recursive: true });
    writeFileSync(
      join(root, "dist", "assets", "index.js"),
      'window.__MARU_NATIVE_E2E__ = { menuCommand() {} };',
    );
    const result = runScript(root);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("__MARU_NATIVE_E2E__");
  });

  it("is red when a bundle file contains a native-only command name", () => {
    const root = setupTmpRepo();
    mkdirSync(join(root, "dist", "assets"), { recursive: true });
    writeFileSync(
      join(root, "dist", "assets", "index.js"),
      'invoke("native_e2e_async_probe");',
    );
    const result = runScript(root);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("native_e2e_async_probe");
  });

  it("is green (exit 0) on a clean bundle, warning and skipping the manifest half", () => {
    const root = setupTmpRepo();
    mkdirSync(join(root, "dist", "assets"), { recursive: true });
    writeFileSync(join(root, "dist", "assets", "index.js"), 'console.log("clean bundle");');
    const result = runScript(root);
    expect(result.status).toBe(0);
    expect(result.stdout).toContain("bundle and Cargo manifest carry no native-e2e affordances");
    // The manifest half must warn-and-skip on this tree (no src-tauri/Cargo.toml
    // to run `cargo metadata` against), not hard-fail — this is the actual
    // observed behavior documented in the script's own comments.
    expect(result.stderr).toContain("skipping Cargo manifest assertions");
  });
});
