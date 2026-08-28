import { useEffect, useMemo, useSyncExternalStore } from "react";

import { readAiMissionLog, stopAiMission } from "./api";
import { listAgents, type AgentRecord } from "./agents";
import { setError } from "./errorStore";
import { useShellAiSlice, useShellTasksSlice } from "./shellSettingsStore";
import { measureStartup, scheduleStartupIdle } from "./startupProfile";
import { skillsListSkills, type SkillDispatchRuntime, type SkillRecord } from "./skills";
import { isTrackedAgentMission } from "./skillRuns";
import type { AiSettings } from "./settings";
import type { MissionRecord } from "./types";
import {
  getTrackedMissionsSnapshot,
  ingestMissionUpdate,
  useTrackedMissions,
} from "./useActiveMissions";

export type AgentRuntimeDomain = "registry" | "mission" | "runtime";

export interface AgentRegistrySlice {
  workspacePath: string | null;
  agents: readonly AgentRecord[];
  skills: readonly SkillRecord[];
  skillsLoading: boolean;
}

export interface AgentMissionSlice {
  missions: readonly MissionRecord[];
  logLines: Readonly<Record<string, readonly string[]>>;
}

export interface AgentRuntimeSlice {
  ai: Partial<AiSettings>;
  runtimeCommands: Partial<Record<SkillDispatchRuntime, string | null>>;
  tasksRoot: string | null;
}

export interface AgentRuntimeControllerOptions {
  listAgents?: () => Promise<AgentRecord[]>;
  listSkills?: (workPath: string, options?: { refresh?: boolean }) => Promise<SkillRecord[]>;
  reportError?: (error: unknown) => void;
}

export interface AgentRuntimeController {
  subscribe(domain: AgentRuntimeDomain, listener: () => void): () => void;
  getRegistrySlice(): AgentRegistrySlice;
  getMissionSlice(): AgentMissionSlice;
  getRuntimeSlice(): AgentRuntimeSlice;
  setWorkspace(workspacePath: string | null): void;
  refreshAgents(): Promise<readonly AgentRecord[]>;
  refreshSkills(options?: { refresh?: boolean }): Promise<readonly SkillRecord[]>;
  publishMissionLog(missionId: string, lines: readonly string[]): void;
  appendMissionLog(missionId: string, line: string): void;
  refreshMissionLogs(): Promise<void>;
  trackMission(missionId: string): void;
  stopMission(missionId: string): Promise<void>;
  publishRuntime(slice: AgentRuntimeSlice): void;
}

const EMPTY_REGISTRY: AgentRegistrySlice = Object.freeze({
  workspacePath: null,
  agents: Object.freeze([]),
  skills: Object.freeze([]),
  skillsLoading: false,
});
const EMPTY_MISSION: AgentMissionSlice = Object.freeze({
  missions: Object.freeze([]),
  logLines: Object.freeze({}),
});
const EMPTY_RUNTIME: AgentRuntimeSlice = Object.freeze({
  ai: Object.freeze({}),
  runtimeCommands: Object.freeze({}),
  tasksRoot: null,
});

function freezeLines(lines: readonly string[]): readonly string[] {
  return Object.freeze([...lines]);
}

function reuseRecord<T extends Readonly<Record<string, unknown>>>(previous: T, next: T): T {
  const previousKeys = Object.keys(previous);
  if (
    previousKeys.length === Object.keys(next).length &&
    previousKeys.every((key) => previous[key] === next[key])
  ) {
    return previous;
  }
  return Object.freeze({ ...next }) as T;
}

function reportStoreError(error: unknown): void {
  setError(error instanceof Error ? error.message : String(error));
}

/**
 * Canonical agent runtime state divided by render domain. Agent and skill
 * registries are workspace-aware; mission continuity remains process-global.
 */
