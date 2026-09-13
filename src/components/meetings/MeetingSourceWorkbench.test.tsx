// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { LocaleContext, registerDictionaries, t } from "../../lib/i18n";
import { ko } from "../../lib/i18n/locales/ko";
import { en } from "../../lib/i18n/locales/en";
import { listMeetingSourceSessions, listMeetingCorrectionExamples, saveMeetingSourceDraft, confirmMeetingSource, readMeetingSourceSession, createMeetingSourceSession, deleteMeetingSourceSession, type SourceSession } from "../../lib/meetingSources";
import { MeetingSourceWorkbench } from "./MeetingSourceWorkbench";
vi.mock("../../lib/meetingSources", async (original) => ({
  ...await original<typeof import("../../lib/meetingSources")>(),
  listMeetingSourceSessions: vi.fn(), listMeetingCorrectionExamples: vi.fn(), saveMeetingSourceDraft: vi.fn(),
  confirmMeetingSource: vi.fn(), readMeetingSourceSession: vi.fn(), createMeetingSourceSession: vi.fn(),
  deleteMeetingSourceSession: vi.fn(),
}));
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
let root: Root;
let host: HTMLDivElement;
let initial: SourceSession;
let changed = vi.fn<(value: unknown) => void>();
function sourceSession(): SourceSession {
  return { id: crypto.randomUUID(), revision: "r1", createdAt: "2026-09-13", updatedAt: "2026-09-13", versions: [], outputLinks: [], draft: {
    title: "회의 검토", sources: [{ id: "note", name: "meeting-note.md", kind: "note", originalText: "원문", text: "원문", originalHash: "hash" }],
    participants: [{ id: "unknown", name: "화자 1", speakerLabels: [], attendance: "attendee", status: "uncertain" }],
    findings: [], suggestions: [], participantsReviewed: false, noteReviewed: false,
  } };
}
async function mount() {
  await act(async () => { root.render(<LocaleContext.Provider value={{ locale: "ko", setLocale: () => {}, t: (key, vars) => t("ko", key, vars) }}>
    <MeetingSourceWorkbench workPath="/test" sourceKind="external" onReviewedSourceChange={changed} onRequestAi={vi.fn()} aiBusy={false} />
  </LocaleContext.Provider>); });
}
function button(text: string) {
  const value = [...host.querySelectorAll<HTMLButtonElement>("button")].find((node) => node.textContent?.trim() === text);
  if (!value) throw new Error(`Button not found: ${text}`); return value;
}
function corrected() { return host.querySelectorAll<HTMLTextAreaElement>(".meeting-source-editors textarea")[1]; }
async function edit(text: string) {
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!.call(corrected(), text);
    corrected().dispatchEvent(new Event("input", { bubbles: true }));
  });
}
beforeEach(() => {
  vi.useFakeTimers(); vi.clearAllMocks(); registerDictionaries({ ko, en });
  host = document.createElement("div"); document.body.appendChild(host); root = createRoot(host);
  initial = sourceSession(); changed = vi.fn<(value: unknown) => void>();
  vi.mocked(listMeetingSourceSessions).mockResolvedValue([initial]);
  vi.mocked(listMeetingCorrectionExamples).mockResolvedValue([]);
  vi.mocked(readMeetingSourceSession).mockImplementation(async () => initial);
  vi.mocked(saveMeetingSourceDraft).mockImplementation(async (_work, _id, draft) => ({ ...initial, draft, revision: "r2", confirmedVersionId: undefined }));
});
afterEach(async () => { await act(async () => root.unmount()); host.remove(); vi.useRealTimers(); });

