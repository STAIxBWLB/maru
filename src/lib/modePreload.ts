import { getModeDescriptor, type RegisteredModeId } from "./modeRegistry";
import { scheduleStartupIdle } from "./startupProfile";

/**
 * The modes whose CSS moved out of the entry stylesheet (phase 10); calendar
 * CSS rides the tasks and meetings chunks. D-03 as amended in #340: Studio,
 * Graph, Diagram and the rest load on first activation instead, since Vite
 * resolves a lazy mode only after its CSS lands and warming every mode costs
 * ~2.9 MB of evaluated JS for the whole session.
 */
export const PRELOAD_MODE_IDS = [
  "today",
  "tasks",
  "meetings",
  "drafts",
  "gap",
  "agents",
] as const satisfies readonly RegisteredModeId[];

/**
 * Idle-time preload of the PRELOAD_MODE_IDS lazy chunks.
 *
 * D-03: preload runs only during browser idle time (never on hover/focus), so
 * first activation of these modes only pays the Suspense boundary cost.
 * Vite's cssCodeSplit ships each mode's lazy CSS inside its JS chunk, so the
 * mode stylesheet lands with the module it styles.
 *
 * One mode per idle callback: the next chunk is requested only after the
 * previous one settled and the browser is idle again, so warming never
 * competes with bootstrap or user input in one burst.
 *
 * The first step waits up to 2000ms, above the helper's 1500ms default:
 * idle preload has no UI deadline, while the default is reserved for
 * startup-critical work. Where requestIdleCallback is missing (WKWebView) the
 * helper falls back to a plain timer, so later steps drop to 250ms there; a 2s
 * timer per mode would leave the last chunk cold for ~30s. Individual
 * load failures are swallowed so a single broken chunk cannot produce an
 * unhandled rejection or stop the queue.
 *
 * Returns a cancel handle that stops the remaining queue.
 */
export function scheduleModePreload(ids: readonly string[] = PRELOAD_MODE_IDS): () => void {
  const queue = [...ids];
  const stepTimeout = typeof window !== "undefined" && "requestIdleCallback" in window ? 2000 : 250;
  let cancelled = false;
  let cancelIdle = () => {};
  const step = () => {
    const descriptor = getModeDescriptor(queue.shift() ?? "");
    const warm = descriptor?.isAvailable() ? descriptor.load().catch(() => {}) : Promise.resolve();
    void warm.then(() => {
      if (!cancelled && queue.length > 0) cancelIdle = scheduleStartupIdle(step, stepTimeout);
    });
  };
  cancelIdle = scheduleStartupIdle(step, 2000);
  return () => {
    cancelled = true;
    cancelIdle();
  };
}
