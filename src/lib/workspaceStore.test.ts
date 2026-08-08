import { describe, expect, it } from "vitest";

import { ALL_DOCUMENTS_FILTER, type DocumentFilter } from "./documentIndex";
import type { VaultEntry, WorkspaceRegistry } from "./types";
import type { WorkspaceEntriesState, WorkspaceStoreState } from "./workspaceStore";
import {
  EMPTY_WORKSPACE_FILES_STATE,
  EMPTY_WORKSPACE_STATE,
  activateWorkspaceInState,
  applyVaultDeltaInState,
  pruneCustomDocumentFiltersInState,
  removeWorkspaceStateInState,
  setCollapsedFileFoldersInState,
  setCollapsedTreeFoldersInState,
  setDocumentFilterInState,
  setExplorerVisibilityInState,
  setFileQueryInState,
  setQueryInState,
  setSelectedFilePathsInState,
  setWorkspaceRegistryInState,
  updateWorkspaceFileStateInState,
  updateWorkspaceStateInState,
} from "./workspaceStore";

const WS = "/ws";

function entry(relPath: string, overrides: Partial<VaultEntry> = {}): VaultEntry {
  return {
    path: `${WS}/${relPath}`,
    relPath,
    title: relPath.split("/").pop() ?? relPath,
    frontmatter: {},
    updatedAt: null,
    wordCount: 0,
    snippet: "",
    fileKind: "md",
    versionCount: 0,
    ...overrides,
  };
}

function registry(paths: string[] = []): WorkspaceRegistry {
  return {
    workspaces: paths.map((path) => ({
      label: path,
      path,
      visibility: "private" as const,
      provider: "local" as const,
      writePolicy: "direct" as const,
    })),
    activeByVisibility: { private: paths[0] ?? null, public: null },
    hiddenDefaults: [],
  };
}

function entriesState(entries: VaultEntry[]): WorkspaceEntriesState {
  return { entries, loading: false, refreshing: false, startupIoReady: true };
}

function stateOf(partial: Partial<WorkspaceStoreState> = {}): WorkspaceStoreState {
  return {
    registry: registry(),
    states: {},
    fileStates: {},
    explorerVisibility: "private",
    queryByVisibility: { private: "", public: "" },
    fileQueryByVisibility: { private: "", public: "" },
    documentFilterByVisibility: {
      private: ALL_DOCUMENTS_FILTER,
      public: ALL_DOCUMENTS_FILTER,
    },
    collapsedTreeFoldersByVisibility: { private: [], public: [] },
    collapsedFileFoldersByVisibility: { private: [], public: [] },
    selectedFilePathsByWorkspace: {},
    ...partial,
  };
}

describe("updateWorkspaceStateInState", () => {
  it("merges a patch into one path, keeping every other path's identity", () => {
    const other = entriesState([entry("other.md")]);
    const state = stateOf({ states: { "/other": other } });
    const entries = [entry("a.md")];

    const next = updateWorkspaceStateInState(state, WS, { entries, loading: true });

    expect(next).not.toBe(state);
    expect(next.states[WS]).toEqual({ ...EMPTY_WORKSPACE_STATE, entries, loading: true });
    expect(next.states[WS]?.entries).toBe(entries);
    expect(next.states["/other"]).toBe(other);
  });

  it("returns the input state when the patch changes nothing", () => {
    const existing = entriesState([entry("a.md")]);
    const state = stateOf({ states: { [WS]: existing } });

    const next = updateWorkspaceStateInState(state, WS, {
      entries: existing.entries,
      loading: false,
    });

    expect(next).toBe(state);
  });
});

describe("updateWorkspaceFileStateInState", () => {
  it("merges a patch into one fileStates path and no-ops on identity", () => {
    const state = stateOf();
    const next = updateWorkspaceFileStateInState(state, WS, {
      scanStatus: "ready",
      loading: false,
    });
    expect(next.states).toBe(state.states);
    expect(next.fileStates[WS]).toEqual({
      ...EMPTY_WORKSPACE_FILES_STATE,
      scanStatus: "ready",
    });

    const current = next.fileStates[WS]!;
    const same = updateWorkspaceFileStateInState(next, WS, {
      entries: current.entries,
      nodes: current.nodes,
      scanStatus: "ready",
      loading: false,
      refreshing: false,
    });
    expect(same).toBe(next);
  });
});

