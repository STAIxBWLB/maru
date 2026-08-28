import { useCallback } from "react";

import { AgentsPane } from "../../components/agents/AgentsPane";
import {
  agentRuntimeController,
  useAgentMissionSlice,
  useAgentRegistrySlice,
  useAgentRuntimeSlice,
} from "../agentRuntimeModeStore";
import type { ModeAdapterProps } from "../modeRegistry";

/** Dedicated lazy Agents surface. It receives only the generic host contract. */
export function AgentsModeAdapter({ scope, commands }: ModeAdapterProps) {
  const { confirmApproval: requestApproval } = commands;
  const registry = useAgentRegistrySlice();
  const mission = useAgentMissionSlice();
  const runtime = useAgentRuntimeSlice();
  const refreshMissions = useCallback(() => {
    void agentRuntimeController.refreshMissionLogs();
  }, []);
  const stopMission = useCallback((missionId: string) => {
    void agentRuntimeController.stopMission(missionId);
  }, []);
  const confirmApproval = useCallback(
    (input: unknown) => requestApproval?.(input) ?? Promise.resolve(null),
    [requestApproval],
  );
  const refreshAgents = useCallback(() => {
    void agentRuntimeController.refreshAgents();
  }, []);
  return (
    <AgentsPane
      workPath={scope.workspacePath}
      skills={[...registry.skills]}
      ai={runtime.ai as typeof runtime.ai & Parameters<typeof AgentsPane>[0]["ai"]}
      missions={[...mission.missions]}
      logLines={mission.logLines as Record<string, string[]>}
      runtimeCommands={runtime.runtimeCommands}
      tasksRoot={runtime.tasksRoot}
      onRefreshMissions={refreshMissions}
      onStopMission={stopMission}
      onMissionStarted={agentRuntimeController.trackMission}
      onConfirmApproval={confirmApproval}
      onAgentsChanged={refreshAgents}
    />
  );
}
