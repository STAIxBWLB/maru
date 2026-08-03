import { describe, expect, it } from "vitest";
import {
  availableRightWorkbenchSurface,
  minimumWorkbenchWidth,
  resolveWorkbenchPlacement,
  shouldCloseRightSites,
} from "./workbenchLayout";

describe("resolveWorkbenchPlacement", () => {
  it("reserves enough width for Docs before sizing a right-docked terminal", () => {
    expect(
      minimumWorkbenchWidth({
        visibleAppMode: "pkm",
        rightWorkbenchMode: null,
        editorSplitOpen: false,
      }),
    ).toBe(736);
    expect(
      minimumWorkbenchWidth({
        visibleAppMode: "pkm",
        rightWorkbenchMode: null,
        editorSplitOpen: true,
      }),
    ).toBe(736);
    expect(
      minimumWorkbenchWidth({
        visibleAppMode: "pkm",
        rightWorkbenchMode: "sites",
        editorSplitOpen: false,
      }),
    ).toBe(608);
    expect(
      minimumWorkbenchWidth({
        visibleAppMode: "files",
        rightWorkbenchMode: null,
        editorSplitOpen: false,
      }),
    ).toBe(608);
  });

  it("opens a persisted non-editor surface only beside Docs", () => {
    expect(
      resolveWorkbenchPlacement({
        visibleAppMode: "pkm",
        splitOpen: true,
        rightSurface: "sites",
        hasRightEditorTab: false,
      }),
    ).toEqual({ rightOpen: true, rightEditorOpen: false, rightMode: "sites" });
    expect(
      resolveWorkbenchPlacement({
        visibleAppMode: "sites",
        splitOpen: true,
        rightSurface: "sites",
        hasRightEditorTab: true,
      }),
    ).toEqual({ rightOpen: false, rightEditorOpen: false, rightMode: null });
  });

  it("requires a tab for an editor split", () => {
    expect(
      resolveWorkbenchPlacement({
        visibleAppMode: "pkm",
        splitOpen: true,
        rightSurface: "editor",
        hasRightEditorTab: false,
      }).rightOpen,
    ).toBe(false);
  });

  it("does not revive feature-gated workbenches from persisted settings", () => {
    expect(
      availableRightWorkbenchSurface("e2e", { e2e: false, diagram: true }),
    ).toBe("editor");
    expect(
      availableRightWorkbenchSurface("diagram", { e2e: true, diagram: false }),
    ).toBe("editor");
    expect(
      availableRightWorkbenchSurface("sites", { e2e: false, diagram: false }),
    ).toBe("sites");
  });

  it("prioritizes right Sites only for right DOM focus or native child focus", () => {
    expect(
      shouldCloseRightSites({
        rightWorkbenchMode: "sites",
        focusedWorkbenchSide: "right",
        documentHasFocus: true,
      }),
    ).toBe(true);
    expect(
      shouldCloseRightSites({
        rightWorkbenchMode: "sites",
        focusedWorkbenchSide: "left",
        documentHasFocus: false,
      }),
    ).toBe(true);
    expect(
      shouldCloseRightSites({
        rightWorkbenchMode: "sites",
        focusedWorkbenchSide: "left",
        documentHasFocus: true,
      }),
    ).toBe(false);
    expect(
      shouldCloseRightSites({
        rightWorkbenchMode: "meetings",
        focusedWorkbenchSide: "right",
        documentHasFocus: false,
      }),
    ).toBe(false);
  });
});
