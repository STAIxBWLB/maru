import { describe, expect, it } from "vitest";
import type { AgentRunEvent } from "./skills";
import type { MissionRecord } from "./types";
import {
  deriveSkillRunPhase,
  extractSkillRunRetryRequest,
  formatElapsed,
  formatSkillRunLogLine,
  isSkillMission,
  isStructuredMission,
  isTrackedAgentMission,
  skillRunView,
} from "./skillRuns";

const mission = (patch: Partial<MissionRecord> = {}): MissionRecord => ({
  id: "ai-1",
  kind: "skill",
  startedAt: "2026-05-12T00:00:00.000Z",
  lastOutputAt: "2026-05-12T00:00:05.000Z",
  status: "running",
  exitCode: null,
  outputLogPath: null,
  metadata: {
    skillName: "meeting-notes",
    runtime: "codex",
    workspacePath: "/tmp/work",
    inputPaths: ["/tmp/a.md"],
  },
  ...patch,
});

const event = (type: string, payload: unknown): AgentRunEvent => ({
  id: `event-${type}`,
  runId: "ai-1",
  ts: "2026-05-12T00:00:01.000Z",
  type,
  actor: "test",
  payload,
  schemaVersion: "anchor_agent_run_event_v1",
});

describe("skill run helpers", () => {
  it("identifies generic skill missions", () => {
    expect(isSkillMission(mission())).toBe(true);
    expect(isSkillMission(mission({ kind: "claude" }))).toBe(false);
    const structured = mission({
      kind: "codex",
      metadata: {
        origin: "structuredLoop",
        runtime: "codex",
        skillName: "Structured run",
        workspacePath: "/tmp/work",
      },
    });
    expect(isStructuredMission(structured)).toBe(true);
    expect(isTrackedAgentMission(structured)).toBe(true);
    expect(skillRunView(structured).canStop).toBe(false);
  });

  it("strips stream prefixes and classifies severity", () => {
    expect(formatSkillRunLogLine("[stdout] proposal ready")).toMatchObject({
      text: "proposal ready",
      severity: "info",
    });
    expect(formatSkillRunLogLine("- [stderr] permission denied")).toMatchObject({
      text: "permission denied",
      severity: "error",
    });
  });

  it("derives phases from mission and proposal state", () => {
    expect(deriveSkillRunPhase(mission(), [])).toBe("running");
    expect(deriveSkillRunPhase(mission({ status: "done" }), [])).toBe("proposal");
    expect(deriveSkillRunPhase(mission({ status: "done" }), [], { reviewLoaded: true })).toBe("review");
    expect(deriveSkillRunPhase(mission({ status: "done" }), [], { applied: true })).toBe("applied");
    expect(deriveSkillRunPhase(mission({ status: "failed", exitCode: 1 }), [])).toBe("failed");
  });

  it("builds display view with runtime metadata", () => {
    const view = skillRunView(mission(), ["[stdout] working"], { now: Date.parse("2026-05-12T00:00:10.000Z") });
    expect(view.skillName).toBe("meeting-notes");
    expect(view.runtime).toBe("codex");
    expect(view.elapsedMs).toBe(10_000);
    expect(view.latestLog).toBe("working");
  });

  it("extracts retry request from run started event", () => {
    const retry = extractSkillRunRetryRequest([
      event("run.started", {
        dispatch: {
          skillId: "builtin:meeting-notes",
          runtime: "claude",
          prompt: "summarize",
          cwd: "/tmp/work",
          context: [{ path: "/tmp/a.md", kind: "file" }],
          commandOverride: "/opt/bin/claude",
          permissionMode: "acceptEdits",
        },
      }),
    ]);
    expect(retry).toEqual({
      skillId: "builtin:meeting-notes",
      runtime: "claude",
      prompt: "summarize",
      cwd: "/tmp/work",
      context: [{ path: "/tmp/a.md", kind: "file" }],
      commandOverride: "/opt/bin/claude",
      permissionMode: "acceptEdits",
    });
  });

  it("formats elapsed time", () => {
    expect(formatElapsed(2_000)).toBe("2s");
    expect(formatElapsed(65_000)).toBe("1m 5s");
  });
});