export function createAgentRuntimeController(
  options: AgentRuntimeControllerOptions = {},
): AgentRuntimeController {
  const listeners: Record<AgentRuntimeDomain, Set<() => void>> = {
    registry: new Set(),
    mission: new Set(),
    runtime: new Set(),
  };
  let registry = EMPTY_REGISTRY;
  let mission = EMPTY_MISSION;
  let runtime = EMPTY_RUNTIME;
  let skillsRequest = 0;
  let agentsRequest = 0;
  const listRegistryAgents = options.listAgents ?? listAgents;
  const listRegistrySkills = options.listSkills ?? skillsListSkills;
  const reportError = options.reportError ?? reportStoreError;

  const notify = (domain: AgentRuntimeDomain) => {
    for (const listener of listeners[domain]) listener();
  };
  const publishRegistry = (next: AgentRegistrySlice) => {
    if (
      registry.workspacePath === next.workspacePath &&
      registry.agents === next.agents &&
      registry.skills === next.skills &&
      registry.skillsLoading === next.skillsLoading
    ) return;
    registry = Object.freeze(next);
    notify("registry");
  };
  const publishMission = (next: AgentMissionSlice) => {
    if (mission.logLines === next.logLines) return;
    mission = Object.freeze(next);
    notify("mission");
  };

  return {
    subscribe(domain, listener) {
      listeners[domain].add(listener);
      return () => listeners[domain].delete(listener);
    },
    getRegistrySlice() {
      return registry;
    },
    getMissionSlice() {
      return mission;
    },
    getRuntimeSlice() {
      return runtime;
    },
    setWorkspace(workspacePath) {
      if (registry.workspacePath === workspacePath) return;
      skillsRequest += 1;
      publishRegistry({
        workspacePath,
        agents: registry.agents,
        skills: EMPTY_REGISTRY.skills,
        skillsLoading: false,
      });
    },
    async refreshAgents() {
      const request = ++agentsRequest;
      try {
        const agents = Object.freeze([...(await listRegistryAgents())]);
        if (request === agentsRequest) {
          publishRegistry({ ...registry, agents });
        }
        return agents;
      } catch (error) {
        if (request === agentsRequest) reportError(error);
        return EMPTY_REGISTRY.agents;
      }
    },
    async refreshSkills(refreshOptions = {}) {
      const workspacePath = registry.workspacePath;
      if (!workspacePath) return EMPTY_REGISTRY.skills;
      const request = ++skillsRequest;
      publishRegistry({ ...registry, skillsLoading: true });
      try {
        const skills = Object.freeze([...(await listRegistrySkills(workspacePath, refreshOptions))]);
        if (request === skillsRequest && registry.workspacePath === workspacePath) {
          publishRegistry({ ...registry, skills, skillsLoading: false });
        }
        return skills;
      } catch (error) {
        if (request === skillsRequest && registry.workspacePath === workspacePath) {
          publishRegistry({ ...registry, skillsLoading: false });
          reportError(error);
        }
        return EMPTY_REGISTRY.skills;
      }
    },
    publishMissionLog(missionId, lines) {
      const nextLines = freezeLines(lines);
      if (mission.logLines[missionId] === nextLines) return;
      publishMission({
        missions: mission.missions,
        logLines: Object.freeze({ ...mission.logLines, [missionId]: nextLines }),
      });
    },
    appendMissionLog(missionId, line) {
      const lines = [...(mission.logLines[missionId] ?? []), line].slice(-120);
      this.publishMissionLog(missionId, lines);
    },
    async refreshMissionLogs() {
      const missions = getTrackedMissionsSnapshot();
      const tails = await Promise.all(
        missions.map((record) =>
          readAiMissionLog(record.id, 80)
            .then((tail) => [record.id, tail.lines] as const)
            .catch(() => [record.id, []] as const),
        ),
      );
      const logLines = Object.freeze({
        ...mission.logLines,
        ...Object.fromEntries(tails.map(([id, lines]) => [id, freezeLines(lines)])),
      });
      publishMission({ missions: mission.missions, logLines });
    },
    trackMission(missionId) {
      if (mission.logLines[missionId]) return;
      this.publishMissionLog(missionId, []);
      void this.refreshMissionLogs();
    },
    async stopMission(missionId) {
      try {
        const record = await stopAiMission(missionId);
        if (isTrackedAgentMission(record)) ingestMissionUpdate(record);
      } catch (error) {
        reportError(error);
      }
    },
    publishRuntime(next) {
      const ai = reuseRecord(runtime.ai, next.ai);
      const runtimeCommands = reuseRecord(runtime.runtimeCommands, next.runtimeCommands);
      if (
        runtime.ai === ai &&
        runtime.runtimeCommands === runtimeCommands &&
        runtime.tasksRoot === next.tasksRoot
      ) return;
      runtime = Object.freeze({ ai, runtimeCommands, tasksRoot: next.tasksRoot });
      notify("runtime");
    },
  };
}

