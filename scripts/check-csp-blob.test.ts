// Behavioral proof for scripts/check-csp-blob.mjs (SEC-01, D-04): each case
// runs the guard on a tmp fixture and asserts the exit code, so a weakened
// needle or a desynced scanner fails here instead of passing silently.

import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { pathToFileURL } from "node:url";

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

// Portable subprocess seam: intercept only the fixed compiled-app diagnostic,
// not filesystem reads or the guard process. No generated executable fixture.
function compiledReport(output: string, failure = false) {
  const dir = fixture({ "response.txt": output });
  const hook = join(dir, "diagnostic-hook.mjs");
  const called = join(dir, "diagnostic-call.json");
  writeFileSync(hook, [
    'import childProcess from "node:child_process";',
    'import { syncBuiltinESMExports } from "node:module";',
    'import { readFileSync, writeFileSync } from "node:fs";',
    `childProcess.execFileSync = (file, args, options) => {`,
    `  writeFileSync(${JSON.stringify(called)}, JSON.stringify({ file, args, options }));`,
    failure ? '  throw new Error("diagnostic failed or timed out");' : `  return readFileSync(${JSON.stringify(join(dir, "response.txt"))}, "utf8");`,
    '};',
    'syncBuiltinESMExports();',
  ].join("\n"));
  const result = spawnSync(process.execPath, ["--import", pathToFileURL(hook).href, guardScript, "--binary", process.execPath], { encoding: "utf8" });
  return { ...result, invocation: JSON.parse(readFileSync(called, "utf8")) as { file: string; args: string[]; options: Record<string, unknown> } };
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

  it("checks overlays merged onto the base: a partial overlay passes", () => {
    writeFileSync(probeConf, JSON.stringify({ app: { security: { csp: { "img-src": "'self'" } } } }));
    const result = runGuard("--dist", fixture({ "ok.js": 'import("./a.js");' }));
    expect(result.stderr).toBe("");
    expect(result.status).toBe(0);
  });

  it("fails an overlay that deletes the CSP or every script-governing directive", () => {
    writeFileSync(probeConf, JSON.stringify({ app: { security: { csp: null } } }));
    let result = runGuard("--dist", fixture({ "ok.js": 'import("./a.js");' }));
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("tauri.__csp_probe__.conf.json leaves the webview with no CSP");

    writeFileSync(probeConf, JSON.stringify({ app: { security: { csp: { "script-src": null, "default-src": null } } } }));
    result = runGuard("--dist", fixture({ "ok.js": 'import("./a.js");' }));
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("has no script-src or default-src");
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

describe("check-csp-blob.mjs compiled context half", () => {
  const report = (csp: unknown) => JSON.stringify({ kind: "maru.compiled-csp.v1", csp });

  it("reads the actual binary with fixed argv and bounded headless execution", () => {
    const result = compiledReport(report({ "script-src": "'self'", "worker-src": "'self' blob:" }));
    expect(result.status).toBe(0);
    expect(result.stdout).toContain(`compiled source list: "'self'"`);
    expect(result.invocation).toEqual({ file: resolve(process.execPath), args: ["--print-compiled-csp"], options: { encoding: "utf8", timeout: 30000, maxBuffer: 1024 * 1024, stdio: ["ignore", "pipe", "pipe"] } });
  });

  it.each([
    { "script-src": "'self' blob:" },
    { "script-src": "'self'", "script-src-elem": ["'self'", "blob:"] },
    { "script-src": "'self'", "script-src-attr": "BLOB:" },
    { "default-src": "'self' blob:" },
    { "script-src-elem": "'self'", "default-src": "blob:" },
    "script-src 'self' blob:; worker-src 'self' blob:",
  ])("rejects blob in explicit and fallback script policies: %j", (csp) => {
    const result = compiledReport(report(csp));
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("carries blob:");
  });

  it.each([null, [], 5, {}, { "script-src-elem": "'self'" }, { "script-src": 42 }, { "script-src": ["'self'", 42] }, "script-src blob:; script-src 'self'"])("fails closed on missing, malformed or duplicate policy: %j", (csp) => {
    const result = compiledReport(report(csp));
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("fails closed");
  });

  it.each(["", "not json", JSON.stringify({ "script-src": "'self'" }), JSON.stringify({ kind: "source-copy", csp: { "script-src": "'self'" } })])("rejects source copies and invalid diagnostic output", (output) => {
    const result = compiledReport(output);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("fails closed");
  });

  it("fails closed on diagnostic execution failure", () => {
    const result = compiledReport(report({ "script-src": "'self'" }), true);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("diagnostic failed or timed out");
  });

  it("accepts a policy string and a restrictive default fallback", () => {
    const result = compiledReport(report("default-src 'none'; worker-src 'self' blob:"));
    expect(result.status).toBe(0);
    expect(result.stdout).toContain(`compiled source list: "'none'"`);
  });

  it("rejects a non-executable source JSON file instead of scanning its strings", () => {
    const bin = join(fixture({ maru: JSON.stringify({ "script-src": "'self'" }) }), "maru");
    const result = runGuard("--binary", bin);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("fails closed");
  });
});
