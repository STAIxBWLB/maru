// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { LocaleContext, registerDictionaries, t } from "../../lib/i18n";
import { ko } from "../../lib/i18n/locales/ko";
import { en } from "../../lib/i18n/locales/en";
import { studioStateSave, studioStateList, studioStateRead } from "../../lib/studio";
import type { DocumentPayload } from "../../lib/types";
import { StudioMode } from "./StudioMode";

vi.mock("../../lib/studio", async (original) => ({
  ...(await original<typeof import("../../lib/studio")>()),
  studioStateSave: vi.fn(),
  studioStateList: vi.fn(),
  studioStateRead: vi.fn(),
  studioStateDelete: vi.fn(),
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

async function mount(host: HTMLDivElement, root: Root, activeDocument: DocumentPayload | null) {
  await act(async () => {
    root.render(
      <LocaleContext.Provider value={{ locale: "ko", setLocale: () => {}, t: (key, vars) => t("ko", key, vars) }}>
        <StudioMode
          workspaceRoot="/work"
          activeDocument={activeDocument}
          canCreateDocument={true}
          canModifyDocument={true}
          onCreateDocument={noop}
          onApplyBody={noop}
          onFreezePackage={noop}
        />
      </LocaleContext.Provider>,
    );
  });
}

function titleInput(host: HTMLDivElement): HTMLInputElement {
  const inputs = Array.from(host.querySelectorAll<HTMLInputElement>("input"));
  const input = inputs[0];
  if (!input) throw new Error("title input not found");
  return input;
}

function setValue(input: HTMLInputElement, value: string) {
  Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, value);
  input.dispatchEvent(new Event("input", { bubbles: true }));
}

describe("StudioMode teardown flush (REL-02, D2)", () => {
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
    vi.mocked(studioStateRead).mockResolvedValue(null);
    vi.mocked(studioStateSave).mockImplementation(async (_workPath, state) => state);
  });

  afterEach(async () => {
    if (root) {
      await act(async () => root.unmount());
    }
    host.remove();
    vi.useRealTimers();
  });

  it("flushes a draft edit made inside the 600ms debounce window when the surface unmounts", async () => {
    await mount(host, root, null);
    await act(async () => {
      await Promise.resolve();
    });

    await act(async () => {
      setValue(titleInput(host), "flush me on unmount");
    });

    // Unmount well inside the 600ms debounce window (StudioMode's saver).
    await act(async () => root.unmount());
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(studioStateSave).toHaveBeenCalledTimes(1);
    expect(studioStateSave).toHaveBeenCalledWith(
      "/work",
      expect.objectContaining({ source: expect.objectContaining({ title: "flush me on unmount" }) }),
    );
  });

  it("saves the OLD document's pending edit when Studio switches documents inside the debounce window", async () => {
    const docA = doc({ path: "/work/docs/a.md", relPath: "docs/a.md", title: "Doc A" });
    const docB = doc({ path: "/work/docs/b.md", relPath: "docs/b.md", title: "Doc B", body: "body b" });
    await mount(host, root, docA);
    await act(async () => {
      await Promise.resolve();
    });

    await act(async () => {
      setValue(titleInput(host), "edited before switch");
    });

    // Switch documents inside the 600ms debounce window. The load effect's
    // settleTeardownSave call must flush docA's pending edit before docB
    // starts loading, rather than coalescing it away.
    await act(async () => {
      root.render(
        <LocaleContext.Provider value={{ locale: "ko", setLocale: () => {}, t: (key, vars) => t("ko", key, vars) }}>
          <StudioMode
            workspaceRoot="/work"
            activeDocument={docB}
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
      await Promise.resolve();
    });

    expect(studioStateSave).toHaveBeenCalledTimes(1);
    expect(studioStateSave).toHaveBeenCalledWith(
      "/work",
      expect.objectContaining({
        source: expect.objectContaining({ title: "edited before switch", documentPath: "/work/docs/a.md" }),
      }),
    );
  });
});
