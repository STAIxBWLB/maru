import { describe, expect, it } from "vitest";
import {
  activeImplementationDraft,
  buildIdeateToDraftPrompt,
  countImplementationDraftsByIdea,
  IMPLEMENTATION_DRAFT_MISSION_KIND,
  IMPLEMENTATION_DRAFT_SCHEMA_VERSION,
  implementationDraftMissionIdeaPath,
  implementationDraftsForIdea,
  isCompletedImplementationDraftMission,
  parseImplementationDraftArtifact,
} from "../lib/ideationDrafts";
import type { DraftEntry, MissionRecord } from "../lib/types";

const IDEA_PATH = "ideas/maru-vault-graph.md";

function artifactJson(fields: Record<string, unknown>): string {
  return JSON.stringify({
    schemaVersion: IMPLEMENTATION_DRAFT_SCHEMA_VERSION,
    ...fields,
  });
}

function draft(overrides: Partial<DraftEntry>): DraftEntry {
  return {
    id: "d1",
    kind: "implementation",
    title: "Draft",
    status: "new",
    source: "claude",
    originRefs: [IDEA_PATH],
    bodyPath: ".maru/drafts/d1/body.md",
    createdAt: "2026-07-01T00:00:00Z",
    updatedAt: "2026-07-01T00:00:00Z",
    ...overrides,
  };
}

function mission(overrides: Partial<MissionRecord>): MissionRecord {
  return {
    id: "ai-1",
    kind: "skill",
    startedAt: "2026-07-30T00:00:00Z",
    lastOutputAt: "2026-07-30T00:01:00Z",
    status: "done",
    exitCode: 0,
    outputLogPath: null,
    metadata: { kind: IMPLEMENTATION_DRAFT_MISSION_KIND, ideaPath: IDEA_PATH },
    ...overrides,
  };
}

describe("parseImplementationDraftArtifact", () => {
  it("parses a fenced artifact and normalizes fields", () => {
    const raw = [
      "[phase:review] done",
      "```json",
      artifactJson({
        title: "  볼트 그래프 뷰 구현  ",
        confidence: 1.4,
        draftBody: "# 본문\n\n## 개요",
      }),
      "```",
    ].join("\n");
    expect(parseImplementationDraftArtifact(raw)).toEqual({
      schemaVersion: IMPLEMENTATION_DRAFT_SCHEMA_VERSION,
      title: "볼트 그래프 뷰 구현",
      confidence: 1,
      draftBody: "# 본문\n\n## 개요",
    });
  });

  it("parses a bare JSON object without a fence", () => {
    const artifact = parseImplementationDraftArtifact(
      `log\n${artifactJson({ title: "Plan" })}`,
    );
    expect(artifact).toMatchObject({ title: "Plan", confidence: null, draftBody: "" });
  });

  it("prefers the last artifact when the skill body example is also present", () => {
    const raw = `${artifactJson({ title: "example" })}\n${artifactJson({ title: "real" })}`;
    expect(parseImplementationDraftArtifact(raw)?.title).toBe("real");
  });

  it("rejects other schema versions, missing titles, and non-JSON input", () => {
    expect(
      parseImplementationDraftArtifact('{"schemaVersion":"maru_task_candidates_v1"}'),
    ).toBeNull();
    expect(parseImplementationDraftArtifact(artifactJson({ title: "  " }))).toBeNull();
    expect(parseImplementationDraftArtifact("no json here")).toBeNull();
  });
});

describe("buildIdeateToDraftPrompt", () => {
  it("embeds the mode, title, path, and content", () => {
    const prompt = buildIdeateToDraftPrompt({
      title: "maru-vault-graph.md",
      relativePath: IDEA_PATH,
      content: "  아이디어 본문  ",
    });
    expect(prompt).toContain("ideation-drafts ideate-to-draft");
    expect(prompt).toContain(`Idea path: ${IDEA_PATH}`);
    expect(prompt).toContain("아이디어 본문");
  });

  it("marks empty content explicitly", () => {
    const prompt = buildIdeateToDraftPrompt({
      title: "t",
      relativePath: IDEA_PATH,
      content: "   ",
    });
    expect(prompt).toContain("(empty)");
  });
});

