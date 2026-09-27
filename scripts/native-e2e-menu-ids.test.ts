// Behavioral proof for the 06-03 T2 cross-check: every menu command id
// dispatched by e2e-native/specs/menu.spec.ts must be a declared id in
// src-tauri/src/app_menu.rs (T-06-01). If a menu id is renamed on one side
// without the other, this fails instead of the spec silently exercising a
// dead id.
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const specPath = resolve(process.cwd(), "e2e-native/specs/menu.spec.ts");
const menuRustPath = resolve(process.cwd(), "src-tauri/src/app_menu.rs");

function extractDispatchedIds(source: string): string[] {
  const ids = new Set<string>();
  for (const match of source.matchAll(/dispatchMenuCommand\(\s*"([^"]+)"\s*\)/g)) {
    ids.add(match[1]);
  }
  return [...ids];
}

describe("native menu command ids stay in sync with app_menu.rs", () => {
  it("declares every id menu.spec.ts drives through the debug bridge", () => {
    const specSource = readFileSync(specPath, "utf8");
    const menuSource = readFileSync(menuRustPath, "utf8");

    const dispatchedIds = extractDispatchedIds(specSource);
    expect(dispatchedIds.length).toBeGreaterThan(0);

    const undeclared = dispatchedIds.filter((id) => !menuSource.includes(`"${id}"`));
    expect(undeclared, `ids missing from src-tauri/src/app_menu.rs: ${undeclared.join(", ")}`).toEqual(
      [],
    );
  });
});
