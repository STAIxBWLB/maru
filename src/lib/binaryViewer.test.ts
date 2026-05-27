import { describe, expect, it } from "vitest";
import { getViewerCategory, isViewableInApp, usesAssetProtocol } from "./binaryViewer";
import type { WorkspaceFileEntry } from "./types";

function entry(fileKind: string, extension = fileKind): WorkspaceFileEntry {
  return {
    path: `/workspace/file.${extension}`,
    relPath: `file.${extension}`,
    name: `file.${extension}`,
    extension,
    fileKind,
    sizeBytes: 10,
    updatedAt: null,
    gitTracked: false,
    binary: true,
  };
}

describe("binary viewer classification fallback", () => {
  it("keeps known viewer types optimistic and unknown types unsupported", () => {
    expect(getViewerCategory(entry("pdf"))).toBe("pdf");
    expect(getViewerCategory(entry("docx"))).toBe("docx");
    expect(getViewerCategory(entry("bin"))).toBe("unsupported");
    expect(isViewableInApp(entry("bin"))).toBe(false);
  });

  it("prepares only asset-backed inline viewers through the asset protocol", () => {
    expect(usesAssetProtocol("pdf")).toBe(true);
    expect(usesAssetProtocol("image")).toBe(true);
    expect(usesAssetProtocol("text")).toBe(false);
    expect(usesAssetProtocol("archive")).toBe(false);
    expect(usesAssetProtocol("unsupported")).toBe(false);
  });
});
