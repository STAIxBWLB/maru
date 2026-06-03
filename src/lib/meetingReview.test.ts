import { describe, expect, it } from "vitest";
import {
  MEETING_REVIEW_SCHEMA_VERSION,
  createMeetingReviewChecks,
  deriveMeetingRunSteps,
  extractProviderOutput,
  extractSkillProposal,
  meetingReviewCanApply,
  meetingReviewChecksComplete,
  parseMeetingReviewArtifact,
  rebuildSkillProposal,
  selectedMeetingFollowupCount,
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

  it("prefers the final review artifact over a skill-body schema example", () => {
    const artifact = parseMeetingReviewArtifact(`
\`\`\`json
{
  "schemaVersion": "${MEETING_REVIEW_SCHEMA_VERSION}",
  "summary": "short review summary",
  "terms": [
    { "label": "source term", "normalized": "workspace term", "note": "why", "required": true }
  ],
  "people": [
    { "label": "source person", "normalized": "canonical person", "note": "role", "required": true }
  ],
  "properNouns": [
    { "label": "source name", "normalized": "canonical name", "note": "context", "required": true }
  ],
  "uncertainties": [
    { "label": "uncertain item", "normalized": "best guess", "note": "needs user check", "required": true }
  ],
  "followups": [
    { "skill": "task-management", "title": "Create task from action item", "prompt": "proposal-only follow-up prompt", "reason": "why this is useful" }
  ]
}
\`\`\`

[phase:review] Proposal and review ready.
\`\`\`json
{
  "schemaVersion": "${MEETING_REVIEW_SCHEMA_VERSION}",
  "summary": "actual review",
  "terms": [
    { "label": "AI-900", "normalized": "Microsoft Azure AI-900", "note": "certification context", "required": true }
  ],
  "people": [
    { "label": "Rose", "normalized": "서현영 (Rose Seo)", "note": "resolved instructor", "required": true }
  ],
  "properNouns": [
    { "label": "KOICA", "normalized": "Korea International Cooperation Agency", "note": "project org", "required": true }
  ],
  "uncertainties": [
    { "label": "Venue", "normalized": "미상", "note": "missing in source", "required": true }
  ],
  "followups": [
    { "skill": "vault-extract", "title": "Extract AI-900 patterns", "prompt": "Extract", "reason": "Reusable" }
  ]
}
\`\`\`
`);

    expect(artifact?.summary).toBe("actual review");
    expect(artifact?.terms[0]).toMatchObject({
      label: "AI-900",
      normalized: "Microsoft Azure AI-900",
    });
    expect(artifact?.people[0].label).toBe("Rose");
    expect(artifact?.properNouns[0].label).toBe("KOICA");
    expect(artifact?.uncertainties[0].label).toBe("Venue");
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

describe("meeting review apply readiness", () => {
  it("allows follow-up only apply after required checks are complete", () => {
    expect(selectedMeetingFollowupCount([
      {
        id: "followup-1",
        skill: "vault-connect",
        title: "Connect",
        prompt: "Connect",
        reason: "Useful",
        selected: true,
      },
    ])).toBe(1);
    expect(meetingReviewCanApply({
      proposal: null,
      files: [],
      followups: [
        {
          id: "followup-1",
          skill: "vault-connect",
          title: "Connect",
          prompt: "Connect",
          reason: "Useful",
          selected: true,
        },
      ],
      checksComplete: true,
    })).toBe(true);
  });

  it("keeps apply blocked when nothing is selected or checks remain", () => {
    const followups = [
      {
        id: "followup-1",
        skill: "vault-connect",
        title: "Connect",
        prompt: "Connect",
        reason: "Useful",
        selected: true,
      },
    ];

    expect(meetingReviewCanApply({
      proposal: null,
      files: [],
      followups: [],
      checksComplete: true,
    })).toBe(false);
    expect(meetingReviewCanApply({
      proposal: null,
      files: [],
      followups,
      checksComplete: false,
    })).toBe(false);
  });

  it("allows approved continuation runs without proposal files", () => {
    expect(meetingReviewCanApply({
      proposal: null,
      files: [],
      followups: [],
      checksComplete: true,
      continuationAvailable: true,
    })).toBe(true);
  });
});

describe("meeting run step derivation", () => {
  it("marks running runs as executing and drafting", () => {
    const steps = deriveMeetingRunSteps({
      missionStatus: "running",
      logLines: ["[phase:source] reading", "[phase:normalize] guides"],
    });

    expect(stepStatus(steps, "input")).toBe("complete");
    expect(stepStatus(steps, "run")).toBe("active");
    expect(stepStatus(steps, "draft")).toBe("active");
    expect(stepStatus(steps, "review")).toBe("pending");
  });

  it("advances to review and blocks apply until required checks are complete", () => {
    const steps = deriveMeetingRunSteps({
      missionStatus: "done",
      logLines: ["[phase:proposal] proposal ready", "[phase:review] review ready"],
      reviewLoaded: true,
      checksComplete: false,
    });

    expect(stepStatus(steps, "draft")).toBe("complete");
    expect(stepStatus(steps, "review")).toBe("complete");
    expect(stepStatus(steps, "confirm")).toBe("blocked");
    expect(stepStatus(steps, "apply")).toBe("pending");
  });

  it("marks final apply complete after approval applies the proposal", () => {
    const steps = deriveMeetingRunSteps({
      missionStatus: "done",
      reviewLoaded: true,
      checksComplete: true,
      applied: true,
    });

    expect(stepStatus(steps, "confirm")).toBe("complete");
    expect(stepStatus(steps, "apply")).toBe("complete");
  });

  it("carries failed or stopped runs into the step timeline as errors", () => {
    const failed = deriveMeetingRunSteps({ missionStatus: "failed" });
    const stopped = deriveMeetingRunSteps({ missionStatus: "stopped" });

    expect(stepStatus(failed, "run")).toBe("error");
    expect(stepStatus(failed, "apply")).toBe("error");
    expect(stepStatus(stopped, "run")).toBe("error");
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

function stepStatus(
  steps: ReturnType<typeof deriveMeetingRunSteps>,
  id: ReturnType<typeof deriveMeetingRunSteps>[number]["id"],
) {
  return steps.find((step) => step.id === id)?.status;
}
