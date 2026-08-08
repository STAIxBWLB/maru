import { describe, expect, it } from "vitest";

import type { BinaryTab, EditorTab, EditorTabsState } from "./editorTabsStore";
import {
  activateTabInState,
  appendRestoredDocTabsInState,
  applyRestoredIdsInState,
  closeTabsInState,
  insertTabInState,
  mapDocTabsInState,
  patchEditorIdsInState,
  patchTabInState,
  removeWorkspaceDocTabsInState,
  replaceAllDocTabsInState,
  resetWorkspaceTabsInState,
  resolveEditorTabIds,
  restoreWorkspaceTabsInState,
  syncTabOrderInState,
  transformTabsInState,
  updateDraftInState,
} from "./editorTabsStore";
import type { DocumentPayload, VaultEntry, WorkspaceFileEntry } from "./types";

const WS = "/ws";

function entry(path: string): VaultEntry {
  return {
    path,
    relPath: path.slice(WS.length + 1),
    title: path.split("/").pop() ?? path,
    frontmatter: {},
    updatedAt: null,
    wordCount: 0,
    snippet: "",
    fileKind: "md",
    versionCount: 0,
  };
}

function documentPayload(path: string, content: string): DocumentPayload {
  return {
    path,
    relPath: path.slice(WS.length + 1),
    title: path.split("/").pop() ?? path,
    content,
    body: content,
    meta: {},
    fileKind: "md",
  };
}

function docTab(id: string, content = `content:${id}`, workspacePath = WS): EditorTab {
  return {
    id,
    workspacePath,
    visibility: "private",
    entry: entry(id),
    document: documentPayload(id, content),
    draftContent: content,
  };
}

function binaryTab(id: string, workspacePath = WS): BinaryTab {
  const fileEntry: WorkspaceFileEntry = {
    path: id,
    relPath: id.replace(/^binary:/, ""),
    name: id.split("/").pop() ?? id,
    extension: "png",
    fileKind: "png",
    sizeBytes: 1,
    updatedAt: null,
    gitTracked: false,
    binary: true,
  };
  return {
    kind: "binary",
    id,
    workspacePath,
    visibility: "private",
    fileEntry,
    classification: {
      category: "image",
      mime: "image/png",
      extension: "png",
      sizeBytes: 1,
      detectedFormat: "png",
    },
    status: "ready",
    error: null,
  };
}

function stateOf(partial: Partial<EditorTabsState> = {}): EditorTabsState {
  return {
    tabs: [],
    binaryTabs: [],
    tabOrder: [],
    activeTabId: null,
    leftActiveTabId: null,
    rightActiveTabId: null,
    focusedEditorGroup: "left",
    ...partial,
  };
}

const resolved = (
  leftResolvedTabId: string | null,
  rightResolvedTabId: string | null = null,
  resolvedActiveTabId: string | null = leftResolvedTabId,
) => ({ leftResolvedTabId, rightResolvedTabId, resolvedActiveTabId });

describe("syncTabOrderInState", () => {
  it("prunes dead ids, appends new live ids, and keeps the state identity when unchanged", () => {
    const state = stateOf({
      tabs: [docTab("a"), docTab("b")],
      binaryTabs: [binaryTab("binary:c")],
      tabOrder: ["gone", "b"],
    });

    const synced = syncTabOrderInState(state);
    expect(synced.tabOrder).toEqual(["b", "a", "binary:c"]);
    expect(syncTabOrderInState(synced)).toBe(synced);
  });
});

describe("resolveEditorTabIds", () => {
  it("falls back left -> active -> first ordered tab and gates the right id on the split", () => {
    const state = stateOf({
      tabs: [docTab("a"), docTab("b")],
      tabOrder: ["b", "a"],
      activeTabId: "a",
      leftActiveTabId: null,
      rightActiveTabId: "b",
      focusedEditorGroup: "right",
    });

    expect(resolveEditorTabIds(state, true)).toEqual({
      leftResolvedTabId: "a",
      rightResolvedTabId: "b",
      resolvedActiveTabId: "b",
    });
    // Split closed: the right id resolves to null and focus falls back left.
    expect(resolveEditorTabIds(state, false)).toEqual({
      leftResolvedTabId: "a",
      rightResolvedTabId: null,
      resolvedActiveTabId: "a",
    });
    // No active ids at all: the first ordered tab wins.
    expect(
      resolveEditorTabIds(stateOf({ tabs: [docTab("a"), docTab("b")], tabOrder: ["b", "a"] }), false)
        .leftResolvedTabId,
    ).toBe("b");
  });
});

