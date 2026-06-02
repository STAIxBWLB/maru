import { describe, expect, it } from "vitest";
import {
  TASK_REVIEW_SCHEMA_VERSION,
  createTaskReviewChecks,
  deriveTaskRunSteps,
  parseTaskReviewArtifact,
  selectedTaskFollowupCount,
  taskReviewCanApply,
  taskReviewChecksComplete,
} from "./taskReview";

describe("task review parsing", () => {
  it("parses fenced anchor_task_review_v1 artifacts", () => {
    const artifact = parseTaskReviewArtifact(`
logs
\`\`\`json
{
  "schemaVersion": "${TASK_REVIEW_SCHEMA_VERSION}",
  "summary": "ready",
  "taskDetails": { "title": "Ship report", "status": "active", "priority": "high", "due": "2026-06-10" },
  "fields": [{"label": "title", "normalized": "Ship Q2 report"}],
  "schedule": [{"label": "tomorrow 3pm", "normalized": "2026-06-10T15:00+09:00", "note": "Asia/Seoul"}],
  "conflicts": [{"label": "overlaps standup", "normalized": "move", "conflictKind": "calendar", "required": true}],
  "uncertainties": [{"label": "owner?", "note": "missing"}],
  "enrichment": { "project": "[[Q2]]", "relatedTasks": ["[[t1]]"], "calendarLink": { "calendarId": "c1", "calendarEventId": null }, "resolvedAssignee": "Lee" },
  "followups": [{"skill": "vault-extract", "title": "Extract", "prompt": "Extract", "selected": true}]
}
\`\`\`
`);

    expect(artifact?.summary).toBe("ready");
    expect(artifact?.taskDetails).toMatchObject({ title: "Ship report", priority: "high", due: "2026-06-10" });
    expect(artifact?.fields[0]).toMatchObject({ label: "title", normalized: "Ship Q2 report", required: true });
    expect(artifact?.schedule[0].normalized).toBe("2026-06-10T15:00+09:00");
    expect(artifact?.conflicts[0]).toMatchObject({ conflictKind: "calendar", normalized: "move" });
    expect(artifact?.enrichment?.calendarLink?.calendarId).toBe("c1");
    expect(artifact?.followups[0].skill).toBe("vault-extract");
  });

  it("prefers the final review artifact over a skill-body schema example", () => {
    const artifact = parseTaskReviewArtifact(`
\`\`\`json
{ "schemaVersion": "${TASK_REVIEW_SCHEMA_VERSION}", "summary": "example", "fields": [{ "label": "x", "normalized": "y" }] }
\`\`\`

[phase:review] ready
\`\`\`json
{ "schemaVersion": "${TASK_REVIEW_SCHEMA_VERSION}", "summary": "actual", "fields": [{ "label": "real", "normalized": "done" }] }
\`\`\`
`);

    expect(artifact?.summary).toBe("actual");
    expect(artifact?.fields[0].label).toBe("real");
  });

  it("returns null for malformed or missing task review artifacts", () => {
    expect(parseTaskReviewArtifact("no json here")).toBeNull();
    expect(parseTaskReviewArtifact("```json\n{\"schemaVersion\":\"other\"}\n```")).toBeNull();
  });

  it("drops self-referential task-management followups and keeps allowed ones", () => {
    const artifact = parseTaskReviewArtifact(JSON.stringify({
      schemaVersion: TASK_REVIEW_SCHEMA_VERSION,
      followups: [
        { skill: "task-management", title: "self", prompt: "no" },
        { skill: "meeting-notes", title: "backlink", prompt: "link" },
        { skill: "vault-connect", title: "connect", prompt: "connect" },
      ],
    }));
    expect(artifact?.followups.map((f) => f.skill)).toEqual(["meeting-notes", "vault-connect"]);
  });

  it("gates apply until required checks are reviewed", () => {
    const artifact = parseTaskReviewArtifact(JSON.stringify({
      schemaVersion: TASK_REVIEW_SCHEMA_VERSION,
      fields: [{ label: "title" }],
      conflicts: [{ label: "optional", required: false }],
    }));
    const checks = createTaskReviewChecks(artifact!);

    expect(taskReviewChecksComplete(checks)).toBe(false);
    expect(taskReviewChecksComplete(checks.map((check) => ({
      ...check,
      status: check.required ? "accepted" : "pending",
    })))).toBe(true);
  });
});

describe("task review apply readiness", () => {
  const followup = {
    id: "followup-1",
    skill: "vault-connect",
    title: "Connect",
    prompt: "Connect",
    reason: "Useful",
    selected: true,
  };

  it("allows follow-up only apply once checks complete", () => {
    expect(selectedTaskFollowupCount([followup])).toBe(1);
    expect(taskReviewCanApply({ proposal: null, files: [], followups: [followup], checksComplete: true })).toBe(true);
  });

  it("keeps apply blocked when nothing is selected or checks remain", () => {
    expect(taskReviewCanApply({ proposal: null, files: [], followups: [], checksComplete: true })).toBe(false);
    expect(taskReviewCanApply({ proposal: null, files: [], followups: [followup], checksComplete: false })).toBe(false);
  });
});

describe("task run step derivation", () => {
  it("recognizes draft/proposal phases and the task review artifact", () => {
    const steps = deriveTaskRunSteps({
      missionStatus: "running",
      logLines: ["[phase:draft] drafting", "[phase:proposal] proposal ready"],
    });
    expect(stepStatus(steps, "run")).toBe("active");
    expect(stepStatus(steps, "draft")).toBe("complete");

    const reviewing = deriveTaskRunSteps({
      missionStatus: "done",
      logLines: ["produced anchor_task_review_v1"],
      reviewLoaded: true,
      checksComplete: false,
    });
    expect(stepStatus(reviewing, "review")).toBe("complete");
    expect(stepStatus(reviewing, "confirm")).toBe("blocked");
  });

  it("carries failed runs as errors", () => {
    const failed = deriveTaskRunSteps({ missionStatus: "failed" });
    expect(stepStatus(failed, "run")).toBe("error");
    expect(stepStatus(failed, "apply")).toBe("error");
  });
});

function stepStatus(
  steps: ReturnType<typeof deriveTaskRunSteps>,
  id: ReturnType<typeof deriveTaskRunSteps>[number]["id"],
) {
  return steps.find((step) => step.id === id)?.status;
}
