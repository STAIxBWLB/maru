// @vitest-environment jsdom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { LocaleContext, t as translate, type Locale } from "../../lib/i18n";
import type { DraftDocument, DraftEntry } from "../../lib/types";
import { DraftsPane } from "./DraftsPane";

vi.mock("../../lib/api", () => ({
  createScratchpadIdea: vi.fn(),
  getDraftsPromoteDefaultDir: vi.fn(),
  isTauri: () => false,
  listDrafts: vi.fn(),
  listScratchpad: vi.fn(),
  readDraft: vi.fn(),
  readScratchpadDocument: vi.fn(),
  saveDraft: vi.fn(),
  saveScratchpadDocument: vi.fn(),
  setDraftStatus: vi.fn(),
  transitionScratchpadIdea: vi.fn(),
  discardDraft: vi.fn(),
  createDraft: vi.fn(),
  listAiMissions: vi.fn().mockResolvedValue([]),
}));
vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn().mockResolvedValue(true) }));
vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn().mockResolvedValue(() => {}) }));
// Ingestion and the ideation lifecycle own their own mission plumbing; they are
// covered by taskIngestionGuard.test.ts and would otherwise pull the whole agent
// surface in.
vi.mock("./useIdeationDrafts", () => ({
  useIdeationDrafts: () => ({ pendingIdeaPaths: new Set<string>(), generate: vi.fn() }),
}));

import {
  createDraft,
  createScratchpadIdea,
  getDraftsPromoteDefaultDir,
  listDrafts,
  listScratchpad,
  readDraft,
  readScratchpadDocument,
  saveDraft,
  saveScratchpadDocument,
  setDraftStatus,
  transitionScratchpadIdea,
} from "../../lib/api";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const DRAFT: DraftEntry = {
  id: "d1",
  kind: "task",
  title: "예산 검토 준비",
  status: "in-review",
  source: "claude",
  originRefs: [],
  bodyPath: ".maru/drafts/d1/body.md",
  createdAt: "2026-07-30T00:00:00Z",
  updatedAt: "2026-07-30T00:00:00Z",
};

const SECOND_DRAFT: DraftEntry = { ...DRAFT, id: "d2", title: "회의 준비" };

const DOC: DraftDocument = { ...DRAFT, content: "원래 본문" };

function localeValue(locale: Locale) {
  return {
    locale,
    setLocale: () => {},
    t: (key: string, vars?: Record<string, string | number>) => translate(locale, key, vars),
  };
}

let root: Root | null = null;
let container: HTMLElement | null = null;

async function render(): Promise<HTMLElement> {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  await act(async () => {
    root?.render(
      <LocaleContext.Provider value={localeValue("ko")}>
        <DraftsPane
          workPath="/w"
          skills={[]}
          defaultRuntime="claude"
          agents={[]}
          ai={{
            defaultRuntime: "claude",
            classifierRuntime: "inherit",
            taskIngestMinImportance: "medium",
            permissionMode: "plan",
            commandOverrides: { claude: null, codex: null, kimi: null, kiro: null },
            extra: {},
          }}
          taskIngestMinImportance="low"
          onTaskIngestMinImportanceChange={() => {}}
          onConfirmApproval={async () => "approval-1"}
          onOpenAgents={() => {}}
        />
      </LocaleContext.Provider>,
    );
  });
  await act(async () => {
    await Promise.resolve();
  });
  return container;
}

/** Click by visible label — the pane has no testids on these controls. */
async function clickByText(host: HTMLElement, text: string) {
  const button = [...host.querySelectorAll("button")].find((el) =>
    (el.textContent ?? "").includes(text),
  );
  if (!button) throw new Error(`button "${text}" not found`);
  await act(async () => {
    button.dispatchEvent(new MouseEvent("click", { bubbles: true }));
  });
  await act(async () => {
    await Promise.resolve();
  });
}

