/**
 * Diagram-mode availability flag.
 *
 * Phase 7 (after the real-world bake of Phases 0–6) flips the default to
 * **enabled**. The same three signals still exist but are now interpreted as
 * opt-OUT — any of them set to `0`/`false` hides the activity-rail icon and
 * routes attempts back to `pkm`:
 *
 *   1. `VITE_ANCHOR_DIAGRAM=0` (build/env)
 *   2. `?anchor-diagram=0` (URL query)
 *   3. `localStorage["anchor:diagram:enabled"] = "0"` (in-app toggle)
 *
 * Anything else — including unset — leaves the feature on. The Settings →
 * Preferences → "Diagram mode" checkbox writes to the localStorage key.
 */

declare global {
  interface Window {
    __TAURI_INTERNALS__?: unknown;
  }
}

export const DIAGRAM_ENABLE_STORAGE_KEY = "anchor:diagram:enabled";

function isOptOut(value: unknown): boolean {
  return value === "0" || value === "false" || value === 0 || value === false;
}

export function isDiagramEnabled(): boolean {
  const env = (import.meta as ImportMeta & { env?: Record<string, unknown> }).env;
  if (isOptOut(env?.VITE_ANCHOR_DIAGRAM)) return false;

  if (typeof window === "undefined") return true;

  const params = new URLSearchParams(window.location.search);
  if (isOptOut(params.get("anchor-diagram"))) return false;

  try {
    if (isOptOut(window.localStorage.getItem(DIAGRAM_ENABLE_STORAGE_KEY))) return false;
  } catch {
    /* ignore — fall through to default */
  }
  return true;
}
