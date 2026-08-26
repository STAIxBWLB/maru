import { useEffect } from "react";

import { GapPane } from "../../components/gap/GapPane";
import { knowledgeModeController, useGapModeSlice } from "../knowledgeModeStore";
import type { ModeAdapterProps } from "../modeRegistry";
import { useWorkspaceEntries, useWorkspaceRegistry } from "../workspaceStore";

/** Dedicated lazy Gap surface retaining the filesystem-backed report lifecycle in GapPane. */
export function GapModeAdapter({ commands }: ModeAdapterProps) {
  const workspaceRegistry = useWorkspaceRegistry();
  const workPath =
    workspaceRegistry.activeByVisibility.private ??
    workspaceRegistry.workspaces.find((workspace) => workspace.visibility === "private")?.path ??
    workspaceRegistry.activeByVisibility.public ??
    workspaceRegistry.workspaces[0]?.path ??
    null;
  const entries = useWorkspaceEntries(workPath);
  const slice = useGapModeSlice();

  useEffect(() => {
    knowledgeModeController.setGapWorkspace(workPath);
  }, [workPath]);

  if (slice.workspacePath !== null && slice.workspacePath !== workPath) return null;
  return (
    <GapPane
      workPath={workPath}
      entries={entries}
      initialDraftId={slice.initialDraftId}
      initialDraftRequest={slice.initialDraftRequest}
      onConsumeInitialDraftId={() => knowledgeModeController.consumeGapDraft(slice.initialDraftRequest)}
      onOpenInGraph={(request) => {
        if (knowledgeModeController.openGraphReference("gap", request, workPath)) {
          commands.openGraphPanel?.();
        }
      }}
      onExitReferenceFocus={() => knowledgeModeController.clearGraphReference("gap")}
    />
  );
}
