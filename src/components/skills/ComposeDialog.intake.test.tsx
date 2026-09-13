// @vitest-environment jsdom
import { act, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { LocaleContext, registerDictionaries, t } from "../../lib/i18n";
import { ko } from "../../lib/i18n/locales/ko";
import { en } from "../../lib/i18n/locales/en";
import { readDocument } from "../../lib/api";
import { createMeetingSourceSession } from "../../lib/meetingSources";
import { requestMeetingSourceSession } from "../../lib/meetingSourceNavigation";
import type { SkillRecord } from "../../lib/skills";
import { ComposeDialog } from "./ComposeDialog";

vi.mock("../../lib/api", () => ({ readDocument: vi.fn() }));
vi.mock("../../lib/meetingSources", () => ({ createMeetingSourceSession: vi.fn() }));
vi.mock("../../lib/meetingSourceNavigation", () => ({ requestMeetingSourceSession: vi.fn() }));
vi.mock("../../lib/skills", async (original) => ({ ...await original<typeof import("../../lib/skills")>(),
  skillsRuntimeStatus: vi.fn().mockResolvedValue({ available: false }),
  skillsDispatchCompose: vi.fn().mockResolvedValue({ prompt: "preview" }),
}));
vi.mock("../ui/DialogSurface", () => ({
  DialogSurface: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  DialogSurfaceClose: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  DialogSurfaceTitle: ({ children }: { children: ReactNode }) => <div>{children}</div>,
}));
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
const skill: SkillRecord = { id: "meeting-notes", sourceId: "builtin", name: "meeting-notes", relPath: "meeting-notes", absPath: "/skills/meeting-notes", title: "회의록", tier: "core", valid: true, editable: false, dirty: false };
const prompt = "발언자는 협력기관 담당자이며 제안과 결정을 구분하세요.";
let root: Root;
let host: HTMLDivElement;
const openWorkbench = vi.fn();
function selectedFile(name: string, bytes: Uint8Array): File {
  const file = new File([], name);
  Object.defineProperties(file, { size: { value: bytes.byteLength }, arrayBuffer: { value: async () => bytes.buffer } });
  return file;
}
async function select(files: File[]) {
  await act(async () => {
    const input = host.querySelector<HTMLInputElement>('input[type="file"]')!;
    Object.defineProperty(input, "files", { configurable: true, value: files });
    input.dispatchEvent(new Event("change", { bubbles: true }));
  });
}
async function submit() {
  const button = [...host.querySelectorAll<HTMLButtonElement>("button")].find((item) => item.textContent?.trim() === "원문 교정으로 이동")!;
  await act(async () => button.click());
}
beforeEach(async () => {
  vi.clearAllMocks(); registerDictionaries({ ko, en });
  vi.mocked(createMeetingSourceSession).mockImplementation(async (_work, draft) => ({ id: "created", revision: "r1", createdAt: "now", updatedAt: "now", draft, versions: [], outputLinks: [] }));
  host = document.createElement("div"); document.body.appendChild(host); root = createRoot(host);
  await act(async () => root.render(<LocaleContext.Provider value={{ locale: "ko", setLocale: () => {}, t: (key, vars) => t("ko", key, vars) }}>
    <ComposeDialog open skills={[skill]} seed={{ skill, cwd: "/workspace", prompt }} onClose={vi.fn()} onTerminalDispatch={vi.fn()} meetingsWorkspacePath="/workspace" onOpenMeetingsWorkbench={openWorkbench} />
  </LocaleContext.Provider>));
});
afterEach(async () => { await act(async () => root.unmount()); host.remove(); });

describe("Compose meeting source intake", () => {
  it("creates one complete file-only session from external picker bytes with the prompt", async () => {
    await select([selectedFile("downloads-note.md", new TextEncoder().encode("첫 원문")), selectedFile("desktop-note.txt", new TextEncoder().encode("둘째 원문"))]);
    await submit();
    expect(createMeetingSourceSession).toHaveBeenCalledTimes(1);
    expect(createMeetingSourceSession).toHaveBeenCalledWith("/workspace", expect.objectContaining({ context: prompt, sources: [expect.objectContaining({ text: "첫 원문" }), expect.objectContaining({ text: "둘째 원문" })] }));
    expect(readDocument).not.toHaveBeenCalled();
    expect(requestMeetingSourceSession).toHaveBeenCalledWith("/workspace", "created");
    expect(openWorkbench).toHaveBeenCalledOnce();
  });
  it("creates no partial session when a later selected file is invalid, and retries once after replacement", async () => {
    const valid = selectedFile("first.md", new TextEncoder().encode("첫 원문"));
    await select([valid, selectedFile("second.txt", new Uint8Array([255]))]);
    await submit();
    expect(createMeetingSourceSession).not.toHaveBeenCalled();
    expect(requestMeetingSourceSession).not.toHaveBeenCalled();
    expect(openWorkbench).not.toHaveBeenCalled();
    await select([valid, selectedFile("second.txt", new TextEncoder().encode("유효한 두 번째 원문"))]);
    await submit();
    expect(createMeetingSourceSession).toHaveBeenCalledTimes(1);
    expect(openWorkbench).toHaveBeenCalledOnce();
  });
});
