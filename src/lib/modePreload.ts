import {
  getModeDescriptor,
  getRegisteredModeIds,
} from "./modeRegistry";
import { scheduleStartupIdle } from "./startupProfile";

/**
 * Idle-time preload of every registered mode's lazy chunk.
 *
 * D-03 locked decision: preload runs only during browser idle time (never on
 * hover/focus), so first activation only pays the Suspense boundary cost.
 * Vite's cssCodeSplit ships each mode's lazy CSS inside its JS chunk, so the
 * mode stylesheet lands with the module it styles.
 *
 * One mode per idle callback: the next chunk is requested only after the
 * previous one settled and the browser is idle again, so warming ~3 MB of
 * mode JS never competes with bootstrap or user input in one burst.
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
export function scheduleModePreload(): () => void {
  const queue = [...getRegisteredModeIds()];
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
