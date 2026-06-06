import type {
  AnchorAppMode,
  AnchorSettings,
  TerminalAttachMentionStyle,
  TerminalLauncherId,
} from "./settings";

export type TerminalKind = TerminalLauncherId;

/** Precise agent lifecycle, populated by agent hooks (Phase D). */
export type AgentStatus = "running" | "needs-input" | "done";

/** Aggregate status surfaced as a colored dot in the sidebar/tab. */
export type TerminalStatus =
  | "spawning"
  | "running"
  | "needs-input"
  | "attention"
  | "done"
  | "exited";

export interface TerminalTab {
  id: string;
  kind: TerminalKind;
  title: string;
  sessionId: string | null;
  running: boolean;
  exitCode: number | null;
  /** Owning task (group). New tabs inherit the active task. */
  taskId: string | null;
  /** Resolved launch cwd — for the sidebar basename and relaunch. */
  cwd: string | null;
  /** Creation timestamp; stable ordering key. */
  createdAt: number;
  /** Output arrived while this tab was not focused (heuristic). */
  attention: boolean;
  /** Precise agent state from hooks; preferred over the heuristic. */
  agentStatus: AgentStatus | null;
  /** Native agent session id (claude/codex) captured via hooks — enables resume. */
  agentSessionId: string | null;
}

/** A multi-task group: one working context, many sessions. */
export interface TerminalTask {
  id: string;
  name: string;
  cwd: string | null;
  contextLabel: string | null;
  createdAt: number;
}

export interface TerminalTabsState {
  tabs: TerminalTab[];
  activeTabId: string | null;
  tasks: TerminalTask[];
  activeTaskId: string | null;
}

export interface TerminalSplitPaneTabs {
  leftTabs: TerminalTab[];
  rightTabs: TerminalTab[];
  leftActiveTabId: string | null;
  rightActiveTabId: string | null;
}

export type TerminalTabsAction =
  | { type: "create"; tab: TerminalTab; activate?: boolean }
  | { type: "switch"; tabId: string }
  | { type: "attach"; tabId: string; sessionId: string }
  | { type: "exit"; sessionId: string; exitCode: number | null }
  | { type: "fail"; tabId: string }
  | { type: "close"; tabId: string }
  | { type: "rename"; tabId: string; title: string }
  | { type: "markAttention"; sessionId: string }
  | { type: "clearAttention"; tabId: string }
  | {
      type: "setStatus";
      sessionId: string;
      status: AgentStatus;
      agentSessionId?: string | null;
    }
  // Task (group) actions
  | { type: "createTask"; task: TerminalTask; activate?: boolean }
  | { type: "switchTask"; taskId: string }
  | { type: "renameTask"; taskId: string; name: string }
  | { type: "closeTask"; taskId: string };

export const TERMINAL_LAUNCHERS: Array<{
  id: TerminalKind;
  titleKey: string;
}> = [
  { id: "claude", titleKey: "terminal.launcher.claude" },
  { id: "codex", titleKey: "terminal.launcher.codex" },
  { id: "shell", titleKey: "terminal.launcher.shell" },
];

type TerminalMouseMoveEvent = Pick<MouseEvent, "type" | "buttons">;

/** Suppress idle hover (button-less mousemove) over the terminal so it does not
 *  bleed into page-level handlers. When the focused program has requested a
 *  mouse mode (claude/codex TUIs), hover is meaningful and must NOT be
 *  suppressed — the renderer forwards it as a motion report instead. */
export function shouldSuppressTerminalHoverMouseEvent(
  event: TerminalMouseMoveEvent,
  mouseModeActive = false,
): boolean {
  if (mouseModeActive) return false;
  return event.type === "mousemove" && event.buttons === 0;
}

export const EMPTY_TERMINAL_STATE: TerminalTabsState = {
  tabs: [],
  activeTabId: null,
  tasks: [],
  activeTaskId: null,
};

export interface CreateTerminalTabOptions {
  taskId?: string | null;
  cwd?: string | null;
  createdAt?: number;
}

