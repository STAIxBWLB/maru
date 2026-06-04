import { describe, expect, it } from "vitest";
import {
  activeItemMention,
  buildAgentContextArgs,
  buildAgentResumeArgs,
  buildAnchorContextEnv,
  createTerminalTab,
  createTerminalTask,
  describeActiveContextChip,
  EMPTY_TERMINAL_STATE,
  getTerminalSplitPaneTabs,
  hydrateTerminalStateFromPersisted,
  isRelaunchableTab,
  pathMention,
  resolveExistingLaunchTaskId,
  selectTerminalSplitLeftTabId,
  selectTerminalTabByIndex,
  serializeTerminalState,
  terminalHookEventToStatus,
  shouldCloseTerminalSplitAfterTabClose,
  shouldAutoLaunchTerminal,
  shouldSuppressTerminalHoverMouseEvent,
  shouldSuppressTerminalMouseTracking,
  tabsForTask,
  terminalCommandPreview,
  terminalTabStatus,
  terminalTaskStatus,
  TERMINAL_SHIFT_ENTER_DATA,
  terminalShiftEnterData,
  terminalTabsReducer,
  type ActiveTerminalContext,
} from "./terminal";
import { DEFAULT_ANCHOR_SETTINGS, normalizeAnchorSettings } from "./settings";

const CTX: ActiveTerminalContext = {
  workspaceRoot: "/work/vault",
  workspaceVisibility: "private",
  appMode: "pkm",
  docAbsPath: "/work/vault/notes/메모.md",
  docRelPath: "notes/메모.md",
  docTitle: "메모",
  docType: "note",
};

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

function mouseMove(buttons: number): MouseEvent {
  return {
    type: "mousemove",
    buttons,
  } as MouseEvent;
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

    expect(selectTerminalSplitLeftTabId(state.tabs, state.activeTabId, "tab-2")).toBe("tab-1");

    const rightOnly = terminalTabsReducer(EMPTY_TERMINAL_STATE, {
      type: "create",
      tab: shell,
      activate: false,
    });
    expect(
      selectTerminalSplitLeftTabId(rightOnly.tabs, rightOnly.activeTabId, "tab-1"),
    ).toBeNull();
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

    const groups = getTerminalSplitPaneTabs(state.tabs, state.activeTabId, "tab-2");
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

    expect(shouldCloseTerminalSplitAfterTabClose(state.tabs, true, "tab-2", "tab-1")).toBe(true);
    expect(shouldCloseTerminalSplitAfterTabClose(state.tabs, true, "tab-2", "tab-2")).toBe(true);
    expect(shouldCloseTerminalSplitAfterTabClose(state.tabs, false, "tab-2", "tab-1")).toBe(false);
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

  it("suppresses terminal mouse tracking modes without blocking non-mouse modes", () => {
    expect(shouldSuppressTerminalMouseTracking([9])).toBe(true);
    expect(shouldSuppressTerminalMouseTracking([1003])).toBe(true);
    expect(shouldSuppressTerminalMouseTracking([1006])).toBe(true);
    expect(shouldSuppressTerminalMouseTracking([[1000, 1006]])).toBe(true);

    expect(shouldSuppressTerminalMouseTracking([1004])).toBe(false);
    expect(shouldSuppressTerminalMouseTracking([1007])).toBe(false);
    expect(shouldSuppressTerminalMouseTracking([1049])).toBe(false);
    expect(shouldSuppressTerminalMouseTracking([2004])).toBe(false);
    expect(shouldSuppressTerminalMouseTracking([[1004, 1049, 2004]])).toBe(false);
  });

  it("suppresses hover mousemove while preserving drag selection", () => {
    expect(shouldSuppressTerminalHoverMouseEvent(mouseMove(0))).toBe(true);
    expect(shouldSuppressTerminalHoverMouseEvent(mouseMove(1))).toBe(false);
    expect(
      shouldSuppressTerminalHoverMouseEvent({
        type: "mousedown",
        buttons: 0,
      } as MouseEvent),
    ).toBe(false);
  });
});

