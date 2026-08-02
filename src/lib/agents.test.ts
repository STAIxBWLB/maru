import { beforeEach, describe, expect, it, vi } from "vitest";

// `runAgent` is the one place skill resolution, runtime fallback, the
// availability probe and metadata assembly happen. Mock the two dispatch
// primitives so all four can be asserted without a subprocess.
interface RuntimeStatusStub {
  runtime: string;
  available: boolean;
  authStatus: string;
  message: string;
  suggestedAction: string | null;
}
const skillsDispatchBackground = vi.fn(async (_params: unknown) => "ai-run-1");
const skillsRuntimeStatus = vi.fn(
  async (params: {
    runtime: string;
    commandOverride?: string | null;
  }): Promise<RuntimeStatusStub> => ({
    runtime: params.runtime,
    available: true,
    authStatus: "authenticated",
    message: `${params.runtime} ready`,
    suggestedAction: null,
  }),
);
vi.mock("./skills", () => ({
  skillsDispatchBackground: (params: unknown) => skillsDispatchBackground(params),
  skillsRuntimeStatus: (params: { runtime: string; commandOverride?: string | null }) =>
    skillsRuntimeStatus(params),
}));

import {
  agentCanRunStandalone,
  agentIdOf,
  agentLabel,
  agentRunStatus,
  agentRuntimeFallbackOrder,
  buildAgentRows,
  findSkill,
  missionsForAgent,
  resolveAgentPermissionMode,
  resolveAgentRuntime,
  runAgentDetailed,
  slugifyAgentId,
  type AgentRecord,
} from "./agents";
import type { AiSettings } from "./settings";
import type { MissionRecord, SchedulerSchedule, SkillMissionMetadata } from "./types";
import type { SkillRecord } from "./skills";

const ai: AiSettings = {
  defaultRuntime: "claude",
  classifierRuntime: "inherit",
  taskIngestMinImportance: "medium",
  permissionMode: "plan",
  commandOverrides: { claude: null, codex: null, kimi: "/opt/kimi", kiro: null },
  extra: {},
};

function skill(id: string, name: string): SkillRecord {
  return { id, name } as unknown as SkillRecord;
}

const skills = [
  skill("maru-builtin::inbox-process", "inbox-process"),
  skill("stai-public::meeting-notes", "meeting-notes"),
];

function agent(overrides: Partial<AgentRecord> = {}): AgentRecord {
  return {
    id: "inbox-triage",
    labelKey: "agents.builtin.inboxTriage",
    skillName: "inbox-process",
    runtime: "inherit",
    permissionMode: "inherit",
    prompt: "",
    kind: "background",
    enabled: true,
    builtin: true,
    customized: false,
    ...overrides,
  };
}

function mission(id: string, metadata: Partial<SkillMissionMetadata>): MissionRecord {
  return { id, metadata } as unknown as MissionRecord;
}

beforeEach(() => {
  skillsDispatchBackground.mockClear();
  skillsRuntimeStatus.mockClear();
  skillsRuntimeStatus.mockImplementation(async (params) => ({
    runtime: params.runtime,
    available: true,
    authStatus: "authenticated",
    message: `${params.runtime} ready`,
    suggestedAction: null,
  }));
});

describe("findSkill", () => {
  it("prefers the portable name over a machine-local registry id", () => {
    expect(findSkill(skills, "inbox-process")?.id).toBe("maru-builtin::inbox-process");
    expect(findSkill(skills, "MEETING-NOTES")?.id).toBe("stai-public::meeting-notes");
  });

  it("still resolves a full id and a source-qualified suffix", () => {
    expect(findSkill(skills, "stai-public::meeting-notes")?.name).toBe("meeting-notes");
    expect(findSkill(skills, "nope")).toBeNull();
    expect(findSkill(skills, "  ")).toBeNull();
  });
});

