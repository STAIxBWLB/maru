import { describe, expect, it } from "vitest";
import { mockEntries } from "./fixtures";
import type { VaultEntry } from "./types";
import {
  isCurrentWorkspaceFilesScanRequest,
  mergeFreshEntry,
  planVaultStartup,
  shouldLazyScanWorkspaceFiles,
  workspaceFileScanPaneMode,
  workspaceFilesScanStatusAfterFailure,
} from "./vaultStartup";

describe("vault startup planning", () => {
  it("demands a file scan only for Files or a visible PKM Explorer", () => {
    const base = {
      visibleAppMode: "pkm" as const,
      outlineOpen: true,
      rightPaneTab: "explorer" as const,
      explorerPaneMode: "documents" as const,
    };
    expect(workspaceFileScanPaneMode(base)).toBe("files");
    expect(workspaceFileScanPaneMode({ ...base, outlineOpen: false })).toBe("documents");
    expect(
      workspaceFileScanPaneMode({ ...base, visibleAppMode: "inbox" }),
    ).toBe("documents");
    expect(
      workspaceFileScanPaneMode({
        ...base,
        visibleAppMode: "files",
        outlineOpen: false,
        rightPaneTab: "workspace",
      }),
    ).toBe("files");
  });

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

  it("defers workspace file scanning until the Files pane is visible after startup I/O", () => {
    expect(
      shouldLazyScanWorkspaceFiles({
        paneMode: "documents",
        startupIoReady: true,
        scanStatus: "unscanned",
        loading: false,
        refreshing: false,
      }),
    ).toBe(false);

    expect(
      shouldLazyScanWorkspaceFiles({
        paneMode: "files",
        startupIoReady: false,
        scanStatus: "unscanned",
        loading: false,
        refreshing: false,
      }),
    ).toBe(false);

    expect(
      shouldLazyScanWorkspaceFiles({
        paneMode: "files",
        startupIoReady: true,
        scanStatus: "unscanned",
        loading: false,
        refreshing: false,
      }),
    ).toBe(true);

    // A successful scan is complete even when the workspace is empty.
    expect(
      shouldLazyScanWorkspaceFiles({
        paneMode: "files",
        startupIoReady: true,
        scanStatus: "ready",
        loading: false,
        refreshing: false,
      }),
    ).toBe(false);

    // Failed automatic scans wait for an explicit refresh instead of looping.
    expect(
      shouldLazyScanWorkspaceFiles({
        paneMode: "files",
        startupIoReady: true,
        scanStatus: "failed",
        loading: false,
        refreshing: false,
      }),
    ).toBe(false);

    expect(
      shouldLazyScanWorkspaceFiles({
        paneMode: "files",
        startupIoReady: true,
        scanStatus: "unscanned",
        loading: true,
        refreshing: false,
      }),
    ).toBe(false);

    expect(
      shouldLazyScanWorkspaceFiles({
        paneMode: "files",
        startupIoReady: true,
        scanStatus: "unscanned",
        loading: false,
        refreshing: true,
      }),
    ).toBe(false);
  });

  it("preserves a successful file snapshot when a refresh fails", () => {
    expect(workspaceFilesScanStatusAfterFailure("ready")).toBe("ready");
    expect(workspaceFilesScanStatusAfterFailure("unscanned")).toBe("failed");
    expect(workspaceFilesScanStatusAfterFailure("failed")).toBe("failed");
  });

  it("guards scan completions independently per workspace", () => {
    const latest = { private: 3, public: 1 };
    expect(isCurrentWorkspaceFilesScanRequest(latest, "private", 2)).toBe(false);
    expect(isCurrentWorkspaceFilesScanRequest(latest, "private", 3)).toBe(true);
    expect(isCurrentWorkspaceFilesScanRequest(latest, "public", 1)).toBe(true);
  });
});
