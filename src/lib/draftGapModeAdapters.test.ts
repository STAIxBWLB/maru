import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

import { createKnowledgeModeController } from "./knowledgeModeStore";
import { visualModeController } from "./visualModeStore";

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

  it("isolates Drafts and Gap publications while delegating graph focus to the visual owner", () => {
    const controller = createKnowledgeModeController();
    let draftsUpdates = 0;
    let gapUpdates = 0;
    const stopDrafts = controller.subscribe("drafts", () => draftsUpdates += 1);
    const stopGap = controller.subscribe("gap", () => gapUpdates += 1);

    controller.setDraftsWorkspace("/workspace");
    expect(draftsUpdates).toBe(1);
    expect(gapUpdates).toBe(0);
    expect(controller.openGraphReference("drafts", {
      docPath: "note.md",
      nodePaths: ["related.md"],
    }, "/workspace")).toBe(true);
    expect(visualModeController.getGraphModeSlice().referenceFocus).toMatchObject({
      source: "drafts",
      docRoot: "/workspace",
      nodePaths: ["related.md"],
    });
    controller.clearGraphReference("drafts");
    expect(visualModeController.getGraphModeSlice().referenceFocus).toBeNull();

    stopDrafts();
    stopGap();
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