export function createTerminalTab(
  id: string,
  kind: TerminalKind,
  title: string,
  options: CreateTerminalTabOptions = {},
): TerminalTab {
  return {
    id,
    kind,
    title,
    sessionId: null,
    running: true,
    exitCode: null,
    taskId: options.taskId ?? null,
    cwd: options.cwd ?? null,
    createdAt: options.createdAt ?? 0,
    attention: false,
    agentStatus: null,
    agentSessionId: null,
  };
}

export function createTerminalTask(
  id: string,
  name: string,
  cwd: string | null,
  options: { contextLabel?: string | null; createdAt?: number } = {},
): TerminalTask {
  return {
    id,
    name,
    cwd,
    contextLabel: options.contextLabel ?? null,
    createdAt: options.createdAt ?? 0,
  };
}

export function terminalTabsReducer(
  state: TerminalTabsState,
  action: TerminalTabsAction,
): TerminalTabsState {
  switch (action.type) {
    case "create":
      return {
        ...state,
        tabs: [...state.tabs, action.tab],
        activeTabId:
          action.activate === false ? state.activeTabId ?? action.tab.id : action.tab.id,
      };
    case "switch":
      return state.tabs.some((tab) => tab.id === action.tabId)
        ? { ...state, activeTabId: action.tabId }
        : state;
    case "attach":
      return {
        ...state,
        tabs: state.tabs.map((tab) =>
          tab.id === action.tabId ? { ...tab, sessionId: action.sessionId } : tab,
        ),
      };
    case "exit":
      return {
        ...state,
        tabs: state.tabs.map((tab) =>
          tab.sessionId === action.sessionId
            ? {
                ...tab,
                running: false,
                exitCode: action.exitCode,
                attention: false,
                agentStatus: tab.agentStatus === "done" ? "done" : null,
              }
            : tab,
        ),
      };
    case "fail":
      return {
        ...state,
        tabs: state.tabs.map((tab) =>
          tab.id === action.tabId ? { ...tab, running: false, exitCode: null } : tab,
        ),
      };
    case "rename": {
      const title = action.title.trim();
      if (!title) return state;
      return {
        ...state,
        tabs: state.tabs.map((tab) =>
          tab.id === action.tabId ? { ...tab, title } : tab,
        ),
      };
    }
    case "markAttention": {
      // No-op (return the same reference) when nothing changes so useReducer
      // bails out of re-rendering — avoids a re-render storm on output spam.
      const target = state.tabs.find((tab) => tab.sessionId === action.sessionId);
      if (!target || target.attention) return state;
      return {
        ...state,
        tabs: state.tabs.map((tab) =>
          tab.sessionId === action.sessionId ? { ...tab, attention: true } : tab,
        ),
      };
    }
    case "clearAttention": {
      const target = state.tabs.find((tab) => tab.id === action.tabId);
      if (!target || !target.attention) return state;
      return {
        ...state,
        tabs: state.tabs.map((tab) =>
          tab.id === action.tabId ? { ...tab, attention: false } : tab,
        ),
      };
    }
    case "setStatus": {
      const target = state.tabs.find((tab) => tab.sessionId === action.sessionId);
      if (!target) return state;
      const nextAgentSessionId =
        action.agentSessionId !== undefined && action.agentSessionId !== null
          ? action.agentSessionId
          : target.agentSessionId;
      const nextAttention = action.status === "needs-input" ? true : target.attention;
      if (
        target.agentStatus === action.status &&
        target.agentSessionId === nextAgentSessionId &&
        target.attention === nextAttention
      ) {
        return state;
      }
      return {
        ...state,
        tabs: state.tabs.map((tab) =>
          tab.sessionId === action.sessionId
            ? {
                ...tab,
                agentStatus: action.status,
                attention: nextAttention,
                agentSessionId: nextAgentSessionId,
              }
            : tab,
        ),
      };
    }
    case "close": {
      const closingIndex = state.tabs.findIndex((tab) => tab.id === action.tabId);
      if (closingIndex === -1) return state;
      const tabs = state.tabs.filter((tab) => tab.id !== action.tabId);
      if (state.activeTabId !== action.tabId) return { ...state, tabs };
      // Pick the nearest remaining tab in the SAME task when possible.
      const closing = state.tabs[closingIndex];
      const originalSiblings = state.tabs.filter((tab) => tab.taskId === closing.taskId);
      const siblingIndex = originalSiblings.findIndex((tab) => tab.id === action.tabId);
      const siblings = tabs.filter((tab) => tab.taskId === closing.taskId);
      const fallback =
        siblings[Math.min(Math.max(siblingIndex, 0), siblings.length - 1)] ??
        tabs[Math.min(closingIndex, tabs.length - 1)] ??
        null;
      return {
        ...state,
        tabs,
        activeTaskId: fallback ? fallback.taskId : state.activeTaskId,
        activeTabId: fallback?.id ?? null,
      };
    }
    case "createTask":
      return {
        ...state,
        tasks: [...state.tasks, action.task],
        activeTaskId:
          action.activate === false ? state.activeTaskId ?? action.task.id : action.task.id,
      };
    case "switchTask": {
      if (!state.tasks.some((task) => task.id === action.taskId)) return state;
      const taskTabs = state.tabs.filter((tab) => tab.taskId === action.taskId);
      // Move the active tab into the newly-active task so the body shows it.
      const nextActiveTab = taskTabs.some((tab) => tab.id === state.activeTabId)
        ? state.activeTabId
        : taskTabs[0]?.id ?? null;
      return { ...state, activeTaskId: action.taskId, activeTabId: nextActiveTab };
    }
    case "renameTask": {
      const name = action.name.trim();
      if (!name) return state;
      return {
        ...state,
        tasks: state.tasks.map((task) =>
          task.id === action.taskId ? { ...task, name } : task,
        ),
      };
    }
    case "closeTask": {
      const tasks = state.tasks.filter((task) => task.id !== action.taskId);
      const tabs = state.tabs.filter((tab) => tab.taskId !== action.taskId);
      const activeTaskId =
        state.activeTaskId === action.taskId ? tasks[0]?.id ?? null : state.activeTaskId;
      const activeTabExists = tabs.some((tab) => tab.id === state.activeTabId);
      const activeTabId = activeTabExists
        ? state.activeTabId
        : tabs.find((tab) => tab.taskId === activeTaskId)?.id ?? null;
      return { tasks, tabs, activeTaskId, activeTabId };
    }
  }
}

