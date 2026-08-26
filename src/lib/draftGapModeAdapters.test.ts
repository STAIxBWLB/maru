import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

import { createKnowledgeModeController } from "./knowledgeModeStore";

describe("knowledge-mode adapters", () => {
  it("keeps one-shot Gap route requests distinct and consumable", () => {
    const controller = createKnowledgeModeController();

    controller.requestGapDraft("draft-1");
    const first = controller.getGapSlice();
    controller.consumeGapDraft(first.initialDraftRequest);
    controller.requestGapDraft("draft-1");
    const second = controller.getGapSlice();

    expect(first.initialDraftId).toBe("draft-1");
    expect(second.initialDraftId).toBe("draft-1");
    expect(second.initialDraftRequest).toBeGreaterThan(first.initialDraftRequest);
  });

  it("ships dedicated Drafts and Gap adapters with canonical agent and visual composition", () => {
    const root = resolve(import.meta.dirname, "modeAdapters");
    const drafts = readFileSync(resolve(root, "DraftsModeAdapter.tsx"), "utf8");
    const gap = readFileSync(resolve(root, "GapModeAdapter.tsx"), "utf8");

    expect(drafts).toContain("useAgentRegistrySlice");
    expect(drafts).toContain("knowledgeModeController.requestGapDraft");
    expect(drafts).toContain("knowledgeModeController.openGraphReference");
    expect(gap).toContain("useGapModeSlice");
    expect(gap).toContain("knowledgeModeController.consumeGapDraft");
    expect(gap).toContain("knowledgeModeController.openGraphReference");
  });
});
