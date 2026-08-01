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
 *  "review weekly report!". Strips punctuation/symbols/separators rather than
 *  keeping an allowlist of scripts — an allowlist collapsed every Hanja-,
 *  Kana- or Cyrillic-only title to "", making unrelated titles collide. */
export function normalizeDraftTitleKey(title: string): string {
  const key = title
    .trim()
    .toLowerCase()
    .replace(/[\p{P}\p{S}\p{Z}]+/gu, " ")
    .trim()
    .replace(/\s+/g, " ");
  // A title made entirely of punctuation or emoji normalizes to "". Fall back to
  // the raw title so two such titles stay distinct instead of deduping away.
  return key || title.trim().toLowerCase();
}

export function importanceRank(importance: DraftImportance): number {
  return importance === "high" ? 3 : importance === "medium" ? 2 : 1;
}

/** Alphanumeric token set of a title (NFKC, lowercased), matching the
 *  desk-pipeline driver's overlap dedupe: extract-tasks rewords a title every
 *  run, so exact-match dedupe never fires for the same follow-up. */
export function titleTokenSet(title: string): Set<string> {
  const tokens = title
    .normalize("NFKC")
    .toLowerCase()
    .split(/[^\p{L}\p{N}]+/u)
    .filter(Boolean);
  return new Set(tokens);
}

const DUP_TITLE_TOKEN_OVERLAP = 0.3;
const DUP_MIN_TOKENS = 3;

/** Probable duplicate of an existing draft: shares at least one originRef AND
 *  has >= 0.3 title-token overlap with the smaller set. Either condition alone
 *  is wrong — one meeting note legitimately yields several distinct
 *  follow-ups, and unrelated tasks share stock words. Titles with fewer than
 *  DUP_MIN_TOKENS tokens are exempt from the overlap rule: one shared subject
 *  word ("솔트룩스 회의" vs "솔트룩스 예산") would otherwise outvote the whole
 *  title. Bias toward suppressing: a missed draft comes back next run, a
 *  duplicate is triage. */
export function isProbableDuplicateDraft(
  candidate: TaskCandidate,
  existing: DraftEntry,
  candidateTokens?: Set<string>,
): boolean {
  const sharedRef = candidate.originRefs.some((ref) => existing.originRefs.includes(ref));
  if (!sharedRef) return false;
  const candidateSet = candidateTokens ?? titleTokenSet(candidate.title);
  const existingSet = titleTokenSet(existing.title);
  const smaller = Math.min(candidateSet.size, existingSet.size);
  if (smaller < DUP_MIN_TOKENS) return false;
  let overlap = 0;
  for (const token of candidateSet) {
    if (existingSet.has(token)) overlap += 1;
  }
  return overlap / smaller >= DUP_TITLE_TOKEN_OVERLAP;
}

/** Apply the importance threshold and title dedupe. Existing discarded drafts
 *  do not block re-ingestion; duplicates inside the batch collapse too. */
export function selectTaskCandidates(
  candidates: TaskCandidate[],
  existingDrafts: DraftEntry[],
  minImportance: AiTaskIngestMinImportance,
): TaskCandidateSelection {
  const minRank = importanceRank(minImportance);
  const liveDrafts = existingDrafts.filter((draft) => draft.status !== "discarded");
  const taken = new Set(liveDrafts.map((draft) => normalizeDraftTitleKey(draft.title)));
  const selection: TaskCandidateSelection = { create: [], skippedLow: [], skippedDup: [] };
  for (const candidate of candidates) {
    if (importanceRank(candidate.importance) < minRank) {
      selection.skippedLow.push(candidate.title);
      continue;
    }
    const key = normalizeDraftTitleKey(candidate.title);
    // Computed once per candidate, not once per comparison.
    const candidateTokens = titleTokenSet(candidate.title);
    if (
      taken.has(key) ||
      liveDrafts.some((existing) => isProbableDuplicateDraft(candidate, existing, candidateTokens))
    ) {
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

// The ingest guard has to live where the replay source lives. Mission records
// are process-global (mission_state hydrates them from disk and keeps them for
// the app's lifetime), while the panes that trigger ingestion unmount on every
// mode switch — so a per-component ref replayed every completed run on each
// remount, resurrecting drafts the user had discarded. Module scope dies with
// the process, exactly like MissionState.
const ingestedRuns = new Set<string>();
let ingestQueue: Promise<unknown> = Promise.resolve();

/** Run `task` at most once per `key`, and never concurrently with another
 *  ingestion. Serialization is required, not just nice: each ingest reads the
 *  draft list, decides, then writes, so two interleaved runs both miss the
 *  titles the other is about to create and duplicate them. */
export function onceSerialized<T>(key: string, task: () => Promise<T>): Promise<T | null> {
  const chained = ingestQueue.then(async () => {
    if (ingestedRuns.has(key)) return null;
    ingestedRuns.add(key);
    try {
      return await task();
    } catch (error) {
      // Release the claim so a transient failure can be retried; already-created
      // drafts are covered by the title dedupe on the next pass.
      ingestedRuns.delete(key);
      throw error;
    }
  });
  ingestQueue = chained.catch(() => undefined);
  return chained;
}

/** Test-only: drop the module-scope ingest guard between cases. */
export function resetIngestGuardForTests(): void {
  ingestedRuns.clear();
  ingestQueue = Promise.resolve();
}

/** Read one completed run's events and import its task candidates as drafts.
 *  Returns null when the run produced no candidates artifact, or when this run
 *  was already ingested in this process. */
export async function ingestTaskCandidateRun(
  workPath: string,
  runId: string,
  minImportance: AiTaskIngestMinImportance,
): Promise<TaskIngestResult | null> {
  return onceSerialized(`${workPath}|${runId}`, () =>
    ingestTaskCandidateRunUnguarded(workPath, runId, minImportance),
  );
}

async function ingestTaskCandidateRunUnguarded(
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
