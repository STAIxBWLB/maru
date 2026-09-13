import { describe, expect, it } from "vitest";
import {
  applySourceSuggestion, buildSourceReviewPrompt, buildSourceTextDiff,
  matchingCorrectionExamples, parseSourceReviewSuggestions, buildSourceSideBySideRows,
} from "./meetingSourceReview";
import type { SourceSession, SourceSuggestion, MeetingCorrectionExample } from "./meetingSources";

function session(): SourceSession {
  return {
    id: "session-one", revision: "revision-one", createdAt: "2026-09-13", updatedAt: "2026-09-13",
    versions: [], outputLinks: [],
    draft: {
      title: "협력 회의", context: "사업 검토", participants: [], findings: [],
      sources: [{ id: "note", name: "Plaud.md", kind: "note", originalText: "이영중이 검토한다.",
        text: "이영중이 검토한다.", originalHash: "hash" }],
      suggestions: [], participantsReviewed: false, noteReviewed: false,
    },
  };
}
function suggestion(patch: Partial<SourceSuggestion> = {}): SourceSuggestion {
  return { id: "s1", sourceId: "note", before: "이영중", after: "이영준", reason: "참가자 확인",
    category: "person", evidence: "참가자가 이름을 확인함", required: true, status: "pending",
    baseRevision: "revision-one", ...patch };
}
function artifact(s: SourceSession, suggestions: unknown[]) {
  return JSON.stringify({ schemaVersion: "maru_meeting_source_review_v1", sessionId: s.id,
    baseRevision: s.revision, suggestions });
}

describe("meeting source suggestions", () => {
  it("parses a provider envelope and binds evidence to a known source revision", () => {
    const s = session();
    const raw = `검토 결과\n\`\`\`json\n${artifact(s, [suggestion()])}\n\`\`\``;
    expect(parseSourceReviewSuggestions(raw, s, "run")[0]).toMatchObject({ id: "run:s1", sourceId: "note", runId: "run", evidence: "참가자가 이름을 확인함" });
  });
  it("rejects stale sessions, nonexistent passages and duplicate suggestion identities", () => {
    const s = session();
    expect(() => parseSourceReviewSuggestions(artifact(s, []), { ...s, revision: "new" }, "run")).toThrow("stale");
    expect(() => parseSourceReviewSuggestions(artifact(s, [suggestion({ before: "없는 인물" })]), s, "run")).toThrow("invalid");
    expect(() => parseSourceReviewSuggestions(artifact(s, [suggestion(), suggestion()]), s, "run")).toThrow("invalid");
  });
  it("rejects fabricated transcript evidence and preserves verified quotations", () => {
    const s = session();
    s.draft.sources.push({ id: "transcript", kind: "transcript", name: "전사", originalText: "이영준입니다.", text: "이영준입니다.", originalHash: "hash" });
    const grounded = suggestion({ evidenceSourceId: "transcript", evidenceQuote: "이영준입니다." });
    expect(parseSourceReviewSuggestions(artifact(s, [grounded]), s, "run")[0].evidenceQuote).toBe("이영준입니다.");
    expect(() => parseSourceReviewSuggestions(artifact(s, [{ ...grounded, evidenceQuote: "확인되지 않은 발언" }]), s, "run")).toThrow("invalid_evidence");
  });
  it("preserves the immutable original and rejected words when accepting a correction", () => {
    const s = session();
    s.draft.suggestions = [suggestion(), suggestion({ id: "s2", before: "검토", after: "승인" })];
    const accepted = applySourceSuggestion(s.draft, "s1", "accepted");
    const rejected = applySourceSuggestion(accepted, "s2", "rejected");
    expect(rejected.sources[0].text).toBe("이영준이 검토한다.");
    expect(rejected.sources[0].originalText).toBe("이영중이 검토한다.");
    expect(s.draft.sources[0].text).toBe("이영중이 검토한다.");
    expect(rejected.noteReviewed).toBe(false);
  });
  it("does not guess repeated occurrences or overwrite overlapping/newer edits", () => {
    const s = session();
    s.draft.suggestions = [suggestion()];
    s.draft.sources[0].text = "이영중과 이영중";
    expect(() => applySourceSuggestion(s.draft, "s1", "accepted")).toThrow("ambiguous");
    s.draft.sources[0].text = "이영준이 검토한다.";
    expect(() => applySourceSuggestion(s.draft, "s1", "accepted")).toThrow("stale");
  });
  it("retains explicit uncertainties without asserting corrected facts", () => {
    const s = session(); s.draft.suggestions = [suggestion()];
    const next = applySourceSuggestion(s.draft, "s1", "uncertain");
    expect(next.sources[0].text).toBe(s.draft.sources[0].text);
    expect(next.suggestions[0].status).toBe("uncertain");
  });
});

