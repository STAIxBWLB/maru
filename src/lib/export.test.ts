import { beforeEach, describe, expect, it, vi } from "vitest";
import { invoke } from "@tauri-apps/api/core";

vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn(),
}));

const mocks = vi.hoisted(() => ({ notice: vi.fn() }));
vi.mock("./errorStore", () => ({ publishOperationNotice: mocks.notice }));

import "./i18n/testing";
import {
  classifyExportDispatchCompletion,
  exportDispatch,
  summarizeDispatch,
  type ExportDispatchResponse,
} from "./export";

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

describe("exportDispatch completion ownership (phase 08-25)", () => {
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

  beforeEach(() => {
    vi.mocked(invoke).mockReset();
    mocks.notice.mockReset();
  });

  it("classifier treats empty dispatch results as informational, not success", () => {
    expect(classifyExportDispatchCompletion(dispatchResponse()).status).toBe("empty");
  });

  it("classifier records per-format failures with reasons and retains outputs", () => {
    const completion = classifyExportDispatchCompletion(
      dispatchResponse({
        results: [
          { format: "docx", output_path: "out.docx", success: true, command: "pandoc" },
          { format: "pdf", output_path: "out.pdf", success: false, command: "wkhtmltopdf", reason: "converter missing" },
        ],
      }),
    );
    expect(completion.status).toBe("partial-success");
    expect(completion.succeeded).toEqual(["docx: out.docx"]);
    expect(completion.failed).toEqual([{ label: "pdf", reason: "converter missing" }]);
  });

  it("falls back to the validation summary when a failed result has no reason", () => {
    const completion = classifyExportDispatchCompletion(
      dispatchResponse({
        validation: {
          manifest_path: "bundle/manifest.yaml",
          source_path: "source.md",
          source_status: "hash-mismatch",
          entries: [],
        },
        results: [
          { format: "docx", output_path: "out.docx", success: false, command: "pandoc", reason: null },
        ],
      }),
    );
    expect(completion.status).toBe("all-failed");
    expect(completion.failed[0].reason).toContain("source: hash-mismatch");
  });

  it("mixed fulfilled dispatch after view disposal publishes exactly one info notice with payload identity", async () => {
    const payload = dispatchResponse({
      results: [
        { format: "docx", output_path: "out.docx", success: true, command: "pandoc" },
        { format: "pdf", output_path: "out.pdf", success: false, command: "wk", reason: "converter missing" },
      ],
    });
    let resolveInvoke!: (value: ExportDispatchResponse) => void;
    vi.mocked(invoke).mockReturnValueOnce(
      new Promise<ExportDispatchResponse>((yes) => {
        resolveInvoke = yes;
      }),
    );
    const promise = exportDispatch({ workspaceRoot: "/workspace", manifestPath: "bundle/manifest.yaml" });
    resolveInvoke(payload);
    await expect(promise).resolves.toBe(payload);
    expect(invoke).toHaveBeenCalledTimes(1);
    expect(mocks.notice).toHaveBeenCalledTimes(1);
    expect(mocks.notice.mock.calls[0][0]).toMatchObject({ kind: "info" });
    expect(mocks.notice.mock.calls[0][0].message).toContain("converter missing");
  });

  it("all-failed fulfilled dispatch publishes exactly one error notice", async () => {
    const payload = dispatchResponse({
      results: [
        { format: "docx", output_path: "out.docx", success: false, command: "pandoc", reason: "converter missing" },
      ],
    });
    vi.mocked(invoke).mockResolvedValueOnce(payload);
    await expect(
      exportDispatch({ workspaceRoot: "/workspace", manifestPath: "bundle/manifest.yaml" }),
    ).resolves.toBe(payload);
    expect(mocks.notice).toHaveBeenCalledTimes(1);
    expect(mocks.notice.mock.calls[0][0]).toMatchObject({ kind: "error" });
  });

  it("all-success dispatch publishes exactly one success notice and keeps the manifest payload", async () => {
    const payload = dispatchResponse({
      results: [
        { format: "docx", output_path: "out.docx", success: true, command: "pandoc" },
        { format: "pdf", output_path: "out.pdf", success: true, command: "wk" },
      ],
    });
    vi.mocked(invoke).mockResolvedValueOnce(payload);
    await expect(
      exportDispatch({ workspaceRoot: "/workspace", manifestPath: "bundle/manifest.yaml" }),
    ).resolves.toBe(payload);
    expect(mocks.notice).toHaveBeenCalledTimes(1);
    expect(mocks.notice.mock.calls[0][0]).toMatchObject({ kind: "success" });
  });

  it("typed rejection publishes one error notice and rethrows the original rejection unchanged", async () => {
    const rejection = { code: "export_dispatch_failed", message: "manifest unreadable" };
    vi.mocked(invoke).mockRejectedValueOnce(rejection);
    let caught: unknown;
    try {
      await exportDispatch({ workspaceRoot: "/workspace", manifestPath: "bundle/manifest.yaml" });
    } catch (error) {
      caught = error;
    }
    expect(caught).toBe(rejection);
    expect(mocks.notice).toHaveBeenCalledTimes(1);
    expect(mocks.notice.mock.calls[0][0].message).toContain("manifest unreadable");
    expect(invoke).toHaveBeenCalledTimes(1);
  });

  it("an explicit outer owner suppresses the inner dispatch notice but still records the classification", async () => {
    const payload = dispatchResponse({
      results: [{ format: "docx", output_path: "out.docx", success: true, command: "pandoc" }],
    });
    vi.mocked(invoke).mockResolvedValueOnce(payload);
    await expect(
      exportDispatch(
        { workspaceRoot: "/workspace", manifestPath: "bundle/manifest.yaml" },
        { outerOperationId: "studio-flow-1" },
      ),
    ).resolves.toBe(payload);
    expect(mocks.notice).not.toHaveBeenCalled();
  });
});
