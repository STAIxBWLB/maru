// @vitest-environment jsdom
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import ts from "typescript";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Compile the actual self-contained callback WebDriver serializes, without
// importing the WDIO runtime or the fixture's filesystem lifecycle into Vitest.
const source = readFileSync(resolve("e2e-native/helpers/shellSession.ts"), "utf8");
const ast = ts.createSourceFile("shellSession.ts", source, ts.ScriptTarget.ES2022, true);
const declaration = ast.statements.find((node) => ts.isFunctionDeclaration(node) && node.name?.text === "pollNativeShell")!;
const code = ts.transpileModule(declaration.getText(ast), { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS } }).outputText;
const exported: Record<string, unknown> = {};
new Function("exports", code)(exported);
type Request = { phase: "open" | "launch" | "select" | "prompt" | "focus" | "split"; splitExpected?: boolean; requireAutoSession?: boolean; priorIds?: string[]; sessionId?: string };
type Result = { ready: boolean; sessionId: string | null; sessionIds: string[]; restoredTabsPresent: boolean; diagnostics: { views: Array<{ id: string; visible: boolean; focused: boolean; promptReady: boolean }>; bodies: Array<{ split: boolean; visible: boolean }>; activeElement: unknown } };
const poll = exported.pollNativeShell as (request: Request, timeout: number, done: (result: Result) => void) => void;
let text: Map<string, string>;
let launch = vi.fn<() => void>();
function probe(request: Request, timeout = 20_000) {
  const done = vi.fn<(result: Result) => void>();
  poll(request, timeout, done);
  return done;
}
function view(id: string, pane: "left" | "right", focused: boolean) {
  const instance = document.createElement("div");
  instance.className = `terminal-instance active pane-${pane}${focused ? " focused" : ""}`;
  instance.innerHTML = `<div class="native-terminal-view" data-session-id="${id}"><textarea class="native-terminal-input"></textarea></div>`;
  document.querySelector(".terminal-body")!.append(instance);
  return instance;
}
function hide(instance: HTMLElement) {
  instance.classList.remove("active", "focused");
  instance.style.visibility = "hidden";
}
beforeEach(() => {
  vi.useFakeTimers();
  text = new Map();
  const bridgeWindow = window as unknown as { __MARU_NATIVE_E2E__?: { terminalText: (id: string) => string | null } };
  bridgeWindow.__MARU_NATIVE_E2E__ = { terminalText: (id) => text.get(id) ?? null };
  window.localStorage.clear();
  document.body.innerHTML = '<button class="terminal-title">Terminal</button><div class="terminal-launchers"><button aria-label="Shell">Shell</button></div><div class="terminal-workspace"><div class="terminal-body"></div></div>';
  launch = vi.fn<() => void>();
  document.querySelector<HTMLButtonElement>('[aria-label="Shell"]')!.onclick = () => launch();
  const rect = new DOMRect(0, 0, 640, 200);
  vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockReturnValue(rect);
  vi.spyOn(HTMLElement.prototype, "getClientRects").mockReturnValue([rect] as unknown as DOMRectList);
});
afterEach(() => {
  vi.clearAllTimers();
  vi.useRealTimers();
  vi.restoreAllMocks();
  delete (window as unknown as { __MARU_NATIVE_E2E__?: unknown }).__MARU_NATIVE_E2E__;
  document.body.replaceChildren();
});

