import type { AnchorSettings, TerminalLauncherId } from "./settings";

export type TerminalKind = TerminalLauncherId;

export interface TerminalTab {
  id: string;
  kind: TerminalKind;
  title: string;
  sessionId: string | null;
  running: boolean;
  exitCode: number | null;
}

export interface TerminalTabsState {
  tabs: TerminalTab[];
  activeTabId: string | null;
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
  | { type: "close"; tabId: string };

export const TERMINAL_LAUNCHERS: Array<{
  id: TerminalKind;
  titleKey: string;
}> = [
  { id: "claude", titleKey: "terminal.launcher.claude" },
  { id: "codex", titleKey: "terminal.launcher.codex" },
  { id: "shell", titleKey: "terminal.launcher.shell" },
];

export const TERMINAL_SHIFT_ENTER_DATA = "\x1b[13;2u";

type TerminalKeyboardEvent = Pick<
  KeyboardEvent,
  "type" | "key" | "shiftKey" | "metaKey" | "ctrlKey" | "altKey"
>;

export function terminalShiftEnterData(
  kind: TerminalKind,
  event: TerminalKeyboardEvent,
): string | null {
  if (kind !== "claude" && kind !== "codex") return null;
  if (event.type !== "keydown") return null;
  if (event.key !== "Enter") return null;
  if (!event.shiftKey || event.metaKey || event.ctrlKey || event.altKey) return null;
  return TERMINAL_SHIFT_ENTER_DATA;
}

export const EMPTY_TERMINAL_STATE: TerminalTabsState = {
  tabs: [],
  activeTabId: null,
};

export function createTerminalTab(
  id: string,
  kind: TerminalKind,
  title: string,
): TerminalTab {
  return {
    id,
    kind,
    title,
    sessionId: null,
    running: true,
    exitCode: null,
  };
}

export function terminalTabsReducer(
  state: TerminalTabsState,
  action: TerminalTabsAction,
): TerminalTabsState {
  switch (action.type) {
    case "create":
      return {
        tabs: [...state.tabs, action.tab],
        activeTabId: action.activate === false ? state.activeTabId ?? action.tab.id : action.tab.id,
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
            ? { ...tab, running: false, exitCode: action.exitCode }
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
    case "close": {
      const closingIndex = state.tabs.findIndex((tab) => tab.id === action.tabId);
      if (closingIndex === -1) return state;
      const tabs = state.tabs.filter((tab) => tab.id !== action.tabId);
      if (state.activeTabId !== action.tabId) return { ...state, tabs };
      const fallback = tabs[Math.min(closingIndex, tabs.length - 1)] ?? null;
      return { tabs, activeTabId: fallback?.id ?? null };
    }
  }
}

export function selectTerminalSplitLeftTabId(
  state: TerminalTabsState,
  rightTabId: string | null,
): string | null {
  if (state.activeTabId && state.activeTabId !== rightTabId) {
    const active = state.tabs.find((tab) => tab.id === state.activeTabId);
    if (active) return active.id;
  }
  return state.tabs.find((tab) => tab.id !== rightTabId)?.id ?? null;
}

export function getTerminalSplitPaneTabs(
  state: TerminalTabsState,
  rightTabId: string | null,
): TerminalSplitPaneTabs {
  const rightTab = rightTabId ? state.tabs.find((tab) => tab.id === rightTabId) ?? null : null;
  const leftActiveTabId = selectTerminalSplitLeftTabId(state, rightTab?.id ?? null);
  return {
    leftTabs: rightTab ? state.tabs.filter((tab) => tab.id !== rightTab.id) : state.tabs,
    rightTabs: rightTab ? [rightTab] : [],
    leftActiveTabId,
    rightActiveTabId: rightTab?.id ?? null,
  };
}

export function shouldCloseTerminalSplitAfterTabClose(
  state: TerminalTabsState,
  splitOpen: boolean,
  rightTabId: string | null,
  closingTabId: string,
): boolean {
  if (!splitOpen) return false;
  const remainingTabs = state.tabs.filter((tab) => tab.id !== closingTabId);
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
