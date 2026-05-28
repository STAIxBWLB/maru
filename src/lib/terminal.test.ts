import { describe, expect, it } from "vitest";
import {
  createTerminalTab,
  EMPTY_TERMINAL_STATE,
  getTerminalSplitPaneTabs,
  selectTerminalSplitLeftTabId,
  shouldCloseTerminalSplitAfterTabClose,
  shouldAutoLaunchTerminal,
  terminalCommandPreview,
  TERMINAL_SHIFT_ENTER_DATA,
  terminalShiftEnterData,
  terminalTabsReducer,
} from "./terminal";
import { DEFAULT_ANCHOR_SETTINGS, normalizeAnchorSettings } from "./settings";

function key(opts: {
  type?: string;
  key?: string;
  shift?: boolean;
  meta?: boolean;
  ctrl?: boolean;
  alt?: boolean;
} = {}): KeyboardEvent {
  return {
    type: opts.type ?? "keydown",
    key: opts.key ?? "Enter",
    shiftKey: opts.shift ?? false,
    metaKey: opts.meta ?? false,
    ctrlKey: opts.ctrl ?? false,
    altKey: opts.alt ?? false,
  } as KeyboardEvent;
}

describe("terminal tab reducer", () => {
  it("creates, switches, attaches, exits, and closes tabs", () => {
    const claude = createTerminalTab("tab-1", "claude", "Claude Code");
    const codex = createTerminalTab("tab-2", "codex", "Codex");
    let state = terminalTabsReducer(EMPTY_TERMINAL_STATE, {
      type: "create",
      tab: claude,
    });
    state = terminalTabsReducer(state, { type: "create", tab: codex });
    expect(state.activeTabId).toBe("tab-2");

    state = terminalTabsReducer(state, { type: "switch", tabId: "tab-1" });
    expect(state.activeTabId).toBe("tab-1");

    state = terminalTabsReducer(state, {
      type: "attach",
      tabId: "tab-1",
      sessionId: "term-1",
    });
    expect(state.tabs[0].sessionId).toBe("term-1");

    state = terminalTabsReducer(state, {
      type: "exit",
      sessionId: "term-1",
      exitCode: 0,
    });
    expect(state.tabs[0].running).toBe(false);
    expect(state.tabs[0].exitCode).toBe(0);

    state = terminalTabsReducer(state, { type: "close", tabId: "tab-1" });
    expect(state.tabs.map((tab) => tab.id)).toEqual(["tab-2"]);
    expect(state.activeTabId).toBe("tab-2");
  });

  it("maps launcher previews to the intended CLI entrypoints", () => {
    expect(terminalCommandPreview("claude", "/tmp/work")).toBe("claude");
    expect(terminalCommandPreview("codex", "/tmp/work")).toBe("codex --cd /tmp/work");
    expect(terminalCommandPreview("codex", "/tmp/work tree")).toBe(
      "codex --cd '/tmp/work tree'",
    );
    expect(terminalCommandPreview("codex", "")).toBe("codex --cd .");
    expect(terminalCommandPreview("shell", "/tmp/work")).toBe("shell");
  });

  it("keeps the split-left tab separate from the right tab", () => {
    const shell = createTerminalTab("tab-1", "shell", "Shell");
    const codex = createTerminalTab("tab-2", "codex", "Codex");
    let state = terminalTabsReducer(EMPTY_TERMINAL_STATE, {
      type: "create",
      tab: shell,
    });
    state = terminalTabsReducer(state, {
      type: "create",
      tab: codex,
      activate: false,
    });

    expect(selectTerminalSplitLeftTabId(state, "tab-2")).toBe("tab-1");

    const rightOnly = terminalTabsReducer(EMPTY_TERMINAL_STATE, {
      type: "create",
      tab: shell,
      activate: false,
    });
    expect(selectTerminalSplitLeftTabId(rightOnly, "tab-1")).toBeNull();
  });

  it("groups split terminal tabs by pane", () => {
    const shell = createTerminalTab("tab-1", "shell", "Shell");
    const codex = createTerminalTab("tab-2", "codex", "Codex");
    const claude = createTerminalTab("tab-3", "claude", "Claude");
    let state = terminalTabsReducer(EMPTY_TERMINAL_STATE, {
      type: "create",
      tab: shell,
    });
    state = terminalTabsReducer(state, {
      type: "create",
      tab: codex,
    });
    state = terminalTabsReducer(state, {
      type: "create",
      tab: claude,
      activate: false,
    });

    const groups = getTerminalSplitPaneTabs(state, "tab-2");
    expect(groups.leftTabs.map((tab) => tab.id)).toEqual(["tab-1", "tab-3"]);
    expect(groups.rightTabs.map((tab) => tab.id)).toEqual(["tab-2"]);
    expect(groups.leftActiveTabId).toBe("tab-1");
    expect(groups.rightActiveTabId).toBe("tab-2");
  });

  it("closes split mode instead of auto-replacing the last remaining pane", () => {
    const shell = createTerminalTab("tab-1", "shell", "Shell");
    const codex = createTerminalTab("tab-2", "codex", "Codex");
    let state = terminalTabsReducer(EMPTY_TERMINAL_STATE, {
      type: "create",
      tab: shell,
    });
    state = terminalTabsReducer(state, {
      type: "create",
      tab: codex,
      activate: false,
    });

    expect(shouldCloseTerminalSplitAfterTabClose(state, true, "tab-2", "tab-1")).toBe(true);
    expect(shouldCloseTerminalSplitAfterTabClose(state, true, "tab-2", "tab-2")).toBe(true);
    expect(shouldCloseTerminalSplitAfterTabClose(state, false, "tab-2", "tab-1")).toBe(false);
  });

  it("auto-launches only when open, empty, and enabled", () => {
    const settings = normalizeAnchorSettings(DEFAULT_ANCHOR_SETTINGS);
    expect(shouldAutoLaunchTerminal(settings, false, 0)).toBeNull();
    expect(shouldAutoLaunchTerminal(settings, true, 1)).toBeNull();
    expect(shouldAutoLaunchTerminal(settings, true, 0)).toBe("shell");

    const disabled = normalizeAnchorSettings({
      terminal: {
        autoLaunch: "shell",
        launchers: {
          shell: { enabled: false, label: "Shell" },
        },
      },
    });
    expect(shouldAutoLaunchTerminal(disabled, true, 0)).toBeNull();
  });

  it("maps Shift+Enter to modified-key data for AI terminal tabs only", () => {
    const event = key({ shift: true });
    expect(terminalShiftEnterData("claude", event)).toBe(TERMINAL_SHIFT_ENTER_DATA);
    expect(terminalShiftEnterData("codex", event)).toBe(TERMINAL_SHIFT_ENTER_DATA);
    expect(terminalShiftEnterData("shell", event)).toBeNull();
  });

  it("does not map plain Enter, other modifiers, or non-keydown events", () => {
    expect(terminalShiftEnterData("claude", key())).toBeNull();
    expect(terminalShiftEnterData("claude", key({ key: "a", shift: true }))).toBeNull();
    expect(terminalShiftEnterData("claude", key({ shift: true, meta: true }))).toBeNull();
    expect(terminalShiftEnterData("claude", key({ shift: true, ctrl: true }))).toBeNull();
    expect(terminalShiftEnterData("claude", key({ shift: true, alt: true }))).toBeNull();
    expect(terminalShiftEnterData("claude", key({ type: "keyup", shift: true }))).toBeNull();
  });
});
