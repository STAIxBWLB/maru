import { describe, expect, it, vi } from "vitest";
import { prepareMeetingSourceIntake, type SelectedMeetingFile } from "./meetingSourceIntake";

function file(name: string, text: string): SelectedMeetingFile {
  const bytes = new TextEncoder().encode(text);
  return { name, size: bytes.byteLength, arrayBuffer: async () => bytes.buffer };
}
const base = () => ({ title: "회의록 교정", prompt: "참가자는 협력기관 담당자이며 제안과 결정을 구분할 것.",
  pastedText: "", files: [] as SelectedMeetingFile[], contextPaths: [] as string[], readContext: vi.fn<(path: string) => Promise<string>>() });

describe("meeting source intake preparation", () => {
  it("reads browser-granted external files and preserves file-only prompt context", async () => {
    const input = base(); input.files = [Object.assign(file("meeting-note.md", "# 회의\r\n원문\r\n"), { path: "/Users/test/Downloads/meeting-note.md" })];
    const draft = await prepareMeetingSourceIntake(input);
    expect(draft?.title).toBe("meeting-note.md");
    expect(draft?.context).toBe(input.prompt);
    expect(draft?.sources[0]).toMatchObject({ name: "meeting-note.md", text: "# 회의\r\n원문\r\n", originalText: "# 회의\r\n원문\r\n" });
    expect(input.readContext).not.toHaveBeenCalled();
  });
  it("combines pasted text, files and unique workspace references in one draft", async () => {
    const input = base(); input.pastedText = "붙여넣은 원본"; input.files = [file("export.txt", "파일 원본")];
    input.contextPaths = ["meetings/reference.md", "meetings/reference.md"];
    input.readContext.mockResolvedValue("---\ntitle: 참고\n---\n참고 내용");
    const draft = await prepareMeetingSourceIntake(input);
    expect(draft?.sources.map((source) => source.text)).toEqual([input.pastedText, "파일 원본", "---\ntitle: 참고\n---\n참고 내용"]);
    expect(new Set(draft?.sources.map((source) => source.id)).size).toBe(3);
    expect(input.readContext).toHaveBeenCalledTimes(1);
  });
  it("rejects unsupported, oversized, empty and undecodable files before producing a draft", async () => {
    for (const bad of [file("bad.pdf", "pdf"), { ...file("huge.md", "x"), size: 2 * 1024 * 1024 + 1 }, file("empty.md", ""),
      { name: "invalid.txt", size: 1, arrayBuffer: async () => new Uint8Array([255]).buffer }]) {
      await expect(prepareMeetingSourceIntake({ ...base(), pastedText: "입력 메모", files: [file("valid.md", "첫 파일"), bad] })).rejects.toThrow();
    }
  });
  it("does not produce a draft when a later workspace reference cannot be read", async () => {
    const input = base(); input.files = [file("first.md", "첫 파일")]; input.contextPaths = ["missing.md"];
    input.readContext.mockRejectedValue(new Error("file disappeared"));
    await expect(prepareMeetingSourceIntake(input)).rejects.toThrow("file disappeared");
  });
});
