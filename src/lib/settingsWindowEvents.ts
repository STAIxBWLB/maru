export const SETTINGS_WINDOW_OPEN_TAB_EVENT = "settings://open-tab";
export const SETTINGS_WINDOW_TERMINAL_LAUNCH_EVENT = "settings://terminal-launch";

export interface SettingsWindowOpenTabPayload {
  tab: string;
}

export interface SettingsWindowTerminalLaunchPayload {
  command: string | null;
  args: string[];
  cwd: string | null;
}
