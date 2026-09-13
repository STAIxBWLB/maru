import { beforeEach, describe, expect, it, vi } from "vitest";
import { MeetingSourceEditorStore } from "./meetingSourceEditorStore";
import { saveMeetingSourceDraft, type SourceSession } from "./meetingSources";
vi.mock("./meetingSources", () => ({ saveMeetingSourceDraft: vi.fn() }));
const save = vi.mocked(saveMeetingSourceDraft);
const session = (): SourceSession => ({ id: "session", revision: "r1", createdAt: "now", updatedAt: "now", versions: [], outputLinks: [],
  draft: { sources: [{ id: "note", name: "meeting-note", kind: "note", text: "원문", originalText: "원문", originalHash: "sha" }],
    participants: [], findings: [], suggestions: [], participantsReviewed: false, noteReviewed: false } });
beforeEach(() => save.mockReset());
describe("source editor working buffer", () => {
  it("preserves unsaved corrections and the old revision when save fails", async () => {
    const initial = session(); const editor = new MeetingSourceEditorStore("/workspace", initial);
    editor.update((d) => ({ ...d, context: "내가 수정한 맥락" }));
    save.mockRejectedValueOnce(new Error("conflict"));
    await expect(editor.flush()).rejects.toThrow("conflict");
    expect(editor.getSnapshot()).toMatchObject({ dirty: true, saving: false, draft: { context: "내가 수정한 맥락" }, session: { revision: "r1" } });
    editor.install({ ...initial, revision: "external-change" });
    expect(editor.getSnapshot().draft.context).toBe("내가 수정한 맥락");
  });
  it("serializes saves and retains edits made during an in-flight request", async () => {
    const editor = new MeetingSourceEditorStore("/workspace", session());
    editor.update((d) => ({ ...d, context: "first" }));
    let resolveFirst!: (value: SourceSession) => void;
    save.mockImplementationOnce(() => new Promise((resolve) => { resolveFirst = resolve; }));
    save.mockImplementationOnce(async (_work, _id, draft) => ({ ...session(), draft, revision: "r3" }));
    const first = editor.flush(); const same = editor.flush(); expect(first).toBe(same);
    const firstDraft = editor.getSnapshot().draft;
    editor.update((d) => ({ ...d, context: "second" }));
    resolveFirst({ ...session(), draft: firstDraft, revision: "r2" });
    await first;
    expect(save).toHaveBeenCalledTimes(2);
    expect(save.mock.calls[1][3]).toBe("r2");
    expect(editor.getSnapshot()).toMatchObject({ dirty: false, draft: { context: "second" }, session: { revision: "r3" } });
  });
});