/** Tabs belonging to a task, in creation order. */
export function tabsForTask(state: TerminalTabsState, taskId: string | null): TerminalTab[] {
  return state.tabs.filter((tab) => tab.taskId === taskId);
}

/**
 * Resolve which EXISTING task a launch should target, or null when the caller
 * must create a fresh one. Keeping this pure (no stale closure state) is what
 * prevents the double-task bug: `launch` owns task creation in one place.
 */
export function resolveExistingLaunchTaskId(
  tasks: TerminalTask[],
  activeTaskId: string | null,
  opts: { requestedTaskId?: string | null; forceNewTask?: boolean },
): string | null {
  if (opts.requestedTaskId && tasks.some((task) => task.id === opts.requestedTaskId)) {
    return opts.requestedTaskId;
  }
  if (!opts.forceNewTask && activeTaskId && tasks.some((task) => task.id === activeTaskId)) {
    return activeTaskId;
  }
  return null;
}

/** 1-based index into the active task's tabs (for ⌘1–9). */
export function selectTerminalTabByIndex(
  tabs: TerminalTab[],
  oneBasedIndex: number,
): TerminalTab | null {
  if (oneBasedIndex < 1) return null;
  return tabs[oneBasedIndex - 1] ?? null;
}

/** Single-session status, preferring precise agent state over the heuristic. */
export function terminalTabStatus(tab: TerminalTab): TerminalStatus {
  if (!tab.running) return "exited";
  if (tab.agentStatus === "needs-input") return "needs-input";
  if (tab.agentStatus === "done") return "done";
  if (tab.sessionId === null) return "spawning";
  if (tab.attention) return "attention";
  return "running";
}

const TERMINAL_STATUS_PRIORITY: Record<TerminalStatus, number> = {
  "needs-input": 5,
  attention: 4,
  running: 3,
  spawning: 2,
  done: 1,
  exited: 0,
};

