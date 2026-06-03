import { describe, expect, it } from "vitest";
import {
  INBOX_REVIEW_SCHEMA_VERSION,
  buildInboxApplyDecisions,
  createInboxItemDecisions,
  deriveInboxRunSteps,
  inboxReviewCanApply,
  inboxReviewDecisionsComplete,
  parseInboxReviewArtifact,
  statusAfterInboxMetadataEdit,
  type InboxItemDecision,
} from "./inboxReview";

describe("inbox review parsing", () => {
  it("parses a fenced inbox review artifact with per-item decisions", () => {
    const artifact = parseInboxReviewArtifact(`
logs
\`\`\`json
{
  "schemaVersion": "${INBOX_REVIEW_SCHEMA_VERSION}",
  "summary": "2 items",
  "items": [
    { "itemId": "260604-kakao-a", "itemDir": "inbox/items/pending/260604-kakao-a", "title": "Memo", "channel": "kakao", "classification": "action", "project": "rise", "destination": "projects/rise/inbox", "confidence": "high", "summaryPreview": "p", "recommendedAction": "route" },
    { "itemId": "260604-mso-b", "title": "Mail", "channel": "mso", "classification": "noise", "confidence": "low", "recommendedAction": "reject" }
  ]
}
\`\`\`
`);
    expect(artifact?.summary).toBe("2 items");
    expect(artifact?.items).toHaveLength(2);
    expect(artifact?.items[0]).toMatchObject({
      itemId: "260604-kakao-a",
      classification: "action",
      project: "rise",
      destination: "projects/rise/inbox",
      confidence: "high",
      requiresConfirmation: false,
    });
    // low confidence + noise + reject all force confirmation.
    expect(artifact?.items[1].requiresConfirmation).toBe(true);
    expect(artifact?.items[1].classification).toBe("noise");
  });

  it("prefers the final artifact over an embedded schema example", () => {
    const raw = [
      "```json",
      JSON.stringify({ schemaVersion: INBOX_REVIEW_SCHEMA_VERSION, summary: "example", items: [] }),
      "```",
      "[phase:review] ready",
      "```json",
      JSON.stringify({
        schemaVersion: INBOX_REVIEW_SCHEMA_VERSION,
        summary: "actual",
        items: [
          {
            itemId: "x",
            itemDir: "inbox/items/pending/x",
            title: "X",
            channel: "kakao",
            classification: "info",
            confidence: "medium",
            recommendedAction: "route",
          },
        ],
      }),
      "```",
    ].join("\n");
    const artifact = parseInboxReviewArtifact(raw);
    expect(artifact?.summary).toBe("actual");
    expect(artifact?.items[0].itemId).toBe("x");
  });

  it("returns null for malformed or mismatched artifacts", () => {
    expect(parseInboxReviewArtifact("no json")).toBeNull();
    expect(parseInboxReviewArtifact('```json\n{"schemaVersion":"other"}\n```')).toBeNull();
  });
});