export const agentRuntimeController = createAgentRuntimeController();

function useStoreSlice<T>(domain: AgentRuntimeDomain, getSnapshot: () => T): T {
  return useSyncExternalStore(
    (listener) => agentRuntimeController.subscribe(domain, listener),
    getSnapshot,
    getSnapshot,
  );
}

export function useAgentRegistrySlice(): AgentRegistrySlice {
  return useStoreSlice("registry", () => agentRuntimeController.getRegistrySlice());
}

/** Composes, but never mirrors, the canonical process-global mission store. */
export function useAgentMissionSlice(): AgentMissionSlice {
  const missions = useTrackedMissions();
  const logs = useStoreSlice("mission", () => agentRuntimeController.getMissionSlice().logLines);
  return useMemo(() => ({ missions, logLines: logs }), [logs, missions]);
}

/** Runtime commands derive from the canonical settings slices instead of a host snapshot. */
export function useAgentRuntimeSlice(): AgentRuntimeSlice {
  const ai = useShellAiSlice();
  const tasks = useShellTasksSlice();
  return useMemo(
    () => ({
      ai,
      runtimeCommands: {
        claude: ai.commandOverrides.claude,
        codex: ai.commandOverrides.codex,
        kimi: ai.commandOverrides.kimi,
        kiro: ai.commandOverrides.kiro,
      },
      tasksRoot: tasks.root,
    }),
    [ai, tasks.root],
  );
}

/** Moves startup refresh sequencing out of MainApp and rejects stale workspace responses. */
export function AgentRuntimeBootstrap({
  booting,
  workspacePath,
  workspaceReady,
}: {
  booting: boolean;
  workspacePath: string | null;
  workspaceReady: boolean;
}) {
  useEffect(() => {
    void agentRuntimeController.refreshAgents();
  }, []);

  useEffect(() => {
    agentRuntimeController.setWorkspace(workspacePath);
    if (booting || !workspacePath || !workspaceReady) return;
    let cancelled = false;
    let refreshScheduled = false;
    let cancelRefresh: (() => void) | null = null;
    const cancelCached = scheduleStartupIdle(() => {
      refreshScheduled = true;
      void measureStartup(
        "skills:cached-read",
        () => agentRuntimeController.refreshSkills(),
        { workPath: workspacePath },
      ).then((skills) => {
        if (cancelled || skills.length > 0) return;
        cancelRefresh = scheduleStartupIdle(() => {
          if (!cancelled) {
            void measureStartup("skills:refresh", () => agentRuntimeController.refreshSkills({ refresh: true }), {
              workPath: workspacePath,
            });
          }
        }, 2500);
      });
    });
    return () => {
      cancelled = true;
      cancelCached();
      cancelRefresh?.();
      if (!refreshScheduled) agentRuntimeController.setWorkspace(null);
    };
  }, [booting, workspacePath, workspaceReady]);

  return null;
}

/** Owns the output stream and log-tail refresh without making MainApp a subscriber. */
export function AgentRuntimeMissionBridge() {
  const missions = useTrackedMissions();

  useEffect(() => {
    void agentRuntimeController.refreshMissionLogs();
  }, [missions]);

  useEffect(() => {
    let cancelled = false;
    let unlisten: (() => void) | null = null;
    void import("@tauri-apps/api/event")
      .then(async ({ listen }) => {
        const off = await listen<{ invocationId: string; stream: string; line: string }>(
          "ai://output",
          (event) => {
            if (!getTrackedMissionsSnapshot().some((mission) => mission.id === event.payload.invocationId)) return;
            agentRuntimeController.appendMissionLog(
              event.payload.invocationId,
              `[${event.payload.stream}] ${event.payload.line}`,
            );
          },
        );
        if (cancelled) off();
        else unlisten = off;
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
      unlisten?.();
    };
  }, []);

  return null;
}
