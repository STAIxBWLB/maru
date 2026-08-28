import { useEffect, useMemo, useRef, useState } from "react";

import { GraphView } from "../../components/graph/GraphView";
import { readVaultCache, vaultGraphRoot } from "../api";
import type { ModeAdapterProps } from "../modeRegistry";
import { updateShellSettings, useShellSettings } from "../shellSettingsStore";
import { useGraphModeSlice, visualModeController } from "../visualModeStore";
import {
  getWorkspaceStoreState,
  rescanWorkspaceEntries,
  updateWorkspaceState,
  useVaultWatcherSync,
  useWorkspaceEntries,
  useWorkspaceRegistry,
} from "../workspaceStore";

/** Dedicated lazy Graph surface shared by primary, right, and tool-panel placements. */
export function GraphModeAdapter({ scope, commands }: ModeAdapterProps) {
  const settings = useShellSettings();
  const workspaceRegistry = useWorkspaceRegistry();
  const graphSlice = useGraphModeSlice();
  const graphWorkspacePath = workspaceRegistry.activeByVisibility.private ?? scope.workspacePath;
  const [nestedVault, setNestedVault] = useState<{ workspace: string; root: string | null } | null>(null);
  const scanGeneration = useRef(0);

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
  const entries = useWorkspaceEntries(graphDataPath);
  const graphKey = useMemo(
    () => `${settings.graph.source}:${graphDataPath ?? "no-workspace"}`,
    [graphDataPath, settings.graph.source],
  );

  // Graph can target a nested vault that the document shell never opens. Keep
  // its cache warm and establish an authoritative index independently of the
  // active editor workspace. The generation/path check rejects responses from
  // a previous target when the graph source or workspace changes mid-scan.
  useEffect(() => {
    if (!graphDataPath) return;
    const current = getWorkspaceStoreState().states[graphDataPath];
    if (current?.startupIoReady || current?.loading || current?.refreshing) return;

    const path = graphDataPath;
    const generation = ++scanGeneration.current;
    let disposed = false;
    const currentRequest = () => !disposed && generation === scanGeneration.current && graphDataPath === path;

    updateWorkspaceState(path, { loading: true });
    void (async () => {
      try {
        const cached = await readVaultCache(path);
        if (!currentRequest()) return;
        if (cached) updateWorkspaceState(path, { entries: cached, loading: false, refreshing: true });

        const fresh = await rescanWorkspaceEntries(path, commands.graphScanOptions);
        if (!currentRequest()) return;
        if (fresh) updateWorkspaceState(path, { startupIoReady: true });
        else updateWorkspaceState(path, { loading: false, refreshing: false });
      } catch {
        if (currentRequest()) updateWorkspaceState(path, { loading: false, refreshing: false });
      }
    })();

    return () => {
      disposed = true;
    };
  }, [commands.graphScanOptions, graphDataPath]);

  // The mounted adapter is the visible graph surface, including the shared
  // terminal panel. Its watcher must follow the resolved graph data root, not
  // whichever workspace happens to host the surrounding shell.
  useVaultWatcherSync(graphDataPath, Boolean(graphDataPath), commands.graphScanOptions);

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
      onGraphChanged={() => {
        if (graphDataPath) commands.onGraphChanged?.(graphDataPath);
      }}
    />
  );
}
