// Behavioral proof for 06-04 T1: e2e-native/ must actually be wired into the
// typecheck and lint gates, not merely proven by a one-off manual
// deliberate-break drill. Asserts the actual contract in the repo's config
// files rather than re-running `pnpm typecheck`/`pnpm lint` (those are
// exercised at the end of the audit run).
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

function readJson(path: string): unknown {
  return JSON.parse(readFileSync(resolve(process.cwd(), path), "utf8"));
}

describe("e2e-native registration in typecheck and lint gates", () => {
  it("root tsconfig.json references tsconfig.e2e-native.json", () => {
    const root = readJson("tsconfig.json") as { references?: { path: string }[] };
    const paths = (root.references ?? []).map((r) => r.path);
    expect(paths).toContain("./tsconfig.e2e-native.json");
  });

  it("tsconfig.e2e-native.json includes e2e-native/**", () => {
    const cfg = readJson("tsconfig.e2e-native.json") as { include?: string[] };
    expect(cfg.include ?? []).toContain("e2e-native");
  });

  it("the lint script covers e2e-native", () => {
    const pkg = readJson("package.json") as { scripts?: Record<string, string> };
    expect(pkg.scripts?.lint ?? "").toMatch(/\be2e-native\b/);
  });

  it("eslint.config.js has a block whose files cover e2e-native and whose parserOptions point at tsconfig.e2e-native.json", () => {
    const eslintSource = readFileSync(resolve(process.cwd(), "eslint.config.js"), "utf8");
    // Find the object literal block that declares files matching e2e-native.
    const blockMatch = eslintSource.match(
      /files:\s*\[\s*"e2e-native\/\*\*\/\*\.ts"\s*\][\s\S]*?parserOptions:\s*\{[\s\S]*?\}/,
    );
    expect(
      blockMatch,
      "eslint.config.js has no block scoping files to e2e-native/**/*.ts",
    ).not.toBeNull();
    expect(blockMatch?.[0]).toContain('"./tsconfig.e2e-native.json"');
  });
});