describe("resolution helpers", () => {
  it("resolves inherit against AI settings and keeps an explicit choice", () => {
    expect(resolveAgentRuntime(agent(), ai)).toBe("claude");
    expect(resolveAgentRuntime(agent({ runtime: "kimi" }), ai)).toBe("kimi");
    expect(resolveAgentPermissionMode(agent(), ai)).toBe("plan");
    expect(resolveAgentPermissionMode(agent({ permissionMode: "acceptEdits" }), ai)).toBe(
      "acceptEdits",
    );
  });

  it("puts the preferred runtime first and keeps the rest as fallbacks", () => {
    expect(agentRuntimeFallbackOrder("kimi")).toEqual(["kimi", "claude", "codex", "kiro"]);
  });

  it("treats an empty prompt as feature-bound, not standalone", () => {
    expect(agentCanRunStandalone(agent())).toBe(false);
    expect(agentCanRunStandalone(agent({ prompt: "  " }))).toBe(false);
    expect(agentCanRunStandalone(agent({ prompt: "점검" }))).toBe(true);
    expect(agentCanRunStandalone(agent({ kind: "inline", prompt: "x" }))).toBe(false);
  });

  it("derives an id that satisfies the Rust id rule, or nothing", () => {
    expect(slugifyAgentId("Weekly report draft")).toBe("weekly-report-draft");
    expect(slugifyAgentId("  주간 보고서 ")).toBe("");
    expect(slugifyAgentId("2026 리포트")).toBe("2026");
    expect(slugifyAgentId("--Docs--")).toBe("docs");
    expect(slugifyAgentId("!!!")).toBe("");
    // Truncation must not leave a trailing hyphen, which the Rust rule allows
    // but reads as an unfinished id.
    const long = slugifyAgentId(`${"a".repeat(47)} b`);
    expect(long).toHaveLength(47);
    expect(long.endsWith("-")).toBe(false);
  });

  it("renders a builtin through i18n and a user agent through its literal label", () => {
    expect(agentLabel(agent(), (key) => `t:${key}`)).toBe("t:agents.builtin.inboxTriage");
    const user = agent({ labelKey: null, label: "문서 변환", builtin: false });
    expect(agentLabel(user, (key) => key)).toBe("문서 변환");
    expect(agentLabel(agent({ labelKey: null, label: "  " }), (key) => key)).toBe("inbox-triage");
  });
});

