import { useEffect } from "react";

import { ScratchpadPane } from "../../components/ScratchpadPane";
import { knowledgeModeController, useScratchpadModeSlice } from "../knowledgeModeStore";
import type { ModeAdapterProps } from "../modeRegistry";
import { useShellSettings } from "../shellSettingsStore";
import { useWorkspaceRegistry } from "../workspaceStore";

/** Dedicated lazy Scratchpad surface; document, watcher, and autosave state stay local. */
export function ScratchpadModeAdapter({ commands }: ModeAdapterProps) {
  const settings = useShellSettings();
  const workspaceRegistry = useWorkspaceRegistry();
  const slice = useScratchpadModeSlice();
  const workPath =
    workspaceRegistry.activeByVisibility.private ??
    workspaceRegistry.workspaces.find((workspace) => workspace.visibility === "private")?.path ??
    workspaceRegistry.activeByVisibility.public ??
    workspaceRegistry.workspaces[0]?.path ??
    null;
  const layout = settings.ui.layout;

  useEffect(() => {
    knowledgeModeController.setScratchpadWorkspace(workPath);
  }, [workPath]);

  useEffect(() => {
    knowledgeModeController.setScratchpadSettings({
      sortKey: settings.ui.scratchpadSortKey,
      listHeight: layout.scratchpadListHeight,
      listWidth: layout.scratchpadListWidth,
      treeOpen: layout.scratchpadTreeOpen,
      treeWidth: layout.scratchpadTreeWidth,
      expandedFolders: settings.ui.scratchpadExpandedFolders,
      editorViewMode: settings.ui.scratchpadEditorViewMode,
    });
  }, [layout, settings.ui.scratchpadEditorViewMode, settings.ui.scratchpadExpandedFolders, settings.ui.scratchpadSortKey]);

  const updateSettings = commands.updateSettings;
  return (
    <ScratchpadPane
      key={workPath ?? "scratchpad-unavailable"}
      workPath={workPath}
      sortKey={settings.ui.scratchpadSortKey}
      listHeight={layout.scratchpadListHeight}
      listWidth={layout.scratchpadListWidth}
      treeOpen={layout.scratchpadTreeOpen}
      treeWidth={layout.scratchpadTreeWidth}
      expandedFolders={settings.ui.scratchpadExpandedFolders}
      editorViewMode={settings.ui.scratchpadEditorViewMode}
      refreshRequestEpoch={slice.refreshRequestEpoch}
      onRefreshWorkspace={() => commands.refreshCurrent?.()}
      onSortKeyChange={(scratchpadSortKey) => updateSettings?.((current) => ({
        ...current,
        ui: { ...current.ui, scratchpadSortKey },
      }))}
      onListHeightChange={(scratchpadListHeight) => updateSettings?.((current) => ({
        ...current,
        ui: { ...current.ui, layout: { ...current.ui.layout, scratchpadListHeight } },
      }))}
      onListWidthChange={(scratchpadListWidth) => updateSettings?.((current) => ({
        ...current,
        ui: { ...current.ui, layout: { ...current.ui.layout, scratchpadListWidth } },
      }))}
      onTreeOpenChange={(scratchpadTreeOpen) => updateSettings?.((current) => ({
        ...current,
        ui: { ...current.ui, layout: { ...current.ui.layout, scratchpadTreeOpen } },
      }))}
      onTreeWidthChange={(scratchpadTreeWidth) => updateSettings?.((current) => ({
        ...current,
        ui: { ...current.ui, layout: { ...current.ui.layout, scratchpadTreeWidth } },
      }))}
      onExpandedFoldersChange={(scratchpadExpandedFolders) => updateSettings?.((current) => ({
        ...current,
        ui: { ...current.ui, scratchpadExpandedFolders },
      }))}
      onEditorViewModeChange={(scratchpadEditorViewMode) => updateSettings?.((current) => ({
        ...current,
        ui: { ...current.ui, scratchpadEditorViewMode },
      }))}
      t={(key, vars) => commands.translate?.(key, vars) ?? key}
    />
  );
}
