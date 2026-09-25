// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { invoke } from "@tauri-apps/api/core";
import {
  isMissingWorkspaceConfigError,
  isWorkspaceConfigShellUnavailableError,
  nextIgnorePatterns,
  resolveWorkspaceConfigLoad,
  writeRecoveryCopy,
} from "./maruDir";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));

describe("isMissingWorkspaceConfigError", () => {
  it("accepts only the backend's exact missing-config error prefix", () => {
    expect(
      isMissingWorkspaceConfigError(
        "workspace.config.yaml not found at /workspace/plain/workspace.config.yaml",
      ),
    ).toBe(true);
    expect(
      isMissingWorkspaceConfigError(
        new Error(
          "workspace.config.yaml not found at /workspace/plain/workspace.config.yaml",
        ),
      ),
    ).toBe(true);
    expect(
      isMissingWorkspaceConfigError(
        "Cannot parse workspace.config.yaml: invalid type at line 2",
      ),
    ).toBe(false);
    expect(
      isMissingWorkspaceConfigError(
        "Cannot read workspace.config.yaml: Permission denied",
      ),
    ).toBe(false);
    expect(isMissingWorkspaceConfigError("workspace.config.yaml not found")).toBe(false);
    expect(
      isMissingWorkspaceConfigError({
        message: "workspace.config.yaml not found at /workspace/plain/workspace.config.yaml",
      }),
    ).toBe(true);
    expect(
      isMissingWorkspaceConfigError({
        message: "Cannot parse workspace.config.yaml: invalid YAML",
      }),
    ).toBe(false);
  });

  it("accepts only the exact browser shell-unavailable error", async () => {
    const exact = "workspace.config.yaml requires the Tauri shell";
    expect(isWorkspaceConfigShellUnavailableError(exact)).toBe(true);
    expect(isWorkspaceConfigShellUnavailableError(new Error(exact))).toBe(true);
    expect(isWorkspaceConfigShellUnavailableError(`${exact}.`)).toBe(false);
    expect(
      isWorkspaceConfigShellUnavailableError(
        `Cannot read workspace.config.yaml: ${exact}`,
      ),
    ).toBe(false);

    await expect(
      resolveWorkspaceConfigLoad("/workspace/browser", async () => {
        throw new Error(exact);
      }),
    ).resolves.toMatchObject({
      workPath: "/workspace/browser",
      status: "ready",
      config: null,
      error: null,
    });
    await expect(
      resolveWorkspaceConfigLoad("/workspace/broken", async () => {
        throw new Error(`${exact}.`);
      }),
    ).resolves.toMatchObject({
      workPath: "/workspace/broken",
      status: "error",
      config: null,
      error: `${exact}.`,
    });
  });
});

describe("nextIgnorePatterns", () => {
  const doc = {
    relPath: ".maruignore",
    patterns: ["archive", "*.png"],
    builtin: [".DS_Store"],
  };

  it("appends a new pattern at the end", () => {
    expect(nextIgnorePatterns(doc, "drafts/tmp.md")).toEqual([
      "archive",
      "*.png",
      "drafts/tmp.md",
    ]);
  });

  it("trims before comparing", () => {
    expect(nextIgnorePatterns(doc, "  drafts/a.md ")).toEqual([
      "archive",
      "*.png",
      "drafts/a.md",
    ]);
  });

  it("returns null when the pattern changes nothing", () => {
    expect(nextIgnorePatterns(doc, "archive")).toBeNull();
    expect(nextIgnorePatterns(doc, "  *.png  ")).toBeNull();
    expect(nextIgnorePatterns(doc, ".DS_Store")).toBeNull();
    expect(nextIgnorePatterns(doc, "   ")).toBeNull();
    expect(nextIgnorePatterns(doc, "# a comment")).toBeNull();
  });
});

describe("writeRecoveryCopy", () => {
  const originalTauriInternals = window.__TAURI_INTERNALS__;

  beforeEach(() => {
    vi.mocked(invoke).mockReset();
  });

  afterEach(() => {
    window.__TAURI_INTERNALS__ = originalTauriInternals;
  });

  it("throws outside the Tauri shell without invoking anything", async () => {
    delete window.__TAURI_INTERNALS__;
    await expect(
      writeRecoveryCopy("/workspace", "notes/draft.md", "body", "flush timed out"),
    ).rejects.toThrow("Recovery copies require the Tauri shell");
    expect(invoke).not.toHaveBeenCalled();
  });

  it("invokes write_recovery_copy with the raw arguments inside the Tauri shell", async () => {
    window.__TAURI_INTERNALS__ = {};
    vi.mocked(invoke).mockResolvedValue(".maru/recovery/20260102-030405-draft-1a2b3c4d.md");
    await expect(
      writeRecoveryCopy("/workspace", "notes/draft.md", "body", "flush timed out"),
    ).resolves.toBe(".maru/recovery/20260102-030405-draft-1a2b3c4d.md");
    expect(invoke).toHaveBeenCalledWith("write_recovery_copy", {
      workPath: "/workspace",
      filePath: "notes/draft.md",
      content: "body",
      reason: "flush timed out",
    });
  });
});
