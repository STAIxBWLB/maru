// @vitest-environment jsdom
import { afterEach, describe, expect, it } from "vitest";
import {
  createSelectAllHandler,
  isEditableTarget,
  resolveSelectScope,
  selectAllComboPressed,
} from "./useScopedSelectAll";

type ComboEvent = Parameters<typeof selectAllComboPressed>[0];

function combo(overrides: Partial<ComboEvent>): ComboEvent {
  return {
    key: "a",
    metaKey: false,
    ctrlKey: false,
    altKey: false,
    shiftKey: false,
    ...overrides,
  };
}

describe("selectAllComboPressed", () => {
  it("matches Cmd+A on macOS and Ctrl+A elsewhere", () => {
    expect(selectAllComboPressed(combo({ metaKey: true }), true)).toBe(true);
    expect(selectAllComboPressed(combo({ ctrlKey: true }), false)).toBe(true);
  });

  it("ignores the wrong modifier for the platform", () => {
    expect(selectAllComboPressed(combo({ ctrlKey: true }), true)).toBe(false);
    expect(selectAllComboPressed(combo({ metaKey: true }), false)).toBe(false);
  });

  it("requires no shift/alt and the 'a' key", () => {
    expect(selectAllComboPressed(combo({ metaKey: true, shiftKey: true }), true)).toBe(false);
    expect(selectAllComboPressed(combo({ metaKey: true, altKey: true }), true)).toBe(false);
    expect(selectAllComboPressed(combo({ metaKey: true, key: "s" }), true)).toBe(false);
    expect(selectAllComboPressed(combo({ metaKey: true, key: "A" }), true)).toBe(true);
  });
});

describe("isEditableTarget", () => {
  const asTarget = (o: unknown) => o as unknown as EventTarget;

  it("treats inputs, textareas and contentEditable as editable", () => {
    expect(isEditableTarget(asTarget({ tagName: "INPUT" }))).toBe(true);
    expect(isEditableTarget(asTarget({ tagName: "TEXTAREA" }))).toBe(true);
    expect(isEditableTarget(asTarget({ tagName: "DIV", isContentEditable: true }))).toBe(true);
  });

  it("treats other elements and null as non-editable", () => {
    expect(isEditableTarget(asTarget({ tagName: "DIV" }))).toBe(false);
    expect(isEditableTarget(asTarget({ tagName: "BUTTON" }))).toBe(false);
    expect(isEditableTarget(null)).toBe(false);
  });
});

describe("resolveSelectScope", () => {
  afterEach(() => {
    document.body.innerHTML = "";
  });

  function mount(html: string) {
    document.body.innerHTML = html;
    return document.body;
  }

  it("resolves the nearest pane, not an outer one", () => {
    mount(`<div class="editor-pane"><article class="preview-surface">
      <p id="leaf">text</p></article></div>`);
    const scope = resolveSelectScope([document.getElementById("leaf")]);
    expect(scope?.className).toBe("preview-surface");
  });

  it("falls through the candidates in order", () => {
    mount(`<div id="loose"></div><div class="inbox-pane"><p id="inner">x</p></div>`);
    const scope = resolveSelectScope([
      document.getElementById("loose"),
      document.getElementById("inner"),
    ]);
    expect(scope?.className).toBe("inbox-pane");
  });

  it("honours the data-select-scope opt-in", () => {
    mount(`<main data-select-scope><p id="leaf">x</p></main>`);
    expect(resolveSelectScope([document.getElementById("leaf")])).not.toBeNull();
  });

  // Panes missing from PANE_SELECTOR must still resolve to their mode surface,
  // otherwise Cmd+A does nothing at all on them.
  it("falls back to the mode surface for unlisted panes", () => {
    mount(`<div class="app-shell">
      <header class="topbar">chrome</header>
      <div class="today-pane"><div class="today-card"><p id="leaf">x</p></div></div>
    </div>`);
    expect(resolveSelectScope([document.getElementById("leaf")])?.className).toBe("today-pane");
  });

  it("prefers a listed pane over the enclosing mode surface", () => {
    mount(`<div class="app-shell">
      <div class="editor-pane"><article class="preview-surface"><p id="leaf">x</p></article></div>
    </div>`);
    expect(resolveSelectScope([document.getElementById("leaf")])?.className).toBe(
      "preview-surface",
    );
  });

  // The whole point of the guard: chrome must not resolve, so the caller blocks
  // Cmd+A instead of letting the browser select the whole window.
  it("returns null for shell chrome and for non-elements", () => {
    mount(`<div class="app-shell">
      <header class="topbar"><span id="leaf">Maru</span></header>
      <nav class="activity-rail"><button id="rail">Files</button></nav>
    </div>`);
    expect(resolveSelectScope([document.getElementById("leaf")])).toBeNull();
    expect(resolveSelectScope([document.getElementById("rail")])).toBeNull();
    expect(resolveSelectScope([null, undefined, "not-an-element"])).toBeNull();
  });

  it("returns null outside the shell entirely", () => {
    mount(`<div class="stray"><p id="leaf">x</p></div>`);
    expect(resolveSelectScope([document.getElementById("leaf")])).toBeNull();
  });
});

