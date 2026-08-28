import { describe, expect, it } from "vitest";

import {
  createKnowledgeModeController,
  type KnowledgeModeController,
} from "./knowledgeModeStore";

function createController(): KnowledgeModeController {
  return createKnowledgeModeController();
}

describe("knowledgeModeStore Scratchpad slice", () => {
  it("keeps persisted Scratchpad settings and transient refresh intent in separate stable slices", () => {
    const controller = createController();
    const initial = controller.getScratchpadSlice();
    let scratchpadUpdates = 0;
    let draftsUpdates = 0;
    const stopScratchpad = controller.subscribe("scratchpad", () => scratchpadUpdates += 1);
    const stopDrafts = controller.subscribe("drafts", () => draftsUpdates += 1);

    controller.setScratchpadWorkspace("/workspace");
    controller.setScratchpadSettings({
      sortKey: "modifiedDesc",
      listHeight: 360,
      listWidth: 320,
      treeOpen: true,
      treeWidth: 240,
      expandedFolders: ["memos"],
      editorViewMode: "source",
    });
    const configured = controller.getScratchpadSlice();
    controller.requestScratchpadRefresh();

    expect(initial).not.toBe(configured);
    expect(configured).toMatchObject({
      workspacePath: "/workspace",
      sortKey: "modifiedDesc",
      listHeight: 360,
      listWidth: 320,
      treeOpen: true,
      treeWidth: 240,
      expandedFolders: ["memos"],
      editorViewMode: "source",
      refreshRequestEpoch: 0,
    });
    expect(controller.getScratchpadSlice().refreshRequestEpoch).toBe(1);
    expect(scratchpadUpdates).toBe(3);
    expect(draftsUpdates).toBe(0);

    stopScratchpad();
    stopDrafts();
  });

  it("rejects stale workspace publications and retains identities for equivalent updates", () => {
    const controller = createController();
    const firstGeneration = controller.setScratchpadWorkspace("/workspace-a");
    const secondGeneration = controller.setScratchpadWorkspace("/workspace-b");
    const current = controller.getScratchpadSlice();

    expect(controller.publishScratchpadForWorkspace(firstGeneration, { refreshRequestEpoch: 9 })).toBe(false);
    expect(controller.publishScratchpadForWorkspace(secondGeneration, { refreshRequestEpoch: 0 })).toBe(true);
    expect(controller.getScratchpadSlice()).toBe(current);
  });
});
