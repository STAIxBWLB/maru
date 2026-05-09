import type { AnchorSettings, LayoutSettings } from "./settings";
import {
  SETTINGS_WINDOW_OPEN_TAB_EVENT,
  type SettingsWindowOpenTabPayload,
} from "./settingsWindowEvents";
import { SKILL_EDITOR_OPEN_EVENT, type SkillEditorOpenPayload } from "./skillEditorEvents";

type LayoutPatch = Partial<AnchorSettings["ui"]["layout"]>;

export function tauriAvailable(): boolean {
  return typeof window !== "undefined" && Boolean(window.__TAURI_INTERNALS__);
}

export async function openSettingsWindow(workPath: string | null, tab?: string): Promise<void> {
  if (!tauriAvailable()) {
    throw new Error("Settings window requires the Tauri app.");
  }
  const { WebviewWindow } = await import("@tauri-apps/api/webviewWindow");
  const existing = await WebviewWindow.getByLabel("settings");
  if (existing) {
    await existing.setFocus();
    if (tab) {
      const { emitTo } = await import("@tauri-apps/api/event");
      const payload: SettingsWindowOpenTabPayload = { tab };
      await emitTo("settings", SETTINGS_WINDOW_OPEN_TAB_EVENT, payload);
    }
    return;
  }

  const params = new URLSearchParams({ window: "settings" });
  if (workPath) params.set("workPath", workPath);
  if (tab) params.set("tab", tab);
  const settingsWindow = new WebviewWindow("settings", {
    url: `/?${params.toString()}`,
    title: "Anchor Settings",
    width: 980,
    height: 720,
    minWidth: 760,
    minHeight: 560,
    resizable: true,
    focus: true,
  });
  await new Promise<void>((resolve, reject) => {
    void settingsWindow.once("tauri://created", () => resolve());
    void settingsWindow.once("tauri://error", (event) => reject(event.payload));
  });
}

export async function openSkillEditorWindow(
  workPath: string | null,
  skillId: string,
): Promise<void> {
  if (!tauriAvailable()) {
    throw new Error("Skill editor requires the Tauri app.");
  }
  const { WebviewWindow } = await import("@tauri-apps/api/webviewWindow");
  const { emitTo } = await import("@tauri-apps/api/event");
  const payload: SkillEditorOpenPayload = { workPath, skillId };
  const existing = await WebviewWindow.getByLabel("skill-editor");
  if (existing) {
    await existing.setFocus();
    await emitTo("skill-editor", SKILL_EDITOR_OPEN_EVENT, payload);
    return;
  }

  const params = new URLSearchParams({ window: "skill-editor", skillId });
  if (workPath) params.set("workPath", workPath);
  const editorWindow = new WebviewWindow("skill-editor", {
    url: `/?${params.toString()}`,
    title: "Skill Editor",
    width: 880,
    height: 760,
    minWidth: 640,
    minHeight: 520,
    resizable: true,
    focus: true,
  });
  await new Promise<void>((resolve, reject) => {
    void editorWindow.once("tauri://created", () => resolve());
    void editorWindow.once("tauri://error", (event) => reject(event.payload));
  });
}

export async function startWindowDrag(): Promise<void> {
  if (!tauriAvailable()) return;
  const { getCurrentWindow } = await import("@tauri-apps/api/window");
  await getCurrentWindow().startDragging();
}

export async function restoreMainWindowLayout(layout: LayoutSettings): Promise<void> {
  if (!tauriAvailable()) return;
  const { getCurrentWindow, availableMonitors } = await import("@tauri-apps/api/window");
  const { PhysicalPosition, PhysicalSize } = await import("@tauri-apps/api/dpi");
  const appWindow = getCurrentWindow();
  if (appWindow.label !== "main") return;

  if (layout.windowBounds) {
    const monitors = await availableMonitors();
    if (isBoundsVisible(layout.windowBounds, monitors)) {
      await appWindow.setSize(
        new PhysicalSize(layout.windowBounds.width, layout.windowBounds.height),
      );
      await appWindow.setPosition(
        new PhysicalPosition(layout.windowBounds.x, layout.windowBounds.y),
      );
    }
  }

  if (layout.windowMaximized === true) {
    await appWindow.maximize();
  }
}

export async function subscribeMainWindowLayout(
  onPatch: (patch: LayoutPatch) => void,
): Promise<() => void> {
  if (!tauriAvailable()) return () => {};
  const { getCurrentWindow } = await import("@tauri-apps/api/window");
  const appWindow = getCurrentWindow();
  if (appWindow.label !== "main") return () => {};

  let timer = 0;
  const captureNow = () =>
    Promise.all([
      appWindow.outerPosition(),
      appWindow.outerSize(),
      appWindow.isMaximized(),
    ])
      .then(([position, size, maximized]) => {
        onPatch({
          windowBounds: {
            x: Math.round(position.x),
            y: Math.round(position.y),
            width: Math.round(size.width),
            height: Math.round(size.height),
          },
          windowMaximized: maximized,
        });
      })
      .catch(() => {});
  const capture = () => {
    if (timer) window.clearTimeout(timer);
    timer = window.setTimeout(() => {
      timer = 0;
      void captureNow();
    }, 250);
  };

  const offResize = await appWindow.onResized(capture);
  const offMove = await appWindow.onMoved(capture);
  return () => {
    if (timer) window.clearTimeout(timer);
    offResize();
    offMove();
  };
}

function isBoundsVisible(
  bounds: NonNullable<LayoutSettings["windowBounds"]>,
  monitors: Array<{
    workArea: { position: { x: number; y: number }; size: { width: number; height: number } };
  }>,
): boolean {
  if (monitors.length === 0) return true;
  const probeX = bounds.x + Math.min(80, Math.max(1, bounds.width / 2));
  const probeY = bounds.y + Math.min(80, Math.max(1, bounds.height / 2));
  return monitors.some((monitor) => {
    const area = monitor.workArea;
    return (
      probeX >= area.position.x &&
      probeY >= area.position.y &&
      probeX <= area.position.x + area.size.width &&
      probeY <= area.position.y + area.size.height
    );
  });
}
