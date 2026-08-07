// @vitest-environment jsdom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { diagramPatternSave } from "../../../lib/diagram";
import { serializePreset, type PatternPresetV1 } from "../../../lib/diagram/presets";
import { LocaleContext, t as translate } from "../../../lib/i18n";
import "../../../lib/i18n/testing";
import {
  PatternGalleryDialog,
  type GallerySelection,
} from "./PatternGalleryDialog";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const WS = "gallery-ws";

interface Harness {
  container: HTMLDivElement;
  root: Root;
  props: {
    onNewDocument: ReturnType<typeof vi.fn>;
    onInsertAtPointer: ReturnType<typeof vi.fn>;
    onConvert: ReturnType<typeof vi.fn>;
    onToggleFavorite: ReturnType<typeof vi.fn>;
    onNotice: ReturnType<typeof vi.fn>;
    onClose: ReturnType<typeof vi.fn>;
  };
}

function renderGallery(
  overrides: Partial<Parameters<typeof PatternGalleryDialog>[0]> = {},
): Harness {
  const props = {
    onNewDocument: vi.fn(),
    onInsertAtPointer: vi.fn(),
    onConvert: vi.fn(),
    onToggleFavorite: vi.fn(),
    onNotice: vi.fn(),
    onClose: vi.fn(),
  };
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  act(() => {
    root.render(
      <LocaleContext.Provider
        value={{
          locale: "ko",
          setLocale: () => {},
          t: (key, vars) => translate("ko", key, vars),
        }}
      >
        <PatternGalleryDialog
          open
          dirty={false}
          workspace={WS}
          convertViewId={null}
          presetDraft={null}
          favorites={[]}
          recents={[]}
          {...props}
          {...overrides}
        />
      </LocaleContext.Provider>,
    );
  });
  return { container, root, props };
}

function click(el: Element): void {
  act(() => {
    el.dispatchEvent(new MouseEvent("click", { bubbles: true }));
  });
}

function doubleClick(el: Element): void {
  act(() => {
    el.dispatchEvent(new MouseEvent("dblclick", { bubbles: true }));
  });
}

