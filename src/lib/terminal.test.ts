import { describe, expect, it } from "vitest";
import {
  createTerminalTab,
  EMPTY_TERMINAL_STATE,
  selectTerminalSplitLeftTabId,
  shouldAutoLaunchTerminal,
  terminalCommandPreview,
  terminalTabsReducer,
} from "./terminal";
import { DEFAULT_ANCHOR_SETTINGS, normalizeAnchorSettings } from "./settings";

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
});
