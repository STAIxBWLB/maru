// Behavioral proof for TEST-02 (D-01/D-02/D-04): coverage is a non-gating
// diagnostic report, not a merge gate. Reads the real Makefile, coverage.yml,
// package.json and vite.config.ts and asserts only what they state.
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const makefile = readFileSync(resolve(process.cwd(), "Makefile"), "utf8");
const coverageYml = readFileSync(
  resolve(process.cwd(), ".github/workflows/coverage.yml"),
  "utf8",
);
const packageJson = JSON.parse(readFileSync(resolve(process.cwd(), "package.json"), "utf8"));
const viteConfig = readFileSync(resolve(process.cwd(), "vite.config.ts"), "utf8");

describe("coverage is non-gating (TEST-02, D-01/D-02/D-04)", () => {
  it("Makefile's verify prerequisite list does not include coverage", () => {
    const verifyLine = makefile.match(/^verify:[^\n]*/m);
    expect(verifyLine, "Makefile has no verify recipe line").not.toBeNull();
    const prereqs = verifyLine![0].replace(/^verify:/, "").split("##")[0].trim().split(/\s+/);
    expect(prereqs).not.toContain("coverage");
  });

  it("the coverage recipe sets no minimum-percentage/threshold flag", () => {
    const recipeMatch = makefile.match(/^coverage:[\s\S]*?(?=\n\.PHONY|\n[a-zA-Z_-]+:)/m);
    expect(recipeMatch, "Makefile has no coverage recipe").not.toBeNull();
    const recipe = recipeMatch![0];
    expect(recipe).not.toMatch(/thresholds?/i);
    expect(recipe).not.toMatch(/fail-under/i);
    expect(recipe).not.toMatch(/--fail-under-\S+/);
  });

  it("coverage.yml triggers only on push to main, with no pull_request or workflow_dispatch trigger", () => {
    const onBlock = coverageYml.match(/^on:[\s\S]*?(?=\npermissions:)/m);
    expect(onBlock, "coverage.yml has no `on:` trigger block").not.toBeNull();
    const on = onBlock![0];
    expect(on).toContain("push:");
    expect(on).toMatch(/branches:\s*\n\s*-\s*main/);
    expect(on).not.toContain("pull_request");
    expect(on).not.toContain("workflow_dispatch");
  });

  it("coverage.yml references no secrets and runs make coverage", () => {
    expect(coverageYml).not.toMatch(/secrets\./);
    expect(coverageYml).toContain("make coverage");
  });

  it("@vitest/coverage-v8 is pinned exactly to the same version as vitest", () => {
    const coverageVersion = packageJson.devDependencies?.["@vitest/coverage-v8"];
    const vitestVersion = packageJson.devDependencies?.vitest;
    expect(coverageVersion, "@vitest/coverage-v8 missing from devDependencies").toBeDefined();
    expect(vitestVersion, "vitest missing from devDependencies").toBeDefined();
    // "exactly pinned" means no range operator (^ or ~) on the coverage package.
    expect(coverageVersion).not.toMatch(/^[\^~]/);
    expect(coverageVersion).toBe(vitestVersion!.replace(/^[\^~]/, ""));
  });

  it("vite.config.ts does not set coverage thresholds", () => {
    expect(viteConfig).not.toMatch(/thresholds?\s*:/);
  });
});
