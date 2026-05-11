import { describe, expect, it } from "vitest";
import {
  MEETING_REVIEW_SCHEMA_VERSION,
  createMeetingReviewChecks,
  extractProviderOutput,
  extractSkillProposal,
  meetingReviewChecksComplete,
  parseMeetingReviewArtifact,
  rebuildSkillProposal,
  type MeetingProposalFileDraft,
} from "./meetingReview";
import type { AgentRunEvent, SkillProposal } from "./skills";

describe("meeting review parsing", () => {
  it("parses fenced meeting review artifacts", () => {
    const artifact = parseMeetingReviewArtifact(`
logs
\`\`\`json
{
  "schemaVersion": "${MEETING_REVIEW_SCHEMA_VERSION}",
  "summary": "ready",
  "terms": [{"label": "AI", "normalized": "Artificial Intelligence"}],
  "people": ["Lee"],
  "properNouns": [{"source": "Anchor", "required": false}],
  "uncertainties": [{"label": "date?", "note": "missing"}],
  "followups": [{"skill": "vault-extract", "title": "Extract", "prompt": "Extract", "selected": true}]
}
\`\`\`
`);

    expect(artifact?.summary).toBe("ready");
    expect(artifact?.terms[0]).toMatchObject({
      label: "AI",
      normalized: "Artificial Intelligence",
      required: true,
    });
    expect(artifact?.people[0].normalized).toBe("Lee");
    expect(artifact?.properNouns[0].required).toBe(false);
    expect(artifact?.followups[0].skill).toBe("vault-extract");
  });

  it("returns null for malformed or missing review artifacts", () => {
    expect(parseMeetingReviewArtifact("no json here")).toBeNull();
    expect(parseMeetingReviewArtifact("```json\n{\"schemaVersion\":\"other\"}\n```")).toBeNull();
    expect(parseMeetingReviewArtifact("```json\n{\"schemaVersion\":\n```")).toBeNull();
  });

  it("gates apply until required checks are reviewed", () => {
    const artifact = parseMeetingReviewArtifact(JSON.stringify({
      schemaVersion: MEETING_REVIEW_SCHEMA_VERSION,
      terms: [{ label: "term" }],
      properNouns: [{ label: "optional", required: false }],
    }));
    const checks = createMeetingReviewChecks(artifact!);

    expect(meetingReviewChecksComplete(checks)).toBe(false);
    expect(meetingReviewChecksComplete(checks.map((check) => ({
      ...check,
      status: check.required ? "accepted" : "pending",
    })))).toBe(true);
  });
});

describe("meeting run event extraction", () => {
  it("joins provider output lines and extracts proposal events", () => {
    const proposal: SkillProposal = {
      summary: "create note",
      files: [{ path: "meetings/a.md", operation: "create", content: "after" }],
      commands: [],
      risks: [],
      requiresApproval: true,
      schemaVersion: "anchor_skill_proposal_v1",
    };
    const events: AgentRunEvent[] = [
      event("provider.output", { line: "line 1" }),
      event("provider.output", { line: "line 2" }),
      event("proposal.created", { proposal }),
    ];

    expect(extractProviderOutput(events)).toBe("line 1\nline 2");
    expect(extractSkillProposal(events)?.files[0].path).toBe("meetings/a.md");
  });
});

describe("proposal rebuild", () => {
  it("keeps only selected edited file drafts", () => {
    const proposal: SkillProposal = {
      summary: "update",
      files: [],
      commands: [],
      risks: [],
      requiresApproval: true,
      schemaVersion: "anchor_skill_proposal_v1",
    };
    const drafts: MeetingProposalFileDraft[] = [
      {
        id: "a",
        selected: true,
        path: "meetings/a.md",
        operation: "create",
        beforeContent: "",
        afterContent: "after a",
      },
      {
        id: "b",
        selected: false,
        path: "meetings/b.md",
        operation: "create",
        beforeContent: "",
        afterContent: "after b",
      },
    ];

    const rebuilt = rebuildSkillProposal(proposal, drafts);

    expect(rebuilt.files).toHaveLength(1);
    expect(rebuilt.files[0]).toMatchObject({ path: "meetings/a.md", content: "after a" });
  });
});

function event(type: string, payload: unknown): AgentRunEvent {
  return {
    id: type,
    runId: "ai-test",
    ts: "2026-05-11T00:00:00Z",
    type,
    actor: "test",
    payload,
    schemaVersion: "anchor_agent_run_event_v1",
  };
}