describe("createSelectAllHandler", () => {
  const handler = createSelectAllHandler(true);

  afterEach(() => {
    document.body.innerHTML = "";
    window.getSelection()?.removeAllRanges();
  });

  function pressCmdA(target: Element, init: Partial<KeyboardEventInit> = {}) {
    const event = new KeyboardEvent("keydown", {
      key: "a",
      metaKey: true,
      bubbles: true,
      cancelable: true,
      ...init,
    });
    target.dispatchEvent(event);
    handler(event);
    return event;
  }

  it("selects only the pane the keystroke came from", () => {
    document.body.innerHTML = `<header class="topbar">chrome</header>
      <div class="inbox-pane"><p id="leaf">pane text</p></div>`;
    const event = pressCmdA(document.getElementById("leaf")!);

    expect(event.defaultPrevented).toBe(true);
    const selected = window.getSelection()?.toString() ?? "";
    expect(selected).toContain("pane text");
    expect(selected).not.toContain("chrome");
  });

  // The reported bug: outside a known pane the browser default highlighted the
  // entire window. It must be blocked, leaving the selection untouched.
  it("blocks the whole-window select-all outside a pane", () => {
    document.body.innerHTML = `<header class="topbar"><span id="leaf">Maru</span></header>`;
    const event = pressCmdA(document.getElementById("leaf")!);

    expect(event.defaultPrevented).toBe(true);
    expect(window.getSelection()?.toString() ?? "").toBe("");
  });

  it("leaves native editables to the browser", () => {
    document.body.innerHTML = `<div class="inbox-pane"><input id="leaf" /></div>`;
    expect(pressCmdA(document.getElementById("leaf")!).defaultPrevented).toBe(false);
  });

  it("ignores other keys and IME composition", () => {
    document.body.innerHTML = `<div class="inbox-pane"><p id="leaf">x</p></div>`;
    const leaf = document.getElementById("leaf")!;
    expect(pressCmdA(leaf, { key: "c" }).defaultPrevented).toBe(false);
    expect(pressCmdA(leaf, { isComposing: true }).defaultPrevented).toBe(false);
  });

  // The Files list maps Cmd+A onto "select every row" in its own bubble-phase
  // handler, so this must not also drop a text selection over those rows.
  it("yields to a surface that owns select-all", () => {
    document.body.innerHTML = `<div class="app-shell"><main class="files-workbench">
      <div class="files-list" data-select-all-owner><div class="files-list-row" id="leaf">a.md</div></div>
    </main></div>`;
    const event = pressCmdA(document.getElementById("leaf")!);

    expect(event.defaultPrevented).toBe(false);
    expect(window.getSelection()?.toString() ?? "").toBe("");
  });

  it("still scopes elsewhere in a pane that owns select-all somewhere", () => {
    document.body.innerHTML = `<div class="app-shell"><main class="files-workbench">
      <div class="files-list" data-select-all-owner><div>a.md</div></div>
      <article class="preview-surface"><p id="leaf">preview body</p></article>
    </main></div>`;
    const event = pressCmdA(document.getElementById("leaf")!);

    expect(event.defaultPrevented).toBe(true);
    expect(window.getSelection()?.toString() ?? "").toContain("preview body");
  });
});
