import type { MaruSettings, LayoutSettings } from "./settings";
import {
  SKILL_EDITOR_OPEN_EVENT,
  SKILL_EDITOR_QUIT_CHECK_ACK_EVENT,
  SKILL_EDITOR_QUIT_CHECK_EVENT,
  SKILL_EDITOR_QUIT_CHECK_RESPONSE_EVENT,
  type SkillEditorOpenPayload,
  type SkillEditorQuitCheckResponse,
} from "./skillEditorEvents";

type LayoutPatch = Partial<MaruSettings["ui"]["layout"]>;

const SKILL_EDITOR_LABEL = "skill-editor";

/** Review finding #2, round 2: how long requestSkillEditorQuitCheck waits for
 * the skill editor's ack before assuming its listener never registered (the
 * window was created but its React content is still loading). Its textarea
 * stays disabled and text===base until load completes, so it provably cannot
 * hold a dirty edit during that window — safe to treat a missing ack as
 * approved. Once an ack arrives, there is no further timeout: the user may be
 * looking at a real confirm dialog for as long as they like. */
export const SKILL_EDITOR_QUIT_CHECK_ACK_TIMEOUT_MS = 1500;

export function tauriAvailable(): boolean {
  return typeof window !== "undefined" && Boolean(window.__TAURI_INTERNALS__);
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
  const existing = await WebviewWindow.getByLabel(SKILL_EDITOR_LABEL);
  if (existing) {
    await existing.setFocus();
    await emitTo(SKILL_EDITOR_LABEL, SKILL_EDITOR_OPEN_EVENT, payload);
    return;
  }

  const params = new URLSearchParams({ window: "skill-editor", skillId });
  if (workPath) params.set("workPath", workPath);
  const editorWindow = new WebviewWindow(SKILL_EDITOR_LABEL, {
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

/**
 * Review finding #2: asks the skill editor window (if open) whether it is
 * clear to quit, without destroying it. Resolves `true` immediately when the
 * window isn't open. The skill editor answers through its own dirty-draft
 * guard; a `false` here means the user cancelled that guard and the whole
 * quit must be aborted, killing nothing.
 *
 * Round 2 (review finding #2, owner-observed regression): a Cmd+Q pressed
 * while the skill editor window exists but its React content is still
 * loading used to hang this promise forever, since no listener had
 * registered yet to answer SKILL_EDITOR_QUIT_CHECK_EVENT — main never
 * finished quitting, orphaning the editor and leaving every later Cmd+Q
 * routed to a now-destroyed "main" label. A two-phase handshake fixes this:
 * the skill editor acks the instant its listener receives the request,
 * before any dirty check; a missing ack within SKILL_EDITOR_QUIT_CHECK_
 * ACK_TIMEOUT_MS means the listener was never there to hear it, which is
 * safe to treat as approved (see the constant's doc comment for why). Once
 * an ack lands, this function waits indefinitely for the real response —
 * the user may be looking at a genuine confirm dialog.
 */
export async function requestSkillEditorQuitCheck(): Promise<boolean> {
  if (!tauriAvailable()) return true;
  const { WebviewWindow } = await import("@tauri-apps/api/webviewWindow");
  const editorWindow = await WebviewWindow.getByLabel(SKILL_EDITOR_LABEL);
  if (!editorWindow) return true;
  const { listen, emitTo } = await import("@tauri-apps/api/event");
  return new Promise<boolean>((resolve) => {
    let settled = false;
    let ackReceived = false;
    let unlistenResponse: (() => void) | null = null;
    let unlistenAck: (() => void) | null = null;
    let ackTimer: ReturnType<typeof setTimeout> | null = null;
    const clearAckTimer = () => {
      if (ackTimer) {
        clearTimeout(ackTimer);
        ackTimer = null;
      }
    };
    const finish = (proceed: boolean) => {
      if (settled) return;
      settled = true;
      clearAckTimer();
      unlistenResponse?.();
      unlistenAck?.();
      resolve(proceed);
    };
    void Promise.all([
      listen<SkillEditorQuitCheckResponse>(SKILL_EDITOR_QUIT_CHECK_RESPONSE_EVENT, (event) =>
        finish(event.payload.proceed),
      ),
      listen(SKILL_EDITOR_QUIT_CHECK_ACK_EVENT, () => {
        ackReceived = true;
        clearAckTimer();
      }),
    ])
      .then(([offResponse, offAck]) => {
        if (settled) {
          offResponse();
          offAck();
          return;
        }
        unlistenResponse = offResponse;
        unlistenAck = offAck;
        ackTimer = setTimeout(() => {
          if (!ackReceived) finish(true);
        }, SKILL_EDITOR_QUIT_CHECK_ACK_TIMEOUT_MS);
        void emitTo(SKILL_EDITOR_LABEL, SKILL_EDITOR_QUIT_CHECK_EVENT, undefined).catch(() =>
          finish(false),
        );
      })
      .catch(() => finish(false));
  });
}

/**
 * Review finding #2: actually destroys the skill editor window. Called only
 * after both its own guard (requestSkillEditorQuitCheck) and main's own
 * dirty-draft guard have passed, as the last step of a whole-app quit — a
 * plain per-window close (red button, Cmd+W) never calls this.
 */
export async function closeSkillEditorForQuit(): Promise<void> {
  if (!tauriAvailable()) return;
  const { WebviewWindow } = await import("@tauri-apps/api/webviewWindow");
  const editorWindow = await WebviewWindow.getByLabel(SKILL_EDITOR_LABEL);
  await editorWindow?.destroy();
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
