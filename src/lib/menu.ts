export const MENU_COMMAND_EVENT = "anchor://menu-command";

declare global {
  interface Window {
    __TAURI_INTERNALS__?: unknown;
  }
}

function menuAvailable(): boolean {
  return typeof window !== "undefined" && Boolean(window.__TAURI_INTERNALS__);
}

export async function listenForMenuCommand(
  handler: (id: string) => void,
): Promise<() => void> {
  if (!menuAvailable()) return () => {};
  const { listen } = await import("@tauri-apps/api/event");
  return listen<string>(MENU_COMMAND_EVENT, (event) => handler(event.payload));
}
