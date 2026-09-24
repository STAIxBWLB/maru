// Visibility of the surface a GraphView is rendered into. The tool panel keeps
// the graph mounted across surface toggles (layout state survives), so the
// graph subtree needs a signal to stop layout work and, after a grace period,
// release its Sigma renderer / WebGL contexts / FA2 worker while hidden.
// Primary/right placements never provide the context and read `true`.
import { createContext, useContext, useEffect, useState } from "react";

export const GraphSurfaceVisibilityContext = createContext(true);

export function useGraphSurfaceVisible(): boolean {
  return useContext(GraphSurfaceVisibilityContext);
}

/** Bounded grace before a hidden graph releases its renderer (#327). */
export const GRAPH_SUSPEND_GRACE_MS = 30_000;
const GRACE_OVERRIDE_KEY = "maru:graph-suspend-grace-ms";

/** Grace period, with a localStorage override so e2e can exercise suspension. */
export function graphSuspendGraceMs(): number {
  try {
    const raw = window.localStorage.getItem(GRACE_OVERRIDE_KEY);
    const parsed = raw === null ? NaN : Number.parseInt(raw, 10);
    return Number.isFinite(parsed) && parsed >= 0 ? parsed : GRAPH_SUSPEND_GRACE_MS;
  } catch {
    return GRAPH_SUSPEND_GRACE_MS;
  }
}

/** Whether the tool panel should keep its graph node mounted. Closing the
 *  panel always unmounts, even while Graph is the selected surface. */
export function graphPanelMounted(prev: boolean, open: boolean, activeSurface: string): boolean {
  if (!open) return false;
  return prev || activeSurface === "graph";
}

/** True once `hidden` has held for `graceMs`; false immediately on reveal. */
export function useSuspendedAfter(hidden: boolean, graceMs: number): boolean {
  const [suspended, setSuspended] = useState(false);
  useEffect(() => {
    if (!hidden) {
      setSuspended(false);
      return;
    }
    const timer = window.setTimeout(() => setSuspended(true), graceMs);
    return () => window.clearTimeout(timer);
  }, [hidden, graceMs]);
  return suspended;
}
