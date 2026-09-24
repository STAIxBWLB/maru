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
 * mode stylesheet lands with the module it styles and the first-activation
 * FOUC window closes once the idle preload completes.
 *
 * The 2000ms timeout is intentionally above the helper's 1500ms default:
 * idle preload has no UI deadline, while the default is reserved for
 * startup-critical work. Individual load failures are swallowed so a single
 * broken chunk cannot produce an unhandled rejection.
 *
 * Returns the idle-cancel handle from `scheduleStartupIdle`.
 */
export function scheduleModePreload(): () => void {
  return scheduleStartupIdle(() => {
    for (const id of getRegisteredModeIds()) {
      const descriptor = getModeDescriptor(id);
      if (!descriptor || !descriptor.isAvailable()) continue;
      void descriptor.load().catch(() => {});
    }
  }, 2000);
}
