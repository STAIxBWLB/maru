// Behavioral proof for scripts/check-csp-blob.mjs (SEC-01, D-04): each case
// runs the guard on a tmp fixture and asserts the exit code, so a weakened
// needle or a desynced scanner fails here instead of passing silently.

import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

const guardScript = resolve(process.cwd(), "scripts/check-csp-blob.mjs");
let fixtureDir: string | null = null;

function fixture(files: Record<string, string>): string {
  fixtureDir = mkdtempSync(join(tmpdir(), "csp-blob-"));
  for (const [name, text] of Object.entries(files)) writeFileSync(join(fixtureDir, name), text, "latin1");
  return fixtureDir;
}

function runGuard(...args: string[]) {
  return spawnSync(process.execPath, [guardScript, ...args], { encoding: "utf8" });
}

const probeConf = resolve(process.cwd(), "src-tauri/tauri.__csp_probe__.conf.json");

afterEach(() => {
  if (fixtureDir) rmSync(fixtureDir, { recursive: true, force: true });
  fixtureDir = null;
  rmSync(probeConf, { force: true });
});

describe("check-csp-blob.mjs config half", () => {
  it("fails an ordinary build when a tauri config re-adds script-src blob:", () => {
    writeFileSync(probeConf, JSON.stringify({ app: { security: { csp: { "script-src": "'self' blob:" } } } }));
    const result = runGuard("--dist", fixture({ "ok.js": 'import("./a.js");' }));
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("tauri.__csp_probe__.conf.json script-src carries blob:");
  });
});

describe("check-csp-blob.mjs dist half", () => {
  it("passes literal imports, new URL workers and createObjectURL-bound workers", () => {
    const dir = fixture({
      "ok.js": [
        'import("./a.js");',
        'new Worker(new URL("/assets/w.js", import.meta.url), { type: "module" });',
        "const o = URL.createObjectURL(new Blob([s]));",
        "new Worker(o);",
      ].join("\n"),
    });
    const result = runGuard("--dist", dir);
    expect(result.stderr).toBe("");
    expect(result.status).toBe(0);
  });

  it("sees through minified regex literals that fooled the old char scanner", () => {
    const result = runGuard("--dist", fixture({ "x.js": 'const r=/"/;import(u);' }));
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("import(u)");
  });

  it("flags unclassifiable worker spawns, importScripts and .mjs assets", () => {
    const dir = fixture({
      "a.js": "new Worker(location.hash);new globalThis.SharedWorker(u);",
      "b.mjs": "importScripts(u);",
    });
    const result = runGuard("--dist", dir);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("new Worker(location.hash)");
    expect(result.stderr).toContain("SharedWorker(u)");
    expect(result.stderr).toContain("importScripts(u)");
  });

  it("fails closed on an unparseable bundle", () => {
    const result = runGuard("--dist", fixture({ "bad.js": "function (" }));
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("unparseable bundle");
  });

  it("rejects unknown arguments", () => {
    expect(runGuard("--nope").status).toBe(1);
  });
});

describe("check-csp-blob.mjs binary half", () => {
  it("fails on blob: in the codegen form the binary actually ships", () => {
    const bin = join(fixture({ maru: "\u0000script-src'self' blob:style-src'self'\u0000" }), "maru");
    const result = runGuard("--binary", bin);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("carries blob:");
  });

  it("passes a clean codegen form and ignores the nonce placeholder", () => {
    const bin = join(
      fixture({ maru: "script-src'self'style-src'self'\u0000script-src__TAURI_SCRIPT_NONCE__" }),
      "maru",
    );
    const result = runGuard("--binary", bin);
    expect(result.status).toBe(0);
    expect(result.stdout).toContain(`compiled source list: "'self'"`);
  });

  it("fails closed when only the include_str! JSON copy is present", () => {
    const bin = join(fixture({ maru: '"script-src": "\'self\'",' }), "maru");
    const result = runGuard("--binary", bin);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("failing closed");
  });
});
