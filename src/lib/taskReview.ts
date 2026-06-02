import type { SkillProposal } from "./skills";
import {
  asRecord,
  extractJsonCandidates,
  safeParseRecord,
  selectedProposalFileCount,
  stringValue,
  type ProposalFileDraft,
  type UnknownRecord,
} from "./skillProposal";

export const TASK_REVIEW_SCHEMA_VERSION = "anchor_task_review_v1";

export type TaskReviewCheckKind = "field" | "schedule" | "conflict" | "uncertainty";
export type TaskReviewCheckStatus = "pending" | "accepted" | "edited" | "rejected";
export type TaskRunStepId = "input" | "run" | "draft" | "review" | "confirm" | "apply";
export type TaskRunStepStatus = "pending" | "active" | "complete" | "blocked" | "error";

export interface TaskRunStep {
  id: TaskRunStepId;
  status: TaskRunStepStatus;
}

export interface TaskRunStepInput {
  missionStatus: string;
  logLines?: string[];
  reviewLoaded?: boolean;
  checksComplete?: boolean;
  applied?: boolean;
}

export interface TaskReviewEntity {
  id: string;
  label: string;
  normalized: string;
  note: string;
  required: boolean;
  /** Only on conflict entities: which side clashes. */
  conflictKind?: "task" | "calendar" | null;
}

export interface TaskFollowupCandidate {
  id: string;
  skill: string;
  title: string;
  prompt: string;
  reason: string;
  selected: boolean;
}

export interface TaskReviewDetails {
  title: string;
  status: string;
  priority: string;
  due: string | null;
  start: string | null;
  project: string | null;
}

export interface TaskReviewEnrichment {
  project: string | null;
  relatedTasks: string[];
  relatedMeetings: string[];
  calendarLink: { calendarId: string | null; calendarEventId: string | null } | null;
  resolvedAssignee: string | null;
}

export interface TaskReviewArtifact {
  schemaVersion: string;
  summary: string;
  taskDetails: TaskReviewDetails | null;
  fields: TaskReviewEntity[];
  schedule: TaskReviewEntity[];
  conflicts: TaskReviewEntity[];
  uncertainties: TaskReviewEntity[];
  enrichment: TaskReviewEnrichment | null;
  followups: TaskFollowupCandidate[];
}

export interface TaskReviewCheck extends TaskReviewEntity {
  kind: TaskReviewCheckKind;
  status: TaskReviewCheckStatus;
}

export type TaskProposalFileDraft = ProposalFileDraft;

// Task followups exclude `task-management` itself to avoid self-recursion.
const TASK_FOLLOWUP_SKILLS = new Set(["vault-extract", "vault-connect", "meeting-notes"]);

export function parseTaskReviewArtifact(raw: string): TaskReviewArtifact | null {
  // Prefer the final artifact when the skill body also embeds an example.
  for (const candidate of extractJsonCandidates(raw).reverse()) {
    const parsed = safeParseRecord(candidate);
    if (!parsed || parsed.schemaVersion !== TASK_REVIEW_SCHEMA_VERSION) continue;
    return normalizeReviewArtifact(parsed);
  }
  return null;
}

export function emptyTaskReviewArtifact(summary = ""): TaskReviewArtifact {
  return {
    schemaVersion: TASK_REVIEW_SCHEMA_VERSION,
    summary,
    taskDetails: null,
    fields: [],
    schedule: [],
    conflicts: [],
    uncertainties: [],
    enrichment: null,
    followups: [],
  };
}

export function createTaskReviewChecks(artifact: TaskReviewArtifact): TaskReviewCheck[] {
  return [
    ...artifact.fields.map((item) => toCheck(item, "field")),
    ...artifact.schedule.map((item) => toCheck(item, "schedule")),
    ...artifact.conflicts.map((item) => toCheck(item, "conflict")),
    ...artifact.uncertainties.map((item) => toCheck(item, "uncertainty")),
  ];
}

export function taskReviewChecksComplete(checks: TaskReviewCheck[]): boolean {
  return checks.every((check) => !check.required || check.status !== "pending");
}

export function selectedTaskFollowupCount(followups: TaskFollowupCandidate[]): number {
  return followups.filter((followup) => followup.selected).length;
}

export function taskReviewCanApply({
  proposal,
  files,
  followups,
  checksComplete,
  applyBusy = false,
}: {
  proposal: SkillProposal | null;
  files: TaskProposalFileDraft[];
  followups: TaskFollowupCandidate[];
  checksComplete: boolean;
  applyBusy?: boolean;
}): boolean {
  if (applyBusy || !checksComplete) return false;
  const selectedFiles = selectedProposalFileCount(files);
  const selectedFollowups = selectedTaskFollowupCount(followups);
  if (selectedFiles === 0 && selectedFollowups === 0) return false;
  return selectedFiles === 0 || Boolean(proposal);
}

