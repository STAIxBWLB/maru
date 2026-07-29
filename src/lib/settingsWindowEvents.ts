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

/** Emit a terminal launch request for the main window. The only listener (and
 *  the terminal itself) lives in the main window, so bring it forward first —
 *  emitting with no listener would silently drop the launch. Returns false
 *  when the main window is gone and the launch cannot be delivered. */
export async function emitSettingsTerminalLaunch(
  payload: SettingsWindowTerminalLaunchPayload,
): Promise<boolean> {
  try {
    const { WebviewWindow } = await import("@tauri-apps/api/webviewWindow");
    const mainWindow = await WebviewWindow.getByLabel("main");
    if (!mainWindow) return false;
    try {
      await mainWindow.show();
      await mainWindow.unminimize();
      await mainWindow.setFocus();
    } catch {
      // Focusing is best-effort; the emit below still reaches the listener.
    }
    const { emit } = await import("@tauri-apps/api/event");
    await emit(SETTINGS_WINDOW_TERMINAL_LAUNCH_EVENT, payload);
    return true;
  } catch {
    // Browser dev shell: no Tauri event bus.
    return true;
  }
}
