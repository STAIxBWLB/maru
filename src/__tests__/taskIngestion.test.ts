import { describe, expect, it } from "vitest";
import {
  importanceRank,
  isCompletedSchedulerSkillMission,
  normalizeDraftTitleKey,
  parseTaskCandidatesArtifact,
  selectTaskCandidates,
  TASK_CANDIDATES_SCHEMA_VERSION,
  type TaskCandidate,
} from "../lib/taskIngestion";
import type { DraftEntry, MissionRecord } from "../lib/types";

function candidate(overrides: Partial<TaskCandidate>): TaskCandidate {
  return {
    title: "Task",
    importance: "medium",
    confidence: 0.5,
    originRefs: ["meetings/2026-07-28-weekly.md"],
    summary: "summary",
    draftBody: "body",
    ...overrides,
  };
}

function draft(overrides: Partial<DraftEntry>): DraftEntry {
  return {
    id: "d1",
    kind: "task",
    title: "Draft",
    status: "new",
    source: "claude",
    originRefs: [],
    bodyPath: ".maru/drafts/d1/body.md",
    createdAt: "2026-07-01T00:00:00Z",
    updatedAt: "2026-07-01T00:00:00Z",
    ...overrides,
  };
}

function artifactJson(candidates: unknown[]): string {
  return JSON.stringify({
    schemaVersion: TASK_CANDIDATES_SCHEMA_VERSION,
    summary: "batch",
    candidates,
  });
}

describe("parseTaskCandidatesArtifact", () => {
  it("parses a fenced artifact and normalizes candidates", () => {
    const raw = [
      "log line",
      "```json",
      artifactJson([
        {
          title: "  예산 검토 준비  ",
          importance: "HIGH",
          confidence: 1.4,
          originRefs: ["inbox/items/pending/a/summary.md", 42, " "],
          summary: "요약",
          draftBody: "# 본문",
        },
      ]),
      "```",
    ].join("\n");
    const artifact = parseTaskCandidatesArtifact(raw);
    expect(artifact).not.toBeNull();
    expect(artifact?.candidates).toEqual([
      {
        title: "예산 검토 준비",
        importance: "high",
        confidence: 1,
        originRefs: ["inbox/items/pending/a/summary.md"],
        summary: "요약",
        draftBody: "# 본문",
      },
    ]);
  });

  it("parses a bare JSON object without a fence", () => {
    const artifact = parseTaskCandidatesArtifact(
      `done\n${artifactJson([{ title: "Follow up", importance: "low" }])}`,
    );
    expect(artifact?.candidates).toHaveLength(1);
    expect(artifact?.candidates[0]).toMatchObject({
      title: "Follow up",
      importance: "low",
      confidence: null,
      originRefs: [],
      summary: "",
      draftBody: "",
    });
  });

  it("prefers the last artifact when the skill body example is also present", () => {
    const raw = `${artifactJson([{ title: "example" }])}\n${artifactJson([{ title: "real" }])}`;
    const artifact = parseTaskCandidatesArtifact(raw);
    expect(artifact?.candidates.map((item) => item.title)).toEqual(["real"]);
  });

  it("rejects other schema versions and missing artifacts", () => {
    expect(parseTaskCandidatesArtifact('{"schemaVersion":"maru_inbox_review_v1","items":[]}')).toBeNull();
    expect(parseTaskCandidatesArtifact("no json here")).toBeNull();
  });

  it("drops candidates without a title and defaults importance/confidence", () => {
    const artifact = parseTaskCandidatesArtifact(
      artifactJson([
        { title: "  " },
        { title: "Keeps", importance: "weird", confidence: "high" },
      ]),
    );
    expect(artifact?.candidates).toHaveLength(1);
    expect(artifact?.candidates[0]).toMatchObject({
      title: "Keeps",
      importance: "medium",
      confidence: null,
    });
  });
});

describe("normalizeDraftTitleKey", () => {
  it("ignores case, punctuation, and whitespace differences", () => {
    expect(normalizeDraftTitleKey("Review weekly report")).toBe(
      normalizeDraftTitleKey("review  weekly-report!"),
    );
    expect(normalizeDraftTitleKey("  예산 검토 준비 ")).toBe("예산 검토 준비");
  });
});

describe("selectTaskCandidates", () => {
  it("filters candidates below the importance threshold", () => {
    const selection = selectTaskCandidates(
      [
        candidate({ title: "high", importance: "high" }),
        candidate({ title: "medium", importance: "medium" }),
        candidate({ title: "low", importance: "low" }),
      ],
      [],
      "medium",
    );
    expect(selection.create.map((item) => item.title)).toEqual(["high", "medium"]);
    expect(selection.skippedLow).toEqual(["low"]);
    expect(selection.skippedDup).toEqual([]);
  });

  it("skips titles matching an existing non-discarded draft", () => {
    const selection = selectTaskCandidates(
      [candidate({ title: "Review Weekly Report!" }), candidate({ title: "Fresh" })],
      [draft({ title: "review weekly report", status: "in-review" })],
      "low",
    );
    expect(selection.create.map((item) => item.title)).toEqual(["Fresh"]);
    expect(selection.skippedDup).toEqual(["Review Weekly Report!"]);
  });

  it("does not treat discarded drafts as duplicates", () => {
    const selection = selectTaskCandidates(
      [candidate({ title: "Revived" })],
      [draft({ title: "Revived", status: "discarded" })],
      "low",
    );
    expect(selection.create.map((item) => item.title)).toEqual(["Revived"]);
  });

  it("collapses duplicates inside the batch", () => {
    const selection = selectTaskCandidates(
      [candidate({ title: "Same task" }), candidate({ title: "same  Task" })],
      [],
      "low",
    );
    expect(selection.create).toHaveLength(1);
    expect(selection.skippedDup).toEqual(["same  Task"]);
  });
});

describe("importanceRank", () => {
  it("orders low < medium < high", () => {
    expect(importanceRank("low")).toBeLessThan(importanceRank("medium"));
    expect(importanceRank("medium")).toBeLessThan(importanceRank("high"));
  });
});

describe("isCompletedSchedulerSkillMission", () => {
  function mission(overrides: Partial<MissionRecord>): MissionRecord {
    return {
      id: "ai-1",
      kind: "skill",
      startedAt: "2026-07-30T00:00:00Z",
      lastOutputAt: "2026-07-30T00:01:00Z",
      status: "done",
      exitCode: 0,
      outputLogPath: null,
      metadata: { scheduler: true, scheduleId: "s-1" },
      ...overrides,
    };
  }

  it("accepts done scheduler skill missions only", () => {
    expect(isCompletedSchedulerSkillMission(mission({}))).toBe(true);
    expect(isCompletedSchedulerSkillMission(mission({ status: "running" }))).toBe(false);
    expect(isCompletedSchedulerSkillMission(mission({ kind: "structured" }))).toBe(false);
    expect(isCompletedSchedulerSkillMission(mission({ metadata: null }))).toBe(false);
    expect(isCompletedSchedulerSkillMission(mission({ metadata: { scheduler: false } }))).toBe(false);
  });
});