describe("runAgentDetailed", () => {
  it("dispatches the resolved skill id with the agent's runtime and override", async () => {
    const result = await runAgentDetailed(agent({ runtime: "kimi" }), {
      skills,
      ai,
      workPath: "/w",
      prompt: "정리해줘",
      context: [{ path: "/w/inbox/a.md", kind: "file" }],
    });

    expect(result).toEqual({
      invocationId: "ai-run-1",
      runtime: "kimi",
      skillId: "maru-builtin::inbox-process",
    });
    const params = skillsDispatchBackground.mock.calls[0][0] as Record<string, unknown>;
    expect(params.skillId).toBe("maru-builtin::inbox-process");
    expect(params.runtime).toBe("kimi");
    expect(params.commandOverride).toBe("/opt/kimi");
    expect(params.permissionMode).toBe("plan");
    expect(params.cwd).toBe("/w");
  });

  it("always stamps agentId but never overwrites a caller's origin", async () => {
    await runAgentDetailed(agent(), {
      skills,
      ai,
      workPath: "/w",
      prompt: "정리해줘",
      context: [{ path: "/w/inbox/a.md", kind: "file" }],
      metadata: { origin: "inboxProcess", reviewFlow: true },
    });

    const params = skillsDispatchBackground.mock.calls[0][0] as {
      metadata: Record<string, unknown>;
    };
    // `origin` is what taskIngestion and the per-pane run panels branch on, so
    // a converted call site must keep emitting exactly what it emitted before.
    expect(params.metadata.origin).toBe("inboxProcess");
    expect(params.metadata.reviewFlow).toBe(true);
    expect(params.metadata.agentId).toBe("inbox-triage");
    expect(params.metadata.skillName).toBe("inbox-process");
    expect(params.metadata.workspacePath).toBe("/w");
    expect(params.metadata.inputPaths).toEqual(["/w/inbox/a.md"]);
  });

  it("defaults origin to the agent id when the caller supplies none", async () => {
    await runAgentDetailed(agent({ prompt: "점검" }), { skills, ai, workPath: "/w" });
    const params = skillsDispatchBackground.mock.calls[0][0] as {
      metadata: Record<string, unknown>;
    };
    expect(params.metadata.origin).toBe("inbox-triage");
  });

  it("falls back to the next runtime when the preferred CLI is unavailable", async () => {
    skillsRuntimeStatus.mockImplementation(async (params) => ({
      runtime: params.runtime,
      available: params.runtime === "codex",
      authStatus: params.runtime === "codex" ? "authenticated" : "cli_missing",
      message: `${params.runtime} missing`,
      suggestedAction: "install it",
    }));

    const result = await runAgentDetailed(agent(), {
      skills,
      ai,
      workPath: "/w",
      prompt: "정리해줘",
    });
    expect(result.runtime).toBe("codex");
  });

  it("reports the preferred runtime's own diagnosis when nothing is available", async () => {
    skillsRuntimeStatus.mockImplementation(async (params) => ({
      runtime: params.runtime,
      available: false,
      authStatus: "cli_missing",
      message: `${params.runtime} missing.`,
      suggestedAction: "brew install it",
    }));

    await expect(
      runAgentDetailed(agent(), { skills, ai, workPath: "/w", prompt: "정리해줘" }),
    ).rejects.toThrow("claude missing. brew install it");
    expect(skillsDispatchBackground).not.toHaveBeenCalled();
  });

  it("refuses to dispatch without a prompt or a resolvable skill", async () => {
    await expect(
      runAgentDetailed(agent(), { skills, ai, workPath: "/w" }),
    ).rejects.toThrow("agent_prompt_required");

    await expect(
      runAgentDetailed(agent({ skillName: "ghost", prompt: "x" }), {
        skills,
        ai,
        workPath: "/w",
      }),
    ).rejects.toThrow("agent_skill_missing: ghost");

    await expect(
      runAgentDetailed(agent({ kind: "inline", prompt: "x" }), {
        skills,
        ai,
        workPath: "/w",
      }),
    ).rejects.toThrow("agent_not_background: inbox-triage");

    // Turning an agent off must stop its feature, not just hide its row.
    await expect(
      runAgentDetailed(agent({ enabled: false, prompt: "x" }), {
        skills,
        ai,
        workPath: "/w",
      }),
    ).rejects.toThrow("agent_disabled: inbox-triage");

    expect(skillsDispatchBackground).not.toHaveBeenCalled();
  });
});

describe("agentIdOf", () => {
  it("prefers an explicit agentId", () => {
    expect(agentIdOf(mission("a", { agentId: "doc-convert", origin: "inboxProcess" }))).toBe(
      "doc-convert",
    );
  });

  it("maps pre-agent runs back through their origin namespace", () => {
    expect(agentIdOf(mission("a", { origin: "inboxProcess" }))).toBe("inbox-triage");
    expect(agentIdOf(mission("b", { origin: "meetingNotesFromTranscript" }))).toBe(
      "meeting-notes",
    );
    // Followup origins are minted from the followup's skill name, so the
    // parent namespace has to keep matching by prefix.
    expect(agentIdOf(mission("c", { origin: "taskManagementVaultConnect" }))).toBe(
      "task-extract",
    );
    expect(agentIdOf(mission("d", { origin: "skillCompose" }))).toBeNull();
    expect(agentIdOf(mission("e", {}))).toBeNull();
  });

  it("groups missions per agent", () => {
    const missions = [
      mission("a", { agentId: "inbox-triage" }),
      mission("b", { origin: "meetingNotesExternalRefine" }),
      mission("c", { origin: "inboxProcess" }),
    ];
    expect(missionsForAgent(missions, "inbox-triage").map((m) => m.id)).toEqual(["a", "c"]);
  });
});

