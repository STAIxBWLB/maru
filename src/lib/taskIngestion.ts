import { createDraft, listDrafts } from "./api";
import type { AiTaskIngestMinImportance } from "./settings";
import { agentReadRunEvents, type AgentRunEvent } from "./skills";
import {
  asRecord,
  extractJsonCandidates,
  extractProviderOutput,
  isString,
  safeParseRecord,
  stringValue,
} from "./skillProposal";
import type { DraftEntry, DraftImportance, MissionRecord, ScratchpadSource } from "./types";

// Task-candidate ingestion: a scheduled `inbox-process extract-tasks` mission
// prints one `maru_task_candidates_v1` JSON object on stdout; the dispatcher
// records every stdout line as a `provider.output` event under
// <work>/.maru/runs/skills/<runId>/events.jsonl. The app reassembles stdout
// from those events (same pattern as the inbox review artifact), validates
// the candidates, and imports them as task drafts via drafts_create.

export const TASK_CANDIDATES_SCHEMA_VERSION = "maru_task_candidates_v1";

export interface TaskCandidate {
  title: string;
  importance: DraftImportance;
  confidence: number | null;
  originRefs: string[];
  summary: string;
  draftBody: string;
}

export interface TaskCandidatesArtifact {
  schemaVersion: string;
  summary: string;
  candidates: TaskCandidate[];
}

export interface TaskCandidateSelection {
  create: TaskCandidate[];
  /** Titles skipped because importance is below the configured threshold. */
  skippedLow: string[];
  /** Titles skipped because a matching non-discarded draft already exists. */
  skippedDup: string[];
}

export interface TaskIngestResult {
  runId: string;
  total: number;
  created: number;
  skippedLow: number;
  skippedDup: number;
}

/** Parse the task-candidates artifact out of raw mission stdout. Prefers the
 *  last matching object since the skill body itself embeds an example. */
export function parseTaskCandidatesArtifact(raw: string): TaskCandidatesArtifact | null {
  for (const candidate of extractJsonCandidates(raw).reverse()) {
    const parsed = safeParseRecord(candidate);
    if (!parsed || parsed.schemaVersion !== TASK_CANDIDATES_SCHEMA_VERSION) continue;
    const rawCandidates = Array.isArray(parsed.candidates) ? parsed.candidates : [];
    return {
      schemaVersion: TASK_CANDIDATES_SCHEMA_VERSION,
      summary: stringValue(parsed.summary),
      candidates: rawCandidates
        .map(normalizeCandidate)
        .filter((item): item is TaskCandidate => item !== null),
    };
  }
  return null;
}

/** Normalized title key for duplicate detection: case-insensitive and
 *  punctuation-insensitive so "Review weekly report" matches
 *  "review weekly report!". */
export function normalizeDraftTitleKey(title: string): string {
  return title
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9가-힣]+/g, " ")
    .trim()
    .replace(/\s+/g, " ");
}

export function importanceRank(importance: DraftImportance): number {
  return importance === "high" ? 3 : importance === "medium" ? 2 : 1;
}

/** Apply the importance threshold and title dedupe. Existing discarded drafts
 *  do not block re-ingestion; duplicates inside the batch collapse too. */
export function selectTaskCandidates(
  candidates: TaskCandidate[],
  existingDrafts: DraftEntry[],
  minImportance: AiTaskIngestMinImportance,
): TaskCandidateSelection {
  const minRank = importanceRank(minImportance);
  const taken = new Set(
    existingDrafts
      .filter((draft) => draft.status !== "discarded")
      .map((draft) => normalizeDraftTitleKey(draft.title)),
  );
  const selection: TaskCandidateSelection = { create: [], skippedLow: [], skippedDup: [] };
  for (const candidate of candidates) {
    if (importanceRank(candidate.importance) < minRank) {
      selection.skippedLow.push(candidate.title);
      continue;
    }
    const key = normalizeDraftTitleKey(candidate.title);
    if (taken.has(key)) {
      selection.skippedDup.push(candidate.title);
      continue;
    }
    taken.add(key);
    selection.create.push(candidate);
  }
  return selection;
}

/** Scheduler-dispatched skill missions carry {scheduler: true} metadata; only
 *  those feed automatic draft ingestion. */
export function isCompletedSchedulerSkillMission(mission: MissionRecord): boolean {
  if (mission.kind !== "skill" || mission.status !== "done") return false;
  return asRecord(mission.metadata)?.scheduler === true;
}

/** Read one completed run's events and import its task candidates as drafts.
 *  Returns null when the run produced no candidates artifact. */
export async function ingestTaskCandidateRun(
  workPath: string,
  runId: string,
  minImportance: AiTaskIngestMinImportance,
): Promise<TaskIngestResult | null> {
  const events = await agentReadRunEvents(workPath, runId);
  const artifact = parseTaskCandidatesArtifact(extractProviderOutput(events));
  if (!artifact) return null;
  const existing = await listDrafts(workPath);
  const selection = selectTaskCandidates(artifact.candidates, existing, minImportance);
  const source = runtimeSourceFromEvents(events);
  let created = 0;
  for (const candidate of selection.create) {
    await createDraft({
      workPath,
      kind: "task",
      title: candidate.title,
      source,
      originRefs: candidate.originRefs,
      importance: candidate.importance,
      confidence: candidate.confidence,
      body: candidate.draftBody || candidate.summary,
    });
    created += 1;
  }
  return {
    runId,
    total: artifact.candidates.length,
    created,
    skippedLow: selection.skippedLow.length,
    skippedDup: selection.skippedDup.length,
  };
}

const RUNTIME_SOURCES: ScratchpadSource[] = ["claude", "codex", "kimi", "kiro"];

/** Draft source = the AI runtime that produced the run, else "maru". Shared
 *  with the ideation-draft ingestion path. */
export function runtimeSourceFromEvents(events: AgentRunEvent[]): ScratchpadSource {
  for (const event of events) {
    if (event.type !== "run.started") continue;
    const payload = asRecord(event.payload);
    const dispatch = asRecord(payload?.dispatch);
    const request = asRecord(payload?.request);
    const runtime = stringValue(dispatch?.runtime ?? request?.runtimeProvider);
    if ((RUNTIME_SOURCES as string[]).includes(runtime)) return runtime as ScratchpadSource;
  }
  return "maru";
}

function normalizeCandidate(value: unknown): TaskCandidate | null {
  const record = asRecord(value);
  if (!record) return null;
  const title = stringValue(record.title);
  if (!title) return null;
  return {
    title,
    importance: normalizeImportance(record.importance),
    confidence: normalizeConfidence(record.confidence),
    originRefs: Array.isArray(record.originRefs)
      ? record.originRefs.filter(isString).map((ref) => ref.trim()).filter(Boolean)
      : [],
    summary: stringValue(record.summary),
    draftBody: typeof record.draftBody === "string" ? record.draftBody.trim() : "",
  };
}

function normalizeImportance(value: unknown): DraftImportance {
  const raw = stringValue(value).toLowerCase();
  return raw === "high" || raw === "low" ? raw : "medium";
}

export function normalizeConfidence(value: unknown): number | null {
  if (typeof value !== "number" || !Number.isFinite(value)) return null;
  return Math.min(1, Math.max(0, value));
}
