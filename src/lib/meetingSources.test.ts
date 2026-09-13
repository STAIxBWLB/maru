import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  checkpointMeetingSource, confirmMeetingSource, createMeetingSourceSession, importMeetingSource,
  listMeetingCorrectionExamples, listMeetingSourceSessions, readMeetingSourceSession, restoreMeetingSourceVersion,
  saveMeetingCorrectionExample, saveMeetingSourceDraft, validateMeetingSourceReference, decideMeetingSourceSuggestion,
  type SourceDraft, type MeetingCorrectionExample,
} from "./meetingSources";

const stores = new Map<string, string>();
let quota = false;
function draft(text = "Plaud 회의록"): SourceDraft {
  return { sources: [{ id: "note", name: "Plaud.md", kind: "note", originalText: text, text, originalHash: "" }],
    participants: [], findings: [], suggestions: [], participantsReviewed: false, noteReviewed: false };
}
beforeEach(() => {
  stores.clear(); quota = false;
  vi.stubGlobal("window", { localStorage: {
    getItem: (key: string) => stores.get(key) ?? null,
    setItem: (key: string, value: string) => { if (quota) throw new Error("quota"); stores.set(key, value); },
  } });
});
afterEach(() => vi.unstubAllGlobals());

describe("meeting source persistence", () => {
  it("allows a reviewed suggestion batch but invalidates it on unrelated manual source edits", async () => {
    const initial = await createMeetingSourceSession("/a", draft("이영중 검토"));
    const candidate = { id: "name", sourceId: "note", before: "이영중", after: "이영준", reason: "이름 확인",
      evidence: "참가자 확인", category: "person", status: "pending" as const, required: true, baseRevision: initial.revision };
    const proposed = await saveMeetingSourceDraft("/a", initial.id, { ...initial.draft, suggestions: [candidate,
      { ...candidate, id: "verb", before: "검토", after: "협의" }] }, initial.revision);
    const first = await decideMeetingSourceSuggestion("/a", initial.id, { id: "name", status: "accepted" }, proposed.revision);
    const second = await decideMeetingSourceSuggestion("/a", initial.id, { id: "verb", status: "accepted" }, first.revision);
    expect(second.draft.sources[0].text).toBe("이영준 협의");
    const fresh = await createMeetingSourceSession("/a", draft("이영중 검토"));
    const newProposal = await saveMeetingSourceDraft("/a", fresh.id, { ...fresh.draft, suggestions: [{ ...candidate, baseRevision: fresh.revision }] }, fresh.revision);
    const edited = await saveMeetingSourceDraft("/a", fresh.id, { ...newProposal.draft, sources: [{ ...newProposal.draft.sources[0], text: "추가 안건\n이영중 검토" }] }, newProposal.revision);
    await expect(decideMeetingSourceSuggestion("/a", fresh.id, { id: "name", status: "accepted" }, edited.revision)).rejects.toThrow("context_changed");
  });
  it("preserves exact originals, isolates workspaces and does not expose mutable stored objects", async () => {
    const session = await createMeetingSourceSession("/a", draft("원문\r\n"), "Plaud");
    expect(session.draft.sources[0].originalHash).toMatch(/^[a-f0-9]{64}$/);
    const changed = { ...session.draft, sources: [{ ...session.draft.sources[0], text: "수정본" }] };
    await saveMeetingSourceDraft("/a", session.id, changed, session.revision);
    changed.sources[0].text = "외부 객체 변경";
    const saved = await readMeetingSourceSession("/a", session.id);
    expect(saved.draft.sources[0]).toMatchObject({ originalText: "원문\r\n", text: "수정본" });
    expect(await listMeetingSourceSessions("/b")).toEqual([]);
    await expect(saveMeetingSourceDraft("/a", saved.id, { ...saved.draft, sources: [{ ...saved.draft.sources[0], originalText: "위조" }] }, saved.revision)).rejects.toThrow("immutable");
  });
  it("rejects stale writes and leaves persisted state intact when storage fails", async () => {
    const session = await createMeetingSourceSession("/a", draft(), "Plaud");
    await expect(saveMeetingSourceDraft("/a", session.id, session.draft, "stale")).rejects.toMatchObject({ code: "meeting_source_revision_conflict" });
    const before = await readMeetingSourceSession("/a", session.id); quota = true;
    await expect(saveMeetingSourceDraft("/a", session.id, { ...session.draft, context: "수정" }, session.revision)).rejects.toThrow("quota");
    expect(await readMeetingSourceSession("/a", session.id)).toEqual(before);
  });
  it("requires explicit reviews and preserves no-op confirmation, but invalidates context edits", async () => {
    const session = await createMeetingSourceSession("/a", draft());
    await expect(confirmMeetingSource("/a", session.id, session.revision)).rejects.toThrow("incomplete");
    const reviewed = await saveMeetingSourceDraft("/a", session.id, { ...session.draft, participantsReviewed: true, noteReviewed: true }, session.revision);
    const confirmed = await confirmMeetingSource("/a", session.id, reviewed.revision);
    const pin = { sessionId: confirmed.id, versionId: confirmed.confirmedVersionId!, contentHash: confirmed.versions.at(-1)!.contentHash };
    expect(validateMeetingSourceReference(confirmed, pin).draft.sources[0].text).toBe("Plaud 회의록");
    const noop = await saveMeetingSourceDraft("/a", confirmed.id, confirmed.draft, confirmed.revision);
    expect(noop.revision).toBe(confirmed.revision);
    const changed = await saveMeetingSourceDraft("/a", noop.id, { ...noop.draft, context: "참석자의 역할 변경" }, noop.revision);
    expect(changed.confirmedVersionId).toBeUndefined();
    expect(() => validateMeetingSourceReference(changed, pin)).toThrow("no_longer_confirmed");
  });
  it("saves checkpoint retries once, restores as a new version, and imports optional transcripts", async () => {
    const session = await createMeetingSourceSession("/a", draft());
    const version = await checkpointMeetingSource("/a", session.id, "검토", session.revision);
    expect((await checkpointMeetingSource("/a", session.id, "검토", session.revision)).id).toBe(version.id);
    const latest = await readMeetingSourceSession("/a", session.id);
    const imported = await importMeetingSource("/a", latest.id, { name: "전사", kind: "transcript", text: "화자 1: 검토" }, latest.revision);
    expect(imported.draft.sources).toHaveLength(2);
    await expect(restoreMeetingSourceVersion("/a", latest.id, version.id, latest.revision)).rejects.toThrow("conflict");
    const restored = await restoreMeetingSourceVersion("/a", latest.id, version.id, imported.revision);
    expect(restored.versions).toHaveLength(2);
    expect(restored.draft.sources).toHaveLength(1);
  });
  it("promotes only saved corrections and protects concurrent edits of examples", async () => {
    const session = await createMeetingSourceSession("/a", draft("원문"));
    const corrected = await saveMeetingSourceDraft("/a", session.id, { ...session.draft, sources: [{ ...session.draft.sources[0], text: "수정" }] }, session.revision);
    const version = await checkpointMeetingSource("/a", session.id, "검토", corrected.revision);
    const example: MeetingCorrectionExample = { id: "example", before: "원문", after: "수정", reason: "직접 확인",
      scope: { kind: "person", value: "확인한 참가자" }, enabled: true, sourceSessionId: session.id, sourceVersionId: version.id };
    const saved = await saveMeetingCorrectionExample("/a", example);
    await expect(saveMeetingCorrectionExample("/a", { ...example, id: "unrelated", after: "기록에 없는 수정" })).rejects.toThrow("not_in_version");
    const disabled = await saveMeetingCorrectionExample("/a", { ...saved, enabled: false });
    expect(await listMeetingCorrectionExamples("/a")).toEqual([disabled]);
    await expect(saveMeetingCorrectionExample("/a", saved)).rejects.toThrow("conflict");
    expect(await listMeetingCorrectionExamples("/b")).toEqual([]);
  });
});
