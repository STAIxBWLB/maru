import type { InboxApplyDecision } from "./types";
import {
  asRecord,
  extractJsonCandidates,
  safeParseRecord,
  stringValue,
  type UnknownRecord,
} from "./skillProposal";

// Inbox batch review flow. Mirrors `taskReview.ts`/`meetingReview.ts`, but the
// artifact is a LIST of per-item routing decisions (many items reviewed in one
// run) rather than one item's grouped checks.

export const INBOX_REVIEW_SCHEMA_VERSION = "anchor_inbox_review_v1";

export type InboxReviewClassification = "action" | "schedule" | "info" | "ideation" | "noise";
export type InboxConfidence = "high" | "medium" | "low";
export type InboxRecommendedAction = "route" | "reject" | "skip" | "handoff";
export type InboxItemDecisionStatus = "pending" | "accepted" | "edited" | "rejected";
export type InboxRunStepId = "input" | "run" | "draft" | "review" | "confirm" | "apply";
export type InboxRunStepStatus = "pending" | "active" | "complete" | "blocked" | "error";

export const INBOX_CLASSIFICATIONS: InboxReviewClassification[] = [
  "action",
  "schedule",
  "info",
  "ideation",
  "noise",
];

export interface InboxRunStep {
  id: InboxRunStepId;
  status: InboxRunStepStatus;
}

export interface InboxRunStepInput {
  missionStatus: string;
  logLines?: string[];
  reviewLoaded?: boolean;
  decisionsComplete?: boolean;
  applied?: boolean;
}

export interface InboxReviewItem {
  itemId: string;
  itemDir: string;
  title: string;
  channel: string;
  classification: InboxReviewClassification;
  project: string | null;
  destination: string | null;
  confidence: InboxConfidence;
  summaryPreview: string;
  requiresConfirmation: boolean;
  recommendedAction: InboxRecommendedAction;
  note: string;
}

export interface InboxReviewArtifact {
  schemaVersion: string;
  summary: string;
  items: InboxReviewItem[];
}

/** Editable per-item decision draft rendered as one card in the review panel. */
export interface InboxItemDecision extends InboxReviewItem {
  id: string;
  status: InboxItemDecisionStatus;
}

export function parseInboxReviewArtifact(raw: string): InboxReviewArtifact | null {
  // Prefer the final artifact when the skill body also embeds the example.
  for (const candidate of extractJsonCandidates(raw).reverse()) {
    const parsed = safeParseRecord(candidate);
    if (!parsed || parsed.schemaVersion !== INBOX_REVIEW_SCHEMA_VERSION) continue;
    return normalizeReviewArtifact(parsed);
  }
  return null;
}

export function emptyInboxReviewArtifact(summary = ""): InboxReviewArtifact {
  return { schemaVersion: INBOX_REVIEW_SCHEMA_VERSION, summary, items: [] };
}

export function createInboxItemDecisions(artifact: InboxReviewArtifact): InboxItemDecision[] {
  return artifact.items.map((item, index) => ({
    ...item,
    id: item.itemId || `item-${index + 1}`,
    status: defaultDecisionStatus(item),
  }));
}

/** Required (`requiresConfirmation`) items must leave the `pending` state. */
export function inboxReviewDecisionsComplete(decisions: InboxItemDecision[]): boolean {
  return decisions.every((decision) => !decision.requiresConfirmation || decision.status !== "pending");
}

/** Count items that will actually be applied (routed or rejected). */
export function selectedInboxDecisionCount(decisions: InboxItemDecision[]): number {
  return decisions.filter((decision) => decision.status !== "pending").length;
}

export function inboxReviewCanApply({
  decisions,
  decisionsComplete,
  applyBusy = false,
}: {
  decisions: InboxItemDecision[];
  decisionsComplete: boolean;
  applyBusy?: boolean;
}): boolean {
  if (applyBusy || !decisionsComplete) return false;
  return selectedInboxDecisionCount(decisions) > 0;
}

/** Map UI decisions to the Rust `apply_inbox_decisions` payload. Pending items
 *  (only non-required ones can still be pending) are dropped — left in place. */
export function buildInboxApplyDecisions(decisions: InboxItemDecision[]): InboxApplyDecision[] {
  const out: InboxApplyDecision[] = [];
  for (const decision of decisions) {
    if (!decision.itemDir) continue;
    if (decision.status === "rejected") {
      out.push({
        itemDir: decision.itemDir,
        decision: "reject",
        destination: null,
        classification: decision.classification,
        project: decision.project,
      });
    } else if (decision.status === "accepted" || decision.status === "edited") {
      out.push({
        itemDir: decision.itemDir,
        decision: "accept",
        destination: decision.destination,
        classification: decision.classification,
        project: decision.project,
      });
    }
    // pending → skip (omitted)
  }
  return out;
}