describe("updateDraftInState", () => {
  it("patches the draft and returns the same state when nothing changes", () => {
    const state = stateOf({ tabs: [docTab("a"), docTab("b")] });

    const next = updateDraftInState(state, "a", "edited");
    expect(next.tabs.find((tab) => tab.id === "a")?.draftContent).toBe("edited");
    expect(next.tabs.find((tab) => tab.id === "b")).toBe(state.tabs[1]);

    expect(updateDraftInState(next, "a", "edited")).toBe(next);
    expect(updateDraftInState(next, "missing", "x")).toBe(next);
  });
});

describe("activateTabInState", () => {
  it("activates in the left group and focuses it", () => {
    const next = activateTabInState(stateOf({ focusedEditorGroup: "right" }), "a", "left");
    expect(next).toMatchObject({
      leftActiveTabId: "a",
      activeTabId: "a",
      focusedEditorGroup: "left",
      rightActiveTabId: null,
    });
  });

  it("activates in the right group without touching the left id", () => {
    const next = activateTabInState(stateOf({ leftActiveTabId: "a" }), "b", "right");
    expect(next).toMatchObject({
      leftActiveTabId: "a",
      rightActiveTabId: "b",
      activeTabId: "b",
      focusedEditorGroup: "right",
    });
  });

  it("returns the same state when the activation is a no-op", () => {
    const state = activateTabInState(stateOf(), "a", "left");
    expect(activateTabInState(state, "a", "left")).toBe(state);
  });
});

describe("patchEditorIdsInState", () => {
  it("patches only the provided keys and keeps identity on no-op", () => {
    const state = stateOf({
      activeTabId: "a",
      leftActiveTabId: "a",
      rightActiveTabId: "b",
      focusedEditorGroup: "right",
    });

    const next = patchEditorIdsInState(state, { rightActiveTabId: null, focusedEditorGroup: "left" });
    expect(next).toMatchObject({
      activeTabId: "a",
      leftActiveTabId: "a",
      rightActiveTabId: null,
      focusedEditorGroup: "left",
    });
    expect(patchEditorIdsInState(next, { focusedEditorGroup: "left" })).toBe(next);
  });
});

describe("insertTabInState", () => {
  it("appends a new doc tab and its tabOrder entry in one transition", () => {
    const state = stateOf({ tabs: [docTab("a")], tabOrder: ["a"] });
    const next = insertTabInState(state, docTab("b"));
    expect(next.tabs.map((tab) => tab.id)).toEqual(["a", "b"]);
    expect(next.tabOrder).toEqual(["a", "b"]);
  });

  it("replaces an existing tab in place without reordering", () => {
    const state = stateOf({ tabs: [docTab("a"), docTab("b")], tabOrder: ["a", "b"] });
    const replacement = { ...docTab("b"), draftContent: "fresh" };
    const next = insertTabInState(state, replacement);
    expect(next.tabs.map((tab) => tab.id)).toEqual(["a", "b"]);
    expect(next.tabs[1].draftContent).toBe("fresh");
    expect(next.tabOrder).toEqual(["a", "b"]);
  });

  it("inserts binary tabs with the same upsert semantics", () => {
    const state = stateOf({ tabs: [docTab("a")], tabOrder: ["a"] });
    const next = insertTabInState(state, binaryTab("binary:x"));
    expect(next.binaryTabs.map((tab) => tab.id)).toEqual(["binary:x"]);
    expect(next.tabOrder).toEqual(["a", "binary:x"]);

    const replaced = insertTabInState(next, { ...binaryTab("binary:x"), status: "error" });
    expect(replaced.binaryTabs).toHaveLength(1);
    expect(replaced.binaryTabs[0].status).toBe("error");
  });

  it("activates the inserted tab in the requested group, defaulting to the current focus", () => {
    const state = stateOf({ focusedEditorGroup: "right" });
    const implicit = insertTabInState(state, docTab("a"), { activate: true });
    expect(implicit).toMatchObject({ rightActiveTabId: "a", focusedEditorGroup: "right" });

    const explicit = insertTabInState(stateOf(), docTab("a"), { activate: true, group: "left" });
    expect(explicit).toMatchObject({ leftActiveTabId: "a", activeTabId: "a" });
  });
});

