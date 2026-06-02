import type { AgentRunEvent, SkillProposal, SkillProposalFile } from "./skills";

export const MEETING_REVIEW_SCHEMA_VERSION = "anchor_meeting_review_v1";

export type MeetingReviewCheckKind = "term" | "person" | "properNoun" | "uncertainty";
export type MeetingReviewCheckStatus = "pending" | "accepted" | "edited" | "rejected";
export type MeetingRunStepId = "input" | "run" | "draft" | "review" | "confirm" | "apply";
export type MeetingRunStepStatus = "pending" | "active" | "complete" | "blocked" | "error";

export interface MeetingRunStep {
  id: MeetingRunStepId;
  status: MeetingRunStepStatus;
}

export interface MeetingRunStepInput {
  missionStatus: string;
  logLines?: string[];
  reviewLoaded?: boolean;
  checksComplete?: boolean;
  applied?: boolean;
}

export interface MeetingReviewEntity {
  id: string;
  label: string;
  normalized: string;
  note: string;
  required: boolean;
}

export interface MeetingFollowupCandidate {
  id: string;
  skill: string;
  title: string;
  prompt: string;
  reason: string;
  selected: boolean;
}

export interface MeetingReviewArtifact {
  schemaVersion: string;
  summary: string;
  terms: MeetingReviewEntity[];
  people: MeetingReviewEntity[];
  properNouns: MeetingReviewEntity[];
  uncertainties: MeetingReviewEntity[];
  followups: MeetingFollowupCandidate[];
}

export interface MeetingReviewCheck extends MeetingReviewEntity {
  kind: MeetingReviewCheckKind;
  status: MeetingReviewCheckStatus;
}

export interface MeetingProposalFileDraft {
  id: string;
  selected: boolean;
  path: string;
  operation: string;
  beforeContent: string;
  afterContent: string;
  expectedHash?: string | null;
  diff?: string | null;
}

type UnknownRecord = Record<string, unknown>;

const FOLLOWUP_SKILLS = new Set(["vault-extract", "vault-connect", "task-management"]);

export function extractProviderOutput(events: AgentRunEvent[], fallbackLines: string[] = []): string {
  const lines = events
    .filter((event) => event.type === "provider.output")
    .map((event) => asRecord(event.payload)?.line)
    .filter((line): line is string => typeof line === "string");
  return (lines.length > 0 ? lines : fallbackLines).join("\n");
}

export function extractSkillProposal(events: AgentRunEvent[]): SkillProposal | null {
  for (const event of events) {
    if (event.type !== "proposal.created") continue;
    const payload = asRecord(event.payload);
    const proposal = asRecord(payload?.proposal);
    if (!proposal || typeof proposal.summary !== "string") continue;
    return {
      summary: proposal.summary,
      files: Array.isArray(proposal.files) ? proposal.files as SkillProposalFile[] : [],
      commands: Array.isArray(proposal.commands) ? proposal.commands as SkillProposal["commands"] : [],
      risks: Array.isArray(proposal.risks) ? proposal.risks.filter(isString) : [],
      requiresApproval:
        typeof proposal.requiresApproval === "boolean" ? proposal.requiresApproval : true,
      schemaVersion:
        typeof proposal.schemaVersion === "string"
          ? proposal.schemaVersion
          : "anchor_skill_proposal_v1",
    };
  }
  return null;
}

export function parseMeetingReviewArtifact(raw: string): MeetingReviewArtifact | null {
  for (const candidate of extractJsonCandidates(raw).reverse()) {
    const parsed = safeParseRecord(candidate);
    if (!parsed || parsed.schemaVersion !== MEETING_REVIEW_SCHEMA_VERSION) continue;
    return normalizeReviewArtifact(parsed);
  }
  return null;
}

export function emptyMeetingReviewArtifact(summary = ""): MeetingReviewArtifact {
  return {
    schemaVersion: MEETING_REVIEW_SCHEMA_VERSION,
    summary,
    terms: [],
    people: [],
    properNouns: [],
    uncertainties: [],
    followups: [],
  };
}

export function createMeetingReviewChecks(artifact: MeetingReviewArtifact): MeetingReviewCheck[] {
  return [
    ...artifact.terms.map((item) => toCheck(item, "term")),
    ...artifact.people.map((item) => toCheck(item, "person")),
    ...artifact.properNouns.map((item) => toCheck(item, "properNoun")),
    ...artifact.uncertainties.map((item) => toCheck(item, "uncertainty")),
  ];
}

export function meetingReviewChecksComplete(checks: MeetingReviewCheck[]): boolean {
  return checks.every((check) => !check.required || check.status !== "pending");
}

export function rebuildSkillProposal(
  proposal: SkillProposal,
  files: MeetingProposalFileDraft[],
): SkillProposal {
  return {
    ...proposal,
    files: files
      .filter((file) => file.selected)
      .map((file) => ({
        path: file.path,
        operation: file.operation,
        content: file.operation === "delete" ? null : file.afterContent,
        expectedHash: file.expectedHash ?? null,
        diff: file.diff ?? null,
      })),
  };
}

export function selectedProposalFileCount(files: MeetingProposalFileDraft[]): number {
  return files.filter((file) => file.selected).length;
}

export function selectedMeetingFollowupCount(followups: MeetingFollowupCandidate[]): number {
  return followups.filter((followup) => followup.selected).length;
}