describe("removeWorkspaceStateInState", () => {
  it("deletes only the states key and keeps identity when the key is absent", () => {
    const state = stateOf({ states: { [WS]: entriesState([entry("a.md")]) } });
    const next = removeWorkspaceStateInState(state, WS);
    expect(next.states[WS]).toBeUndefined();
    expect(removeWorkspaceStateInState(next, WS)).toBe(next);
  });
});

describe("registry and visibility helpers", () => {
  it("setWorkspaceRegistryInState swaps the registry and no-ops on identity", () => {
    const state = stateOf();
    const nextRegistry = registry([WS]);
    const next = setWorkspaceRegistryInState(state, nextRegistry);
    expect(next.registry).toBe(nextRegistry);
    expect(setWorkspaceRegistryInState(next, nextRegistry)).toBe(next);
  });

  it("setExplorerVisibilityInState flips the visibility and no-ops on identity", () => {
    const state = stateOf();
    const next = setExplorerVisibilityInState(state, "public");
    expect(next.explorerVisibility).toBe("public");
    expect(setExplorerVisibilityInState(next, "public")).toBe(next);
  });

  it("activateWorkspaceInState lands registry and visibility in one transition", () => {
    const state = stateOf();
    const nextRegistry = registry([WS]);
    const next = activateWorkspaceInState(state, nextRegistry, "public");
    expect(next.registry).toBe(nextRegistry);
    expect(next.explorerVisibility).toBe("public");
    expect(activateWorkspaceInState(next, nextRegistry, "public")).toBe(next);
  });
});

describe("query/filter/collapsed/selection helpers", () => {
  it("setQueryInState sets one visibility and keeps the other", () => {
    const state = stateOf({ queryByVisibility: { private: "", public: "pub" } });
    const next = setQueryInState(state, "private", "q");
    expect(next.queryByVisibility).toEqual({ private: "q", public: "pub" });
    expect(setQueryInState(next, "private", "q")).toBe(next);
  });

  it("setFileQueryInState sets one visibility and no-ops on identity", () => {
    const state = stateOf();
    const next = setFileQueryInState(state, "public", "f");
    expect(next.fileQueryByVisibility.public).toBe("f");
    expect(next.fileQueryByVisibility.private).toBe("");
    expect(setFileQueryInState(next, "public", "f")).toBe(next);
  });

  it("setDocumentFilterInState swaps the filter object", () => {
    const state = stateOf();
    const filter: DocumentFilter = { kind: "view", view: "drafts" };
    const next = setDocumentFilterInState(state, "private", filter);
    expect(next.documentFilterByVisibility.private).toBe(filter);
    expect(setDocumentFilterInState(next, "private", filter)).toBe(next);
  });

  it("pruneCustomDocumentFiltersInState resets stale custom filters only", () => {
    const custom: DocumentFilter = { kind: "custom", viewId: "gone" };
    const kept: DocumentFilter = { kind: "custom", viewId: "kept" };
    const state = stateOf({
      documentFilterByVisibility: { private: custom, public: kept },
    });
    const next = pruneCustomDocumentFiltersInState(state, new Set(["kept"]));
    expect(next.documentFilterByVisibility.private).toEqual({ kind: "all" });
    expect(next.documentFilterByVisibility.public).toBe(kept);
    expect(pruneCustomDocumentFiltersInState(next, new Set(["kept"]))).toBe(next);
  });

  it("collapsed folder helpers set one visibility and no-op on identity", () => {
    const state = stateOf();
    const tree = setCollapsedTreeFoldersInState(state, "private", ["a", "b"]);
    expect(tree.collapsedTreeFoldersByVisibility.private).toEqual(["a", "b"]);
    expect(setCollapsedTreeFoldersInState(tree, "private", tree.collapsedTreeFoldersByVisibility.private)).toBe(tree);

    const files = setCollapsedFileFoldersInState(state, "public", ["c"]);
    expect(files.collapsedFileFoldersByVisibility).toEqual({ private: [], public: ["c"] });
    expect(setCollapsedFileFoldersInState(files, "public", files.collapsedFileFoldersByVisibility.public)).toBe(files);
  });

  it("setSelectedFilePathsInState sets one workspace and no-ops on identity", () => {
    const state = stateOf();
    const next = setSelectedFilePathsInState(state, WS, ["a.md"]);
    expect(next.selectedFilePathsByWorkspace[WS]).toEqual(["a.md"]);
    expect(setSelectedFilePathsInState(next, WS, next.selectedFilePathsByWorkspace[WS]!)).toBe(next);
  });
});

