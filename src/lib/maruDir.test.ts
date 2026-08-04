import { describe, expect, it } from "vitest";
import {
  isMissingWorkspaceConfigError,
  isWorkspaceConfigShellUnavailableError,
  nextIgnorePatterns,
  resolveWorkspaceConfigLoad,
} from "./maruDir";

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
