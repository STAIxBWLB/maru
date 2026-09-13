import { invoke } from "@tauri-apps/api/core";
import { invokeE2EOverride } from "./e2eInvoke";
import { normalizeIpcError, IpcError } from "./ipcError";
import { applySourceSuggestion } from "./meetingSourceReview";

export type SourceKind = "note" | "transcript";
export type ReviewStatus = "pending" | "accepted" | "rejected" | "uncertain" | "edited";
export interface SourceSuggestion {
  id: string; sourceId: string; baseTextHash?: string; before: string; after: string;
  reason: string; category: string; evidence: string; status: ReviewStatus; required: boolean;
  runId?: string; baseRevision: string;
  evidenceSourceId?: string; evidenceQuote?: string;
  contextHash?: string;
}
export interface Participant {
  id: string; name: string; affiliation?: string; title?: string; role?: string;
  speakerLabels: string[]; attendance: "attendee" | "mentioned";
  status: "confirmed" | "uncertain"; reference?: string;
}
export interface SourceDraft {
  title?: string; date?: string; provider?: string; context?: string;
  sources: MeetingSource[]; participants: Participant[]; findings: unknown[];
  suggestions: SourceSuggestion[]; participantsReviewed: boolean; noteReviewed: boolean;
}
export interface MeetingSource {
  id: string; name: string; kind: SourceKind; originalText: string; text: string;
  originalHash: string; importedAt?: string; originalPath?: string;
}
export interface SourceVersion {
  id: string; revision: string; reason: string; createdAt: string; actor?: string;
  draft: SourceDraft; contentHash: string;
}
export interface SourceSession {
  id: string; revision: string; createdAt: string; updatedAt: string; draft: SourceDraft;
  versions: SourceVersion[]; confirmedVersionId?: string; outputLinks: string[];
}
export interface ReviewedSourceReference { sessionId: string; versionId: string; contentHash: string }
export interface MeetingCorrectionExample {
  id: string; revision?: string; before: string; after: string; reason: string;
  scope: { kind: "general" | "person" | "institution" | "project"; value: string };
  enabled: boolean; sourceSessionId?: string; sourceVersionId?: string;
}
export interface MeetingSourceImportInput { name: string; kind: SourceKind; text?: string; path?: string }