describe("correction examples and source prompts", () => {
  it("uses enabled examples only within confirmed participant scope", () => {
    const s = session();
    const sample: MeetingCorrectionExample = { id: "e", before: "이영중", after: "이영준", reason: "확인",
      scope: { kind: "person", value: "이영준" }, enabled: true };
    expect(matchingCorrectionExamples(s.draft, [sample])).toEqual([]);
    s.draft.participants = [{ id: "p", name: "이영준", status: "uncertain", attendance: "attendee", speakerLabels: [] }];
    expect(matchingCorrectionExamples(s.draft, [sample])).toEqual([]);
    s.draft.participants[0].status = "confirmed";
    expect(matchingCorrectionExamples(s.draft, [sample, { ...sample, id: "disabled", enabled: false }])).toEqual([sample]);
  });
  it("keeps the imported summary primary and does not require transcript evidence", () => {
    const prompt = buildSourceReviewPrompt(session(), null, []);
    expect(prompt).toContain("Transcripts are optional reference evidence");
    expect(prompt).toContain("never claim transcript verification");
    expect(prompt).toContain("이영중이 검토한다.");
    expect(prompt).not.toContain("maru_skill_proposal_v1");
  });
});

describe("source comparison", () => {
  it("pairs original and corrected lines in parallel columns, leaving blanks for added lines", () => {
    const rows = buildSourceSideBySideRows(buildSourceTextDiff("회의\n기존 발언\n마무리", "회의\n수정 발언\n추가 발언\n마무리"));
    expect(rows.map((row) => [row.left?.text ?? null, row.right?.text ?? null])).toEqual([
      ["회의", "회의"], ["기존 발언", "수정 발언"], [null, "추가 발언"], ["마무리", "마무리"],
    ]);
    expect(rows[1].left?.changed).toBe(true);
    expect(rows[1].right?.changed).toBe(true);
    expect(rows.at(-1)?.right?.lineNumber).toBe(4);
  });
  it("aligns inserts, removals and Korean replacements", () => {
    const rows = buildSourceTextDiff("회의\n이영중\n검토", "회의\n이영준\n추가\n검토");
    expect(rows.filter((r) => r.kind !== "added").map((r) => r.text).join("\n")).toBe("회의\n이영중\n검토");
    expect(rows.filter((r) => r.kind !== "removed").map((r) => r.text).join("\n")).toBe("회의\n이영준\n추가\n검토");
    expect(rows.at(-1)).toMatchObject({ kind: "equal", oldLineNumber: 3, newLineNumber: 4 });
  });
  it("retains all content across large unmatched regions", () => {
    const before = Array.from({ length: 1500 }, (_, n) => `원문 ${n}`).join("\n");
    const after = Array.from({ length: 1700 }, (_, n) => `수정 ${n}`).join("\n");
    const rows = buildSourceTextDiff(before, after);
    expect(rows.filter((r) => r.kind !== "added").map((r) => r.text).join("\n")).toBe(before);
    expect(rows.filter((r) => r.kind !== "removed").map((r) => r.text).join("\n")).toBe(after);
  });
});