/** Aggregate status for a task row (highest-priority session wins). */
export function terminalTaskStatus(tabs: TerminalTab[]): TerminalStatus {
  if (tabs.length === 0) return "exited";
  let best: TerminalStatus = "exited";
  for (const tab of tabs) {
    const status = terminalTabStatus(tab);
    if (TERMINAL_STATUS_PRIORITY[status] > TERMINAL_STATUS_PRIORITY[best]) {
      best = status;
    }
  }
  return best;
}

export function selectTerminalSplitLeftTabId(
  tabs: TerminalTab[],
  activeTabId: string | null,
  rightTabId: string | null,
): string | null {
  if (activeTabId && activeTabId !== rightTabId) {
    const active = tabs.find((tab) => tab.id === activeTabId);
    if (active) return active.id;
  }
  return tabs.find((tab) => tab.id !== rightTabId)?.id ?? null;
}

export function getTerminalSplitPaneTabs(
  tabs: TerminalTab[],
  activeTabId: string | null,
  rightTabId: string | null,
): TerminalSplitPaneTabs {
  const rightTab = rightTabId ? tabs.find((tab) => tab.id === rightTabId) ?? null : null;
  const leftActiveTabId = selectTerminalSplitLeftTabId(tabs, activeTabId, rightTab?.id ?? null);
  return {
    leftTabs: rightTab ? tabs.filter((tab) => tab.id !== rightTab.id) : tabs,
    rightTabs: rightTab ? [rightTab] : [],
    leftActiveTabId,
    rightActiveTabId: rightTab?.id ?? null,
  };
}

export function shouldCloseTerminalSplitAfterTabClose(
  tabs: TerminalTab[],
  splitOpen: boolean,
  rightTabId: string | null,
  closingTabId: string,
): boolean {
  if (!splitOpen) return false;
  const remainingTabs = tabs.filter((tab) => tab.id !== closingTabId);
  return rightTabId === closingTabId || remainingTabs.length < 2;
}

export function terminalCommandPreview(kind: TerminalKind, cwd: string): string {
  const displayCwd = cwd.trim() || ".";
  switch (kind) {
    case "claude":
      return "claude";
    case "codex":
      return `codex --cd ${quoteShellToken(displayCwd)}`;
    case "shell":
      return "shell";
  }
}

export function shouldAutoLaunchTerminal(
  settings: AnchorSettings,
  open: boolean,
  tabCount: number,
): TerminalKind | null {
  if (!open || tabCount > 0) return null;
  const launcher = settings.terminal.autoLaunch;
  if (!launcher) return null;
  return settings.terminal.launchers[launcher]?.enabled ? launcher : null;
}

function quoteShellToken(value: string): string {
  if (/^[A-Za-z0-9_./:-]+$/.test(value)) return value;
  return `'${value.replace(/'/g, "'\\''")}'`;
}

// ---------------------------------------------------------------------------
// Persistence: tasks + relaunchable sessions across app restarts
// ---------------------------------------------------------------------------

export interface PersistedTerminalTask {
  id: string;
  name: string;
  cwd: string | null;
  contextLabel: string | null;
  createdAt: number;
}

export interface PersistedTerminalSession {
  taskId: string;
  kind: TerminalKind;
  title: string;
  cwd: string | null;
  agentSessionId: string | null;
}

export interface PersistedTerminalState {
  version: 1;
  tasks: PersistedTerminalTask[];
  sessions: PersistedTerminalSession[];
}

const VALID_KINDS: ReadonlySet<string> = new Set(["claude", "codex", "shell"]);

/** Extract the durable task + session metadata (no live PTY/handle state). */
export function serializeTerminalState(state: TerminalTabsState): PersistedTerminalState {
  return {
    version: 1,
    tasks: state.tasks.map((task) => ({
      id: task.id,
      name: task.name,
      cwd: task.cwd,
      contextLabel: task.contextLabel,
      createdAt: task.createdAt,
    })),
    sessions: state.tabs
      .filter((tab) => tab.taskId)
      .map((tab) => ({
        taskId: tab.taskId as string,
        kind: tab.kind,
        title: tab.title,
        cwd: tab.cwd,
        agentSessionId: tab.agentSessionId,
      })),
  };
}