function setInputValue(input: HTMLInputElement, value: string): void {
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!;
  act(() => {
    setter.call(input, value);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

function query<T extends Element>(selector: string): T | null {
  return document.body.querySelector<T>(selector);
}

function queryAll<T extends Element>(selector: string): T[] {
  return [...document.body.querySelectorAll<T>(selector)];
}

/** jsdom here ships a crippled localStorage — install a working in-memory one. */
function installLocalStorageMock(): void {
  const store = new Map<string, string>();
  const storage = {
    getItem: (k: string) => (store.has(k) ? store.get(k)! : null),
    setItem: (k: string, v: string) => void store.set(k, String(v)),
    removeItem: (k: string) => void store.delete(k),
    clear: () => store.clear(),
    key: (i: number) => [...store.keys()][i] ?? null,
    get length() {
      return store.size;
    },
  };
  Object.defineProperty(window, "localStorage", { value: storage, configurable: true });
}

function validPreset(name: string, patternId = "report.raci"): PatternPresetV1 {
  return {
    v: 1,
    id: `preset-${name}`,
    name,
    patternId,
    theme: "dark",
    createdAt: 1,
    updatedAt: 1,
  };
}

describe("PatternGalleryDialog", () => {
  let harness: Harness | null = null;

  beforeEach(() => {
    document.body.innerHTML = "";
    installLocalStorageMock();
  });

  afterEach(() => {
    if (harness) {
      act(() => harness!.root.unmount());
      harness.container.remove();
      harness = null;
    }
  });

  it("lists report patterns and classic templates in separate sections", () => {
    harness = renderGallery();
    expect(query("#gallery-section-report, [data-testid='gallery-section-report']")).toBeTruthy();
    expect(query("[data-testid='gallery-section-templates']")).toBeTruthy();
    expect(query("[data-testid='gallery-card-report.raci']")).toBeTruthy();
    expect(query("[data-testid='gallery-card-swot']")).toBeTruthy();
  });

  it("filters entries by translated label via the search box", () => {
    harness = renderGallery();
    const search = query<HTMLInputElement>(".maru-diagram-template-search input")!;
    setInputValue(search, "raci");
    expect(query("[data-testid='gallery-card-report.raci']")).toBeTruthy();
    expect(query("[data-testid='gallery-card-swot']")).toBeNull();
    expect(query("[data-testid='gallery-card-report.pdm']")).toBeNull();
  });

  it("toggles favorites via the star button", () => {
    harness = renderGallery();
    const card = query("[data-testid='gallery-card-report.raci']")!;
    const star = card.querySelector(".maru-diagram-gallery-star")!;
    click(star);
    expect(harness.props.onToggleFavorite).toHaveBeenCalledWith("report.raci");
  });

  it("shows favorites and recents sections from props", () => {
    harness = renderGallery({ favorites: ["report.raci"], recents: ["report.timeline"] });
    expect(query("[data-testid='gallery-section-favorites']")).toBeTruthy();
    expect(query("[data-testid='gallery-section-recents']")).toBeTruthy();
  });

  it("applies 'New document' from the action bar", () => {
    harness = renderGallery();
    click(query("[data-testid='gallery-card-report.raci']")!);
    click(query("[data-testid='gallery-action-new-document']")!);
    expect(harness.props.onNewDocument).toHaveBeenCalledTimes(1);
    const sel = harness.props.onNewDocument.mock.calls[0]![0] as GallerySelection;
    expect(sel).toEqual({ kind: "pattern", patternId: "report.raci" });
  });

  it("double-click applies the default action", () => {
    harness = renderGallery();
    doubleClick(query("[data-testid='gallery-card-report.pdm']")!);
    expect(harness.props.onNewDocument).toHaveBeenCalledTimes(1);
  });

  it("asks for confirmation before replacing a dirty doc", () => {
    harness = renderGallery({ dirty: true });
    click(query("[data-testid='gallery-card-report.raci']")!);
    click(query("[data-testid='gallery-action-new-document']")!);
    expect(harness.props.onNewDocument).not.toHaveBeenCalled();
    // Confirm dialog appears; confirm applies.
    const confirmButtons = queryAll<HTMLButtonElement>(".maru-diagram-confirm-dialog button");
    const replace = confirmButtons.find((b) => b.className.includes("maru-diagram-toolbar-primary"))!;
    click(replace);
    expect(harness.props.onNewDocument).toHaveBeenCalledTimes(1);
  });

  it("routes 'Insert at pointer' to the insert callback", () => {
    harness = renderGallery();
    click(query("[data-testid='gallery-card-report.timeline']")!);
    click(query("[data-testid='gallery-action-insert']")!);
    expect(harness.props.onInsertAtPointer).toHaveBeenCalledWith({
      kind: "pattern",
      patternId: "report.timeline",
    });
  });

  it("disables convert without a view-linked selection; converts with one", () => {
    harness = renderGallery();
    click(query("[data-testid='gallery-card-report.raci']")!);
    const convertBtn = query<HTMLButtonElement>("[data-testid='gallery-action-convert']")!;
    expect(convertBtn.disabled).toBe(true);
    act(() => harness!.root.unmount());
    harness.container.remove();

    harness = renderGallery({ convertViewId: "view-1" });
    click(query("[data-testid='gallery-card-report.raci']")!);
    const enabledBtn = query<HTMLButtonElement>("[data-testid='gallery-action-convert']")!;
    expect(enabledBtn.disabled).toBe(false);
    click(enabledBtn);
    expect(harness.props.onConvert).toHaveBeenCalledWith("report.raci");
  });

  it("saves, lists, and applies workspace presets", async () => {
    await act(async () => {
      await diagramPatternSave(WS, "my-raci", serializePreset(validPreset("my-raci")));
    });
    harness = renderGallery();
    await act(async () => {
      await Promise.resolve();
    });
    const card = query("[data-testid='gallery-preset-my-raci']");
    expect(card).toBeTruthy();
    click(card!);
    click(query("[data-testid='gallery-action-new-document']")!);
    const sel = harness.props.onNewDocument.mock.calls[0]![0] as GallerySelection;
    expect(sel.kind).toBe("preset");
    if (sel.kind === "preset") {
      expect(sel.preset.patternId).toBe("report.raci");
      expect(sel.preset.theme).toBe("dark");
    }
  });

  it("skips tampered presets with a notice", async () => {
    await act(async () => {
      await diagramPatternSave(WS, "good", serializePreset(validPreset("good")));
      // Tampered: executable-looking payload + unknown pattern id.
      await diagramPatternSave(
        WS,
        "evil",
        JSON.stringify({ v: 1, id: "x", name: "evil", patternId: "nope", run: "alert(1)" }),
      );
    });
    harness = renderGallery();
    await act(async () => {
      await Promise.resolve();
    });
    expect(query("[data-testid='gallery-preset-good']")).toBeTruthy();
    expect(query("[data-testid='gallery-preset-evil']")).toBeNull();
    expect(harness.props.onNotice).toHaveBeenCalledWith(
      expect.stringContaining("1"),
    );
  });

  it("deletes a preset via its delete button", async () => {
    await act(async () => {
      await diagramPatternSave(WS, "doomed", serializePreset(validPreset("doomed")));
    });
    harness = renderGallery();
    await act(async () => {
      await Promise.resolve();
    });
    const card = query("[data-testid='gallery-preset-doomed']")!;
    await act(async () => {
      card.querySelector(".maru-diagram-gallery-delete")!.dispatchEvent(
        new MouseEvent("click", { bubbles: true }),
      );
      await Promise.resolve();
    });
    expect(query("[data-testid='gallery-preset-doomed']")).toBeNull();
  });

  it("saves the current selection config as a preset", async () => {
    window.localStorage.clear();
    harness = renderGallery({
      presetDraft: { patternId: "report.raci", theme: "dark" },
    });
    const input = query<HTMLInputElement>(".maru-diagram-gallery-preset-save input")!;
    setInputValue(input, "team-raci");
    await act(async () => {
      query<HTMLButtonElement>(".maru-diagram-gallery-preset-save button")!.dispatchEvent(
        new MouseEvent("click", { bubbles: true }),
      );
      await Promise.resolve();
    });
    expect(query("[data-testid='gallery-preset-team-raci']")).toBeTruthy();
  });
});
