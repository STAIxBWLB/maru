import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

/**
 * Policy pin for scripts/check-mode-css-ownership.mjs (PERF-05, phase 10
 * plan 02 Task 3). Hermetic source assertions: read the guard from disk
 * and pin its fail-closed structure. No subprocess, no dist needed.
 *
 * The guard is a tampering surface (T-10-05, guard weakening): these
 * assertions keep the red list, the raw-marker scan, and the
 * exit-1-on-violations path pinned in the suite `pnpm test` already runs.
 */
const guardSource = readFileSync(resolve(process.cwd(), "scripts/check-mode-css-ownership.mjs"), "utf8");

describe("check-mode-css-ownership guard policy", () => {
  it("scans the RAW text for maru:mode markers (raw scan cannot false-positive)", () => {
    expect(guardSource).toContain("maru:mode:([a-z0-9-]+)");
  });

  it("asserts the RED LIST on the entry chunk (index-*.css)", () => {
    expect(guardSource).toContain('entry chunk ${name} carries maru:mode markers');
    expect(guardSource).toContain("/^index-.*\\.css$/.test(f)");
  });

  it("asserts NO CROSS-CHUNK DUPLICATES with a fail-closed violation message", () => {
    expect(guardSource).toContain("NO CROSS-CHUNK DUPLICATES");
  });

  it("asserts MISSING MARKER (unimported per-mode file = silent split defeat)", () => {
    expect(guardSource).toContain("MISSING MARKER");
    expect(guardSource).toContain("silent split defeat");
  });

  it("asserts FULL INVENTORY against the registered mode list", () => {
    expect(guardSource).toContain("FULL INVENTORY");
    expect(guardSource).toContain('const REGISTERED_MODE_IDS');
  });

  it("keeps the mode inventory in sync with modeRegistry.getRegisteredModeIds()", () => {
    expect(guardSource).toContain("Keep in sync with src/lib/modeRegistry.tsx getRegisteredModeIds()");
  });

  it("carries the documented NO_PER_MODE_CSS exception list", () => {
    expect(guardSource).toContain("const NO_PER_MODE_CSS");
    expect(guardSource).toContain("documented exception list");
  });

  it("fails closed: process.exit(1) on violations, no success path in the violation branch", () => {
    expect(guardSource).toContain("process.exit(1)");
    const violationBranch = guardSource.slice(guardSource.indexOf("if (violations.length > 0)"));
    expect(violationBranch).toContain("process.exit(1)");
    expect(violationBranch).not.toContain("process.exit(0)");
  });

  it("prints the single mode-css-ownership success line", () => {
    expect(guardSource).toContain("`mode-css-ownership: ${chunkTexts.size} CSS chunks");
  });

  it("remediates the missing dist/assets directory", () => {
    expect(guardSource).toContain("run `pnpm build:frontend` first");
  });

  it("uses no AST parser or lint-framework dependency (plain node builtins only)", () => {
    for (const forbidden of ["@babel", "espree", "acorn", "typescript-eslint", "ts-morph"]) {
      expect(guardSource).not.toContain(forbidden);
    }
    expect(guardSource).toMatch(/from "node:fs\/promises"/);
    expect(guardSource).toMatch(/from "node:path"/);
  });
});

describe("check-mode-css-ownership SPLIT HOME behavior", () => {
  const home = (file: string, text: string) => ({ file, text });

  it("flags an entry-side override of a mode selector (lazy CSS would win)", async () => {
    const { splitHomeConflicts } = await import("./check-mode-css-ownership.mjs");
    const conflicts = splitHomeConflicts([
      home("src/styles.css", "@container wb (max-width: 720px) { .x-list, .y { width: 100%; } }"),
      home("src/components/x/x.css", ".x-list { width: 300px; }"),
    ]);
    expect(conflicts).toHaveLength(1);
    expect(conflicts[0]).toContain("SPLIT HOME: .x-list { width }");
  });

  it("treats shorthand/longhand as conflicting, except longhands the shorthand does not reset", async () => {
    const { splitHomeConflicts } = await import("./check-mode-css-ownership.mjs");
    expect(
      splitHomeConflicts([home("a.css", ".a { border: 0; flex: 1; }"), home("b.css", ".a { border-right: 1px solid; flex-direction: column; }")]),
    ).toEqual([expect.stringContaining(".a { border/border-right }")]);
  });

  it("ignores equal values, differing !important, keyframes, and ordered pairs", async () => {
    const { splitHomeConflicts } = await import("./check-mode-css-ownership.mjs");
    const files = [
      home("a.css", '.a { color: red; } .b { color: red !important; background: url("data:x;y"); } @keyframes k { to { opacity: 1; } }'),
      home("b.css", '.a { color: red; } .b { color: blue; background: url("data:x;y"); } @keyframes k { to { opacity: 0; } }'),
      home("c.css", ".c:is(.d, .e) { gap: 1px; }"),
      home("d.css", ".c:is(.d, .e) { gap: 2px; }"),
    ];
    expect(splitHomeConflicts(files, [["c.css", "d.css"]])).toEqual([]);
  });
});