describe("terminal task layer", () => {
  function seedTwoTasks() {
    let state = terminalTabsReducer(EMPTY_TERMINAL_STATE, {
      type: "createTask",
      task: createTerminalTask("task-1", "Task 1", "/a"),
    });
    state = terminalTabsReducer(state, {
      type: "create",
      tab: createTerminalTab("tab-1", "claude", "Claude", { taskId: "task-1", cwd: "/a" }),
    });
    state = terminalTabsReducer(state, {
      type: "createTask",
      task: createTerminalTask("task-2", "Task 2", "/b"),
    });
    state = terminalTabsReducer(state, {
      type: "create",
      tab: createTerminalTab("tab-2", "shell", "Shell", { taskId: "task-2", cwd: "/b" }),
    });
    return state;
  }

  it("creates tasks and groups tabs by task", () => {
    const state = seedTwoTasks();
    expect(state.tasks.map((task) => task.id)).toEqual(["task-1", "task-2"]);
    expect(state.activeTaskId).toBe("task-2");
    expect(tabsForTask(state, "task-1").map((tab) => tab.id)).toEqual(["tab-1"]);
    expect(tabsForTask(state, "task-2").map((tab) => tab.id)).toEqual(["tab-2"]);
  });

  it("switchTask moves the active tab into the selected task", () => {
    let state = seedTwoTasks();
    state = terminalTabsReducer(state, { type: "switchTask", taskId: "task-1" });
    expect(state.activeTaskId).toBe("task-1");
    expect(state.activeTabId).toBe("tab-1");
    // Unknown task is a no-op.
    expect(terminalTabsReducer(state, { type: "switchTask", taskId: "nope" })).toBe(state);
  });

  it("renameTask trims and ignores empty names", () => {
    let state = seedTwoTasks();
    state = terminalTabsReducer(state, { type: "renameTask", taskId: "task-1", name: "  Build  " });
    expect(state.tasks.find((task) => task.id === "task-1")?.name).toBe("Build");
    expect(terminalTabsReducer(state, { type: "renameTask", taskId: "task-1", name: "   " })).toBe(
      state,
    );
  });

  it("closeTask removes the task and its tabs and reselects", () => {
    let state = seedTwoTasks();
    state = terminalTabsReducer(state, { type: "closeTask", taskId: "task-2" });
    expect(state.tasks.map((task) => task.id)).toEqual(["task-1"]);
    expect(state.tabs.map((tab) => tab.id)).toEqual(["tab-1"]);
    expect(state.activeTaskId).toBe("task-1");
    expect(state.activeTabId).toBe("tab-1");
  });

  it("resolves the launch target task without stale-state double-create", () => {
    const tasks = [createTerminalTask("task-1", "A", "/a"), createTerminalTask("task-2", "B", "/b")];
    // Explicit existing task (relaunch path) wins.
    expect(resolveExistingLaunchTaskId(tasks, "task-1", { requestedTaskId: "task-2" })).toBe("task-2");
    // No request → active task (normal launcher button).
    expect(resolveExistingLaunchTaskId(tasks, "task-1", {})).toBe("task-1");
    // forceNewTask → null (caller creates a fresh task) — the "+" path.
    expect(resolveExistingLaunchTaskId(tasks, "task-1", { forceNewTask: true })).toBeNull();
    // Requested id that no longer exists → ignored, falls back to active.
    expect(resolveExistingLaunchTaskId(tasks, "task-1", { requestedTaskId: "gone" })).toBe("task-1");
    // Nothing to target → null.
    expect(resolveExistingLaunchTaskId([], null, {})).toBeNull();
  });
});

