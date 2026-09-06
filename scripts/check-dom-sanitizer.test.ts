// Policy pin for scripts/check-dom-sanitizer.mjs (SEC-02): source assertions
// on the guard itself so a future edit cannot silently weaken the tracing
// policy (D-07 module allowlist, D-08 registered pairs, fail-closed exit,
// no AST parser, test-file exclusion, EditorPane dynamic-import provenance).
// The behavioral proof lives in check-dom-sanitizer.behavior.test.ts and the
// Task 2 red-then-green drill; this test is deliberately hermetic.

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const guardSource = readFileSync(
  resolve(process.cwd(), "scripts/check-dom-sanitizer.mjs"),
  "utf8",
);

describe("check-dom-sanitizer.mjs tracing policy", () => {
  it("collects only .ts/.tsx sources and skips __tests__ and *.test.*/.spec.* files", () => {
    expect(guardSource).toContain('entry.name !== "__tests__"');
    expect(guardSource).toContain("TEST_FILE_PATTERN");
    expect(guardSource).toContain("\\.(?:test|spec)");
    expect(guardSource).toContain("(?:ts|tsx)$");
    expect(guardSource).toContain("collectTsFiles");
  });

  it("pins exactly the three DOMPurify-helper modules (D-07)", () => {
    expect(guardSource).toContain('"src/lib/markdown.ts"');
    expect(guardSource).toContain('"src/lib/scratchpad.ts"');
    expect(guardSource).toContain('"src/lib/diagram/richText.ts"');
    const allowlistBlock = guardSource.match(
      /const ALLOWED_HELPER_MODULES = \[([\s\S]*?)\];/,
    );
    expect(allowlistBlock).not.toBeNull();
    expect(allowlistBlock![1].split(",").filter((e) => e.includes('"'))).toHaveLength(3);
  });

  it("pins exactly the two registered (file, function) pairs (D-08)", () => {
    expect(guardSource).toContain('["src/components/EditorPane.tsx", "decoratePreviewHtml"]');
    expect(guardSource).toContain(
      '["src/components/binaryViewers/HwpxViewer.tsx", "sanitizeHwpxPreviewHtml"]',
    );
    const pairsBlock = guardSource.match(/const REGISTERED_LOCAL_HELPERS = \[([\s\S]*?)\];/);
    expect(pairsBlock).not.toBeNull();
    expect(pairsBlock![1].split("],").filter((e) => e.includes('"'))).toHaveLength(2);
  });

  it("fails closed: process.exit(1) on violations, no success path in the violation branch", () => {
    expect(guardSource).toContain("process.exit(1)");
    const violationBranch = guardSource.slice(guardSource.indexOf("if (violations.length > 0)"));
    expect(violationBranch).toContain("process.exit(1)");
    expect(violationBranch).not.toContain("process.exit(0)");
  });

  it("uses no AST parser or lint-framework dependency (plain node:fs/node:path only)", () => {
    for (const forbidden of ["@babel", "espree", "acorn", "typescript-eslint", "ts-morph"]) {
      expect(guardSource).not.toContain(forbidden);
    }
    expect(guardSource).toMatch(/from "node:fs"/);
    expect(guardSource).toMatch(/from "node:path"/);
  });

  it("recognizes the EditorPane previewBaseHtml dynamic-import provenance pattern", () => {
    expect(guardSource).toContain("hasDynamicImportProvenance");
    expect(guardSource).toContain('import\\(\\s*["\']');
    expect(guardSource).toContain(".then(");
    expect(guardSource).toContain("previewBaseHtml\\\\s*[= (]+");
  });
});
