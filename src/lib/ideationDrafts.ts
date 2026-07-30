import { createDraft, listDrafts } from "./api";
import { agentReadRunEvents } from "./skills";
import {
  asRecord,
  extractJsonCandidates,
  extractProviderOutput,
  safeParseRecord,
  stringValue,
} from "./skillProposal";
import { normalizeConfidence, runtimeSourceFromEvents } from "./taskIngestion";
import type { DraftEntry, MissionRecord } from "./types";

// Ideation-draft ingestion: an `ideation-drafts ideate-to-draft` background
// mission prints one `maru_implementation_draft_v1` JSON object on stdout.
// Same event-reassembly pattern as the scheduler task-candidate path (see
// taskIngestion.ts); the mission carries {kind: "implementation-draft",
// ideaPath} metadata so completions route here instead of the scheduler
// ingestion.

export const IMPLEMENTATION_DRAFT_SCHEMA_VERSION = "maru_implementation_draft_v1";
export const IMPLEMENTATION_DRAFT_MISSION_KIND = "implementation-draft";
export const IDEATION_DRAFTS_SKILL_NAME = "ideation-drafts";
export const IDEATE_TO_DRAFT_MODE = "ideate-to-draft";

export interface ImplementationDraftArtifact {
  schemaVersion: string;
  title: string;
  confidence: number | null;
  draftBody: string;
}

export interface ImplementationDraftIngestResult {
  runId: string;
  /** The created draft, or null when ingestion was skipped. */
  created: DraftEntry | null;
  /** True when a non-discarded implementation draft already existed for the
   *  idea, so no new draft was created. */
  skippedDuplicate: boolean;
}

/** Parse the implementation-draft artifact out of raw mission stdout. Prefers
 *  the last matching object since the skill body embeds an example. */
export function parseImplementationDraftArtifact(
  raw: string,
): ImplementationDraftArtifact | null {
  for (const candidate of extractJsonCandidates(raw).reverse()) {
    const parsed = safeParseRecord(candidate);
    if (!parsed || parsed.schemaVersion !== IMPLEMENTATION_DRAFT_SCHEMA_VERSION) continue;
    const title = stringValue(parsed.title);
    if (!title) continue;
    return {
      schemaVersion: IMPLEMENTATION_DRAFT_SCHEMA_VERSION,
      title,
      confidence: normalizeConfidence(parsed.confidence),
      draftBody: typeof parsed.draftBody === "string" ? parsed.draftBody.trim() : "",
    };
  }
  return null;
}

/** Prompt handed to the AI runtime: skill mode invocation plus the full idea
 *  inline, so the run works without extra file reads. */
export function buildIdeateToDraftPrompt(params: {
  title: string;
  relativePath: string;
  content: string;
}): string {
  return [
    `${IDEATION_DRAFTS_SKILL_NAME} ${IDEATE_TO_DRAFT_MODE}`,
    "",
    `Idea title: ${params.title}`,
    `Idea path: ${params.relativePath}`,
    "",
    "Idea content:",
    params.content.trim() || "(empty)",
  ].join("\n");
}

/** Idea path carried by an ideation-draft mission's metadata, else null. */
export function implementationDraftMissionIdeaPath(mission: MissionRecord): string | null {
  if (mission.kind !== "skill") return null;
  const metadata = asRecord(mission.metadata);
  if (metadata?.kind !== IMPLEMENTATION_DRAFT_MISSION_KIND) return null;
  return stringValue(metadata.ideaPath) || null;
}

/** Completed (done) ideation-draft missions feed draft ingestion. */
export function isCompletedImplementationDraftMission(mission: MissionRecord): boolean {
  return mission.status === "done" && implementationDraftMissionIdeaPath(mission) !== null;
}

/** All implementation drafts derived from one idea, newest first. */
export function implementationDraftsForIdea(
  drafts: DraftEntry[],
  ideaPath: string,
): DraftEntry[] {
  return drafts
    .filter((draft) => draft.kind === "implementation" && draft.originRefs.includes(ideaPath))
    .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt));
}

/** The newest non-discarded implementation draft for an idea, if any. Used by
 *  the duplicate guard: discarded drafts do not block regeneration. */
export function activeImplementationDraft(
  drafts: DraftEntry[],
  ideaPath: string,
): DraftEntry | null {
  return (
    implementationDraftsForIdea(drafts, ideaPath).find(
      (draft) => draft.status !== "discarded",
    ) ?? null
  );
}

/** Non-discarded implementation draft counts keyed by idea path, for the
 *  "초안 N개" indicator on idea rows. */
export function countImplementationDraftsByIdea(drafts: DraftEntry[]): Map<string, number> {
  const counts = new Map<string, number>();
  for (const draft of drafts) {
    if (draft.kind !== "implementation" || draft.status === "discarded") continue;
    for (const ref of draft.originRefs) {
      counts.set(ref, (counts.get(ref) ?? 0) + 1);
    }
  }
  return counts;
}

/** Read one completed run's events and import its implementation-draft
 *  artifact as a draft linked to the idea. Returns null when the run produced
 *  no artifact. */
export async function ingestImplementationDraftRun(
  workPath: string,
  runId: string,
  ideaPath: string,
): Promise<ImplementationDraftIngestResult | null> {
  const events = await agentReadRunEvents(workPath, runId);
  const artifact = parseImplementationDraftArtifact(extractProviderOutput(events));
  if (!artifact) return null;
  const existing = await listDrafts(workPath);
  if (activeImplementationDraft(existing, ideaPath)) {
    return { runId, created: null, skippedDuplicate: true };
  }
  const created = await createDraft({
    workPath,
    kind: "implementation",
    title: artifact.title,
    source: runtimeSourceFromEvents(events),
    originRefs: [ideaPath],
    confidence: artifact.confidence,
    body: artifact.draftBody,
  });
  return { runId, created, skippedDuplicate: false };
}
