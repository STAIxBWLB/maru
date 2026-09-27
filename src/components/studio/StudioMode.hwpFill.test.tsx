// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { LocaleContext, registerDictionaries, t } from "../../lib/i18n";
import { ko } from "../../lib/i18n/locales/ko";
import { en } from "../../lib/i18n/locales/en";
import {
  createInitialStudioState,
  hwpCliTemplateFill,
  studioStateList,
  studioStateRead,
  studioStateSave,
  templateFillHwpx,
  type StudioHwpTemplateFieldState,
  type StudioState,
  type TemplateFillResponse,
} from "../../lib/studio";
import type { DocumentPayload } from "../../lib/types";
import { StudioMode } from "./StudioMode";

vi.mock("../../lib/studio", async (original) => ({
  ...(await original<typeof import("../../lib/studio")>()),
  studioStateSave: vi.fn(),
  studioStateList: vi.fn(),
  studioStateRead: vi.fn(),
  studioStateDelete: vi.fn(),
  templateFillHwpx: vi.fn(),
  hwpCliTemplateFill: vi.fn(),
}));

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

function doc(patch: Partial<DocumentPayload> = {}): DocumentPayload {
  return {
    path: "/work/docs/a.md",
    relPath: "docs/a.md",
    title: "Doc A",
    content: "",
    body: "body a",
    meta: {},
    fileKind: "markdown",
    ...patch,
  };
}

function noop() {
  return Promise.resolve(null);
}

function field(key: string, label: string, required: boolean): StudioHwpTemplateFieldState {
  return { key, label, required, occurrences: 1 };
}

function fillResponse(): TemplateFillResponse {
  return {
    outputPath: "/work/.maru/studio/filled/plan-filled.hwpx",
    replacedCount: 2,
    validationOk: true,
    command: "hwp fill",
    formFilledCount: 2,
    unmatchedFields: [],
    validationChecks: [],
    warnings: [],
  };
}

/**
 * A scanned Studio state on the HWP step: `title` filled, `agency` (required)
 * and `notes` (optional) left blank, `period` explicitly marked to clear.
 */
function seededState(patch: Partial<StudioState["hwpFields"]> = {}): StudioState {
  return {
    ...createInitialStudioState(doc()),
    currentStep: "hwp",
    template: {
      id: "tpl-1",
      slug: "plan",
      version: 1,
      title: "Plan",
      businessUnit: null,
      documentTypeCode: null,
      source: null,
      hwpxTemplateKey: "hwp-cli-plan",
    },
    hwpFields: {
      status: "ready",
      templatePath: null,
      fields: [
        field("title", "사업명", true),
        field("agency", "주관기관", true),
        field("notes", "비고", false),
        field("period", "사업기간", true),
      ],
      values: { title: "2026 사업계획", agency: "", notes: "", period: "" },
      clearedKeys: ["period"],
      lastOutputPath: null,
      formFilledCount: 0,
      unmatchedFields: [],
      validationChecks: [],
      warnings: [],
      ...patch,
    },
  };
}

async function mount(host: HTMLDivElement, root: Root) {
  await act(async () => {
    root.render(
      <LocaleContext.Provider value={{ locale: "ko", setLocale: () => {}, t: (key, vars) => t("ko", key, vars) }}>
        <StudioMode
          workspaceRoot="/work"
          activeDocument={doc()}
          canCreateDocument={true}
          canModifyDocument={true}
          onCreateDocument={noop}
          onApplyBody={noop}
          onFreezePackage={noop}
        />
      </LocaleContext.Provider>,
    );
  });
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
}

function fillButton(host: HTMLDivElement): HTMLButtonElement {
  const button = Array.from(host.querySelectorAll("button")).find((candidate) =>
    candidate.textContent?.includes(t("ko", "studio.hwp.fill")),
  );
  if (!button) throw new Error("fill button not found");
  return button;
}

describe("StudioMode HWP fill values (issue #380)", () => {
  let host: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    vi.useFakeTimers();
    vi.clearAllMocks();
    registerDictionaries({ ko, en });
    host = document.createElement("div");
    document.body.appendChild(host);
    root = createRoot(host);
    vi.mocked(studioStateList).mockResolvedValue([]);
    vi.mocked(studioStateSave).mockImplementation(async (_workPath, state) => state);
    vi.mocked(templateFillHwpx).mockResolvedValue(fillResponse());
  });

  afterEach(async () => {
    if (root) {
      await act(async () => root.unmount());
    }
    host.remove();
    vi.useRealTimers();
  });

  it("omits blank fields from the fill request and sends \"\" only for explicitly cleared fields", async () => {
    vi.mocked(studioStateRead).mockResolvedValue(seededState());
    await mount(host, root);

    await act(async () => {
      fillButton(host).click();
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(templateFillHwpx).toHaveBeenCalledTimes(1);
    const request = vi.mocked(templateFillHwpx).mock.calls[0][1];
    expect(request.values).toEqual({ title: "2026 사업계획", period: "" });
    expect(request.values).not.toHaveProperty("agency");
    expect(request.values).not.toHaveProperty("notes");
    expect(hwpCliTemplateFill).not.toHaveBeenCalled();

    // The required slot left blank is surfaced, not silently kept as {{주관기관}}.
    expect(host.textContent).toContain("주관기관");
    expect(host.textContent).toContain(t("ko", "studio.hwp.blankRequired", { fields: "주관기관" }));
  });

  it("refuses to fill when every field is blank and nothing is marked to clear", async () => {
    vi.mocked(studioStateRead).mockResolvedValue(
      seededState({ values: { title: "", agency: "", notes: "", period: "" }, clearedKeys: [] }),
    );
    await mount(host, root);

    await act(async () => {
      fillButton(host).click();
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(templateFillHwpx).not.toHaveBeenCalled();
    expect(hwpCliTemplateFill).not.toHaveBeenCalled();
  });
});
