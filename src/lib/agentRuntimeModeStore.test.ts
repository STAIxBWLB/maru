import { describe, expect, it } from "vitest";

import {
  createAgentRuntimeController,
  type AgentRuntimeController,
} from "./agentRuntimeModeStore";

function createController(): AgentRuntimeController {
  return createAgentRuntimeController({
    listAgents: async () => [
      {
        id: "inbox-triage",
        label: null,
        description: null,
        skillName: "inbox-process",
        runtime: "inherit",
        permissionMode: "inherit",
        prompt: "",
        kind: "background",
        enabled: true,
        builtin: true,
        customized: false,
      },
    ],
    listSkills: async (workPath) => [
      {
        id: `skill:${workPath}`,
        sourceId: "test",
        name: "inbox-process",
        relPath: "skills/inbox-process/SKILL.md",
        absPath: `${workPath}/skills/inbox-process/SKILL.md`,
        title: "Inbox process",
        tier: "core",
        editable: false,
        dirty: false,
      },
    ],
  });
}

describe("agentRuntimeModeStore", () => {
  it("publishes registry, mission/log, and runtime domains independently", async () => {
    const controller = createController();
    let registryUpdates = 0;
    let missionUpdates = 0;
    let runtimeUpdates = 0;
    const stopRegistry = controller.subscribe("registry", () => registryUpdates += 1);
    const stopMission = controller.subscribe("mission", () => missionUpdates += 1);
    const stopRuntime = controller.subscribe("runtime", () => runtimeUpdates += 1);

    controller.setWorkspace("/workspace-a");
    await controller.refreshAgents();
    await controller.refreshSkills();
    const registry = controller.getRegistrySlice();
    controller.publishMissionLog("mission-1", ["[stdout] started"]);
    controller.publishRuntime({
      ai: { defaultRuntime: "claude" },
      runtimeCommands: { claude: "claude" },
      tasksRoot: "/workspace-a/tasks",
    });

    expect(registry.agents).toHaveLength(1);
    expect(registry.skills).toHaveLength(1);
    expect(controller.getMissionSlice().logLines).toEqual({ "mission-1": ["[stdout] started"] });
    expect(controller.getRuntimeSlice().tasksRoot).toBe("/workspace-a/tasks");
    expect(registryUpdates).toBeGreaterThan(0);
    expect(missionUpdates).toBe(1);
    expect(runtimeUpdates).toBe(1);

    stopRegistry();
    stopMission();
    stopRuntime();
  });

  it("rejects stale workspace skill responses without resetting process-global missions", async () => {
    let resolveOld: ((value: Awaited<ReturnType<AgentRuntimeController["refreshSkills"]>>) => void) | null = null;
    const controller = createAgentRuntimeController({
      listAgents: async () => [],
      listSkills: (workPath) =>
        new Promise((resolve) => {
          if (workPath === "/workspace-a") {
            resolveOld = () => resolve([
              {
                id: "old-skill",
                sourceId: "test",
                name: "old",
                relPath: "old/SKILL.md",
                absPath: "/workspace-a/old/SKILL.md",
                title: "Old",
                tier: "core",
                editable: false,
                dirty: false,
              },
            ]);
            return;
          }
          resolve([
            {
              id: "new-skill",
              sourceId: "test",
              name: "new",
              relPath: "new/SKILL.md",
              absPath: "/workspace-b/new/SKILL.md",
              title: "New",
              tier: "core",
              editable: false,
              dirty: false,
            },
          ]);
        }),
    });

    controller.publishMissionLog("process-mission", ["[stdout] still running"]);
    controller.setWorkspace("/workspace-a");
    const oldRequest = controller.refreshSkills();
    controller.setWorkspace("/workspace-b");
    await controller.refreshSkills();
    resolveOld?.();
    await oldRequest;

    expect(controller.getRegistrySlice().workspacePath).toBe("/workspace-b");
    expect(controller.getRegistrySlice().skills.map((skill) => skill.id)).toEqual(["new-skill"]);
    expect(controller.getMissionSlice().logLines["process-mission"]).toEqual(["[stdout] still running"]);
  });

  it("retains unchanged slice identities across isolated updates", () => {
    const controller = createController();
    const registry = controller.getRegistrySlice();
    const mission = controller.getMissionSlice();
    const runtime = controller.getRuntimeSlice();

    controller.publishMissionLog("mission-1", ["[stdout] one"]);
    expect(controller.getRegistrySlice()).toBe(registry);
    expect(controller.getRuntimeSlice()).toBe(runtime);

    controller.publishRuntime({ ai: {}, runtimeCommands: {}, tasksRoot: null });
    expect(controller.getRegistrySlice()).toBe(registry);
    expect(controller.getMissionSlice()).not.toBe(mission);
  });
});