describe("inbox decision gating", () => {
  it("seeds confident routes as accepted and uncertain items as pending", () => {
    const artifact = parseInboxReviewArtifact(
      JSON.stringify({
        schemaVersion: INBOX_REVIEW_SCHEMA_VERSION,
        items: [
          { itemId: "a", itemDir: "d/a", title: "A", channel: "k", classification: "action", confidence: "high", recommendedAction: "route" },
          { itemId: "b", itemDir: "d/b", title: "B", channel: "k", classification: "info", confidence: "low", recommendedAction: "route" },
        ],
      }),
    );
    const decisions = createInboxItemDecisions(artifact!);
    expect(decisions[0].status).toBe("accepted");
    expect(decisions[1].status).toBe("pending");
    expect(inboxReviewDecisionsComplete(decisions)).toBe(false);
    const resolved = decisions.map((d) => (d.requiresConfirmation ? { ...d, status: "accepted" as const } : d));
    expect(inboxReviewDecisionsComplete(resolved)).toBe(true);
    expect(inboxReviewCanApply({ decisions: resolved, decisionsComplete: true })).toBe(true);
  });

  it("blocks apply when nothing is actionable", () => {
    expect(inboxReviewCanApply({ decisions: [], decisionsComplete: true })).toBe(false);
  });

  it("preserves rejected status for metadata edits and marks other edits", () => {
    expect(statusAfterInboxMetadataEdit("rejected")).toBe("rejected");
    expect(statusAfterInboxMetadataEdit("deferred")).toBe("deferred");
    expect(statusAfterInboxMetadataEdit("accepted")).toBe("edited");
    expect(statusAfterInboxMetadataEdit("pending")).toBe("edited");
    expect(statusAfterInboxMetadataEdit("edited")).toBe("edited");
  });

  it("treats deferred required items as confirmed but keeps them out of the backend payload", () => {
    const pending = [decision("a", "pending", { requiresConfirmation: true })];
    expect(inboxReviewDecisionsComplete(pending)).toBe(false);
    expect(inboxReviewCanApply({ decisions: pending, decisionsComplete: false })).toBe(false);

    const deferred = [decision("a", "deferred", { requiresConfirmation: true })];
    expect(inboxReviewDecisionsComplete(deferred)).toBe(true);
    expect(inboxReviewCanApply({ decisions: deferred, decisionsComplete: true })).toBe(true);
    expect(buildInboxApplyDecisions(deferred)).toEqual([]);
  });

  it("maps decisions to the rust apply payload, skipping pending and deferred items", () => {
    const decisions: InboxItemDecision[] = [
      decision("a", "accepted", { destination: "projects/x" }),
      decision("b", "rejected", {
        destination: "projects/ignored",
        classification: "schedule",
        project: "rise",
      }),
      decision("c", "pending"),
      decision("d", "edited", { destination: "projects/y", classification: "schedule" }),
      decision("e", "deferred", { destination: "projects/deferred", classification: "info" }),
    ];
    const payload = buildInboxApplyDecisions(decisions);
    expect(payload).toHaveLength(3);
    expect(payload[0]).toMatchObject({ itemDir: "inbox/items/pending/a", decision: "accept", destination: "projects/x" });
    expect(payload[1]).toMatchObject({
      decision: "reject",
      destination: null,
      classification: "schedule",
      project: "rise",
    });
    expect(payload[2]).toMatchObject({ decision: "accept", destination: "projects/y", classification: "schedule" });
  });

  it("allows mixed deferred decisions while applying only route and reject decisions", () => {
    const decisions: InboxItemDecision[] = [
      decision("route", "accepted", { requiresConfirmation: true, destination: "projects/rise/inbox" }),
      decision("reject", "rejected", { requiresConfirmation: true }),
      decision("media", "deferred", { requiresConfirmation: true }),
    ];

    expect(inboxReviewDecisionsComplete(decisions)).toBe(true);
    expect(inboxReviewCanApply({ decisions, decisionsComplete: true })).toBe(true);
    expect(buildInboxApplyDecisions(decisions).map((item) => item.decision)).toEqual(["accept", "reject"]);
  });
});

describe("inbox run step derivation", () => {
  it("activates run and completes draft during extraction phases", () => {
    const steps = deriveInboxRunSteps({
      missionStatus: "running",
      logLines: ["[phase:source] x", "[phase:extract] y"],
    });
    expect(stepStatus(steps, "run")).toBe("active");
    expect(stepStatus(steps, "draft")).toBe("complete");
    expect(stepStatus(steps, "review")).toBe("pending");
  });

  it("blocks confirm until required decisions are resolved", () => {
    const steps = deriveInboxRunSteps({ missionStatus: "done", reviewLoaded: true, decisionsComplete: false });
    expect(stepStatus(steps, "review")).toBe("complete");
    expect(stepStatus(steps, "confirm")).toBe("blocked");
    expect(stepStatus(steps, "apply")).toBe("pending");
  });

  it("completes apply after the routes are applied", () => {
    const steps = deriveInboxRunSteps({
      missionStatus: "done",
      reviewLoaded: true,
      decisionsComplete: true,
      applied: true,
    });
    expect(stepStatus(steps, "confirm")).toBe("complete");
    expect(stepStatus(steps, "apply")).toBe("complete");
  });

  it("carries failed runs into the step timeline as errors", () => {
    const steps = deriveInboxRunSteps({ missionStatus: "failed" });
    expect(stepStatus(steps, "run")).toBe("error");
    expect(stepStatus(steps, "apply")).toBe("error");
  });
});

function decision(
  id: string,
  status: InboxItemDecision["status"],
  extra: Partial<InboxItemDecision> = {},
): InboxItemDecision {
  return {
    itemId: id,
    id,
    itemDir: `inbox/items/pending/${id}`,
    title: id.toUpperCase(),
    channel: "kakao",
    classification: "action",
    project: null,
    destination: null,
    confidence: "high",
    summaryPreview: "",
    requiresConfirmation: false,
    recommendedAction: "route",
    note: "",
    status,
    ...extra,
  };
}

function stepStatus(
  steps: ReturnType<typeof deriveInboxRunSteps>,
  id: ReturnType<typeof deriveInboxRunSteps>[number]["id"],
) {
  return steps.find((step) => step.id === id)?.status;
}
