import { describe, expect, it } from "vitest";
import {
  replaceEditorTabIds,
  tabIdsToCloseOthers,
  tabIdsToCloseRight,
  tabIdsToCloseSaved,
} from "./editorTabActions";

describe("editor tab action helpers", () => {
  it("replaces active left and right tab ids after a path change", () => {
    expect(
      replaceEditorTabIds(
        {
          activeTabId: "old.md",
          leftActiveTabId: "old.md",
          rightActiveTabId: "other.md",
        },
        "old.md",
        "renamed.md",
      ),
    ).toEqual({
      activeTabId: "renamed.md",
      leftActiveTabId: "renamed.md",
      rightActiveTabId: "other.md",
    });
  });

  it("calculates close-others and close-right targets stably", () => {
    const tabs = [{ id: "a" }, { id: "b" }, { id: "c" }, { id: "d" }];
    expect(tabIdsToCloseOthers(tabs, "b")).toEqual(["a", "c", "d"]);
    expect(tabIdsToCloseRight(tabs, "b")).toEqual(["c", "d"]);
    expect(tabIdsToCloseRight(tabs, "missing")).toEqual([]);
  });

  it("calculates saved tabs without closing dirty tabs", () => {
    const tabs = [
      { id: "a", dirty: false },
      { id: "b", dirty: true },
      { id: "c", dirty: false },
    ];
    expect(tabIdsToCloseSaved(tabs)).toEqual(["a", "c"]);
  });
});
