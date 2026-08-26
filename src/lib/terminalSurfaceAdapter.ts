import type { TerminalLaunchRequest } from "../components/TerminalPanel";
import type { MaruSettings, TerminalDock, TerminalTheme, ToolPanelSurface } from "./settings";

/** A narrow shell port: the terminal can request retained panel mutations but
 * never receives a broad App state object or calls settings/Tauri directly. */
export interface TerminalPanelCommands {
  getSettings(): MaruSettings;
  onOpenChange(open: boolean): void;
  onHeightChange(height: number): void;
  onDockChange(dock: TerminalDock): void;
  onWidthChange(width: number): void;
  onSplitOpenChange(open: boolean): void;
  onSplitRatioChange(ratio: number): void;
  onMaximizedChange(maximized: boolean): void;
  onSurfaceChange(surface: ToolPanelSurface): void;
  onTerminalThemeChange(theme: TerminalTheme): void;
  onGraphThemeChange(theme: "dark" | "light" | "app"): void;
}

export interface CreateTerminalPanelCommandsOptions extends TerminalPanelCommands {}

export function createTerminalPanelCommands(
  options: CreateTerminalPanelCommandsOptions,
): TerminalPanelCommands {
  return {
    getSettings: () => options.getSettings(),
    onOpenChange: (open) => options.onOpenChange(open),
    onHeightChange: (height) => options.onHeightChange(height),
    onDockChange: (dock) => options.onDockChange(dock),
    onWidthChange: (width) => options.onWidthChange(width),
    onSplitOpenChange: (open) => options.onSplitOpenChange(open),
    onSplitRatioChange: (ratio) => options.onSplitRatioChange(ratio),
    onMaximizedChange: (maximized) => options.onMaximizedChange(maximized),
    onSurfaceChange: (surface) => options.onSurfaceChange(surface),
    onTerminalThemeChange: (theme) => options.onTerminalThemeChange(theme),
    onGraphThemeChange: (theme) => options.onGraphThemeChange(theme),
  };
}

export type TerminalLaunchCommand = Pick<TerminalLaunchRequest, "kind" | "nonce">;
