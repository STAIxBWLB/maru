import { describe, expect, it, vi } from "vitest";
import type { NativeTerminalViewHandle } from "./NativeTerminalView";
import {
  cancelTerminalLayoutRefresh,
  refreshFocusedTerminal,
  shouldFocusTerminalInput,
  terminalActivationFocusAction,
  terminalFrameDisposition,
  type TerminalFocusState,
} from "./TerminalPanel";

function focusState(overrides: Partial<TerminalFocusState> = {}): TerminalFocusState {
  return {
    open: true,
    searchOpen: false,
    renamingTaskId: null,
    ...overrides,
  };
}

function terminalHandle(): NativeTerminalViewHandle {
  return {
    focus: vi.fn(),
    ownsFocus: vi.fn(() => false),
    applyFrame: vi.fn(() => true),
    refreshLayout: vi.fn(),
    pasteText: vi.fn(),
    copySelection: vi.fn(() => null),
    selectAll: vi.fn(),
    clearSelection: vi.fn(),
  };
}

describe("TerminalPanel focus refresh helpers", () => {
  it("only restores terminal input focus when the panel is open and no text editor is active", () => {
    expect(shouldFocusTerminalInput(focusState())).toBe(true);
    expect(shouldFocusTerminalInput(focusState({ open: false }))).toBe(false);
    expect(shouldFocusTerminalInput(focusState({ searchOpen: true }))).toBe(false);
    expect(shouldFocusTerminalInput(focusState({ renamingTaskId: "task-1" }))).toBe(false);
  });

  it("cancels pending terminal layout refresh work and clears the raf ref", () => {
    const rafRef = { current: 42 };
    const cancel = vi.fn();

    expect(cancelTerminalLayoutRefresh(rafRef, cancel)).toBe(true);
    expect(cancel).toHaveBeenCalledWith(42);
    expect(rafRef.current).toBeNull();
    expect(cancelTerminalLayoutRefresh(rafRef, cancel)).toBe(false);
  });

  it("does not refresh or focus a hidden terminal panel", () => {
    const handle = terminalHandle();

    expect(refreshFocusedTerminal(handle, focusState({ open: false }))).toBe(false);

    expect(handle.refreshLayout).not.toHaveBeenCalled();
    expect(handle.focus).not.toHaveBeenCalled();
  });

  it("refreshes layout but does not steal focus from search or rename inputs", () => {
    const searchHandle = terminalHandle();
    const renameHandle = terminalHandle();

    expect(refreshFocusedTerminal(searchHandle, focusState({ searchOpen: true }))).toBe(true);
    expect(refreshFocusedTerminal(renameHandle, focusState({ renamingTaskId: "task-1" }))).toBe(true);

    expect(searchHandle.refreshLayout).toHaveBeenCalledWith({ focus: false });
    expect(renameHandle.refreshLayout).toHaveBeenCalledWith({ focus: false });
    expect(searchHandle.focus).not.toHaveBeenCalled();
    expect(renameHandle.focus).not.toHaveBeenCalled();
  });

  it("refreshes layout and then focuses the terminal input for direct typing", () => {
    const handle = terminalHandle();

    expect(refreshFocusedTerminal(handle, focusState())).toBe(true);

    expect(handle.refreshLayout).toHaveBeenCalledWith({ focus: false });
    expect(handle.focus).toHaveBeenCalledTimes(1);
  });
});

describe("terminalActivationFocusAction", () => {
  function action(
    overrides: Partial<Parameters<typeof terminalActivationFocusAction>[0]> = {},
  ) {
    return terminalActivationFocusAction({
      seededTabId: null,
      focusedTabId: "tab-1",
      ownsFocus: false,
      activeElementIsBody: true,
      focusState: focusState(),
      ...overrides,
    });
  }

  it("repairs a first activation whose click landed on the terminal", () => {
    // The first-mouse bug: DOM focus on the textarea, no seeded tab. This
    // case used to bail and leave the terminal key-dead.
    expect(action({ ownsFocus: true, seededTabId: null })).toBe("refocus");
    expect(action({ ownsFocus: true, activeElementIsBody: false })).toBe("refocus");
  });

  it("restores the seeded tab on non-click activation (dock icon, Cmd+Tab)", () => {
    expect(action({ seededTabId: "tab-1" })).toBe("refocus");
  });

  it("never steals focus without click ownership or a seeded match", () => {
    expect(action({ seededTabId: null })).toBe("none");
    expect(action({ seededTabId: "tab-2" })).toBe("none");
    expect(action({ seededTabId: "tab-1", activeElementIsBody: false })).toBe("none");
    expect(action({ focusedTabId: null })).toBe("none");
  });

  it("yields to search and rename inputs", () => {
    expect(
      action({ ownsFocus: true, focusState: focusState({ searchOpen: true }) }),
    ).toBe("none");
    expect(
      action({ ownsFocus: true, focusState: focusState({ renamingTaskId: "t" }) }),
    ).toBe("none");
    expect(action({ ownsFocus: true, focusState: focusState({ open: false }) })).toBe(
      "none",
    );
  });
});

describe("TerminalPanel ordered frame stream", () => {
  it("accepts an initial full frame and contiguous patches", () => {
    expect(terminalFrameDisposition(null, "g1", 1, 0, false)).toBe("apply");
    expect(terminalFrameDisposition({ generation: "g1", lastSeq: 1 }, "g1", 2, 1, true)).toBe(
      "apply",
    );
  });

  it("rejects duplicates and gaps while accepting a full resync", () => {
    const current = { generation: "g1", lastSeq: 3 };
    expect(terminalFrameDisposition(current, "g1", 3, 2, true)).toBe("duplicate");
    expect(terminalFrameDisposition(current, "g1", 5, 4, true)).toBe("resync");
    expect(terminalFrameDisposition(current, "g1", 5, 4, false)).toBe("apply");
    expect(terminalFrameDisposition(current, "g2", 1, 0, true)).toBe("resync");
  });
});
