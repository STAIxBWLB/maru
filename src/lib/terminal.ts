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

export function terminalCommandPreview(kind: TerminalKind, cwd: string): string {
  const displayCwd = cwd.trim() || ".";
  switch (kind) {
    case "claude":
      return "claude";
    case "codex":
      return `codex --cd ${quoteShellToken(displayCwd)}`;
    case "shell":
      return "$SHELL";
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
