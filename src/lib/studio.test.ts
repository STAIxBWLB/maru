import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createInitialStudioState,
  nextStudioStep,
  previousStudioStep,
  sanitizeStudioDocId,
  studioApplyBody,
  studioDocIdFromDocument,
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
