import { useEffect } from "react";

import { DraftsPane } from "../../components/drafts/DraftsPane";
import { useAgentRegistrySlice } from "../agentRuntimeModeStore";
import { knowledgeModeController, useDraftsModeSlice } from "../knowledgeModeStore";
import type { ModeAdapterProps } from "../modeRegistry";
import { useShellAiSlice, useShellLayoutSlice } from "../shellSettingsStore";
import { useWorkspaceEntries, useWorkspaceRegistry } from "../workspaceStore";

/** Dedicated lazy Drafts surface composed from canonical workspace, agent, and visual owners. */
export function DraftsModeAdapter({ commands }: ModeAdapterProps) {
  const workspaceRegistry = useWorkspaceRegistry();
  const workPath =
    workspaceRegistry.activeByVisibility.private ??
    workspaceRegistry.workspaces.find((workspace) => workspace.visibility === "private")?.path ??
    workspaceRegistry.activeByVisibility.public ??
    workspaceRegistry.workspaces[0]?.path ??
    null;
  const entries = useWorkspaceEntries(workPath);
  const agents = useAgentRegistrySlice();
  const ai = useShellAiSlice();
  const { layout } = useShellLayoutSlice();
  const slice = useDraftsModeSlice();

  useEffect(() => {
    knowledgeModeController.setDraftsWorkspace(workPath);
  }, [workPath]);

  if (slice.workspacePath !== null && slice.workspacePath !== workPath) return null;
  return (
    <DraftsPane
      workPath={workPath}
      entries={entries}
      skills={[...agents.skills]}
      defaultRuntime={ai.defaultRuntime}
      agents={[...agents.agents]}
      ai={ai}
      taskIngestMinImportance={ai.taskIngestMinImportance}
      onTaskIngestMinImportanceChange={(taskIngestMinImportance) => commands.updateSettings?.((current) => ({
        ...current,
        ai: { ...current.ai, taskIngestMinImportance },
      }))}
      onConfirmApproval={(input) => commands.confirmApproval?.(input) ?? Promise.resolve(null)}
      onOpenAgents={() => commands.openPrimaryMode?.("agents")}
      onOpenGapAnalysis={(draftId) => {
        knowledgeModeController.requestGapDraft(draftId);
        commands.openPrimaryMode?.("gap");
      }}
      onOpenInGraph={(request) => {
        if (knowledgeModeController.openGraphReference("drafts", request, workPath)) {
          commands.openGraphPanel?.();
        }
      }}
      onExitReferenceFocus={() => knowledgeModeController.clearGraphReference("drafts")}
      layout={{ draftsListWidth: layout.draftsListWidth }}
      onLayoutChange={(patch) => commands.updateSettings?.((current) => ({
        ...current,
        ui: { ...current.ui, layout: { ...current.ui.layout, ...patch } },
      }))}
    />
  );
}