export function meetingReviewCanApply({
  proposal,
  files,
  followups,
  checksComplete,
  applyBusy = false,
  continuationAvailable = false,
}: {
  proposal: SkillProposal | null;
  files: MeetingProposalFileDraft[];
  followups: MeetingFollowupCandidate[];
  checksComplete: boolean;
  applyBusy?: boolean;
  continuationAvailable?: boolean;
}): boolean {
  if (applyBusy || !checksComplete) return false;
  const selectedFiles = selectedProposalFileCount(files);
  const selectedFollowups = selectedMeetingFollowupCount(followups);
  if (continuationAvailable) return true;
  if (selectedFiles === 0 && selectedFollowups === 0) return false;
  return selectedFiles === 0 || Boolean(proposal);
}

export function deriveMeetingRunSteps({
  missionStatus,
  logLines = [],
  reviewLoaded = false,
  checksComplete = false,
  applied = false,
}: MeetingRunStepInput): MeetingRunStep[] {
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
    logLines.some((line) => /anchor_meeting_review_v1/i.test(line));

  const runStatus: MeetingRunStepStatus = failed ? "error" : running ? "active" : "complete";
  const draftStatus: MeetingRunStepStatus = failed
    ? "error"
    : done || hasDraftSignal
      ? "complete"
      : running
        ? "active"
        : "pending";
  const reviewStatus: MeetingRunStepStatus = failed
    ? "error"
    : reviewLoaded
      ? "complete"
      : done || hasReviewSignal
        ? "active"
        : "pending";
  const confirmStatus: MeetingRunStepStatus = failed
    ? "error"
    : !reviewLoaded
      ? "pending"
      : checksComplete
        ? "complete"
        : "blocked";
  const applyStatus: MeetingRunStepStatus = failed
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

function normalizeReviewArtifact(value: UnknownRecord): MeetingReviewArtifact {
  return {
    schemaVersion: MEETING_REVIEW_SCHEMA_VERSION,
    summary: stringValue(value.summary) || "",
    terms: normalizeEntities(value.terms, "term"),
    people: normalizeEntities(value.people, "person"),
    properNouns: normalizeEntities(value.properNouns ?? value.proper_nouns, "properNoun"),
    uncertainties: normalizeEntities(value.uncertainties, "uncertainty"),
    followups: normalizeFollowups(value.followups ?? value.vaultFollowups ?? value.vault_followups),
  };
}

function hasPhase(lines: string[], phase: string): boolean {
  const pattern = new RegExp(`(?:\\[phase:${phase}\\]|phase\\s*[:=]\\s*${phase})`, "i");
  return lines.some((line) => pattern.test(line));
}

function normalizeEntities(value: unknown, prefix: string): MeetingReviewEntity[] {
  if (!Array.isArray(value)) return [];
  return value.map((item, index) => normalizeEntity(item, `${prefix}-${index + 1}`));
}

function normalizeEntity(value: unknown, id: string): MeetingReviewEntity {
  if (typeof value === "string") {
    return { id, label: value, normalized: value, note: "", required: true };
  }
  const record = asRecord(value);
  const label =
    stringValue(record?.label) ||
    stringValue(record?.source) ||
    stringValue(record?.name) ||
    stringValue(record?.value) ||
    id;
  const normalized =
    stringValue(record?.normalized) ||
    stringValue(record?.canonical) ||
    stringValue(record?.replacement) ||
    label;
  return {
    id: stringValue(record?.id) || id,
    label,
    normalized,
    note: stringValue(record?.note) || stringValue(record?.reason) || "",
    required: typeof record?.required === "boolean" ? record.required : true,
  };
}

function normalizeFollowups(value: unknown): MeetingFollowupCandidate[] {
  if (!Array.isArray(value)) return [];
  return value
    .map((item, index) => {
      const record = asRecord(item);
      const skill = stringValue(record?.skill) || "";
      if (!FOLLOWUP_SKILLS.has(skill)) return null;
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
    .filter((item): item is MeetingFollowupCandidate => item !== null);
}

function toCheck(entity: MeetingReviewEntity, kind: MeetingReviewCheckKind): MeetingReviewCheck {
  return { ...entity, kind, status: "pending" };
}

function extractJsonCandidates(raw: string): string[] {
  const candidates: string[] = [];
  const fencePattern = /```(?:json)?\s*([\s\S]*?)```/gi;
  let match: RegExpExecArray | null;
  while ((match = fencePattern.exec(raw)) !== null) {
    const body = match[1]?.trim();
    if (body?.startsWith("{")) candidates.push(body);
  }
  candidates.push(...extractBalancedObjects(raw));
  return Array.from(new Set(candidates));
}

function extractBalancedObjects(raw: string): string[] {
  const objects: string[] = [];
  for (let start = raw.indexOf("{"); start >= 0; start = raw.indexOf("{", start + 1)) {
    let depth = 0;
    let inString = false;
    let escaped = false;
    for (let index = start; index < raw.length; index += 1) {
      const char = raw[index];
      if (inString) {
        if (escaped) {
          escaped = false;
        } else if (char === "\\") {
          escaped = true;
        } else if (char === "\"") {
          inString = false;
        }
        continue;
      }
      if (char === "\"") {
        inString = true;
      } else if (char === "{") {
        depth += 1;
      } else if (char === "}") {
        depth -= 1;
        if (depth === 0) {
          objects.push(raw.slice(start, index + 1));
          break;
        }
      }
    }
  }
  return objects;
}

function safeParseRecord(raw: string): UnknownRecord | null {
  try {
    return asRecord(JSON.parse(raw));
  } catch {
    return null;
  }
}

function asRecord(value: unknown): UnknownRecord | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as UnknownRecord
    : null;
}

function stringValue(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function isString(value: unknown): value is string {
  return typeof value === "string";
}
