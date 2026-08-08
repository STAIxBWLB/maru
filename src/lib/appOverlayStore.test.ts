import { describe, expect, it } from "vitest";

import type { AppOverlayStoreState } from "./appOverlayStore";
import {
  closeAddWorkspaceDialogInState,
  closeCommitDialogInState,
  closeComposeInState,
  closeNewDocumentDialogInState,
  closeSettingsInState,
  openAddWorkspaceDialogInState,
  openCommitDialogInState,
  openComposeInState,
  openNewDocumentDialogInState,
  openSettingsInState,
  setCommandPaletteOpenInState,
  setSettingsTabInState,
  sitesOverlayOpenInState,
} from "./appOverlayStore";
import type { GitStatus } from "./types";

function stateOf(partial: Partial<AppOverlayStoreState> = {}): AppOverlayStoreState {
  return {
    settingsOverlay: null,
    commandPaletteOpen: false,
    composeSeed: null,
    newDocument: null,
    addWorkspace: null,
    commitDialog: null,
    ...partial,
  };
}

const GIT_STATUS = { branch: "main", ahead: 0, behind: 0, files: [] } as unknown as GitStatus;

describe("openSettingsInState", () => {
  it("opens with a null tab when called without arguments", () => {
    const next = openSettingsInState(stateOf());
    expect(next.settingsOverlay).toEqual({ tab: null });
  });

  it("keeps the current tab when already open and called without arguments", () => {
    const state = stateOf({ settingsOverlay: { tab: "skills" } });
    expect(openSettingsInState(state)).toBe(state);
  });

  it("replaces the tab when an explicit tab is given", () => {
    const next = openSettingsInState(stateOf({ settingsOverlay: { tab: null } }), "comms");
    expect(next.settingsOverlay).toEqual({ tab: "comms" });
  });

  it("is a no-op when the same tab is already set", () => {
    const state = stateOf({ settingsOverlay: { tab: "comms" } });
    expect(openSettingsInState(state, "comms")).toBe(state);
  });
});

describe("settings close/tab helpers", () => {
  it("closeSettingsInState is a no-op when already closed", () => {
    const state = stateOf();
    expect(closeSettingsInState(state)).toBe(state);
  });

  it("closeSettingsInState clears the overlay", () => {
    const next = closeSettingsInState(stateOf({ settingsOverlay: { tab: "tasks" } }));
    expect(next.settingsOverlay).toBeNull();
  });

  it("setSettingsTabInState replaces the tab and keeps identity on repeat", () => {
    const opened = setSettingsTabInState(stateOf(), "agents");
    expect(opened.settingsOverlay).toEqual({ tab: "agents" });
    expect(setSettingsTabInState(opened, "agents")).toBe(opened);
  });
});

describe("setCommandPaletteOpenInState", () => {
  it("toggles both ways and keeps identity on no-op", () => {
    const state = stateOf();
    const opened = setCommandPaletteOpenInState(state, true);
    expect(opened.commandPaletteOpen).toBe(true);
    expect(setCommandPaletteOpenInState(opened, true)).toBe(opened);
    expect(setCommandPaletteOpenInState(opened, false).commandPaletteOpen).toBe(false);
    expect(setCommandPaletteOpenInState(state, false)).toBe(state);
  });
});

describe("compose helpers", () => {
  it("openComposeInState stores the seed; closeComposeInState clears it once", () => {
    const seed = { prompt: "hi" };
    const opened = openComposeInState(stateOf(), seed);
    expect(opened.composeSeed).toBe(seed);
    const closed = closeComposeInState(opened);
    expect(closed.composeSeed).toBeNull();
    expect(closeComposeInState(closed)).toBe(closed);
  });
});

describe("new-document dialog helpers", () => {
  it("opens with a seed and closing clears it", () => {
    const seed = { title: "Note", relPath: "notes/note.md" };
    const opened = openNewDocumentDialogInState(stateOf(), seed);
    expect(opened.newDocument).toEqual({ seed });
    const closed = closeNewDocumentDialogInState(opened);
    expect(closed.newDocument).toBeNull();
    expect(closeNewDocumentDialogInState(closed)).toBe(closed);
  });

  it("opens seedless when no seed is given", () => {
    expect(openNewDocumentDialogInState(stateOf()).newDocument).toEqual({ seed: null });
  });
});

describe("add-workspace dialog helpers", () => {
  it("defaults to private, keeps the previous visibility on bare reopen", () => {
    const opened = openAddWorkspaceDialogInState(stateOf());
    expect(opened.addWorkspace).toEqual({ defaultVisibility: "private" });
    expect(openAddWorkspaceDialogInState(opened)).toBe(opened);

    const publicOpened = openAddWorkspaceDialogInState(stateOf(), "public");
    expect(publicOpened.addWorkspace).toEqual({ defaultVisibility: "public" });
    expect(openAddWorkspaceDialogInState(publicOpened)).toBe(publicOpened);

    const closed = closeAddWorkspaceDialogInState(publicOpened);
    expect(closed.addWorkspace).toBeNull();
    expect(closeAddWorkspaceDialogInState(closed)).toBe(closed);
  });
});

describe("commit dialog helpers", () => {
  it("stores path+status and clears once", () => {
    const opened = openCommitDialogInState(stateOf(), "/ws", GIT_STATUS);
    expect(opened.commitDialog).toEqual({ path: "/ws", status: GIT_STATUS });
    const closed = closeCommitDialogInState(opened);
    expect(closed.commitDialog).toBeNull();
    expect(closeCommitDialogInState(closed)).toBe(closed);
  });
});

describe("sitesOverlayOpenInState", () => {
  it("is false when every slice is closed", () => {
    expect(sitesOverlayOpenInState(stateOf())).toBe(false);
  });

  it.each([
    ["settingsOverlay", stateOf({ settingsOverlay: { tab: null } })],
    ["commandPaletteOpen", stateOf({ commandPaletteOpen: true })],
    ["composeSeed", stateOf({ composeSeed: {} })],
    ["newDocument", stateOf({ newDocument: { seed: null } })],
    ["addWorkspace", stateOf({ addWorkspace: { defaultVisibility: "private" } })],
    ["commitDialog", stateOf({ commitDialog: { path: "/ws", status: GIT_STATUS } })],
  ])("is true while %s is open", (_label, state) => {
    expect(sitesOverlayOpenInState(state)).toBe(true);
  });
});