describe("patchTabInState", () => {
  it("merges the patch into the matching tab only", () => {
    const state = stateOf({ tabs: [docTab("a"), docTab("b")] });
    const saved = documentPayload("a", "saved");
    const next = patchTabInState(state, "a", { document: saved, draftContent: "saved" });
    expect(next.tabs[0].document).toBe(saved);
    expect(next.tabs[0].draftContent).toBe("saved");
    expect(next.tabs[1]).toBe(state.tabs[1]);
    expect(patchTabInState(state, "missing", { draftContent: "x" })).toBe(state);
  });
});

describe("mapDocTabsInState", () => {
  it("preserves identity when the updater returns the same tabs", () => {
    const state = stateOf({ tabs: [docTab("a"), docTab("b")] });
    expect(mapDocTabsInState(state, (tab) => tab)).toBe(state);

    const next = mapDocTabsInState(state, (tab) =>
      tab.id === "a" ? { ...tab, draftContent: "x" } : tab,
    );
    expect(next.tabs[1]).toBe(state.tabs[1]);
    expect(next.tabs[0].draftContent).toBe("x");
  });
});

describe("closeTabsInState", () => {
  const fixture = () =>
    stateOf({
      tabs: [docTab("a"), docTab("b"), docTab("c")],
      binaryTabs: [binaryTab("binary:d")],
      tabOrder: ["a", "binary:d", "b", "c"],
      activeTabId: "b",
      leftActiveTabId: "b",
      rightActiveTabId: "c",
      focusedEditorGroup: "right",
    });

  it("is a no-op for empty or unknown ids", () => {
    const state = fixture();
    expect(closeTabsInState(state, [], resolved("b")).state).toBe(state);
    expect(closeTabsInState(state, ["missing"], resolved("b")).state).toBe(state);
  });

  it("closes a single tab, prunes the order, and falls back to the next tab", () => {
    const state = fixture();
    const result = closeTabsInState(state, ["b"], resolved("b"), {
      resetFocusOnRightClose: true,
    });
    expect(result.state.tabs.map((tab) => tab.id)).toEqual(["a", "c"]);
    expect(result.state.tabOrder).toEqual(["a", "binary:d", "c"]);
    expect(result.state.leftActiveTabId).toBe("c");
    expect(result.state.activeTabId).toBe("c");
    // The right id was not closed, so it survives.
    expect(result.state.rightActiveTabId).toBe("c");
    expect(result.state.focusedEditorGroup).toBe("right");
    expect(result.rightClosed).toBe(false);
    expect(result.removedDocTabs.map((tab) => tab.id)).toEqual(["b"]);
  });

  it("clears the right id and optionally resets focus when the right tab closes", () => {
    const state = fixture();
    const single = closeTabsInState(state, ["c"], resolved("b", "c", "c"), {
      resetFocusOnRightClose: true,
    });
    expect(single.rightClosed).toBe(true);
    expect(single.state.rightActiveTabId).toBeNull();
    expect(single.state.focusedEditorGroup).toBe("left");
    expect(single.state.activeTabId).toBe("b");

    // Multi-close leaves the focused group untouched.
    const multi = closeTabsInState(state, ["c"], resolved("b", "c", "c"));
    expect(multi.rightClosed).toBe(true);
    expect(multi.state.focusedEditorGroup).toBe("right");
  });

  it("anchors the fallback on the active tab when it is among the closed ids", () => {
    const state = fixture();
    const result = closeTabsInState(state, ["b", "c"], resolved("b", "c", "c"));
    // The anchor c slides out; the tab taking its slot is binary:d.
    expect(result.fallbackId).toBe("binary:d");
    expect(result.state.leftActiveTabId).toBe("binary:d");
    expect(result.state.activeTabId).toBe("binary:d");
    expect(result.state.binaryTabs.map((tab) => tab.id)).toEqual(["binary:d"]);
  });

  it("applies the post-close id patch inside the same transition", () => {
    const state = fixture();
    const result = closeTabsInState(state, ["a", "c", "binary:d"], resolved("b", "c", "b"), {
      postIds: {
        leftActiveTabId: "b",
        rightActiveTabId: null,
        activeTabId: "b",
        focusedEditorGroup: "left",
      },
    });
    expect(result.state).toMatchObject({
      leftActiveTabId: "b",
      rightActiveTabId: null,
      activeTabId: "b",
      focusedEditorGroup: "left",
    });
    expect(result.state.tabs.map((tab) => tab.id)).toEqual(["b"]);
    expect(result.state.binaryTabs).toEqual([]);
  });
});