describe("MeetingSourceWorkbench", () => {
  it("preserves visible edits when autosave fails and never reports confirmation", async () => {
    vi.mocked(saveMeetingSourceDraft).mockRejectedValue(new Error("revision conflict"));
    await mount(); await edit("저장 실패 후에도 남아 있는 수정");
    await act(async () => { await vi.advanceTimersByTimeAsync(750); });
    expect(corrected().value).toBe("저장 실패 후에도 남아 있는 수정");
    expect(host.textContent).toContain("revision conflict");
    expect(changed.mock.calls.every(([value]) => value === null)).toBe(true);
  });
  it("defers autosave until Korean IME composition finishes", async () => {
    await mount();
    await act(async () => corrected().dispatchEvent(new CompositionEvent("compositionstart", { bubbles: true })));
    await edit("회의록 수정");
    await act(async () => { await vi.advanceTimersByTimeAsync(900); });
    expect(saveMeetingSourceDraft).not.toHaveBeenCalled();
    await act(async () => corrected().dispatchEvent(new CompositionEvent("compositionend", { bubbles: true })));
    await act(async () => { await vi.advanceTimersByTimeAsync(750); });
    expect(saveMeetingSourceDraft).toHaveBeenCalledWith("/test", initial.id, expect.objectContaining({ sources: expect.arrayContaining([expect.objectContaining({ text: "회의록 수정", originalText: "원문" })]) }), "r1");
  });
  it("allows acknowledged uncertain participants and uses the server's confirmed version", async () => {
    initial.draft.participantsReviewed = true; initial.draft.noteReviewed = true;
    const version = { id: "confirmed", revision: "r1", createdAt: "now", reason: "Confirmed", draft: initial.draft, contentHash: "server-full-context-hash" };
    vi.mocked(confirmMeetingSource).mockResolvedValue({ ...initial, revision: "r2", confirmedVersionId: version.id, versions: [version] });
    await mount(); expect(button("검토 완료").disabled).toBe(false);
    await act(async () => button("검토 완료").click());
    expect(confirmMeetingSource).toHaveBeenCalledWith("/test", initial.id, "r1");
    expect(changed).toHaveBeenLastCalledWith(expect.objectContaining({ reference: { sessionId: initial.id, versionId: "confirmed", contentHash: "server-full-context-hash" } }));
    await edit("확정 후 수정");
    expect(changed).toHaveBeenLastCalledWith(null);
    expect(button("검토 완료").disabled).toBe(true);
  });
  it("creates a blank note from the new button and opens it in the editor", async () => {
    vi.mocked(createMeetingSourceSession).mockImplementation(async (_work, draft) => ({
      id: crypto.randomUUID(), revision: "r1", createdAt: "now", updatedAt: "now", versions: [], outputLinks: [], draft,
    }));
    await mount();
    await act(async () => button("새 회의록").click());
    expect(createMeetingSourceSession).toHaveBeenCalledWith("/test", expect.objectContaining({
      title: "새 회의록", provider: "",
      sources: expect.arrayContaining([expect.objectContaining({ kind: "note", text: "" })]),
    }), "");
    expect(host.querySelector(".meeting-source-editor-body")).not.toBeNull();
  });
  it("deletes a session only after confirmation and closes its editor", async () => {
    const confirmSpy = vi.spyOn(window, "confirm").mockReturnValue(false);
    vi.mocked(deleteMeetingSourceSession).mockResolvedValue(undefined);
    await mount();
    const deleteButton = () => host.querySelector<HTMLButtonElement>("button[aria-label='회의록 삭제']")!;
    await act(async () => deleteButton().click());
    expect(deleteMeetingSourceSession).not.toHaveBeenCalled();
    confirmSpy.mockReturnValue(true);
    await act(async () => deleteButton().click());
    expect(deleteMeetingSourceSession).toHaveBeenCalledWith("/test", initial.id);
    expect(host.querySelector(".meeting-source-session-row")).toBeNull();
    expect(host.querySelector(".meeting-source-editor-body")).toBeNull();
    confirmSpy.mockRestore();
  });
  it("saves a clean draft on demand and shows a transient saved confirmation", async () => {
    await mount();
    const save = button("임시저장");
    expect(save.disabled).toBe(false);
    await act(async () => save.click());
    expect(saveMeetingSourceDraft).not.toHaveBeenCalled();
    expect(host.querySelector(".save-flash")).not.toBeNull();
    await act(async () => { await vi.advanceTimersByTimeAsync(1600); });
    expect(host.querySelector(".save-flash")).toBeNull();
  });
  it("resyncs from the saved session when an action fails", async () => {
    initial.draft.participantsReviewed = true; initial.draft.noteReviewed = true;
    vi.mocked(confirmMeetingSource).mockRejectedValue(new Error("boom"));
    await mount();
    await act(async () => button("검토 완료").click());
    expect(host.textContent).toContain("boom");
    expect(readMeetingSourceSession).toHaveBeenCalledWith("/test", initial.id);
  });
});
