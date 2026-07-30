// @vitest-environment jsdom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { LocaleContext, t as translate, type Locale } from "../../lib/i18n";
import type { DraftDocument, DraftEntry } from "../../lib/types";
import { DraftsPane } from "./DraftsPane";

vi.mock("../../lib/api", () => ({
  isTauri: () => false,
  listDrafts: vi.fn(),
  listScratchpad: vi.fn(),
  readDraft: vi.fn(),
  saveDraft: vi.fn(),
  setDraftStatus: vi.fn(),
  discardDraft: vi.fn(),
}));
vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn().mockResolvedValue(true) }));
vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn().mockResolvedValue(() => {}) }));
// The scheduler section owns its own mission/ingestion plumbing; it is covered by
// taskIngestionGuard.test.ts and would otherwise pull the whole agent surface in.
vi.mock("./SchedulerSection", () => ({ SchedulerSection: () => null }));
vi.mock("./useIdeationDrafts", () => ({
  useIdeationDrafts: () => ({ pendingIdeaPaths: new Set<string>(), generate: vi.fn() }),
}));

import { listDrafts, listScratchpad, readDraft, saveDraft, setDraftStatus } from "../../lib/api";

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
          taskIngestMinImportance="low"
          onTaskIngestMinImportanceChange={() => {}}
          onConfirmApproval={async () => "approval-1"}
          onError={() => {}}
          onOpenScratchpad={() => {}}
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
