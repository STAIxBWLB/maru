// @vitest-environment jsdom

// Review finding #2, round 2 (owner-observed regression): window.confirm is
// not a reliable blocking gate in this app's WKWebView — a dirty skill
// editor edit was lost on Cmd+Q with no dialog ever appearing. These tests
// drive the component's onCloseRequested handler, its quit-check listener,
// and the app.quit menu fallback directly, mocking the Tauri window/event/
// dialog/process bridges.
import { act } from "react";
import { createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { LocaleContext, registerDictionaries, t as translate } from "../../lib/i18n";
import { en } from "../../lib/i18n/locales/en";
import { ko } from "../../lib/i18n/locales/ko";
import { MENU_COMMAND_EVENT } from "../../lib/menu";
import type { SkillDocument } from "../../lib/skills";
import {
  SKILL_EDITOR_QUIT_CHECK_ACK_EVENT,
  SKILL_EDITOR_QUIT_CHECK_EVENT,
  SKILL_EDITOR_QUIT_CHECK_RESPONSE_EVENT,
} from "../../lib/skillEditorEvents";

const mocks = vi.hoisted(() => ({
  skillsReadSkill: vi.fn(),
  skillsListSources: vi.fn(),
  skillsSaveSkillFile: vi.fn(),
  skillsSaveSkillAs: vi.fn(),
  onCloseRequested: vi.fn(),
  windowClose: vi.fn(),
  setTitle: vi.fn(),
  listen: vi.fn(),
  emit: vi.fn(),
  dialogConfirm: vi.fn(),
  processExit: vi.fn(),
}));

vi.mock("../../lib/skills", async (original) => ({
  ...(await original<typeof import("../../lib/skills")>()),
  skillsReadSkill: mocks.skillsReadSkill,
  skillsListSources: mocks.skillsListSources,
  skillsSaveSkillFile: mocks.skillsSaveSkillFile,
  skillsSaveSkillAs: mocks.skillsSaveSkillAs,
}));

vi.mock("@tauri-apps/api/window", () => ({
  getCurrentWindow: () => ({
    label: "skill-editor",
    onCloseRequested: mocks.onCloseRequested,
    close: mocks.windowClose,
    setTitle: mocks.setTitle,
  }),
}));

vi.mock("@tauri-apps/api/event", () => ({
  listen: mocks.listen,
  emit: mocks.emit,
}));

// listenForMenuCommand listens window-scoped; route it into the same
// handler registry so the app.quit tests below can fire it.
vi.mock("@tauri-apps/api/webviewWindow", () => ({
  getCurrentWebviewWindow: () => ({
    label: "skill-editor",
    listen: (event: string, handler: unknown) => mocks.listen(event, handler),
  }),
}));

vi.mock("@tauri-apps/plugin-dialog", () => ({
  confirm: mocks.dialogConfirm,
}));

vi.mock("@tauri-apps/plugin-process", () => ({
  exit: mocks.processExit,
}));

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

import { SkillEditorWindow } from "./SkillEditorWindow";

type CloseEvent = { preventDefault: () => void };
type CloseHandler = (event: CloseEvent) => Promise<void> | void;
type EventHandler = (event: { payload: unknown }) => void;

function makeEvent(): CloseEvent {
  return { preventDefault: vi.fn() };
}

function capturedCloseHandler(): CloseHandler {
  const call = mocks.onCloseRequested.mock.calls[0] as [CloseHandler] | undefined;
  if (!call) throw new Error("onCloseRequested was never called");
  return call[0];
}

function handlersFor(eventName: string): EventHandler[] {
  return mocks.listen.mock.calls
    .filter(([name]) => name === eventName)
    .map(([, handler]) => handler as EventHandler);
}

function skillDocument(): SkillDocument {
  return {
    skill: {
      id: "skill-1",
      sourceId: "source-1",
      name: "example",
      relPath: "example/SKILL.md",
      absPath: "/work/skills/example/SKILL.md",
      title: "Example",
      tier: "user",
      editable: true,
      dirty: false,
    },
    content: "original content",
  };
}

let root: Root;
let host: HTMLDivElement;

async function mount(): Promise<void> {
  await act(async () => {
    root.render(
      createElement(
        LocaleContext.Provider,
        {
          value: { locale: "ko" as const, setLocale: () => {}, t: (key: string, vars?: Record<string, string | number>) => translate("ko", key, vars) },
        },
        createElement(SkillEditorWindow, { initialWorkPath: "/work", initialSkillId: "skill-1" }),
      ),
    );
  });
  // Let every effect's dynamic-import + mocked-async-API microtask chain
  // settle (each is import().then().then()) before assertions run.
  await act(async () => {
    for (let tick = 0; tick < 8; tick += 1) {
      await Promise.resolve();
    }
  });
}

function dirtyTextarea(value = "edited content"): void {
  const textarea = host.querySelector<HTMLTextAreaElement>("textarea")!;
  const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!;
  setter.call(textarea, value);
  textarea.dispatchEvent(new Event("input", { bubbles: true }));
}

beforeEach(() => {
  vi.clearAllMocks();
  registerDictionaries({ ko, en });
  mocks.skillsReadSkill.mockResolvedValue(skillDocument());
  mocks.skillsListSources.mockResolvedValue([]);
  mocks.onCloseRequested.mockImplementation(() => Promise.resolve(vi.fn()));
  mocks.windowClose.mockResolvedValue(undefined);
  mocks.setTitle.mockResolvedValue(undefined);
  mocks.listen.mockImplementation(() => Promise.resolve(vi.fn()));
  mocks.emit.mockResolvedValue(undefined);
  // listenForMenuCommand (../../lib/menu.ts) no-ops without this.
  (window as unknown as { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__ = {};
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
});

afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
  (window as unknown as { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__ = undefined;
});

describe("SkillEditorWindow onCloseRequested", () => {
  it("awaits the dialog plugin's confirm() before deciding, and a declined confirm blocks the close", async () => {
    await mount();
    act(() => {
      dirtyTextarea();
    });

    let resolveConfirm!: (value: boolean) => void;
    mocks.dialogConfirm.mockReturnValue(
      new Promise<boolean>((resolve) => {
        resolveConfirm = resolve;
      }),
    );

    const event = makeEvent();
    let handlerDone: Promise<void> | void;
    await act(async () => {
      handlerDone = capturedCloseHandler()(event) as Promise<void>;
      await Promise.resolve();
    });

    // The handler must not have decided yet — it's awaiting confirm().
    expect(event.preventDefault).not.toHaveBeenCalled();
    expect(mocks.dialogConfirm).toHaveBeenCalledWith(
      translate("ko", "skillEditor.closeConfirm"),
      { kind: "warning" },
    );

    await act(async () => {
      resolveConfirm(false);
      await handlerDone;
    });

    expect(event.preventDefault).toHaveBeenCalledTimes(1);
  });

  it("a confirmed close does not prevent the default close", async () => {
    await mount();
    act(() => {
      dirtyTextarea();
    });
    mocks.dialogConfirm.mockResolvedValue(true);

    const event = makeEvent();
    await act(async () => {
      await capturedCloseHandler()(event);
    });

    expect(event.preventDefault).not.toHaveBeenCalled();
  });

  it("a clean (non-dirty) close never calls confirm at all", async () => {
    await mount();

    const event = makeEvent();
    await act(async () => {
      await capturedCloseHandler()(event);
    });

    expect(mocks.dialogConfirm).not.toHaveBeenCalled();
    expect(event.preventDefault).not.toHaveBeenCalled();
  });
});

describe("SkillEditorWindow quit-check listener", () => {
  it("acks immediately, before resolving dirty/confirm, then responds once confirm settles", async () => {
    await mount();
    act(() => {
      dirtyTextarea();
    });

    let resolveConfirm!: (value: boolean) => void;
    mocks.dialogConfirm.mockReturnValue(
      new Promise<boolean>((resolve) => {
        resolveConfirm = resolve;
      }),
    );

    await act(async () => {
      handlersFor(SKILL_EDITOR_QUIT_CHECK_EVENT).forEach((handler) =>
        handler({ payload: undefined }),
      );
      await Promise.resolve();
    });

    // The ack must already have gone out before confirm() resolves.
    expect(mocks.emit).toHaveBeenCalledWith(SKILL_EDITOR_QUIT_CHECK_ACK_EVENT, undefined);
    expect(mocks.emit).not.toHaveBeenCalledWith(
      SKILL_EDITOR_QUIT_CHECK_RESPONSE_EVENT,
      expect.anything(),
    );

    await act(async () => {
      resolveConfirm(false);
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(mocks.emit).toHaveBeenCalledWith(SKILL_EDITOR_QUIT_CHECK_RESPONSE_EVENT, {
      proceed: false,
    });
  });

  it("acks and responds proceed:true immediately when there is nothing dirty", async () => {
    await mount();

    await act(async () => {
      handlersFor(SKILL_EDITOR_QUIT_CHECK_EVENT).forEach((handler) =>
        handler({ payload: undefined }),
      );
      await Promise.resolve();
    });

    expect(mocks.dialogConfirm).not.toHaveBeenCalled();
    expect(mocks.emit).toHaveBeenCalledWith(SKILL_EDITOR_QUIT_CHECK_ACK_EVENT, undefined);
    expect(mocks.emit).toHaveBeenCalledWith(SKILL_EDITOR_QUIT_CHECK_RESPONSE_EVENT, {
      proceed: true,
    });
  });
  // PR #361 review: main asks again right before it destroys the editor (its
  // own dialogs are in-page, so the editor stays editable meanwhile). An
  // unchanged, already-approved edit must not get a second dialog; a newer
  // edit must.
  it("answers a repeat quit-check for the same attempt without a second dialog, until the text or the attempt changes", async () => {
    await mount();
    act(() => {
      dirtyTextarea();
    });
    mocks.dialogConfirm.mockResolvedValue(true);
    const fireQuitCheck = (attempt: number) =>
      act(async () => {
        handlersFor(SKILL_EDITOR_QUIT_CHECK_EVENT).forEach((handler) =>
          handler({ payload: { attempt } }),
        );
        await Promise.resolve();
        await Promise.resolve();
        await Promise.resolve();
      });
    const responses = () =>
      mocks.emit.mock.calls.filter(([name]) => name === SKILL_EDITOR_QUIT_CHECK_RESPONSE_EVENT);

    await fireQuitCheck(1);
    await fireQuitCheck(1);
    expect(mocks.dialogConfirm).toHaveBeenCalledTimes(1);
    expect(responses()).toEqual([
      [SKILL_EDITOR_QUIT_CHECK_RESPONSE_EVENT, { proceed: true }],
      [SKILL_EDITOR_QUIT_CHECK_RESPONSE_EVENT, { proceed: true }],
    ]);

    act(() => {
      dirtyTextarea("edited again");
    });
    await fireQuitCheck(1);
    expect(mocks.dialogConfirm).toHaveBeenCalledTimes(2);

    // A later quit attempt (the first one was cancelled in main) asks again.
    await fireQuitCheck(2);
    expect(mocks.dialogConfirm).toHaveBeenCalledTimes(3);
  });
});

// PR #361 merge-gate review: a confirm sheet does not block the app menu, so
// a Cmd+Q while the editor's own close sheet is up used to stack a quit-check
// sheet on the same window, leaving both dead (the round-3 symptom) and main's
// already-acked check waiting forever.
describe("SkillEditorWindow confirm sheets", () => {
  it("never opens a second sheet while one is up; a quit-check waits for it", async () => {
    await mount();
    act(() => {
      dirtyTextarea();
    });
    const answers: Array<(value: boolean) => void> = [];
    mocks.dialogConfirm.mockImplementation(
      () => new Promise<boolean>((resolve) => answers.push(resolve)),
    );

    const event = makeEvent();
    let closing!: Promise<void>;
    await act(async () => {
      closing = capturedCloseHandler()(event) as Promise<void>;
      await Promise.resolve();
    });
    await act(async () => {
      handlersFor(SKILL_EDITOR_QUIT_CHECK_EVENT).forEach((handler) =>
        handler({ payload: { attempt: 1 } }),
      );
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(mocks.dialogConfirm).toHaveBeenCalledTimes(1);

    await act(async () => {
      answers[0](false);
      await closing;
    });
    expect(event.preventDefault).toHaveBeenCalledTimes(1);
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(mocks.dialogConfirm).toHaveBeenCalledTimes(2);

    await act(async () => {
      answers[1](false);
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(mocks.emit).toHaveBeenCalledWith(SKILL_EDITOR_QUIT_CHECK_RESPONSE_EVENT, {
      proceed: false,
    });
  });
});

describe("SkillEditorWindow app.quit menu fallback (review finding #2, round 2)", () => {
  it("exits the process when nothing is dirty", async () => {
    await mount();
    mocks.processExit.mockResolvedValue(undefined);

    await act(async () => {
      handlersFor(MENU_COMMAND_EVENT).forEach((handler) => handler({ payload: "app.quit" }));
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(mocks.processExit).toHaveBeenCalledWith(0);
  });

  it("asks for confirmation when dirty, and does not exit if declined", async () => {
    await mount();
    act(() => {
      dirtyTextarea();
    });
    mocks.dialogConfirm.mockResolvedValue(false);

    await act(async () => {
      handlersFor(MENU_COMMAND_EVENT).forEach((handler) => handler({ payload: "app.quit" }));
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(mocks.dialogConfirm).toHaveBeenCalled();
    expect(mocks.processExit).not.toHaveBeenCalled();
  });

  it("exits after a confirmed dirty state", async () => {
    await mount();
    act(() => {
      dirtyTextarea();
    });
    mocks.dialogConfirm.mockResolvedValue(true);
    mocks.processExit.mockResolvedValue(undefined);

    await act(async () => {
      handlersFor(MENU_COMMAND_EVENT).forEach((handler) => handler({ payload: "app.quit" }));
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(mocks.processExit).toHaveBeenCalledWith(0);
  });
});

async function settle(ticks = 6): Promise<void> {
  await act(async () => {
    for (let tick = 0; tick < ticks; tick += 1) {
      await Promise.resolve();
    }
  });
}

// #370: menu listeners are window-scoped since #361, so Cmd+S with the
// editor focused reaches only the editor, which must save the skill.
describe("SkillEditorWindow save shortcuts (#370)", () => {
  it("Cmd+S saves a dirty skill and does nothing for a clean one", async () => {
    mocks.skillsSaveSkillFile.mockResolvedValue(skillDocument().skill);
    await mount();

    await act(async () => {
      handlersFor(MENU_COMMAND_EVENT).forEach((handler) => handler({ payload: "file.save" }));
    });
    await settle();
    expect(mocks.skillsSaveSkillFile).not.toHaveBeenCalled();

    act(() => {
      dirtyTextarea();
    });
    await act(async () => {
      handlersFor(MENU_COMMAND_EVENT).forEach((handler) => handler({ payload: "file.save" }));
    });
    await settle();
    expect(mocks.skillsSaveSkillFile).toHaveBeenCalledWith("skill-1", "SKILL.md", "edited content");
  });

  // wry implements no JavaScript prompt panel on macOS, so window.prompt()
  // returns null there and Save As never got past its name prompt.
  it("Save As asks for the name inside the window, never through window.prompt", async () => {
    const promptSpy = vi.spyOn(window, "prompt").mockReturnValue(null);
    mocks.dialogConfirm.mockResolvedValue(true);
    mocks.skillsSaveSkillAs.mockResolvedValue({ ...skillDocument().skill, id: "skill-2", name: "copy-name" });
    await mount();

    const saveAsButton = [...host.querySelectorAll("button")].find(
      (button) => button.textContent === translate("ko", "system.skills.saveAs"),
    )!;
    await act(async () => {
      saveAsButton.click();
    });
    const input = host.querySelector<HTMLInputElement>(".skill-editor-save-as input")!;
    expect(input).not.toBeNull();
    expect(input.value).toBe("example-copy");

    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!;
    await act(async () => {
      setter.call(input, "copy-name");
      input.dispatchEvent(new Event("input", { bubbles: true }));
    });
    await act(async () => {
      host.querySelector<HTMLFormElement>(".skill-editor-save-as")!.requestSubmit();
    });
    await settle(10);

    expect(promptSpy).not.toHaveBeenCalled();
    expect(mocks.dialogConfirm).toHaveBeenCalledWith(
      translate("ko", "system.skills.saveAsConfirm", { name: "copy-name" }),
      { kind: "warning" },
    );
    expect(mocks.skillsSaveSkillAs).toHaveBeenCalledWith("skill-1", "copy-name", "original content");
    expect(host.querySelector(".skill-editor-save-as")).toBeNull();
    promptSpy.mockRestore();
  });
});

// #371: edge cases in the editor's close and quit guards.
describe("SkillEditorWindow guard edge cases (#371)", () => {
  it("answers a quit-check with proceed:false when the confirm itself fails", async () => {
    await mount();
    act(() => {
      dirtyTextarea();
    });
    mocks.dialogConfirm.mockRejectedValue(new Error("dialog ipc failed"));

    await act(async () => {
      handlersFor(SKILL_EDITOR_QUIT_CHECK_EVENT).forEach((handler) =>
        handler({ payload: { attempt: 1 } }),
      );
    });
    await settle(10);

    expect(mocks.emit).toHaveBeenCalledWith(SKILL_EDITOR_QUIT_CHECK_RESPONSE_EVENT, {
      proceed: false,
    });
  });

  it("still blocks the close on Cancel after the close handler's effect was torn down", async () => {
    await mount();
    act(() => {
      dirtyTextarea();
    });
    let answer!: (value: boolean) => void;
    mocks.dialogConfirm.mockReturnValue(new Promise<boolean>((resolve) => (answer = resolve)));

    const event = makeEvent();
    let closing!: Promise<void>;
    await act(async () => {
      closing = capturedCloseHandler()(event) as Promise<void>;
      await Promise.resolve();
    });
    await act(async () => root.unmount());
    host.remove();
    host = document.createElement("div");
    document.body.appendChild(host);
    root = createRoot(host);

    await act(async () => {
      answer(false);
      await closing;
    });
    expect(event.preventDefault).toHaveBeenCalledTimes(1);
  });

  it("skips a queued quit-check prompt when the editor became clean while it waited", async () => {
    await mount();
    act(() => {
      dirtyTextarea();
    });
    const answers: Array<(value: boolean) => void> = [];
    mocks.dialogConfirm.mockImplementation(
      () => new Promise<boolean>((resolve) => answers.push(resolve)),
    );

    const event = makeEvent();
    let closing!: Promise<void>;
    await act(async () => {
      closing = capturedCloseHandler()(event) as Promise<void>;
      await Promise.resolve();
    });
    await act(async () => {
      handlersFor(SKILL_EDITOR_QUIT_CHECK_EVENT).forEach((handler) =>
        handler({ payload: { attempt: 1 } }),
      );
    });
    act(() => {
      dirtyTextarea("original content");
    });
    await act(async () => {
      answers[0](false);
      await closing;
    });
    await settle(10);

    expect(mocks.dialogConfirm).toHaveBeenCalledTimes(1);
    expect(mocks.emit).toHaveBeenCalledWith(SKILL_EDITOR_QUIT_CHECK_RESPONSE_EVENT, {
      proceed: true,
    });
  });
});