export function deriveInboxRunSteps({
  missionStatus,
  logLines = [],
  reviewLoaded = false,
  decisionsComplete = false,
  applied = false,
}: InboxRunStepInput): InboxRunStep[] {
  const failed = missionStatus === "failed" || missionStatus === "stopped";
  const done = missionStatus === "done" || reviewLoaded || applied;
  const running = missionStatus === "running" || missionStatus === "idle";
  const hasDraftSignal =
    hasPhase(logLines, "extract") ||
    hasPhase(logLines, "summary") ||
    hasPhase(logLines, "classify") ||
    hasPhase(logLines, "route") ||
    hasPhase(logLines, "review") ||
    logLines.some((line) => /anchor_inbox_review_v1/i.test(line));
  const hasReviewSignal =
    reviewLoaded ||
    hasPhase(logLines, "review") ||
    logLines.some((line) => /anchor_inbox_review_v1/i.test(line));

  const runStatus: InboxRunStepStatus = failed ? "error" : running ? "active" : "complete";
  const draftStatus: InboxRunStepStatus = failed
    ? "error"
    : done || hasDraftSignal
      ? "complete"
      : running
        ? "active"
        : "pending";
  const reviewStatus: InboxRunStepStatus = failed
    ? "error"
    : reviewLoaded
      ? "complete"
      : done || hasReviewSignal
        ? "active"
        : "pending";
  const confirmStatus: InboxRunStepStatus = failed
    ? "error"
    : !reviewLoaded
      ? "pending"
      : decisionsComplete
        ? "complete"
        : "blocked";
  const applyStatus: InboxRunStepStatus = failed
    ? "error"
    : applied
      ? "complete"
      : decisionsComplete && reviewLoaded
        ? "active"
        : "pending";

  return [
    { id: "input", status: "complete" },
    { id: "run", status: runStatus },
    { id: "draft", status: draftStatus },
    { id: "review", status: reviewStatus },
    { id: "confirm", status: confirmStatus },
    { id: "apply", status: applyStatus },
  ];
}

function defaultDecisionStatus(item: InboxReviewItem): InboxItemDecisionStatus {
  if (item.requiresConfirmation) return "pending";
  if (item.recommendedAction === "reject") return "rejected";
  if (item.recommendedAction === "skip" || item.recommendedAction === "handoff") return "pending";
  return "accepted";
}

function normalizeReviewArtifact(value: UnknownRecord): InboxReviewArtifact {
  const rawItems = Array.isArray(value.items) ? value.items : [];
  return {
    schemaVersion: INBOX_REVIEW_SCHEMA_VERSION,
    summary: stringValue(value.summary) || "",
    items: rawItems.map((item, index) => normalizeItem(item, index)),
  };
}

function normalizeItem(value: unknown, index: number): InboxReviewItem {
  const record = asRecord(value) ?? {};
  const itemId = stringValue(record.itemId ?? record.item_id ?? record.id) || `item-${index + 1}`;
  const classification = normalizeClassification(record.classification);
  const confidence = normalizeConfidence(record.confidence);
  const recommendedAction = normalizeAction(record.recommendedAction ?? record.recommended_action);
  const requiresConfirmation =
    typeof record.requiresConfirmation === "boolean"
      ? record.requiresConfirmation
      : typeof record.requires_confirmation === "boolean"
        ? record.requires_confirmation
        : confidence === "low" ||
          recommendedAction === "reject" ||
          recommendedAction === "handoff" ||
          classification === "noise";
  return {
    itemId,
    itemDir: stringValue(record.itemDir ?? record.item_dir) || "",
    title: stringValue(record.title) || itemId,
    channel: stringValue(record.channel) || "",
    classification,
    project: nullableString(record.project),
    destination: nullableString(record.destination),
    confidence,
    summaryPreview: stringValue(record.summaryPreview ?? record.summary_preview ?? record.summary) || "",
    requiresConfirmation,
    recommendedAction,
    note: stringValue(record.note ?? record.reason) || "",
  };
}

function normalizeClassification(value: unknown): InboxReviewClassification {
  const raw = stringValue(value).toLowerCase();
  return (INBOX_CLASSIFICATIONS as string[]).includes(raw)
    ? (raw as InboxReviewClassification)
    : "info";
}

function normalizeConfidence(value: unknown): InboxConfidence {
  const raw = stringValue(value).toLowerCase();
  return raw === "high" || raw === "medium" || raw === "low" ? raw : "medium";
}

function normalizeAction(value: unknown): InboxRecommendedAction {
  const raw = stringValue(value).toLowerCase();
  return raw === "route" || raw === "reject" || raw === "skip" || raw === "handoff" ? raw : "route";
}

/** Treat empty / "-" / "null" placeholders as absent. */
function nullableString(value: unknown): string | null {
  const raw = stringValue(value);
  if (!raw || raw === "-" || raw.toLowerCase() === "null") return null;
  return raw;
}

function hasPhase(lines: string[], phase: string): boolean {
  const pattern = new RegExp(`(?:\\[phase:${phase}\\]|phase\\s*[:=]\\s*${phase})`, "i");
  return lines.some((line) => pattern.test(line));
}