describe("applyVaultDeltaInState", () => {
  it("upserts fresh entries by relPath, replacing the old object", () => {
    const stale = entry("a.md", { title: "Stale", updatedAt: "2026-08-01T00:00:00Z" });
    const fresh = entry("a.md", { title: "Fresh", updatedAt: "2026-08-02T00:00:00Z" });
    const states = { [WS]: entriesState([stale]) };

    const next = applyVaultDeltaInState(states, WS, [fresh], ["a.md"]);

    expect(next[WS]?.entries).toEqual([fresh]);
    expect(next[WS]?.entries[0]).toBe(fresh);
  });

  it("removes touched entries that are absent from freshEntries", () => {
    const states = {
      [WS]: entriesState([
        entry("gone.md", { updatedAt: "2026-08-02T00:00:00Z" }),
        entry("kept.md", { updatedAt: "2026-08-01T00:00:00Z" }),
      ]),
    };

    const next = applyVaultDeltaInState(states, WS, [], ["gone.md"]);

    expect(next[WS]?.entries.map((item) => item.relPath)).toEqual(["kept.md"]);
  });

  it("appends creations and re-sorts by updatedAt desc, then title", () => {
    const older = entry("older.md", {
      title: "Zulu",
      updatedAt: "2026-08-01T00:00:00Z",
    });
    const states = { [WS]: entriesState([older]) };
    const created = entry("created.md", {
      title: "Alpha",
      updatedAt: "2026-08-03T00:00:00Z",
    });
    const bumped = entry("older.md", {
      title: "Zulu",
      updatedAt: "2026-08-02T00:00:00Z",
    });

    const next = applyVaultDeltaInState(states, WS, [created, bumped], [
      "created.md",
      "older.md",
    ]);

    expect(next[WS]?.entries.map((item) => item.relPath)).toEqual(["created.md", "older.md"]);
  });

  it("orders equal updatedAt by lowercased title, null updatedAt last", () => {
    const stamp = "2026-08-01T00:00:00Z";
    const states = { [WS]: entriesState([]) };
    const beta = entry("b.md", { title: "beta", updatedAt: stamp });
    const alpha = entry("a.md", { title: "Alpha", updatedAt: stamp });
    const undated = entry("c.md", { title: "aaa", updatedAt: null });

    const next = applyVaultDeltaInState(states, WS, [beta, undated, alpha], [
      "a.md",
      "b.md",
      "c.md",
    ]);

    expect(next[WS]?.entries.map((item) => item.relPath)).toEqual(["a.md", "b.md", "c.md"]);
  });

  it("keeps object identity for untouched entries", () => {
    const untouched = entry("untouched.md", { updatedAt: "2026-08-01T00:00:00Z" });
    const stale = entry("touched.md", { updatedAt: "2026-08-02T00:00:00Z" });
    const states = { [WS]: entriesState([stale, untouched]) };
    const fresh = entry("touched.md", { updatedAt: "2026-08-03T00:00:00Z" });

    const next = applyVaultDeltaInState(states, WS, [fresh], ["touched.md"]);

    expect(next[WS]?.entries[0]).toBe(fresh);
    expect(next[WS]?.entries[1]).toBe(untouched);
  });

  it("returns the input record when the delta changes nothing", () => {
    const states = { [WS]: entriesState([entry("a.md")]) };
    expect(applyVaultDeltaInState(states, WS, [], [])).toBe(states);
  });

  it("ignores fresh entries whose relPath was not touched", () => {
    const states = { [WS]: entriesState([entry("a.md")]) };
    const intruder = entry("intruder.md");

    const next = applyVaultDeltaInState(states, WS, [intruder], ["else.md"]);

    expect(next[WS]?.entries.map((item) => item.relPath)).toEqual(["a.md"]);
  });

  it("starts from the empty state for a workspace with no entries yet", () => {
    const created = entry("new.md", { updatedAt: "2026-08-01T00:00:00Z" });

    const next = applyVaultDeltaInState({}, WS, [created], ["new.md"]);

    expect(next[WS]).toEqual({ ...EMPTY_WORKSPACE_STATE, entries: [created] });
  });

  it("never touches other workspaces' state objects", () => {
    const other = entriesState([entry("other.md")]);
    const states = { "/other": other, [WS]: entriesState([entry("a.md")]) };

    const next = applyVaultDeltaInState(states, WS, [], ["a.md"]);

    expect(next["/other"]).toBe(other);
  });
});