async function typeInEditor(host: HTMLElement, value: string) {
  const textarea = host.querySelector("textarea");
  if (!textarea) throw new Error("draft editor textarea not found");
  await act(async () => {
    const setter = Object.getOwnPropertyDescriptor(
      HTMLTextAreaElement.prototype,
      "value",
    )?.set;
    setter?.call(textarea, value);
    textarea.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

beforeEach(() => {
  vi.mocked(listDrafts).mockResolvedValue([DRAFT, SECOND_DRAFT]);
  vi.mocked(listScratchpad).mockResolvedValue([]);
  vi.mocked(readDraft).mockResolvedValue(DOC);
  vi.mocked(saveDraft).mockImplementation(async (_w, _id, content) => ({
    ...DOC,
    content: content as string,
    updatedAt: "2026-07-30T01:00:00Z",
  }));
  vi.mocked(setDraftStatus).mockResolvedValue(DRAFT);
  vi.mocked(readScratchpadDocument).mockReset();
  vi.mocked(saveScratchpadDocument).mockReset();
  vi.mocked(transitionScratchpadIdea).mockReset();
  vi.mocked(createScratchpadIdea).mockReset();
  vi.mocked(getDraftsPromoteDefaultDir).mockResolvedValue("_incoming");
});

afterEach(() => {
  act(() => root?.unmount());
  container?.remove();
  root = null;
  container = null;
  vi.clearAllMocks();
  vi.unstubAllGlobals();
});

describe("DraftsPane unsaved-edit guards", () => {
  // Promotion reads the body from DISK and freezes it as the gap baseline, so an
  // unsaved buffer used to be published as the pre-edit text while the textarea
  // kept showing text that existed nowhere.
  it("flushes the editor before opening the promote dialog", async () => {
    const host = await render();
    await clickByText(host, "예산 검토 준비");
    await clickByText(host, translate("ko", "drafts.detail.edit"));
    await typeInEditor(host, "사용자가 고친 본문");

    await clickByText(host, translate("ko", "drafts.actions.accept"));

    expect(vi.mocked(saveDraft)).toHaveBeenCalledTimes(1);
    expect(vi.mocked(saveDraft).mock.calls[0][2]).toBe("사용자가 고친 본문");
  });

  it("does not promote when the flush fails", async () => {
    vi.mocked(saveDraft).mockRejectedValue(new Error("drafts_conflict"));
    const host = await render();
    await clickByText(host, "예산 검토 준비");
    await clickByText(host, translate("ko", "drafts.detail.edit"));
    await typeInEditor(host, "충돌하는 본문");

    await clickByText(host, translate("ko", "drafts.actions.accept"));

    expect(vi.mocked(saveDraft)).toHaveBeenCalledTimes(1);
    // The promote dialog must not have opened on a body the user never approved.
    expect(host.querySelector("[role=dialog]")).toBeNull();
  });

  it("does not save when the buffer is unchanged", async () => {
    const host = await render();
    await clickByText(host, "예산 검토 준비");
    await clickByText(host, translate("ko", "drafts.detail.edit"));

    await clickByText(host, translate("ko", "drafts.actions.accept"));

    expect(vi.mocked(saveDraft)).not.toHaveBeenCalled();
  });

  it("confirms before replacing a dirty buffer with another draft", async () => {
    const confirm = vi.fn().mockReturnValue(false);
    vi.stubGlobal("confirm", confirm);
    const host = await render();
    await clickByText(host, "예산 검토 준비");
    await clickByText(host, translate("ko", "drafts.detail.edit"));
    await typeInEditor(host, "지키고 싶은 편집");
    vi.mocked(readDraft).mockClear();

    await clickByText(host, "회의 준비");

    expect(confirm).toHaveBeenCalledWith(translate("ko", "drafts.discardEdits"));
    // Declined: the other draft must not be loaded over the buffer.
    expect(vi.mocked(readDraft)).not.toHaveBeenCalled();
  });
});

describe("DraftsPane manual draft creation", () => {
  function dialogRoot(): HTMLElement {
    const dialog = document.body.querySelector<HTMLElement>("[role=dialog]");
    if (!dialog) throw new Error("create dialog not open");
    return dialog;
  }

  async function typeIntoInput(input: Element, value: string) {
    await act(async () => {
      const setter = Object.getOwnPropertyDescriptor(
        HTMLInputElement.prototype,
        "value",
      )?.set;
      setter?.call(input, value);
      input.dispatchEvent(new Event("input", { bubbles: true }));
    });
  }

  it("creates a manual draft through the dialog and opens it", async () => {
    vi.mocked(createDraft).mockImplementation(async (params) => ({
      ...DRAFT,
      id: "d3",
      kind: params.kind,
      title: params.title,
      status: "new",
      source: params.source,
      importance: params.importance ?? undefined,
    }));
    const host = await render();

    const openButton = [...host.querySelectorAll("button")].find(
      (el) => el.getAttribute("aria-label") === translate("ko", "drafts.create.open"),
    );
    if (!openButton) throw new Error("create button not found");
    await act(async () => {
      openButton.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });

    const dialog = dialogRoot();
    const titleInput = dialog.querySelector("input:not([type=radio])");
    if (!titleInput) throw new Error("title input not found");
    await typeIntoInput(titleInput, "손으로 쓴 초안");

    const textareas = dialog.querySelectorAll("textarea");
    await act(async () => {
      const setter = Object.getOwnPropertyDescriptor(
        HTMLTextAreaElement.prototype,
        "value",
      )?.set;
      setter?.call(textareas[0], "본문 내용");
      textareas[0].dispatchEvent(new Event("input", { bubbles: true }));
    });

    const submit = [...dialog.querySelectorAll("button")].find(
      (el) => (el.textContent ?? "").trim() === translate("ko", "drafts.create.submit"),
    );
    if (!submit) throw new Error("submit button not found");
    await act(async () => {
      submit.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });

    expect(vi.mocked(createDraft)).toHaveBeenCalledTimes(1);
    expect(vi.mocked(createDraft).mock.calls[0][0]).toEqual({
      workPath: "/w",
      kind: "task",
      title: "손으로 쓴 초안",
      source: "manual",
      originRefs: [],
      importance: null,
      confidence: null,
      body: "본문 내용",
    });
    // The created draft opens in the detail view (auto new → in-review).
    expect(vi.mocked(readDraft)).toHaveBeenCalledWith("/w", "d3");
    expect(document.body.querySelector("[role=dialog]")).toBeNull();
  });

  it("keeps the submit disabled until a title is entered", async () => {
    const host = await render();
    const openButton = [...host.querySelectorAll("button")].find(
      (el) => el.getAttribute("aria-label") === translate("ko", "drafts.create.open"),
    );
    if (!openButton) throw new Error("create button not found");
    await act(async () => {
      openButton.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });

    const dialog = dialogRoot();
    const submit = [...dialog.querySelectorAll("button")].find(
      (el) => (el.textContent ?? "").trim() === translate("ko", "drafts.create.submit"),
    );
    if (!submit) throw new Error("submit button not found");
    expect(submit.disabled).toBe(true);

    const titleInput = dialog.querySelector("input:not([type=radio])");
    if (!titleInput) throw new Error("title input not found");
    await typeIntoInput(titleInput, "제목");
    expect(submit.disabled).toBe(false);
  });
});

const IDEA_ENTRY = {
  collection: "ideation" as const,
  relativePath: "seeds/idea.md",
  name: "idea.md",
  source: "manual" as const,
  ideationStage: "seed" as const,
  format: "markdown" as const,
  updatedAt: "2026-07-30T00:00:00Z",
  sizeBytes: 20,
  preview: "Idea body",
  revision: "idea-rev-1",
  stale: false,
  editable: true,
};

const IDEA_DOC = { ...IDEA_ENTRY, content: "# Idea\n\nOriginal body" };

describe("DraftsPane Ideation hub", () => {
  it("edits and saves an idea with its read revision, then transitions its stage", async () => {
    vi.mocked(listScratchpad).mockResolvedValue([IDEA_ENTRY]);
    vi.mocked(readScratchpadDocument).mockResolvedValue(IDEA_DOC);
    vi.mocked(saveScratchpadDocument).mockResolvedValue({
      ...IDEA_DOC,
      content: "Updated body",
      revision: "idea-rev-2",
    });
    vi.mocked(transitionScratchpadIdea).mockResolvedValue({
      ...IDEA_DOC,
      relativePath: "developing/idea.md",
      ideationStage: "developing",
      revision: "idea-rev-3",
      content: "Updated body",
    });
    const host = await render();

    await clickByText(host, "idea.md");
    await clickByText(host, translate("ko", "drafts.detail.edit"));
    await typeInEditor(host, "Updated body");
    await clickByText(host, translate("ko", "drafts.detail.save"));

    expect(vi.mocked(readScratchpadDocument)).toHaveBeenCalledWith(
      "/w",
      "ideation",
      "seeds/idea.md",
    );
    expect(vi.mocked(saveScratchpadDocument)).toHaveBeenCalledWith(
      "/w",
      "ideation",
      "seeds/idea.md",
      "markdown",
      "Updated body",
      "idea-rev-1",
    );

    await clickByText(host, translate("ko", "rightPane.scratchpad.stage.developing"));
    expect(vi.mocked(transitionScratchpadIdea)).toHaveBeenCalledWith(
      "/w",
      "seeds/idea.md",
      "developing",
      "idea-rev-2",
    );
  });

  it("creates a new idea from the Ideation header and refreshes the list", async () => {
    vi.mocked(listScratchpad).mockResolvedValue([]);
    vi.mocked(createScratchpadIdea).mockResolvedValue(IDEA_DOC);
    vi.stubGlobal("prompt", vi.fn().mockReturnValue("New hub idea"));
    const host = await render();

    const create = host.querySelector<HTMLButtonElement>(
      `[aria-label="${translate("ko", "drafts.idea.create")}"]`,
    );
    if (!create) throw new Error("idea create button not found");
    await act(async () => create.click());

    expect(vi.mocked(createScratchpadIdea)).toHaveBeenCalledWith("/w", "New hub idea");
    expect(vi.mocked(listScratchpad).mock.calls.length).toBeGreaterThan(1);
  });
});
