// Policy pin for scripts/check-csp-blob.mjs (SEC-01): source assertions on
// the guard itself so a future edit cannot silently weaken the two-half
// fail-closed posture (D-04). The behavioral proof lives in the Task 1
// red-then-green fixture drill recorded in the plan summary; this test is
// deliberately hermetic.

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const guardSource = readFileSync(
  resolve(process.cwd(), "scripts/check-csp-blob.mjs"),
  "utf8",
);

describe("check-csp-blob.mjs two-half policy", () => {
  it("exposes both D-04 proof entry points (dist half and binary half)", () => {
    expect(guardSource).toContain("function checkBundle()");
    expect(guardSource).toContain("function checkBinary(binaryPath)");
    expect(guardSource).toContain("checkBinary(args.binary)");
    expect(guardSource).toContain("checkBundle()");
  });

  it("fails closed: process.exit(1) on violations, no success path in the violation branch", () => {
    expect(guardSource).toContain("process.exit(1)");
    const violationBranch = guardSource.slice(
      guardSource.indexOf("if (violations.length > 0)"),
    );
    expect(violationBranch).toContain("process.exit(1)");
    expect(violationBranch).not.toContain("process.exit(0)");
  });

  it("rejects unknown arguments with exit 1", () => {
    expect(guardSource).toContain("unknown argument");
    const argLoop = guardSource.slice(
      guardSource.indexOf("function parseArgs"),
      guardSource.indexOf("return args"),
    );
    expect(argLoop).toContain("process.exit(1)");
  });

  it("strips comments and strings before needle matching", () => {
    expect(guardSource).toContain("stripCommentsAndStrings");
    expect(
      guardSource.indexOf("function stripCommentsAndStrings"),
    ).toBeLessThan(guardSource.indexOf("const offenders = jsFiles.flatMap"));
    const scanLoop = guardSource.slice(
      guardSource.indexOf("while (i < n)"),
      guardSource.indexOf("return out"),
    );
    expect(scanLoop).toContain('"/"');
    expect(scanLoop).toContain('next === "*"');
    expect(scanLoop).toContain("`");
  });

  it("Worker needle exempts new URL( spawns and string-literal (blanked) args", () => {
    expect(guardSource).toContain("WORKER_NEEDLE");
    expect(guardSource).toContain("/new\\s+Worker\\s*\\(/g");
    expect(guardSource).toContain("/^new\\s+URL\\b/");
    expect(guardSource).toContain('trimmed.startsWith(")")) continue');
  });

  it("Worker needle exempts only createObjectURL-bound identifiers (D-05) and fails closed otherwise", () => {
    expect(guardSource).toContain("hasBlobUrlBinding");
    expect(guardSource).toContain("createObjectURL(");
    expect(guardSource).toContain("createObjectURL\\\\s*\\\\(");
    const workerBlock = guardSource.slice(
      guardSource.indexOf("function workerSpawnOffenses"),
      guardSource.indexOf("function dynamicImportOffenses"),
    );
    expect(workerBlock).toContain("hasBlobUrlBinding(stripped");
    expect(workerBlock).toContain("offenses.push");
  });

  it("dynamic-import needle exempts quoted/template literals and new URL(, flags non-literal specifiers", () => {
    expect(guardSource).toContain("DYNAMIC_IMPORT_NEEDLE");
    expect(guardSource).toContain("(?<![.\\w$])import\\s*\\(");
    const importBlock = guardSource.slice(
      guardSource.indexOf("function dynamicImportOffenses"),
      guardSource.indexOf("// --- Binary half"),
    );
    expect(importBlock).toContain("/^new\\s+URL\\b/");
    expect(importBlock).toContain("non-literal");
  });

  it("binary half treats a missing embedded script-src serialization as a violation (fails closed)", () => {
    expect(guardSource).toContain("SCRIPT_SRC_NEEDLE");
    expect(guardSource).toContain('"script-src"');
    const binaryBlock = guardSource.slice(
      guardSource.indexOf("function checkBinary"),
      guardSource.indexOf("const args = parseArgs"),
    );
    expect(binaryBlock).toContain("embeddedScriptSrcValues.length === 0");
    expect(binaryBlock).toContain("violations.push");
    expect(binaryBlock).toContain('value.includes("blob:")');
  });
});