describe("native explicit shell attribution", () => {
  it("samples restored placeholders before opening and waits for the split's automatic right prompt", () => {
    window.localStorage.setItem("maru:terminal:v1", JSON.stringify({ tasks: [{ id: "task", name: "Restored" }], sessions: [{ taskId: "task", kind: "shell" }] }));
    const opened = probe({ phase: "open" });
    expect(opened.mock.calls[0][0].restoredTabsPresent).toBe(true);
    const pending = probe({ phase: "launch", splitExpected: true });
    expect(pending).not.toHaveBeenCalled();
    expect(launch).not.toHaveBeenCalled();
    // A restored left placeholder has no NativeTerminalView. Restoring split
    // still creates this automatic right PTY after the panel opens.
    document.querySelector(".terminal-body")!.classList.add("split");
    const automatic = view("automatic-right", "right", true);
    vi.advanceTimersByTime(100);
    expect(launch).not.toHaveBeenCalled();
    text.set("automatic-right", "$ ");
    vi.advanceTimersByTime(100);
    const baseline = pending.mock.calls[0][0].sessionIds;
    expect(baseline).toEqual(["automatic-right"]);
    expect(launch).toHaveBeenCalledOnce();
    const selected = probe({ phase: "select", priorIds: baseline });
    expect(selected).not.toHaveBeenCalled();
    hide(automatic);
    view("explicit-right", "right", true);
    vi.advanceTimersByTime(100);
    expect(selected.mock.calls[0][0].sessionId).toBe("explicit-right");
  });

  it("does not let a live left pane or a late old right view replace the explicit launcher target", () => {
    const left = view("live-left", "left", true);
    text.set("live-left", "$ ");
    const pending = probe({ phase: "launch", splitExpected: true });
    expect(launch).not.toHaveBeenCalled();
    document.querySelector(".terminal-body")!.classList.add("split");
    left.classList.remove("focused");
    const automatic = view("automatic-right", "right", true);
    text.set("automatic-right", "$ ");
    vi.advanceTimersByTime(100);
    const baseline = pending.mock.calls[0][0].sessionIds;
    expect(baseline).toEqual(["live-left", "automatic-right"]);
    const selection = probe({ phase: "select", priorIds: baseline });
    expect(selection).not.toHaveBeenCalled();
    hide(automatic);
    const explicit = view("explicit-right", "right", true);
    vi.advanceTimersByTime(100);
    expect(selection.mock.calls[0][0].sessionId).toBe("explicit-right");
    // An old mounted pane can retain a text mirror; it does not own focus.
    automatic.classList.add("active");
    const selectedInput = explicit.querySelector<HTMLTextAreaElement>("textarea")!;
    const focus = vi.spyOn(selectedInput, "focus");
    const focused = probe({ phase: "focus", sessionId: "explicit-right" });
    expect(focused.mock.calls[0][0].ready).toBe(true);
    expect(focus).toHaveBeenCalledOnce();
    expect(document.activeElement).toBe(selectedInput);
  });

  it("never rebinds a prompt/focus check to a different session after its target becomes hidden", () => {
    const selected = view("selected", "left", true);
    text.set("selected", "sensitive terminal output");
    const input = selected.querySelector<HTMLTextAreaElement>("textarea")!;
    input.value = "sensitive typed input";
    const inputFocus = vi.spyOn(input, "focus");
    hide(selected);
    view("replacement", "left", true);
    text.set("replacement", "$ ");
    const prompt = probe({ phase: "prompt", sessionId: "selected" });
    const focus = probe({ phase: "focus", sessionId: "selected" });
    vi.advanceTimersByTime(20_000);
    expect(prompt.mock.calls[0][0].ready).toBe(false);
    expect(focus.mock.calls[0][0].ready).toBe(false);
    expect(inputFocus).not.toHaveBeenCalled();
    const diagnostics = focus.mock.calls[0][0].diagnostics;
    expect(diagnostics.views.map((item) => item.id)).toEqual(["selected", "replacement"]);
    expect(diagnostics.views.find((item) => item.id === "selected")?.visible).toBe(false);
    expect(JSON.stringify(diagnostics)).not.toContain("sensitive");
  });

  it("rejects an ACTIVE+FOCUSED view hidden by an ancestor and rejects ambiguous focused panes", () => {
    const instance = view("hidden", "left", true);
    document.querySelector<HTMLElement>(".terminal-workspace")!.hidden = true;
    const hidden = probe({ phase: "select", priorIds: [] });
    vi.advanceTimersByTime(20_000);
    expect(hidden.mock.calls[0][0].ready).toBe(false);
    document.querySelector<HTMLElement>(".terminal-workspace")!.hidden = false;
    view("other", "right", true);
    const ambiguous = probe({ phase: "select", priorIds: [] });
    vi.advanceTimersByTime(20_000);
    expect(ambiguous.mock.calls[0][0].ready).toBe(false);
    expect(instance.classList.contains("focused")).toBe(true);
  });

  it("does not wait for an ordinary auto-launch when a nonsplit restored placeholder suppresses it", () => {
    const ready = probe({ phase: "launch", splitExpected: false, requireAutoSession: false });
    expect(ready.mock.calls[0][0].ready).toBe(true);
    expect(ready.mock.calls[0][0].sessionIds).toEqual([]);
    expect(launch).toHaveBeenCalledOnce();
  });

  it("captures pre-open state even when opening immediately writes new session metadata", () => {
    document.querySelector<HTMLButtonElement>(".terminal-title")!.onclick = () => {
      window.localStorage.setItem("maru:terminal:v1", JSON.stringify({ tasks: [{ id: "new", name: "New" }], sessions: [{ taskId: "new", kind: "shell" }] }));
      view("ordinary-automatic", "left", true);
    };
    const opened = probe({ phase: "open" });
    expect(opened.mock.calls[0][0].sessionIds).toEqual([]);
    expect(opened.mock.calls[0][0].restoredTabsPresent).toBe(false);
    const pending = probe({ phase: "launch", requireAutoSession: true });
    expect(launch).not.toHaveBeenCalled();
    text.set("ordinary-automatic", "$ ");
    vi.advanceTimersByTime(100);
    expect(pending.mock.calls[0][0].sessionIds).toEqual(["ordinary-automatic"]);
    expect(launch).toHaveBeenCalledOnce();
  });

  it("requires one visible split body with distinct painted left/right IDs and preserves the selected left", () => {
    document.querySelector(".terminal-body")!.classList.add("split");
    view("original-left", "left", false); view("right", "right", true);
    text.set("original-left", "$ "); text.set("right", "$ ");
    const ready = probe({ phase: "split", sessionId: "original-left" });
    expect(ready.mock.calls[0][0].ready).toBe(true);
    expect(ready.mock.calls[0][0].diagnostics.bodies).toEqual([expect.objectContaining({ split: true, visible: true })]);
    expect(ready.mock.calls[0][0].diagnostics.views.every((item) => item.promptReady)).toBe(true);
  });

  it("excludes hidden ACTIVE keep-alive views, but never excludes a visible unpainted pane to make the count pass", () => {
    document.querySelector(".terminal-body")!.classList.add("split");
    view("left", "left", false); const right = view("right", "right", true);
    const hidden = view("hidden-old-right", "right", false); hidden.style.visibility = "hidden";
    text.set("left", "$ "); text.set("right", "$ ");
    expect(probe({ phase: "split", sessionId: "left" }).mock.calls[0][0].ready).toBe(true);
    const unpainted = view("visible-unpainted", "right", false);
    const tooMany = probe({ phase: "split", sessionId: "left" }); vi.advanceTimersByTime(20_000);
    expect(tooMany.mock.calls[0][0].ready).toBe(false);
    expect(tooMany.mock.calls[0][0].diagnostics.views.find((item) => item.id === "visible-unpainted"))
      .toMatchObject({ visible: true, promptReady: false });
    hide(unpainted); text.set("right", "");
    const noPrompt = probe({ phase: "split", sessionId: "left" }); vi.advanceTimersByTime(20_000);
    expect(noPrompt.mock.calls[0][0].ready).toBe(false);
    expect(right.classList.contains("active")).toBe(true);
  });

  it("reports a split rollback without retrying any command", () => {
    view("left", "left", true); text.set("left", "$ ");
    const rolledBack = probe({ phase: "split", sessionId: "left" }); vi.advanceTimersByTime(20_000);
    expect(rolledBack.mock.calls[0][0].ready).toBe(false);
    expect(rolledBack.mock.calls[0][0].diagnostics.bodies).toEqual([expect.objectContaining({ split: false, visible: true })]);
    expect(launch).not.toHaveBeenCalled();
  });

  it("refuses a replacement left ID and identical IDs even when both panes have real prompts", () => {
    document.querySelector(".terminal-body")!.classList.add("split");
    view("replacement-left", "left", false); const right = view("right", "right", true);
    text.set("replacement-left", "$ "); text.set("right", "$ ");
    const replaced = probe({ phase: "split", sessionId: "original-left" }); vi.advanceTimersByTime(20_000);
    expect(replaced.mock.calls[0][0].ready).toBe(false);
    right.querySelector<HTMLElement>(".native-terminal-view")!.dataset.sessionId = "replacement-left";
    const duplicate = probe({ phase: "split", sessionId: "replacement-left" }); vi.advanceTimersByTime(20_000);
    expect(duplicate.mock.calls[0][0].ready).toBe(false);
  });

  it("rejects multiple visible split bodies rather than choosing one arbitrarily", () => {
    document.querySelector(".terminal-body")!.classList.add("split");
    view("left", "left", false); view("right", "right", true); text.set("left", "$ "); text.set("right", "$ ");
    const other = document.createElement("div"); other.className = "terminal-body split"; document.querySelector(".terminal-workspace")!.append(other);
    const ambiguous = probe({ phase: "split", sessionId: "left" }); vi.advanceTimersByTime(20_000);
    expect(ambiguous.mock.calls[0][0].ready).toBe(false);
  });

});
