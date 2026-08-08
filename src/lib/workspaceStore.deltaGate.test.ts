import { beforeEach, describe, expect, it, vi } from "vitest";

import type { VaultEntry } from "./types";

const scanVault = vi.fn(async (): Promise<VaultEntry[]> => []);
const scanVaultPaths = vi.fn(async (): Promise<VaultEntry[]> => []);

vi.mock("./api", () => ({
  isTauri: () => false,
  scanVault: (...args: unknown[]) => scanVault(...(args as [])),
  scanVaultPaths: (...args: unknown[]) => scanVaultPaths(...(args as [])),
  startVaultWatcher: async () => undefined,
  stopVaultWatcher: async () => undefined,
}));

import { scanAndApplyVaultDelta, updateWorkspaceState } from "./workspaceStore";

const WS = "/ws-delta-gate";

function entry(relPath: string): VaultEntry {
  return {
    path: `${WS}/${relPath}`,
    relPath,
    title: relPath,
    frontmatter: {},
    updatedAt: null,
    wordCount: 0,
    snippet: "",
    fileKind: "md",
    versionCount: 0,
  };
}

describe("scanAndApplyVaultDelta startup gate", () => {
  beforeEach(() => {
    scanVault.mockClear();
    scanVaultPaths.mockClear();
  });

  it("upgrades to a full rescan while the workspace is not yet populated", async () => {
    // No state for WS yet -> startupIoReady is falsy -> full scan, no delta.
    await scanAndApplyVaultDelta(WS, ["a.md"]);
    expect(scanVault).toHaveBeenCalledTimes(1);
    expect(scanVaultPaths).not.toHaveBeenCalled();
  });

  it("applies an incremental delta once startupIoReady is set", async () => {
    updateWorkspaceState(WS, { startupIoReady: true, entries: [entry("a.md")] });
    scanVaultPaths.mockResolvedValueOnce([entry("a.md")]);
    await scanAndApplyVaultDelta(WS, ["a.md"]);
    expect(scanVaultPaths).toHaveBeenCalledTimes(1);
    expect(scanVault).not.toHaveBeenCalled();
  });

  it("no-ops on an empty touched set", async () => {
    await scanAndApplyVaultDelta(WS, []);
    expect(scanVault).not.toHaveBeenCalled();
    expect(scanVaultPaths).not.toHaveBeenCalled();
  });
});
