// Behavioral proof for scripts/check-dom-sanitizer.mjs (SEC-02): the guard
// must exit 0 on the current tree, fail closed (exit 1) on an untraced sink,
// and never scan *.test.* files (EditorPane.test.tsx asserts a sink literal as
// source text). The tracing-policy source assertions live in
// check-dom-sanitizer.test.ts; this file is the live red/green behavioral gate.

import { spawnSync } from "node:child_process";
import { rmSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

const guardScript = resolve(process.cwd(), "scripts/check-dom-sanitizer.mjs");
const probeFile = resolve(process.cwd(), "src/__dom_sanitizer_probe__.tsx");

function runGuard() {
  return spawnSync(process.execPath, [guardScript], { encoding: "utf8" });
}

afterEach(() => {
  rmSync(probeFile, { force: true });
});

describe("check-dom-sanitizer.mjs behavior", () => {
  it("exits 0 on the current tree and reports the sinks it verified", () => {
    const result = runGuard();
    expect(result.status).toBe(0);
    expect(result.stdout).toContain("check-dom-sanitizer:");
    expect(result.stdout).toMatch(/6 dangerouslySetInnerHTML sinks trace/);
  });

  it("fails closed on an untraced sink, naming the probe file", () => {
    writeFileSync(
      probeFile,
      [
        "export function Probe({ untrustedInput }: { untrustedInput: string }) {",
        "  return <div dangerouslySetInnerHTML={{ __html: untrustedInput }} />;",
        "}",
        "",
      ].join("\n"),
    );
    const result = runGuard();
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("__dom_sanitizer_probe__.tsx");
  });

  it("never scans test files that assert the sink literal as source text", () => {
    const result = runGuard();
    expect(result.status).toBe(0);
    expect(result.stdout + result.stderr).not.toContain("EditorPane.test.tsx");
  });
});
