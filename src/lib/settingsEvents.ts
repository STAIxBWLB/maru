export const SETTINGS_TERMINAL_LAUNCH_EVENT = "settings://terminal-launch";

export interface SettingsTerminalLaunchPayload {
  command: string | null;
  args: string[];
  cwd: string | null;
}

/** Emit a terminal launch request. Settings lives inside the main window,
 *  so a plain same-window emit reaches the listener in MainApp. Returns false
 *  only if the emit itself throws outside the browser dev shell. */
export async function emitSettingsTerminalLaunch(
  payload: SettingsTerminalLaunchPayload,
): Promise<boolean> {
  try {
    const { emit } = await import("@tauri-apps/api/event");
    await emit(SETTINGS_TERMINAL_LAUNCH_EVENT, payload);
    return true;
  } catch {
    // Browser dev shell: no Tauri event bus.
    return true;
  }
}