describe("transformTabsInState", () => {
  it("remaps tab objects, ids, tabOrder, and active ids atomically", () => {
    const state = stateOf({
      tabs: [docTab("/ws/old.md"), docTab("/ws/keep.md")],
      binaryTabs: [binaryTab("binary:/ws/old.png")],
      tabOrder: ["/ws/old.md", "binary:/ws/old.png", "/ws/keep.md"],
      activeTabId: "/ws/old.md",
      leftActiveTabId: "/ws/old.md",
      rightActiveTabId: "binary:/ws/old.png",
    });

    const next = transformTabsInState(state, {
      mapDocTab: (tab) =>
        tab.id === "/ws/old.md"
          ? {
              ...tab,
              id: "/ws/new.md",
              entry: entry("/ws/new.md"),
              document: documentPayload("/ws/new.md", tab.document.content),
            }
          : tab,
      mapBinaryTab: (tab) =>
        tab.id === "binary:/ws/old.png"
          ? { ...tab, id: "binary:/ws/new.png", fileEntry: { ...tab.fileEntry, path: "/ws/new.png" } }
          : tab,
      mapTabId: (id) =>
        id === "/ws/old.md"
          ? "/ws/new.md"
          : id === "binary:/ws/old.png"
            ? "binary:/ws/new.png"
            : id,
    });

    expect(next.tabs.map((tab) => tab.id)).toEqual(["/ws/new.md", "/ws/keep.md"]);
    expect(next.binaryTabs[0].id).toBe("binary:/ws/new.png");
    expect(next.tabOrder).toEqual(["/ws/new.md", "binary:/ws/new.png", "/ws/keep.md"]);
    expect(next.activeTabId).toBe("/ws/new.md");
    expect(next.leftActiveTabId).toBe("/ws/new.md");
    expect(next.rightActiveTabId).toBe("binary:/ws/new.png");
  });

  it("preserves null active ids and state identity when nothing remaps", () => {
    const state = stateOf({ tabs: [docTab("a")], tabOrder: ["a"] });
    const next = transformTabsInState(state, { mapTabId: (id) => id });
    expect(next.activeTabId).toBeNull();
    expect(next.tabOrder).toBe(state.tabOrder);
    expect(next).toBe(state);
  });
});