/**
 * Rebuild a tab state from persisted metadata. Sessions come back as exited,
 * relaunchable placeholders (no live sessionId) — PTYs cannot survive a quit.
 */
export function hydrateTerminalStateFromPersisted(
  persisted: unknown,
): TerminalTabsState {
  if (!persisted || typeof persisted !== "object") return EMPTY_TERMINAL_STATE;
  const record = persisted as Partial<PersistedTerminalState>;
  if (!Array.isArray(record.tasks)) return EMPTY_TERMINAL_STATE;
  const tasks: TerminalTask[] = record.tasks
    .filter((task): task is PersistedTerminalTask =>
      Boolean(task && typeof task.id === "string" && typeof task.name === "string"),
    )
    .map((task) => ({
      id: task.id,
      name: task.name,
      cwd: typeof task.cwd === "string" ? task.cwd : null,
      contextLabel: typeof task.contextLabel === "string" ? task.contextLabel : null,
      createdAt: typeof task.createdAt === "number" ? task.createdAt : 0,
    }));
  if (tasks.length === 0) return EMPTY_TERMINAL_STATE;
  const taskIds = new Set(tasks.map((task) => task.id));
  const sessions = Array.isArray(record.sessions) ? record.sessions : [];
  let index = 0;
  const tabs: TerminalTab[] = sessions
    .filter(
      (session): session is PersistedTerminalSession =>
        Boolean(
          session &&
            typeof session.taskId === "string" &&
            taskIds.has(session.taskId) &&
            VALID_KINDS.has(session.kind),
        ),
    )
    .map((session) => ({
      ...createTerminalTab(`restored-${index++}`, session.kind, session.title, {
        taskId: session.taskId,
        cwd: typeof session.cwd === "string" ? session.cwd : null,
      }),
      running: false,
      exitCode: null,
      agentSessionId:
        typeof session.agentSessionId === "string" ? session.agentSessionId : null,
    }));
  const activeTaskId = tasks[0]?.id ?? null;
  const activeTabId = tabs.find((tab) => tab.taskId === activeTaskId)?.id ?? null;
  return { tasks, tabs, activeTaskId, activeTabId };
}

/** Native resume args for an agent CLI given a captured session id. */
export function buildAgentResumeArgs(
  kind: TerminalKind,
  agentSessionId: string | null,
): string[] {
  if (!agentSessionId) return [];
  // claude: `claude --resume <id>`. codex: `codex resume <id>` (subcommand).
  if (kind === "claude") return ["--resume", agentSessionId];
  if (kind === "codex") return ["resume", agentSessionId];
  return [];
}

/** A hydrated, not-yet-running placeholder the user can relaunch/resume. */
export function isRelaunchableTab(tab: TerminalTab): boolean {
  return !tab.running && tab.sessionId === null;
}

/**
 * Map a hook event token (emitted by `anchor-cli terminal-hook --event <token>`)
 * to a precise agent status. The hook installer translates each agent's native
 * lifecycle events into these canonical tokens, so the mapping is version-robust.
 * Unknown tokens return null (no status change).
 */
export function terminalHookEventToStatus(token: string): AgentStatus | null {
  const normalized = token.trim().toLowerCase();
  switch (normalized) {
    case "running":
    case "start":
    case "active":
      return "running";
    case "needs-input":
    case "needs_input":
    case "notification":
    case "waiting":
    case "approval":
      return "needs-input";
    case "done":
    case "stop":
    case "idle":
    case "complete":
      return "done";
    default:
      return null;
  }
}

// ---------------------------------------------------------------------------
// Active-item context bridge (env + --add-dir + @file mention)
// ---------------------------------------------------------------------------

export type AttachMentionStyle = TerminalAttachMentionStyle;

/** The Anchor active window/item, fed to CLI agents as context. */
export interface ActiveTerminalContext {
  workspaceRoot: string | null;
  workspaceVisibility: "private" | "public";
  appMode: AnchorAppMode;
  docAbsPath: string | null;
  docRelPath: string | null;
  docTitle: string | null;
  docType: string | null;
}