const key = (workspace: string) => `maru.meeting-source-reviews.v1:${workspace}`;
const exampleKey = (workspace: string) => `maru.meeting-correction-examples.v1:${workspace}`;
const clone = <T,>(value: T): T => structuredClone(value);
const stamp = () => new Date().toISOString();
const revisionConflict = () => new IpcError({ code: "meeting_source_revision_conflict", message: "The saved review changed; compare your edits with the latest version." });
const queues = new Map<string, Promise<unknown>>();
async function serialized<T>(workspace: string, work: () => Promise<T>): Promise<T> {
  const prior = queues.get(workspace) ?? Promise.resolve();
  const next = prior.catch(() => {}).then(work);
  queues.set(workspace, next);
  try { return await next; } finally { if (queues.get(workspace) === next) queues.delete(workspace); }
}
function readSessions(workspace: string): SourceSession[] {
  return JSON.parse(window.localStorage.getItem(key(workspace)) ?? "[]") as SourceSession[];
}
function commit(workspace: string, sessions: SourceSession[]): void {
  // Do not publish an in-memory mutation before durable browser storage succeeds.
  window.localStorage.setItem(key(workspace), JSON.stringify(sessions));
}
function find(sessions: SourceSession[], id: string): SourceSession {
  const session = sessions.find((s) => s.id === id);
  if (!session) throw new Error("meeting_source_not_found");
  return session;
}
function expected(session: SourceSession, revision: string) {
  if (session.revision !== revision) throw revisionConflict();
}
async function digest(value: string): Promise<string> {
  const bytes = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return Array.from(new Uint8Array(bytes), (b) => b.toString(16).padStart(2, "0")).join("");
}
function contextContent(draft: SourceDraft): string {
  return JSON.stringify({ title: draft.title, date: draft.date, provider: draft.provider,
    context: draft.context, participants: draft.participants, sources: draft.sources.map((source) => [source.id, source.text]) });
}
function validateDraft(draft: SourceDraft) {
  // A blank draft is allowed so a new note can be created before any text exists.
  if (!draft.sources.length) throw new Error("meeting_source_empty");
  const ids = new Set<string>();
  for (const source of draft.sources) {
    if (ids.has(source.id) || !/^[a-zA-Z0-9_-]+$/.test(source.id)) throw new Error("meeting_source_invalid");
    ids.add(source.id);
    if (new TextEncoder().encode(source.text).byteLength > 2 * 1024 * 1024) throw new Error("meeting_source_exceeds_2_mib");
  }
}
async function call<T>(command: string, args: Record<string, unknown>, mock: () => Promise<T> | T): Promise<T> {
  try {
    if (typeof window !== "undefined" && !window.__TAURI_INTERNALS__) {
      const override = await invokeE2EOverride<T>(command, args);
      if (override !== null) return override;
      return clone(await mock());
    }
    return await invoke<T>(command, args);
  } catch (error) { throw normalizeIpcError(error); }
}
function advance(session: SourceSession) { session.revision = crypto.randomUUID(); session.updatedAt = stamp(); }
async function version(session: SourceSession, reason: string): Promise<SourceVersion> {
  if (!reason.trim()) throw new Error("meeting_source_version_reason_required");
  const contentHash = await digest(JSON.stringify(session.draft));
  return { id: await digest(`${session.revision}\n${contentHash}\n${reason.trim()}`),
    revision: session.revision, reason: reason.trim(), createdAt: stamp(), actor: "user",
    draft: clone(session.draft), contentHash };
}
export function listMeetingSourceSessions(workspace: string): Promise<SourceSession[]> {
  return call("list_meeting_source_sessions", { workspace }, () => readSessions(workspace).sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)));
}
export function readMeetingSourceSession(workspace: string, sessionId: string): Promise<SourceSession> {
  return call("read_meeting_source_session", { workspace, sessionId }, () => find(readSessions(workspace), sessionId));
}
export function deleteMeetingSourceSession(workspace: string, sessionId: string): Promise<void> {
  return call("delete_meeting_source_session", { workspace, sessionId }, () => serialized(workspace, async () => {
    const sessions = readSessions(workspace);
    find(sessions, sessionId);
    commit(workspace, sessions.filter((session) => session.id !== sessionId));
  }));
}
export function createMeetingSourceSession(workspace: string, draft: SourceDraft, provider?: string): Promise<SourceSession> {
  return call("create_meeting_source_session", { workspace, draft, provider }, () => serialized(workspace, async () => {
    validateDraft(draft);
    const sources = await Promise.all(draft.sources.map(async (s) => ({ ...s, originalText: s.text, originalHash: await digest(s.text), importedAt: stamp() })));
    const session: SourceSession = { id: crypto.randomUUID(), revision: crypto.randomUUID(), createdAt: stamp(), updatedAt: stamp(),
      draft: { ...clone(draft), sources, provider: provider ?? draft.provider, participantsReviewed: false, noteReviewed: false }, versions: [], outputLinks: [] };
    commit(workspace, [session, ...readSessions(workspace)]); return session;
  }));
}
export function saveMeetingSourceDraft(workspace: string, sessionId: string, draft: SourceDraft, expectedRevision: string): Promise<SourceSession> {
  return call("save_meeting_source_draft", { workspace, sessionId, draft, expectedRevision }, () => serialized(workspace, async () => {
    validateDraft(draft); const sessions = readSessions(workspace); const session = find(sessions, sessionId); expected(session, expectedRevision);
    for (const prior of session.draft.suggestions) {
      if (JSON.stringify(draft.suggestions.find((item) => item.id === prior.id)) !== JSON.stringify(prior)) throw new Error("meeting_source_use_decision");
    }
    const normalized = clone(draft);
    for (const suggestion of normalized.suggestions) {
      if (session.draft.suggestions.some((item) => item.id === suggestion.id)) continue;
      const source = session.draft.sources.find((item) => item.id === suggestion.sourceId);
      if (suggestion.status !== "pending" || suggestion.baseRevision !== session.revision || !source || !suggestion.before
        || source.text.split(suggestion.before).length !== 2 || contextContent(draft) !== contextContent(session.draft)
        || JSON.stringify(draft.sources) !== JSON.stringify(session.draft.sources)) throw new Error("meeting_source_stale_suggestion");
      suggestion.contextHash = await digest(contextContent(draft));
    }
    if (contextContent(draft) !== contextContent(session.draft)) {
      for (const suggestion of normalized.suggestions) {
        if (suggestion.status === "pending") delete suggestion.contextHash;
      }
    }
    if (draft.sources.length !== session.draft.sources.length) throw new Error("meeting_source_use_import");
    for (const source of draft.sources) {
      const original = session.draft.sources.find((s) => s.id === source.id);
      if (!original || ["originalText", "originalHash", "name", "kind", "importedAt", "originalPath"].some((field) => source[field as keyof MeetingSource] !== original[field as keyof MeetingSource])) throw new Error("meeting_source_original_immutable");
    }
    if (JSON.stringify(draft) === JSON.stringify(session.draft)) return session;
    session.draft = normalized; session.confirmedVersionId = undefined; advance(session); commit(workspace, sessions); return session;
  }));
}
export function decideMeetingSourceSuggestion(workspace: string, sessionId: string,
  decision: { id: string; status: "accepted" | "edited" | "rejected" | "uncertain"; replacement?: string },
  expectedRevision: string): Promise<SourceSession> {
  return call("save_meeting_source_draft", { workspace, sessionId, decision, expectedRevision, draft: null }, () => serialized(workspace, async () => {
    const sessions = readSessions(workspace); const session = find(sessions, sessionId); expected(session, expectedRevision);
    const suggestion = session.draft.suggestions.find((item) => item.id === decision.id);
    if (!suggestion) throw new Error("meeting_source_unknown_suggestion");
    if ((decision.status === "accepted" || decision.status === "edited") && suggestion.contextHash !== await digest(contextContent(session.draft))) throw new Error("meeting_source_context_changed");
    session.draft = applySourceSuggestion(session.draft, decision.id, decision.status, decision.replacement);
    if (decision.status === "accepted" || decision.status === "edited") {
      const nextContext = await digest(contextContent(session.draft));
      session.draft.suggestions = session.draft.suggestions.map((item) => item.status === "pending" && item.contextHash === suggestion.contextHash
        ? { ...item, contextHash: nextContext } : item);
    }
    session.confirmedVersionId = undefined; advance(session); commit(workspace, sessions); return session;
  }));
}
export function importMeetingSource(workspace: string, sessionId: string | null, input: MeetingSourceImportInput, expectedRevision?: string): Promise<SourceSession> {
  return call("import_meeting_source", { workspace, sessionId, input, expectedRevision }, async () => {
    if (input.path || input.text === undefined) throw new Error("Use the browser file picker to import local file contents.");
    const source: MeetingSource = { id: crypto.randomUUID(), name: input.name, kind: input.kind, text: input.text, originalText: input.text, originalHash: await digest(input.text), importedAt: stamp() };
    if (!sessionId) return createMeetingSourceSession(workspace, { title: input.name, sources: [source], participants: [], findings: [], suggestions: [], participantsReviewed: false, noteReviewed: false });
    return serialized(workspace, async () => {
      const sessions = readSessions(workspace); const session = find(sessions, sessionId); expected(session, expectedRevision ?? "");
      session.draft.sources.push(source); validateDraft(session.draft); session.draft.noteReviewed = false; session.confirmedVersionId = undefined;
      advance(session); commit(workspace, sessions); return session;
    });
  });
}
export function checkpointMeetingSource(workspace: string, sessionId: string, reason: string, expectedRevision: string): Promise<SourceVersion> {
  return call("checkpoint_meeting_source", { workspace, sessionId, reason, expectedRevision }, () => serialized(workspace, async () => {
    const sessions = readSessions(workspace); const session = find(sessions, sessionId);
    if (session.revision !== expectedRevision) {
      const prior = session.versions.at(-1); if (prior?.revision === expectedRevision && prior.reason === reason.trim()) return prior;
      throw revisionConflict();
    }
    const saved = await version(session, reason); session.versions.push(saved); advance(session); commit(workspace, sessions); return saved;
  }));
}
export function confirmMeetingSource(workspace: string, sessionId: string, expectedRevision: string): Promise<SourceSession> {
  return call("confirm_meeting_source", { workspace, sessionId, expectedRevision }, () => serialized(workspace, async () => {
    const sessions = readSessions(workspace); const session = find(sessions, sessionId); expected(session, expectedRevision);
    if (!session.draft.participantsReviewed || !session.draft.noteReviewed || session.draft.suggestions.some((s) => s.required && s.status === "pending") || session.draft.participants.some((p) => !p.name.trim())) throw new Error("meeting_source_review_incomplete");
    if (session.confirmedVersionId) return session;
    const saved = await version(session, "Review confirmed"); session.versions.push(saved); session.confirmedVersionId = saved.id; advance(session); commit(workspace, sessions); return session;
  }));
}
export function readMeetingSourceVersion(workspace: string, sessionId: string, versionId: string): Promise<SourceVersion> {
  return call("read_meeting_source_version", { workspace, sessionId, versionId }, () => {
    const value = find(readSessions(workspace), sessionId).versions.find((v) => v.id === versionId);
    if (!value) throw new Error("meeting_source_version_not_found"); return value;
  });
}
export function restoreMeetingSourceVersion(workspace: string, sessionId: string, versionId: string, expectedRevision: string): Promise<SourceSession> {
  return call("restore_meeting_source_version", { workspace, sessionId, versionId, expectedRevision }, () => serialized(workspace, async () => {
    const sessions = readSessions(workspace); const session = find(sessions, sessionId); expected(session, expectedRevision);
    const previous = session.versions.find((v) => v.id === versionId); if (!previous) throw new Error("meeting_source_version_not_found");
    session.draft = { ...clone(previous.draft), participantsReviewed: false, noteReviewed: false };
    session.confirmedVersionId = undefined; session.versions.push(await version(session, `Restored version ${versionId}`)); advance(session); commit(workspace, sessions); return session;
  }));
}
export function validateMeetingSourceReference(session: SourceSession, reference: ReviewedSourceReference): SourceVersion {
  const saved = session.versions.find((v) => v.id === reference.versionId);
  if (session.id !== reference.sessionId || !saved || session.confirmedVersionId !== saved.id || saved.contentHash !== reference.contentHash || JSON.stringify(saved.draft) !== JSON.stringify(session.draft)) throw new Error("meeting_source_no_longer_confirmed");
  return saved;
}
export function listMeetingCorrectionExamples(workspace: string): Promise<MeetingCorrectionExample[]> {
  return call("list_meeting_correction_examples", { workspace }, () => JSON.parse(window.localStorage.getItem(exampleKey(workspace)) ?? "[]") as MeetingCorrectionExample[]);
}
export function saveMeetingCorrectionExample(workspace: string, example: MeetingCorrectionExample): Promise<MeetingCorrectionExample> {
  return call("save_meeting_correction_example", { workspace, example }, () => serialized(workspace, async () => {
    if (!example.before.trim() || !example.after.trim() || !example.reason.trim() || (example.scope.kind !== "general" && !example.scope.value.trim())) throw new Error("meeting_source_example_incomplete");
    const examples = JSON.parse(window.localStorage.getItem(exampleKey(workspace)) ?? "[]") as MeetingCorrectionExample[];
    const prior = examples.find((e) => e.id === example.id);
    if (prior && (!example.revision || example.revision !== prior.revision)) throw revisionConflict();
    const session = find(readSessions(workspace), example.sourceSessionId ?? "");
    const index = session.versions.findIndex((v) => v.id === example.sourceVersionId);
    if (index < 0) throw new Error("meeting_source_example_version_required");
    const version = session.versions[index];
    const beforePresent = version.draft.sources.some((source) => source.originalText.includes(example.before))
      || session.versions.slice(0, index + 1).some((item) => item.draft.sources.some((source) => source.text.includes(example.before)))
      || version.draft.suggestions.some((item) => ["accepted", "edited"].includes(item.status) && item.before === example.before && item.after === example.after);
    if (!beforePresent || !version.draft.sources.some((source) => source.text.includes(example.after))) throw new Error("meeting_source_example_not_in_version");
    if (prior && (prior.sourceSessionId !== example.sourceSessionId || prior.sourceVersionId !== example.sourceVersionId)) throw new Error("meeting_source_example_provenance_immutable");
    const saved = { ...clone(example), revision: crypto.randomUUID() };
    window.localStorage.setItem(exampleKey(workspace), JSON.stringify([...examples.filter((e) => e.id !== saved.id), saved])); return saved;
  }));
}