describe("implementationDraftMissionIdeaPath / isCompletedImplementationDraftMission", () => {
  it("reads the idea path only from implementation-draft skill missions", () => {
    expect(implementationDraftMissionIdeaPath(mission({}))).toBe(IDEA_PATH);
    expect(implementationDraftMissionIdeaPath(mission({ kind: "structured" }))).toBeNull();
    expect(implementationDraftMissionIdeaPath(mission({ metadata: null }))).toBeNull();
    expect(
      implementationDraftMissionIdeaPath(mission({ metadata: { kind: "other", ideaPath: IDEA_PATH } })),
    ).toBeNull();
    expect(
      implementationDraftMissionIdeaPath(
        mission({ metadata: { kind: IMPLEMENTATION_DRAFT_MISSION_KIND } }),
      ),
    ).toBeNull();
  });

  it("accepts done implementation-draft missions only", () => {
    expect(isCompletedImplementationDraftMission(mission({}))).toBe(true);
    expect(isCompletedImplementationDraftMission(mission({ status: "running" }))).toBe(false);
    expect(isCompletedImplementationDraftMission(mission({ status: "failed" }))).toBe(false);
    expect(isCompletedImplementationDraftMission(mission({ metadata: { scheduler: true } }))).toBe(
      false,
    );
  });
});

describe("implementationDraftsForIdea", () => {
  it("matches implementation drafts by originRef, newest first", () => {
    const drafts = [
      draft({ id: "old", updatedAt: "2026-07-01T00:00:00Z" }),
      draft({ id: "new", updatedAt: "2026-07-02T00:00:00Z" }),
      draft({ id: "task", kind: "task", updatedAt: "2026-07-03T00:00:00Z" }),
      draft({ id: "other", originRefs: ["ideas/other.md"], updatedAt: "2026-07-04T00:00:00Z" }),
    ];
    expect(implementationDraftsForIdea(drafts, IDEA_PATH).map((entry) => entry.id)).toEqual([
      "new",
      "old",
    ]);
  });
});

describe("activeImplementationDraft (duplicate guard)", () => {
  it("returns the newest non-discarded draft for the idea", () => {
    const drafts = [
      draft({ id: "discarded-new", status: "discarded", updatedAt: "2026-07-02T00:00:00Z" }),
      draft({ id: "active-old", status: "in-review", updatedAt: "2026-07-01T00:00:00Z" }),
    ];
    expect(activeImplementationDraft(drafts, IDEA_PATH)?.id).toBe("active-old");
  });

  it("returns null when only discarded drafts exist", () => {
    expect(
      activeImplementationDraft([draft({ status: "discarded" })], IDEA_PATH),
    ).toBeNull();
  });

  it("returns null for ideas without drafts", () => {
    expect(activeImplementationDraft([draft({})], "ideas/other.md")).toBeNull();
  });
});

describe("countImplementationDraftsByIdea", () => {
  it("counts non-discarded implementation drafts per idea path", () => {
    const counts = countImplementationDraftsByIdea([
      draft({ id: "a", originRefs: [IDEA_PATH] }),
      draft({ id: "b", originRefs: [IDEA_PATH], status: "accepted" }),
      draft({ id: "c", originRefs: [IDEA_PATH], status: "discarded" }),
      draft({ id: "d", kind: "task", originRefs: [IDEA_PATH] }),
      draft({ id: "e", originRefs: ["ideas/other.md"] }),
    ]);
    expect(counts.get(IDEA_PATH)).toBe(2);
    expect(counts.get("ideas/other.md")).toBe(1);
  });
});