describe("workspace-scoped state transitions", () => {
  it("resetWorkspaceTabsInState drops the workspace's tabs and nulls dangling ids", () => {
    const state = stateOf({
      tabs: [docTab("a", "x", "/ws"), docTab("b", "x", "/other")],
      tabOrder: ["a", "b"],
      activeTabId: "a",
      leftActiveTabId: "a",
      rightActiveTabId: "b",
      focusedEditorGroup: "right",
    });

    const next = resetWorkspaceTabsInState(state, "/ws");
    expect(next.tabs.map((tab) => tab.id)).toEqual(["b"]);
    expect(next.tabOrder).toEqual(["b"]);
    expect(next.activeTabId).toBeNull();
    expect(next.leftActiveTabId).toBeNull();
    expect(next.rightActiveTabId).toBeNull();
    expect(next.focusedEditorGroup).toBe("left");

    // An id whose tab survives in another workspace is kept.
    const kept = resetWorkspaceTabsInState(
      stateOf({
        tabs: [docTab("a", "x", "/ws"), docTab("b", "x", "/other")],
        tabOrder: ["a", "b"],
        activeTabId: "b",
      }),
      "/ws",
    );
    expect(kept.activeTabId).toBe("b");
  });

  it("removeWorkspaceDocTabsInState leaves dangling ids untouched", () => {
    const state = stateOf({
      tabs: [docTab("a", "x", "/ws")],
      tabOrder: ["a"],
      activeTabId: "a",
      leftActiveTabId: "a",
    });
    const next = removeWorkspaceDocTabsInState(state, "/ws");
    expect(next.tabs).toEqual([]);
    expect(next.tabOrder).toEqual([]);
    expect(next.activeTabId).toBe("a");
    expect(next.leftActiveTabId).toBe("a");
    expect(removeWorkspaceDocTabsInState(state, "/other")).toBe(state);
  });

  it("restoreWorkspaceTabsInState replaces the workspace tabs and applies stored ids", () => {
    const state = stateOf({
      tabs: [docTab("stale", "x", "/ws"), docTab("other", "x", "/other")],
      tabOrder: ["stale", "other"],
    });
    const next = restoreWorkspaceTabsInState(state, "/ws", docTab("primary"), {
      leftActiveTabId: "primary",
      rightActiveTabId: null,
      focusedEditorGroup: "left",
    });
    expect(next.tabs.map((tab) => tab.id)).toEqual(["other", "primary"]);
    expect(next.tabOrder).toEqual(["other", "primary"]);
    expect(next).toMatchObject({
      leftActiveTabId: "primary",
      activeTabId: "primary",
      focusedEditorGroup: "left",
    });
  });

  it("appendRestoredDocTabsInState dedupes, caps, and re-applies stored ids", () => {
    const state = stateOf({
      tabs: [docTab("primary")],
      tabOrder: ["primary"],
    });
    const companions = [docTab("primary"), docTab("c1"), docTab("c2")];
    const next = appendRestoredDocTabsInState(state, companions, {
      leftActiveTabId: "c1",
      rightActiveTabId: "c2",
      focusedEditorGroup: "right",
    });
    expect(next.tabs.map((tab) => tab.id)).toEqual(["primary", "c1", "c2"]);
    expect(next.tabOrder).toEqual(["primary", "c1", "c2"]);
    // Right-focused restore activates the right id.
    expect(next).toMatchObject({
      leftActiveTabId: "c1",
      rightActiveTabId: "c2",
      activeTabId: "c2",
      focusedEditorGroup: "right",
    });

    const capped = appendRestoredDocTabsInState(
      stateOf({ tabs: Array.from({ length: 8 }, (_, i) => docTab(`t${i}`)) }),
      [docTab("overflow")],
      { leftActiveTabId: null, rightActiveTabId: null, focusedEditorGroup: "left" },
    );
    expect(capped.tabs).toHaveLength(8);
    expect(capped.tabs.some((tab) => tab.id === "overflow")).toBe(false);
  });

  it("applyRestoredIdsInState keeps live ids and filters dangling ones", () => {
    const state = stateOf({ tabs: [docTab("a")] });
    const next = applyRestoredIdsInState(state, {
      leftActiveTabId: "a",
      rightActiveTabId: "ghost",
      focusedEditorGroup: "right",
    });
    expect(next.activeTabId).toBe("a");
    expect(next.leftActiveTabId).toBe("a");
    expect(next.rightActiveTabId).toBeNull();
    expect(next.focusedEditorGroup).toBe("left");
  });

  it("replaceAllDocTabsInState keeps exactly the given tabs and resets the session", () => {
    const state = stateOf({
      tabs: [docTab("a"), docTab("b")],
      binaryTabs: [binaryTab("binary:c")],
      tabOrder: ["a", "binary:c", "b"],
      activeTabId: "a",
    });
    const dirty = { ...docTab("b"), draftContent: "dirty" };
    const next = replaceAllDocTabsInState(state, [dirty], {
      activeTabId: "b",
      leftActiveTabId: "b",
      rightActiveTabId: null,
      focusedEditorGroup: "left",
    });
    expect(next.tabs).toEqual([dirty]);
    expect(next.binaryTabs).toEqual([]);
    expect(next.tabOrder).toEqual(["b"]);
    expect(next.activeTabId).toBe("b");
  });
});
