import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { invoke } from "@tauri-apps/api/core";

vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn(),
}));

const mocks = vi.hoisted(() => ({ notice: vi.fn() }));
vi.mock("./errorStore", () => ({ publishOperationNotice: mocks.notice }));

import "./i18n/testing";
import {
  classifyTemplateFillCompletion,
  classifyTemplatePrepareCompletion,
  createInitialStudioState,
  normalizeStudioState,
  nextStudioStep,
  previousStudioStep,
  sanitizeStudioDocId,
  studioApplyBody,
  studioDocIdFromDocument,
  templateFillHwpx,
  templatePrepareHwpxTemplate,
} from "./studio";
import type { DocumentPayload } from "./types";

function document(overrides: Partial<DocumentPayload> = {}): DocumentPayload {
  return {
    path: "/work/reports/plan.md",
    relPath: "reports/plan.md",
    title: "Plan",
    content: "---\nid: doc-123\ntype: report\n---\n# Plan\n\nBody",
    body: "# Plan\n\nBody",
    meta: {
      id: "doc-123",
      type: "report",
    },
    fileKind: "md",
    ...overrides,
  };
}

describe("studio helpers", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("sanitizes doc ids into leaf tokens", () => {
    expect(sanitizeStudioDocId("reports/2026 plan.md")).toBe("reports-2026-plan");
    expect(sanitizeStudioDocId("../bad/path")).toBe("bad-path");
    expect(sanitizeStudioDocId("")).toBe("studio");
  });

  it("prefers frontmatter id for active document state", () => {
    expect(studioDocIdFromDocument(document())).toBe("doc-123");
    expect(
      studioDocIdFromDocument(
        document({
          meta: {},
          relPath: "ops/business plan.md",
        }),
      ),
    ).toBe("ops-business-plan");
  });

  it("creates initial state from the active document body", () => {
    const state = createInitialStudioState(document());
    expect(state.docId).toBe("doc-123");
    expect(state.source.mode).toBe("activeDocument");
    expect(state.source.documentPath).toBe("/work/reports/plan.md");
    expect(state.source.docType).toBe("report");
    expect(state.bodyDraft).toBe("# Plan\n\nBody");
  });

  it("falls back to a generated draft id when no document is active", () => {
    vi.spyOn(Date, "now").mockReturnValue(1234);
    const state = createInitialStudioState(null);
    expect(state.docId).toBe("studio-1234");
    expect(state.source.mode).toBe("newDocument");
    expect(state.bodyDraft).toBe("");
  });

  it("preserves the hwp_cli_skill source for native template routing", () => {
    const initial = createInitialStudioState(document());
    const state = normalizeStudioState({
      ...initial,
      template: {
        id: "hwp-template",
        slug: "report",
        version: 1,
        title: "Report",
        businessUnit: null,
        documentTypeCode: "report",
        source: "hwp_cli_skill",
        hwpxTemplateKey: "보고서",
      },
    });
    expect(state.template?.source).toBe("hwp_cli_skill");
    expect(state.template?.hwpxTemplateKey).toBe("보고서");
  });

  it("steps forward and backward within the fixed wizard bounds", () => {
    expect(nextStudioStep("source")).toBe("template");
    expect(nextStudioStep("package")).toBe("package");
    expect(previousStudioStep("sections")).toBe("guidelines");
    expect(previousStudioStep("source")).toBe("source");
  });

  it("fails clearly when applying body outside Tauri", async () => {
    await expect(studioApplyBody("/work", "/work/reports/plan.md", "# Body")).rejects.toThrow(
      "studio_apply_body_requires_tauri",
    );
  });
});

