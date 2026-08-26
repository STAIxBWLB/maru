import { useEffect, useMemo, useState } from "react";

import { GraphView } from "../../components/graph/GraphView";
import { vaultGraphRoot } from "../api";
import type { ModeAdapterProps } from "../modeRegistry";
import { updateShellSettings, useShellSettings } from "../shellSettingsStore";
import { useGraphModeSlice, visualModeController } from "../visualModeStore";
import { useWorkspaceRegistry, useWorkspaceStates } from "../workspaceStore";

/** Dedicated lazy Graph surface shared by primary, right, and tool-panel placements. */
export function GraphModeAdapter({ scope, commands }: ModeAdapterProps) {
  const settings = useShellSettings();
  const workspaceRegistry = useWorkspaceRegistry();
  const workspaceStates = useWorkspaceStates();
  const graphSlice = useGraphModeSlice();
  const graphWorkspacePath = workspaceRegistry.activeByVisibility.private ?? scope.workspacePath;
  const [nestedVault, setNestedVault] = useState<{ workspace: string; root: string | null } | null>(null);

  useEffect(() => {
    if (!graphWorkspacePath) return;
    let cancelled = false;
    void vaultGraphRoot(graphWorkspacePath)
      .then((root) => {
        if (!cancelled) setNestedVault({ workspace: graphWorkspacePath, root });
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [graphWorkspacePath]);

  const graphVaultPath =
    (nestedVault?.workspace === graphWorkspacePath ? nestedVault.root : null) ??
    workspaceRegistry.activeByVisibility.public ??
    scope.workspacePath;
  const graphDataPath =
    settings.graph.source === "vault" ? graphVaultPath ?? scope.workspacePath : graphWorkspacePath ?? scope.workspacePath;
  const entries = graphDataPath ? workspaceStates[graphDataPath]?.entries ?? [] : [];
  const graphKey = useMemo(
    () => `${settings.graph.source}:${graphDataPath ?? "no-workspace"}`,
    [graphDataPath, settings.graph.source],
  );

  return (
    <GraphView
      key={graphKey}
      workspacePath={graphDataPath}
      entries={entries}
      focusTarget={graphSlice.focusTarget}
      onFocusTargetChange={visualModeController.setGraphFocusTarget}
      onOpenEntry={(entry) => commands.openGraphEntry?.(entry)}
      onCreateNote={(target) => commands.createGraphNote?.(target)}
      graphSettings={settings.graph}
      onGraphSettingsChange={(graph) => updateShellSettings((current) => ({ ...current, graph }))}
      isFavorite={(kind, relPath) => commands.isGraphFavorite?.(kind, relPath) ?? false}
      onToggleFavorite={(target) => commands.toggleGraphFavorite?.(target)}
      referenceFocus={graphSlice.referenceFocus}
      onExitReferenceFocus={() => visualModeController.setGraphReferenceFocus(null)}
      onGraphChanged={commands.onGraphChanged}
    />
  );
}