describe("terminal session status", () => {
  it("renames a session, ignoring empty titles", () => {
    let state = terminalTabsReducer(EMPTY_TERMINAL_STATE, {
      type: "create",
      tab: createTerminalTab("tab-1", "shell", "Shell"),
    });
    state = terminalTabsReducer(state, { type: "rename", tabId: "tab-1", title: "  build  " });
    expect(state.tabs[0].title).toBe("build");
    expect(terminalTabsReducer(state, { type: "rename", tabId: "tab-1", title: "  " })).toBe(state);
  });

  it("marks and clears attention by session/tab id", () => {
    let state = terminalTabsReducer(EMPTY_TERMINAL_STATE, {
      type: "create",
      tab: createTerminalTab("tab-1", "claude", "Claude"),
    });
    state = terminalTabsReducer(state, { type: "attach", tabId: "tab-1", sessionId: "s1" });
    state = terminalTabsReducer(state, { type: "markAttention", sessionId: "s1" });
    expect(state.tabs[0].attention).toBe(true);
    state = terminalTabsReducer(state, { type: "clearAttention", tabId: "tab-1" });
    expect(state.tabs[0].attention).toBe(false);
  });

  it("returns the same state reference when attention/status do not change", () => {
    let state = terminalTabsReducer(EMPTY_TERMINAL_STATE, {
      type: "create",
      tab: createTerminalTab("tab-1", "claude", "Claude"),
    });
    state = terminalTabsReducer(state, { type: "attach", tabId: "tab-1", sessionId: "s1" });
    // clearAttention when already clear → no-op (same reference, no re-render).
    expect(terminalTabsReducer(state, { type: "clearAttention", tabId: "tab-1" })).toBe(state);
    // First markAttention changes; a second identical one is a no-op.
    const flagged = terminalTabsReducer(state, { type: "markAttention", sessionId: "s1" });
    expect(flagged).not.toBe(state);
    expect(terminalTabsReducer(flagged, { type: "markAttention", sessionId: "s1" })).toBe(flagged);
    // Unknown session → no-op.
    expect(terminalTabsReducer(state, { type: "markAttention", sessionId: "nope" })).toBe(state);
    // setStatus with identical result → no-op.
    const running = terminalTabsReducer(state, { type: "setStatus", sessionId: "s1", status: "running" });
    expect(terminalTabsReducer(running, { type: "setStatus", sessionId: "s1", status: "running" })).toBe(running);
  });

  it("applies precise agent status and captures the resume id", () => {
    let state = terminalTabsReducer(EMPTY_TERMINAL_STATE, {
      type: "create",
      tab: createTerminalTab("tab-1", "claude", "Claude"),
    });
    state = terminalTabsReducer(state, { type: "attach", tabId: "tab-1", sessionId: "s1" });
    state = terminalTabsReducer(state, {
      type: "setStatus",
      sessionId: "s1",
      status: "needs-input",
      agentSessionId: "abc123",
    });
    expect(state.tabs[0].agentStatus).toBe("needs-input");
    expect(state.tabs[0].attention).toBe(true);
    expect(state.tabs[0].agentSessionId).toBe("abc123");
  });

  it("derives single-session status with agent state taking precedence", () => {
    const base = createTerminalTab("tab-1", "claude", "Claude");
    expect(terminalTabStatus({ ...base, sessionId: null })).toBe("spawning");
    expect(terminalTabStatus({ ...base, sessionId: "s1" })).toBe("running");
    expect(terminalTabStatus({ ...base, sessionId: "s1", attention: true })).toBe("attention");
    expect(
      terminalTabStatus({ ...base, sessionId: "s1", attention: true, agentStatus: "needs-input" }),
    ).toBe("needs-input");
    expect(terminalTabStatus({ ...base, running: false, exitCode: 0 })).toBe("exited");
  });

  it("aggregates task status by highest priority", () => {
    const running = { ...createTerminalTab("a", "shell", "a"), sessionId: "s" };
    const needs = { ...createTerminalTab("b", "claude", "b"), sessionId: "s2", agentStatus: "needs-input" as const };
    expect(terminalTaskStatus([])).toBe("exited");
    expect(terminalTaskStatus([running])).toBe("running");
    expect(terminalTaskStatus([running, needs])).toBe("needs-input");
  });

  it("selects a session by 1-based index", () => {
    const tabs = [
      createTerminalTab("a", "shell", "a"),
      createTerminalTab("b", "shell", "b"),
    ];
    expect(selectTerminalTabByIndex(tabs, 1)?.id).toBe("a");
    expect(selectTerminalTabByIndex(tabs, 2)?.id).toBe("b");
    expect(selectTerminalTabByIndex(tabs, 0)).toBeNull();
    expect(selectTerminalTabByIndex(tabs, 3)).toBeNull();
  });
});

describe("active-item context bridge", () => {
  it("injects ANCHOR_* env, omitting empty item keys", () => {
    const env = buildAnchorContextEnv(CTX, "term-1", true);
    expect(env.ANCHOR_TERMINAL).toBe("1");
    expect(env.ANCHOR_SESSION_ID).toBe("term-1");
    expect(env.ANCHOR_WORKSPACE).toBe("/work/vault");
    expect(env.ANCHOR_APP_MODE).toBe("pkm");
    expect(env.ANCHOR_ACTIVE_DOC_REL).toBe("notes/메모.md");

    const noItem = buildAnchorContextEnv(
      { ...CTX, docAbsPath: null, docRelPath: null, docTitle: null, docType: null },
      "term-2",
      true,
    );
    expect("ANCHOR_ACTIVE_DOC" in noItem).toBe(false);
    expect("ANCHOR_ACTIVE_DOC_REL" in noItem).toBe(false);
  });

  it("returns only safe markers when disabled", () => {
    const env = buildAnchorContextEnv(CTX, "term-1", false);
    expect(Object.keys(env).sort()).toEqual(["ANCHOR_SESSION_ID", "ANCHOR_TERMINAL"]);
  });

  it("adds --add-dir only for agents with a workspace", () => {
    expect(buildAgentContextArgs("shell", CTX, true)).toEqual([]);
    expect(buildAgentContextArgs("claude", CTX, true)).toEqual(["--add-dir", "/work/vault"]);
    expect(buildAgentContextArgs("codex", CTX, true)).toEqual(["--add-dir", "/work/vault"]);
    expect(buildAgentContextArgs("claude", { ...CTX, workspaceRoot: null }, true)).toEqual([]);
    expect(buildAgentContextArgs("claude", CTX, false)).toEqual([]);
  });

  it("builds file mentions in each style with a trailing space", () => {
    expect(activeItemMention(CTX, "mention")).toBe("@notes/메모.md ");
    expect(activeItemMention(CTX, "read")).toBe('Read this file: "/work/vault/notes/메모.md" ');
    expect(activeItemMention(CTX, "path")).toBe('"/work/vault/notes/메모.md" ');
    expect(pathMention(null, "/x/y.md", "mention")).toBe("/x/y.md ");
    expect(pathMention(null, null, "mention")).toBeNull();
  });

  it("describes the context chip and its enabled state", () => {
    expect(describeActiveContextChip(CTX, { focusedKind: "claude" })).toMatchObject({
      label: "메모",
      enabled: true,
    });
    expect(describeActiveContextChip(CTX, { focusedKind: "shell" }).enabled).toBe(false);
    expect(
      describeActiveContextChip(
        { ...CTX, docTitle: null, docRelPath: null, docAbsPath: null },
        { focusedKind: "claude" },
      ).enabled,
    ).toBe(false);
  });
});

