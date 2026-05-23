import { describe, expect, it, vi } from "vitest";

vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn(),
}));

import { summarizeDispatch, type ExportDispatchResponse } from "./export";

function dispatchResponse(patch: Partial<ExportDispatchResponse> = {}): ExportDispatchResponse {
  return {
    manifest_path: "bundle/manifest.yaml",
    manifest: {
      schema_version: 1,
      source: "source.md",
      source_sha256: "abc",
      source_byte_size: 12,
      generated_at: "2026-05-23T00:00:00Z",
      outputs: [],
    },
    validation: {
      manifest_path: "bundle/manifest.yaml",
      source_path: "source.md",
      source_status: "pass",
      entries: [],
    },
    results: [],
    ...patch,
  };
}

describe("summarizeDispatch", () => {
  it("trims the first failure reason before display", () => {
    const summary = summarizeDispatch(
      dispatchResponse({
        results: [
          {
            format: "docx",
            output_path: "out.docx",
            success: false,
            command: "pandoc",
            reason: "  converter missing  ",
          },
        ],
      }),
    );

    expect(summary).toContain("first failure: converter missing");
    expect(summary).not.toContain("  converter missing  ");
  });
});
