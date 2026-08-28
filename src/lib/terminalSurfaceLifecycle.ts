import { useEffect } from "react";

import type { MaruSettings } from "./settings";
import type { ActiveTerminalContext } from "./terminal";
import { setTerminalPanelActiveContext, setTerminalPanelLayout } from "./terminalPanelStore";

/**
 * Owns the projection from canonical shell settings and the current document
 * context into the persistent terminal surface. Terminal state remains in its
 * dedicated store; this bridge never snapshots mutable runtime objects.
 */
export function useTerminalSurfaceLifecycle(
  activeContext: ActiveTerminalContext,
  settings: MaruSettings,
): void {
  useEffect(() => {
    setTerminalPanelActiveContext(activeContext);
    setTerminalPanelLayout({
      open: settings.ui.layout.terminalOpen,
      height: settings.ui.layout.terminalHeight,
      dock: settings.ui.layout.terminalDock,
      width: settings.ui.layout.terminalWidth,
      splitOpen: settings.ui.layout.terminalSplitOpen,
      splitRatio: settings.ui.layout.terminalSplitRatio,
      maximized: settings.ui.layout.terminalMaximized,
      activeSurface: settings.ui.layout.toolPanelSurface,
      terminalTheme: settings.terminal.theme,
      graphTheme: settings.graph.display.theme,
    });
  }, [activeContext, settings]);
}
