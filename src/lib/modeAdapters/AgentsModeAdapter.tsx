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
  const registry = useAgentRegistrySlice();
  const mission = useAgentMissionSlice();
  const runtime = useAgentRuntimeSlice();
  return (
    <AgentsPane
      workPath={scope.workspacePath}
      skills={[...registry.skills]}
      ai={runtime.ai as typeof runtime.ai & Parameters<typeof AgentsPane>[0]["ai"]}
      missions={[...mission.missions]}
      logLines={mission.logLines as Record<string, string[]>}
      runtimeCommands={runtime.runtimeCommands}
      tasksRoot={runtime.tasksRoot}
      onRefreshMissions={() => void agentRuntimeController.refreshMissionLogs()}
      onStopMission={(missionId) => void agentRuntimeController.stopMission(missionId)}
      onMissionStarted={agentRuntimeController.trackMission}
      onConfirmApproval={(input) => commands.confirmApproval?.(input) ?? Promise.resolve(null)}
      onAgentsChanged={() => void agentRuntimeController.refreshAgents()}
    />
  );
}
