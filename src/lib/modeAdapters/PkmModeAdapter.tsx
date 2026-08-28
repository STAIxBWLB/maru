import { useDocumentBrowserSlice } from "../documentBrowserStore";
import { useShellDocumentBrowserSlice } from "../shellSettingsStore";
import type { ModeAdapterProps } from "../modeRegistry";

/** Lazy adapter boundary for the Documents/editor workbench. */
export function PkmModeAdapter({ scope, commands }: ModeAdapterProps) {
  // Keep mode-local subscriptions outside MainApp. The rendered shell retains
  // its existing commands and DOM ownership while later plans finish moving
  // the editor split facade into this adapter.
  useDocumentBrowserSlice(scope.documentBrowserScope, "queryFilter");
  useShellDocumentBrowserSlice();
  return <>{commands.renderPrimarySurface()}</>;
}