function applyActiveContextEnv(
  env: Record<string, string>,
  ctx: ActiveTerminalContext,
  enabled: boolean,
): Record<string, string> {
  if (!enabled) return env;
  if (ctx.workspaceRoot) env.ANCHOR_WORKSPACE = ctx.workspaceRoot;
  env.ANCHOR_WORKSPACE_VISIBILITY = ctx.workspaceVisibility;
  env.ANCHOR_APP_MODE = ctx.appMode;
  if (ctx.docAbsPath) env.ANCHOR_ACTIVE_DOC = ctx.docAbsPath;
  if (ctx.docRelPath) env.ANCHOR_ACTIVE_DOC_REL = ctx.docRelPath;
  if (ctx.docTitle) env.ANCHOR_ACTIVE_DOC_TITLE = ctx.docTitle;
  if (ctx.docType) env.ANCHOR_ACTIVE_DOC_TYPE = ctx.docType;
  return env;
}

/**
 * Environment variables injected into every Anchor-spawned PTY (cmux pattern).
 * Item-dependent keys are omitted (not set to "") so agents can test `-n "$VAR"`.
 * When `enabled` is false only the safe markers are returned.
 */
export function buildAnchorContextEnv(
  ctx: ActiveTerminalContext,
  sessionId: string,
  enabled: boolean,
): Record<string, string> {
  const env: Record<string, string> = {
    ANCHOR_TERMINAL: "1",
    ANCHOR_SESSION_ID: sessionId,
  };
  return applyActiveContextEnv(env, ctx, enabled);
}

/**
 * Environment variables for non-PTY background agent runs. These carry the
 * same active item context but deliberately omit terminal hook markers.
 */
export function buildAnchorBackgroundContextEnv(
  ctx: ActiveTerminalContext,
  enabled: boolean,
): Record<string, string> {
  return applyActiveContextEnv({}, ctx, enabled);
}

/** `--add-dir <workspace>` for claude/codex so the agent can read the tree. */
export function buildAgentContextArgs(
  kind: TerminalKind,
  ctx: ActiveTerminalContext,
  enabled: boolean,
): string[] {
  if (!enabled) return [];
  if (kind !== "claude" && kind !== "codex") return [];
  if (!ctx.workspaceRoot) return [];
  return ["--add-dir", ctx.workspaceRoot];
}

function quoteIfNeeded(value: string): string {
  if (/^[A-Za-z0-9_./:@-]+$/.test(value)) return value;
  return `"${value.replace(/(["\\$`])/g, "\\$1")}"`;
}

/** Build the file reference to insert into a focused agent REPL (no submit). */
export function pathMention(
  relPath: string | null,
  absPath: string | null,
  style: AttachMentionStyle,
): string | null {
  const rel = relPath?.trim() || null;
  const abs = absPath?.trim() || null;
  if (!rel && !abs) return null;
  if (style === "mention" && rel) return `@${rel} `;
  // Fall back to an absolute path when no rel path is available or path/read styles.
  const target = abs ?? rel!;
  if (style === "read") return `Read this file: ${quoteIfNeeded(target)} `;
  return `${quoteIfNeeded(target)} `;
}

/** The active item as an agent mention, or null when there is no active item. */
export function activeItemMention(
  ctx: ActiveTerminalContext,
  style: AttachMentionStyle,
): string | null {
  return pathMention(ctx.docRelPath, ctx.docAbsPath, style);
}

export interface ContextChipDescriptor {
  label: string;
  title: string;
  enabled: boolean;
}

/** Header chip describing the attachable active item and whether attach is live. */
export function describeActiveContextChip(
  ctx: ActiveTerminalContext,
  options: { focusedKind: TerminalKind | null },
): ContextChipDescriptor {
  const isAgent = options.focusedKind === "claude" || options.focusedKind === "codex";
  const hasItem = Boolean(ctx.docTitle || ctx.docRelPath || ctx.docAbsPath);
  const label = hasItem
    ? ctx.docTitle || ctx.docRelPath || ctx.docAbsPath || ctx.appMode
    : ctx.appMode;
  const title = hasItem
    ? ctx.docAbsPath || ctx.docRelPath || label
    : `${ctx.appMode} · no active item`;
  return { label, title, enabled: isAgent && hasItem };
}