describe("terminal persistence", () => {
  function liveState() {
    let state = terminalTabsReducer(EMPTY_TERMINAL_STATE, {
      type: "createTask",
      task: createTerminalTask("task-1", "Build", "/work"),
    });
    state = terminalTabsReducer(state, {
      type: "create",
      tab: createTerminalTab("tab-1", "claude", "Claude", { taskId: "task-1", cwd: "/work" }),
    });
    state = terminalTabsReducer(state, { type: "attach", tabId: "tab-1", sessionId: "s1" });
    state = terminalTabsReducer(state, {
      type: "setStatus",
      sessionId: "s1",
      status: "done",
      agentSessionId: "resume-xyz",
    });
    return state;
  }

  it("serializes durable task + session metadata", () => {
    const persisted = serializeTerminalState(liveState());
    expect(persisted.version).toBe(1);
    expect(persisted.tasks).toEqual([
      { id: "task-1", name: "Build", cwd: "/work", contextLabel: null, createdAt: 0 },
    ]);
    expect(persisted.sessions).toEqual([
      { taskId: "task-1", kind: "claude", title: "Claude", cwd: "/work", agentSessionId: "resume-xyz" },
    ]);
  });

  it("round-trips into relaunchable placeholders", () => {
    const persisted = serializeTerminalState(liveState());
    const restored = hydrateTerminalStateFromPersisted(persisted);
    expect(restored.tasks.map((task) => task.id)).toEqual(["task-1"]);
    expect(restored.activeTaskId).toBe("task-1");
    expect(restored.tabs).toHaveLength(1);
    const tab = restored.tabs[0];
    expect(tab.running).toBe(false);
    expect(tab.sessionId).toBeNull();
    expect(tab.agentSessionId).toBe("resume-xyz");
    expect(isRelaunchableTab(tab)).toBe(true);
  });

  it("rejects malformed or empty persisted blobs", () => {
    expect(hydrateTerminalStateFromPersisted(null)).toBe(EMPTY_TERMINAL_STATE);
    expect(hydrateTerminalStateFromPersisted({ tasks: [] })).toBe(EMPTY_TERMINAL_STATE);
    const dropped = hydrateTerminalStateFromPersisted({
      tasks: [{ id: "t", name: "T", cwd: null, contextLabel: null, createdAt: 0 }],
      sessions: [{ taskId: "missing", kind: "claude", title: "x", cwd: null, agentSessionId: null }],
    });
    expect(dropped.tabs).toHaveLength(0);
  });

  it("builds native agent resume args", () => {
    expect(buildAgentResumeArgs("claude", "abc")).toEqual(["--resume", "abc"]);
    expect(buildAgentResumeArgs("codex", "abc")).toEqual(["resume", "abc"]);
    expect(buildAgentResumeArgs("shell", "abc")).toEqual([]);
    expect(buildAgentResumeArgs("claude", null)).toEqual([]);
  });

  it("maps hook event tokens to precise status", () => {
    expect(terminalHookEventToStatus("running")).toBe("running");
    expect(terminalHookEventToStatus("needs-input")).toBe("needs-input");
    expect(terminalHookEventToStatus("Notification")).toBe("needs-input");
    expect(terminalHookEventToStatus("done")).toBe("done");
    expect(terminalHookEventToStatus("Stop")).toBe("done");
    expect(terminalHookEventToStatus("garbage")).toBeNull();
  });
});
