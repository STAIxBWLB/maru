import { describe, expect, it } from "vitest";
import { mockEntries } from "./fixtures";
import type { VaultEntry } from "./types";
import { mergeFreshEntry, planVaultStartup } from "./vaultStartup";

describe("vault startup planning", () => {
  it("prefers the requested cached entry and restores it as the first tab", () => {
    const entries = mockEntries();
    const plan = planVaultStartup(
      entries,
      {
        activeRelPath: entries[0].relPath,
        relPaths: entries.map((entry) => entry.relPath),
      },
      entries[1].relPath,
    );

    expect(plan.candidate?.relPath).toBe(entries[1].relPath);
    expect(plan.tabEntries.map((entry) => entry.relPath)).toEqual([
      entries[1].relPath,
      entries[0].relPath,
    ]);
  });

  it("falls back from missing stored tabs to the first scanned entry", () => {
    const entries = mockEntries();
    const plan = planVaultStartup(
      entries,
      { activeRelPath: "missing.md", relPaths: ["missing.md"] },
      null,
    );

    expect(plan.candidate?.relPath).toBe(entries[0].relPath);
    expect(plan.tabEntries).toEqual([entries[0]]);
  });

  it("replaces stale cached entry metadata with background scan metadata", () => {
    const [cached] = mockEntries();
    const fresh: VaultEntry = {
      ...cached,
      title: "Fresh title",
      updatedAt: "2026-05-03T07:00:00+09:00",
      versionCount: 2,
    };
    const tab = { id: cached.path, entry: cached, draftContent: "draft" };

    expect(mergeFreshEntry(tab, [fresh])).toEqual({
      ...tab,
      entry: fresh,
    });
  });
});
