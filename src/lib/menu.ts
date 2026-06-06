export const MENU_COMMAND_EVENT = "anchor://menu-command";

export interface MenuPoint {
  x: number;
  y: number;
}

export interface MenuSize {
  width: number;
  height: number;
}

export interface MenuViewport {
  width: number;
  height: number;
}

declare global {
  interface Window {
    __TAURI_INTERNALS__?: unknown;
  }
}

function menuAvailable(): boolean {
  return typeof window !== "undefined" && Boolean(window.__TAURI_INTERNALS__);
}

export function clampMenuPosition(
  point: MenuPoint,
  size: MenuSize,
  viewport: MenuViewport,
  margin = 8,
): MenuPoint {
  const minX = margin;
  const minY = margin;
  const maxX = Math.max(minX, viewport.width - size.width - margin);
  const maxY = Math.max(minY, viewport.height - size.height - margin);

  return {
    x: Math.min(Math.max(point.x, minX), maxX),
    y: Math.min(Math.max(point.y, minY), maxY),
  };
}

export async function listenForMenuCommand(
  handler: (id: string) => void,
): Promise<() => void> {
  if (!menuAvailable()) return () => {};
  const { listen } = await import("@tauri-apps/api/event");
  return listen<string>(MENU_COMMAND_EVENT, (event) => handler(event.payload));
}
