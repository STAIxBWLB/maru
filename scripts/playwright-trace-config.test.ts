// Behavioral proof for GATE-08: the narrowed Playwright trace config that the
// 11-03 CI probe measured (retain-on-failure, no snapshots/screenshots) is
// guarded so a later edit cannot silently invalidate that evidence.
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

describe("Playwright trace config stays narrowed (GATE-08)", () => {
  it("playwright.config.ts keeps trace at retain-on-failure with snapshots and screenshots off", () => {
    const source = readFileSync(resolve(process.cwd(), "playwright.config.ts"), "utf8");
    expect(source).toMatch(
      /trace:\s*\{\s*mode:\s*"retain-on-failure",\s*snapshots:\s*false,\s*screenshots:\s*false\s*\}/,
    );
  });
});