export function deriveTaskRunSteps({
  missionStatus,
  logLines = [],
  reviewLoaded = false,
  checksComplete = false,
  applied = false,
}: TaskRunStepInput): TaskRunStep[] {
  const failed = missionStatus === "failed" || missionStatus === "stopped";
  const done = missionStatus === "done" || reviewLoaded || applied;
  const running = missionStatus === "running" || missionStatus === "idle";
  const hasDraftSignal =
    hasPhase(logLines, "draft") ||
    hasPhase(logLines, "proposal") ||
    hasPhase(logLines, "review") ||
    logLines.some((line) => /anchor_skill_proposal_v1|proposal\.created/i.test(line));
  const hasReviewSignal =
    reviewLoaded ||
    hasPhase(logLines, "review") ||
    logLines.some((line) => /anchor_task_review_v1/i.test(line));

  const runStatus: TaskRunStepStatus = failed ? "error" : running ? "active" : "complete";
  const draftStatus: TaskRunStepStatus = failed
    ? "error"
    : done || hasDraftSignal
      ? "complete"
      : running
        ? "active"
        : "pending";
  const reviewStatus: TaskRunStepStatus = failed
    ? "error"
    : reviewLoaded
      ? "complete"
      : done || hasReviewSignal
        ? "active"
        : "pending";
  const confirmStatus: TaskRunStepStatus = failed
    ? "error"
    : !reviewLoaded
      ? "pending"
      : checksComplete
        ? "complete"
        : "blocked";
  const applyStatus: TaskRunStepStatus = failed
    ? "error"
    : applied
      ? "complete"
      : checksComplete
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

function normalizeReviewArtifact(value: UnknownRecord): TaskReviewArtifact {
  return {
    schemaVersion: TASK_REVIEW_SCHEMA_VERSION,
    summary: stringValue(value.summary) || "",
    taskDetails: normalizeTaskDetails(value.taskDetails ?? value.task_details),
    fields: normalizeEntities(value.fields, "field"),
    schedule: normalizeEntities(value.schedule, "schedule"),
    conflicts: normalizeEntities(value.conflicts, "conflict"),
    uncertainties: normalizeEntities(value.uncertainties, "uncertainty"),
    enrichment: normalizeEnrichment(value.enrichment),
    followups: normalizeFollowups(value.followups),
  };
}

function hasPhase(lines: string[], phase: string): boolean {
  const pattern = new RegExp(`(?:\\[phase:${phase}\\]|phase\\s*[:=]\\s*${phase})`, "i");
  return lines.some((line) => pattern.test(line));
}

function normalizeEntities(value: unknown, prefix: string): TaskReviewEntity[] {
  if (!Array.isArray(value)) return [];
  return value.map((item, index) => normalizeEntity(item, `${prefix}-${index + 1}`));
}

function normalizeEntity(value: unknown, id: string): TaskReviewEntity {
  if (typeof value === "string") {
    return { id, label: value, normalized: value, note: "", required: true };
  }
  const record = asRecord(value);
  const label =
    stringValue(record?.label) ||
    stringValue(record?.source) ||
    stringValue(record?.name) ||
    stringValue(record?.field) ||
    stringValue(record?.value) ||
    id;
  const normalized =
    stringValue(record?.normalized) ||
    stringValue(record?.canonical) ||
    stringValue(record?.resolution) ||
    stringValue(record?.replacement) ||
    label;
  const conflictKindRaw = stringValue(record?.conflictKind ?? record?.conflict_kind);
  return {
    id: stringValue(record?.id) || id,
    label,
    normalized,
    note: stringValue(record?.note) || stringValue(record?.reason) || "",
    required: typeof record?.required === "boolean" ? record.required : true,
    conflictKind: conflictKindRaw === "task" || conflictKindRaw === "calendar" ? conflictKindRaw : null,
  };
}

function normalizeTaskDetails(value: unknown): TaskReviewDetails | null {
  const record = asRecord(value);
  if (!record) return null;
  const title = stringValue(record.title);
  const status = stringValue(record.status);
  const priority = stringValue(record.priority);
  const due = stringValue(record.due);
  const start = stringValue(record.start);
  const project = stringValue(record.project);
  if (!title && !status && !priority && !due && !start && !project) return null;
  return {
    title,
    status,
    priority,
    due: due || null,
    start: start || null,
    project: project || null,
  };
}

function normalizeEnrichment(value: unknown): TaskReviewEnrichment | null {
  const record = asRecord(value);
  if (!record) return null;
  const calendar = asRecord(record.calendarLink ?? record.calendar_link);
  const calendarLink = calendar
    ? {
        calendarId: stringValue(calendar.calendarId ?? calendar.calendar_id) || null,
        calendarEventId: stringValue(calendar.calendarEventId ?? calendar.calendar_event_id) || null,
      }
    : null;
  return {
    project: stringValue(record.project) || null,
    relatedTasks: normalizeLinkList(record.relatedTasks ?? record.related_tasks),
    relatedMeetings: normalizeLinkList(record.relatedMeetings ?? record.related_meetings),
    calendarLink,
    resolvedAssignee:
      stringValue(record.resolvedAssignee ?? record.resolved_assignee ?? record.assignee) || null,
  };
}

function normalizeLinkList(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.map((item) => stringValue(item)).filter((item) => item.length > 0);
}

function normalizeFollowups(value: unknown): TaskFollowupCandidate[] {
  if (!Array.isArray(value)) return [];
  return value
    .map((item, index) => {
      const record = asRecord(item);
      const skill = stringValue(record?.skill) || "";
      if (!TASK_FOLLOWUP_SKILLS.has(skill)) return null;
      const title = stringValue(record?.title) || skill;
      return {
        id: stringValue(record?.id) || `followup-${index + 1}`,
        skill,
        title,
        prompt: stringValue(record?.prompt) || title,
        reason: stringValue(record?.reason) || "",
        selected: typeof record?.selected === "boolean" ? record.selected : false,
      };
    })
    .filter((item): item is TaskFollowupCandidate => item !== null);
}

function toCheck(entity: TaskReviewEntity, kind: TaskReviewCheckKind): TaskReviewCheck {
  return { ...entity, kind, status: "pending" };
}