describe("template processing completion ownership (phase 08-25)", () => {
  beforeEach(() => {
    vi.mocked(invoke).mockReset();
    mocks.notice.mockReset();
    (globalThis as { window?: unknown }).window = { __TAURI_INTERNALS__: {} };
  });

  afterEach(() => {
    delete (globalThis as { window?: unknown }).window;
  });

  it("manualFallback is informational with its reason, never a success claim", async () => {
    const payload = {
      inputPath: "/templates/report.hwp",
      preparedPath: null,
      status: "manualFallback",
      reason: "hwp converter unavailable",
    };
    vi.mocked(invoke).mockResolvedValueOnce(payload);
    await expect(
      templatePrepareHwpxTemplate("/workspace", "/templates/report.hwp"),
    ).resolves.toBe(payload);
    expect(mocks.notice).toHaveBeenCalledTimes(1);
    expect(mocks.notice.mock.calls[0][0]).toMatchObject({ kind: "info" });
    expect(mocks.notice.mock.calls[0][0].message).toContain("hwp converter unavailable");
    expect(mocks.notice.mock.calls[0][0].message).not.toContain("(1");
  });

  it("ready prepare publishes exactly one success notice retaining the prepared path", async () => {
    const payload = {
      inputPath: "/templates/report.hwp",
      preparedPath: "/tmp/report.hwpx",
      status: "ready",
      reason: null,
    };
    vi.mocked(invoke).mockResolvedValueOnce(payload);
    await expect(
      templatePrepareHwpxTemplate("/workspace", "/templates/report.hwp"),
    ).resolves.toBe(payload);
    expect(mocks.notice).toHaveBeenCalledTimes(1);
    expect(mocks.notice.mock.calls[0][0]).toMatchObject({ kind: "success" });
    expect(classifyTemplatePrepareCompletion(payload).status).toBe("all-success");
    expect(classifyTemplatePrepareCompletion(payload).succeeded).toEqual(["/tmp/report.hwpx"]);
  });

  it("unsuccessful prepare payload without preparedPath is all-failed with its reason", () => {
    const completion = classifyTemplatePrepareCompletion({
      inputPath: "/templates/report.hwp",
      preparedPath: null,
      status: "error",
      reason: "template locked",
    });
    expect(completion.status).toBe("all-failed");
    expect(completion.failed[0]).toEqual({ label: "/templates/report.hwp", reason: "template locked" });
  });

  it("fill with failed validation retains the output path and reports actionable reasons", () => {
    const completion = classifyTemplateFillCompletion({
      outputPath: "/out/report.hwpx",
      replacedCount: 4,
      validationOk: false,
      command: "fill",
      formFilledCount: 3,
      unmatchedFields: ["budget"],
      validationChecks: [
        { name: "requiredFields", status: "fail", reason: "missing 팀장 확인" },
        { name: "hash", status: "pass" },
      ],
      warnings: [],
    });
    expect(completion.status).toBe("partial-success");
    expect(completion.succeeded).toEqual(["/out/report.hwpx"]);
    expect(completion.failed.map((failure) => failure.reason)).toContain("missing 팀장 확인");
    expect(completion.failed.map((failure) => failure.label)).toContain("budget");
  });

  it("fill never equates output existence with full success when validation failed", async () => {
    const payload = {
      outputPath: "/out/report.hwpx",
      replacedCount: 4,
      validationOk: false,
      command: "fill",
      formFilledCount: 3,
      unmatchedFields: ["budget"],
      validationChecks: [{ name: "requiredFields", status: "fail", reason: "missing sign-off" }],
      warnings: [],
    };
    vi.mocked(invoke).mockResolvedValueOnce(payload);
    await expect(
      templateFillHwpx("/workspace", { templatePath: "/templates/report.hwpx", values: {} }),
    ).resolves.toBe(payload);
    expect(mocks.notice).toHaveBeenCalledTimes(1);
    expect(mocks.notice.mock.calls[0][0]).toMatchObject({ kind: "info" });
    expect(mocks.notice.mock.calls[0][0].message).toContain("missing sign-off");
  });

  it("fill with passing validation publishes exactly one success notice", async () => {
    const payload = {
      outputPath: "/out/report.hwpx",
      replacedCount: 4,
      validationOk: true,
      command: "fill",
      formFilledCount: 4,
      unmatchedFields: [],
      validationChecks: [{ name: "requiredFields", status: "pass" }],
      warnings: [],
    };
    vi.mocked(invoke).mockResolvedValueOnce(payload);
    await expect(
      templateFillHwpx("/workspace", { templatePath: "/templates/report.hwpx", values: {} }),
    ).resolves.toBe(payload);
    expect(mocks.notice).toHaveBeenCalledTimes(1);
    expect(mocks.notice.mock.calls[0][0]).toMatchObject({ kind: "success" });
  });

  it("typed fill rejection rethrows the original rejection and reports it once", async () => {
    const rejection = { code: "template_fill_failed", message: "hwped task failed" };
    vi.mocked(invoke).mockRejectedValueOnce(rejection);
    let caught: unknown;
    try {
      await templateFillHwpx("/workspace", { templatePath: "/templates/report.hwpx", values: {} });
    } catch (error) {
      caught = error;
    }
    expect(caught).toBe(rejection);
    expect(mocks.notice).toHaveBeenCalledTimes(1);
    expect(mocks.notice.mock.calls[0][0]).toMatchObject({ kind: "error" });
    expect(mocks.notice.mock.calls[0][0].message).toContain("hwped task failed");
    expect(invoke).toHaveBeenCalledTimes(1);
  });

  it("browser fallback behavior is preserved: prepare still requires Tauri", async () => {
    delete (globalThis as { window?: unknown }).window;
    await expect(
      templatePrepareHwpxTemplate("/workspace", "/templates/report.hwp"),
    ).rejects.toThrow("template_prepare_requires_tauri");
    expect(mocks.notice).not.toHaveBeenCalled();
  });

  it("an explicit outer owner suppresses the inner template notice for Studio flow ownership", async () => {
    const payload = {
      inputPath: "/templates/report.hwp",
      preparedPath: "/tmp/report.hwpx",
      status: "ready",
      reason: null,
    };
    vi.mocked(invoke).mockResolvedValueOnce(payload);
    await expect(
      templatePrepareHwpxTemplate("/workspace", "/templates/report.hwp", {
        outerOperationId: "studio-flow-1",
      }),
    ).resolves.toBe(payload);
    expect(mocks.notice).not.toHaveBeenCalled();
  });
});
