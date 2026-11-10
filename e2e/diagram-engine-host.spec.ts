import { existsSync, readFileSync } from "node:fs";
import { expect, test } from "@playwright/test";

const browserSpec = readFileSync(new URL("./diagram.spec.ts", import.meta.url), "utf8");
const oldHostHelper = new URL("./helpers/diagramEngineHost.ts", import.meta.url);

test("semantic browser validation uses the generated SDK without a Node sidecar override", () => {
  expect(existsSync(oldHostHelper)).toBe(false);
  expect(browserSpec).not.toContain("diagramValidateFixture");
  expect(browserSpec).not.toMatch(/exposeFunction\s*\(/);
  expect(browserSpec).not.toMatch(/page\.route\([^\n]*generationHost/);
  expect(browserSpec).toContain("loadWasmEngine");
});
