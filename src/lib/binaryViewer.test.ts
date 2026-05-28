import { describe, expect, it } from "vitest";
import packageJson from "../../package.json";
import {
  getViewerCategory,
  isViewableInApp,
  previewStrategyForCategory,
  usesAssetProtocol,
} from "./binaryViewer";
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
    expect(usesAssetProtocol("docx")).toBe(false);
    expect(usesAssetProtocol("xlsx")).toBe(false);
    expect(usesAssetProtocol("text")).toBe(false);
    expect(usesAssetProtocol("archive")).toBe(false);
    expect(usesAssetProtocol("unsupported")).toBe(false);
  });

  it("keeps preview policy lightweight by category", () => {
    expect(previewStrategyForCategory("pdf")).toBe("nativeInline");
    expect(previewStrategyForCategory("image")).toBe("nativeInline");
    expect(previewStrategyForCategory("audio")).toBe("nativeInline");
    expect(previewStrategyForCategory("text")).toBe("rustInline");
    expect(previewStrategyForCategory("archive")).toBe("rustInline");
    expect(previewStrategyForCategory("hwpx")).toBe("rustInline");
    expect(previewStrategyForCategory("docx")).toBe("system");
    expect(previewStrategyForCategory("xlsx")).toBe("system");
    expect(previewStrategyForCategory("unsupported")).toBe("system");
  });

  it("does not declare removed inline PDF/DOCX/XLSX renderer dependencies", () => {
    expect(packageJson.dependencies).not.toHaveProperty("pdfjs-dist");
    expect(packageJson.dependencies).not.toHaveProperty("mammoth");
    expect(packageJson.dependencies).not.toHaveProperty("xlsx");
  });
});
