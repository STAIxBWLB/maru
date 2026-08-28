import { useEffect, useMemo } from "react";

import { DiagramMode, type DiagramActiveDocument } from "../../components/diagram/DiagramMode";
import { useActiveTabIds, useDocTabs } from "../editorTabsStore";
import type { ModeAdapterProps } from "../modeRegistry";
import { useWorkspaceStates } from "../workspaceStore";
import { useDiagramModeSlice, visualModeController } from "../visualModeStore";

/** Dedicated lazy adapter. Diagram projections are read from canonical tab/workspace stores. */
export function DiagramModeAdapter({ scope, commands }: ModeAdapterProps) {
  const tabs = useDocTabs();
  const activeTabIds = useActiveTabIds();
  const workspaceStates = useWorkspaceStates();
  const workPath = scope.workspacePath;
  const activeDocument = useMemo<DiagramActiveDocument | null>(() => {
    const activeTab = tabs.find(
      (tab) => tab.id === activeTabIds.activeTabId && tab.workspacePath === workPath,
    );
    if (!activeTab) return null;
    return {
      path: activeTab.document.path,
      title: activeTab.document.title,
      revision: activeTab.document.revision,
      fileKind: activeTab.document.fileKind,
    };
  }, [activeTabIds.activeTabId, tabs, workPath]);
  const recentDocuments = useMemo(
    () => (workPath ? workspaceStates[workPath]?.entries ?? [] : []).map(({ path, title }) => ({ path, title })),
    [workPath, workspaceStates],
  );
  const projection = useMemo(
    () => ({ workPath, activeDocument, recentDocuments }),
    [activeDocument, recentDocuments, workPath],
  );

  useEffect(() => {
    visualModeController.setDiagramActiveDocument(projection);
  }, [projection]);

  const slice = useDiagramModeSlice();
  return (
    <DiagramMode
      workPath={slice.workPath}
      activeDocument={slice.activeDocument}
      recentDocuments={slice.recentDocuments}
      onSaveDocument={commands.saveDocument}
    />
  );
}
