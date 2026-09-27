// Behavioral proof for 06-05 T1 (CI placement, T-06-11) and T2 (verdict
// recorded consistently, T-06-04). Reads the actual workflow/Makefile/doc
// files and asserts only what they state — no invented contract.
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const ciYml = readFileSync(resolve(process.cwd(), ".github/workflows/ci.yml"), "utf8");
const nativeE2eYml = readFileSync(
  resolve(process.cwd(), ".github/workflows/native-e2e.yml"),
  "utf8",
);
const makefile = readFileSync(resolve(process.cwd(), "Makefile"), "utf8");

describe("native-e2e CI placement (T-06-11)", () => {
  it("ci.yml has a macOS native-e2e compile job that does not run the suite", () => {
    const jobMatch = ciYml.match(/native-e2e-compile:[\s\S]*$/);
    expect(jobMatch, "ci.yml has no native-e2e-compile job").not.toBeNull();
    const job = jobMatch![0];
    expect(job).toContain("macos-14");
    expect(job).not.toContain("test-e2e-native");
    expect(job).not.toContain("make test-e2e-native");
  });

  it("ci.yml's native-e2e-compile job runs on pull_request (via the shared decision gate)", () => {
    expect(ciYml).toContain("pull_request:");
    expect(ciYml).toContain("native-e2e-compile:");
  });

  it("native-e2e.yml runs the suite on main pushes, v* tags, and workflow_dispatch", () => {
    const onBlock = nativeE2eYml.match(/^on:[\s\S]*?(?=\njobs:)/m);
    expect(onBlock, "native-e2e.yml has no `on:` trigger block").not.toBeNull();
    const on = onBlock![0];
    expect(on).toMatch(/branches:\s*\n\s*-\s*main/);
    expect(on).toMatch(/tags:\s*\n\s*-\s*'v\*'/);
    expect(on).toContain("workflow_dispatch:");
    expect(nativeE2eYml).toContain("make test-e2e-native");
  });

  it("Makefile's release-preflight recipe blocks on test-e2e-native", () => {
    const recipeMatch = makefile.match(/^release-preflight:[\s\S]*?(?=\n\.PHONY|\n[a-zA-Z_-]+:)/m);
    expect(recipeMatch, "Makefile has no release-preflight recipe").not.toBeNull();
    expect(recipeMatch![0]).toContain("test-e2e-native");
  });

  it("Makefile's verify recipe does not include test-e2e-native", () => {
    const verifyLine = makefile.match(/^verify:[^\n]*/m);
    expect(verifyLine, "Makefile has no verify recipe line").not.toBeNull();
    expect(verifyLine![0]).not.toContain("test-e2e-native");
  });
});

describe("native-e2e CI-viability verdict recorded consistently (T-06-04)", () => {
  it("docs/native-e2e.md and .planning/PROJECT.md both name the ci-viable verdict", () => {
    const docs = readFileSync(resolve(process.cwd(), "docs/native-e2e.md"), "utf8");
    const project = readFileSync(resolve(process.cwd(), ".planning/PROJECT.md"), "utf8");
    expect(docs).toMatch(/\*\*ci-viable\*\*|`ci-viable`/);
    expect(project).toContain("ci-viable");
  });
});