describe("buildAgentRows", () => {
  function run(
    id: string,
    agentId: string,
    status: MissionRecord["status"],
    at: string,
  ): MissionRecord {
    return {
      id,
      status,
      startedAt: at,
      lastOutputAt: at,
      metadata: { agentId },
    } as unknown as MissionRecord;
  }

  function schedule(agentId: string, nextRunAt: string): SchedulerSchedule {
    return {
      id: `s-${agentId}`,
      agentId,
      nextRunAt,
      skillId: "",
    } as unknown as SchedulerSchedule;
  }

  it("shows a live run over a stale failure", () => {
    expect(
      agentRunStatus([
        run("old", "a", "failed", "2026-08-01T09:00:00Z"),
        run("new", "a", "running", "2026-08-02T09:00:00Z"),
      ]),
    ).toBe("running");
    expect(
      agentRunStatus([
        run("old", "a", "done", "2026-08-02T09:00:00Z"),
        run("new", "a", "failed", "2026-08-02T10:00:00Z"),
      ]),
    ).toBe("failed");
    expect(agentRunStatus([])).toBe("never");
  });

  it("orders rows the way the pane reads: live, then soonest, then recent", () => {
    const agents = [
      agent({ id: "never-run" }),
      agent({ id: "paused", enabled: false }),
      agent({ id: "scheduled-later" }),
      agent({ id: "running-now" }),
      agent({ id: "broke" }),
      agent({ id: "scheduled-soon" }),
      agent({ id: "ran-recently" }),
    ];
    const schedules = [
      schedule("scheduled-later", "2026-08-05T09:00:00Z"),
      schedule("scheduled-soon", "2026-08-03T09:00:00Z"),
    ];
    const missions = [
      run("m1", "running-now", "running", "2026-08-02T12:00:00Z"),
      run("m2", "ran-recently", "done", "2026-08-02T11:00:00Z"),
      run("m3", "paused", "running", "2026-08-02T12:30:00Z"),
      run("m4", "broke", "failed", "2026-08-01T08:00:00Z"),
    ];

    const rows = buildAgentRows(agents, schedules, missions);
    expect(rows.map((row) => row.agent.id)).toEqual([
      "running-now",
      // A failure outranks a schedule: it is the one quiet state wanting a human.
      "broke",
      // Quiet rows answer "what is coming up", so a schedule beats a past run.
      "scheduled-soon",
      "scheduled-later",
      "ran-recently",
      "never-run",
      // Disabled sinks below its peers even while a run of its own is live.
      "paused",
    ]);

    const live = rows[0];
    expect(live.status).toBe("running");
    expect(live.activeMissionId).toBe("m1");
    expect(rows.find((row) => row.agent.id === "scheduled-soon")?.schedule?.id).toBe(
      "s-scheduled-soon",
    );
    expect(rows.find((row) => row.agent.id === "never-run")?.status).toBe("never");
  });

  it("adopts a pre-agent schedule by the skill it dispatches", () => {
    // The user's real schedule: created before agents existed, so it carries a
    // machine-local skill id and no agentId. Without adoption it would have no
    // row at all now that the old scheduler section is gone.
    const legacy = {
      id: "sched-bb4e8305",
      name: "Inbox extract-tasks",
      skillId: "maru-builtin::inbox-process",
      prompt: "extract-tasks",
      hour: 7,
      minute: 0,
      daysOfWeek: [],
      enabled: true,
      nextRunAt: "2026-08-03T07:00:00+09:00",
    } as unknown as SchedulerSchedule;

    const rows = buildAgentRows(
      [agent({ id: "inbox-triage", skillName: "inbox-process" }), agent({ id: "other", skillName: "vault-lint" })],
      [legacy],
      [],
    );
    expect(rows.find((row) => row.agent.id === "inbox-triage")?.schedule?.id).toBe(
      "sched-bb4e8305",
    );
    expect(rows.find((row) => row.agent.id === "other")?.schedule).toBeNull();
  });

  it("never shows one schedule against two agents", () => {
    const legacy = {
      id: "sched-shared",
      skillId: "inbox-process",
      daysOfWeek: [],
      enabled: true,
    } as unknown as SchedulerSchedule;
    const rows = buildAgentRows(
      [
        agent({ id: "a-first", skillName: "inbox-process" }),
        agent({ id: "b-second", skillName: "inbox-process" }),
      ],
      [legacy],
      [],
    );
    const withSchedule = rows.filter((row) => row.schedule !== null);
    expect(withSchedule).toHaveLength(1);
    expect(withSchedule[0].agent.id).toBe("a-first");
  });
});
