import { spawnSync } from "node:child_process";
import { linkSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";

const svgFixture = readFileSync("src/lib/diagram/viewer/__fixtures__/architecture-light.svg");
const specFixture = readFileSync("src/lib/diagram/viewer/__fixtures__/architecture-light.spec.json");
const builderPath = resolve("scripts/build-diagram-viewer.mjs");

describe("offline diagram viewer CLI output safety", () => {
  it.each(["svg", "spec"] as const)("refuses a hard-linked %s input as the output path", (aliasKind) => {
    const temp = mkdtempSync(join(tmpdir(), "maru-offline-viewer-output-alias-"));
    const svgPath = join(temp, "engine.svg");
    const specPath = join(temp, "source.json");
    const outputPath = join(temp, "viewer.html");
    writeFileSync(svgPath, svgFixture);
    writeFileSync(specPath, specFixture);
    const aliasedInput = aliasKind === "svg" ? svgPath : specPath;
    const originalSvg = readFileSync(svgPath);
    const originalSpec = readFileSync(specPath);
    linkSync(aliasedInput, outputPath);

    try {
      const result = spawnSync(process.execPath, [builderPath, svgPath, specPath, outputPath], {
        cwd: process.cwd(),
        encoding: "utf8",
      });
      expect(result.error).toBeUndefined();
      expect(result.status).not.toBe(0);
      expect(`${result.stdout}\n${result.stderr}`).toContain("Existing files are never overwritten.");
      expect(readFileSync(svgPath)).toEqual(originalSvg);
      expect(readFileSync(specPath)).toEqual(originalSpec);
      expect(readFileSync(outputPath)).toEqual(aliasKind === "svg" ? originalSvg : originalSpec);
    } finally {
      rmSync(temp, { recursive: true, force: true });
    }
  });
});
