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

  // The nav sidebar is a grid child of .app-shell, so the mode-surface fallback
  // would otherwise resolve it and select the whole file list as text.
  it("does not resolve the nav sidebar as a selectable surface", () => {
    mount(`<div class="app-shell">
      <div class="document-list"><div id="leaf">a.md</div></div>
    </div>`);
    expect(resolveSelectScope([document.getElementById("leaf")])).toBeNull();
  });

  it("returns null outside the shell entirely", () => {
    mount(`<div class="stray"><p id="leaf">x</p></div>`);
    expect(resolveSelectScope([document.getElementById("leaf")])).toBeNull();
  });

  // Candidates are in falling order of trust. Resolving all of them against
  // panes before considering any mode surface would let the weakest signal -
  // wherever the selection happens to be anchored - beat the event target.
  it("resolves each candidate fully before falling to the next", () => {
    mount(`<div class="app-shell">
      <div class="today-pane"><p id="target">today</p></div>
      <div class="editor-pane"><p id="anchor">editor</p></div>
    </div>`);
    const scope = resolveSelectScope([
      document.getElementById("target"),
      document.getElementById("anchor"),
    ]);
    expect(scope?.className).toBe("today-pane");
  });

  // Clicking a tab leaves focus on the tab strip; a later Cmd+A must use the
  // selection anchor (e.g. a caret in the preview), not the surface behind
  // the focused chrome.
  it("skips chrome candidates so the anchor can resolve", () => {
    mount(`<div class="app-shell">
      <div class="editor-pane">
        <div class="document-tabs-row"><button id="tab">doc.md</button></div>
        <article class="preview-surface"><p id="caret">body</p></article>
      </div>
    </div>`);
    const scope = resolveSelectScope([
      null,
      document.getElementById("tab"),
      document.getElementById("caret"),
    ]);
    expect(scope?.className).toBe("preview-surface");
  });

  // A focused Radix tab panel resolves to the whole editor pane, but a caret
  // in the preview narrows the selection to the preview text.
  it("lets a nested anchor narrow a focused container's scope", () => {
    mount(`<div class="app-shell">
      <div class="editor-pane">
        <div class="tab-panel" id="panel">
          <article class="preview-surface"><p id="caret">body</p></article>
        </div>
      </div>
    </div>`);
    const scope = resolveSelectScope([
      document.getElementById("panel"),
      document.getElementById("caret"),
    ]);
    expect(scope?.className).toBe("preview-surface");
  });

  // Nested narrowing must not let a weaker candidate jump to a sibling pane.
  it("does not narrow across sibling panes", () => {
    mount(`<div class="app-shell">
      <div class="editor-pane"><article class="preview-surface"><p id="caret">x</p></article></div>
      <div class="today-pane"><p id="focused">y</p></div>
    </div>`);
    const scope = resolveSelectScope([
      document.getElementById("focused"),
      document.getElementById("caret"),
    ]);
    expect(scope?.className).toBe("today-pane");
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

  // The invariant. Deferring to an owner used to return before preventDefault,
  // so an owner that declines the key (the terminal panel bails whenever its
  // surface is inactive or the target is a field) left the native
  // whole-document select-all unopposed - the exact bug this hook exists to
  // stop. Anything that is not a real text field must leave the default blocked.
  it.each([
    ["owner chrome", `<div class="terminal-panel" data-select-all-owner>
       <button id="leaf">Terminal</button></div>`],
    ["owner body", `<main class="files-workbench" data-select-all-owner>
       <div id="leaf">row</div></main>`],
    ["known pane", `<div class="inbox-pane"><p id="leaf">x</p></div>`],
    ["shell chrome", `<header class="topbar"><button id="leaf">Maru</button></header>`],
    ["open menu", `<div role="menu"><button id="leaf">Rename</button></div>`],
    ["nav sidebar", `<div class="document-list"><div id="leaf">a.md</div></div>`],
    ["tab strip", `<div class="document-tabs-row"><button id="leaf">doc</button></div>`],
    ["tablist", `<div role="tablist"><button id="leaf">Terminal</button></div>`],
    ["unattributable", `<div class="stray"><p id="leaf">x</p></div>`],
  ])("never lets the native select-all through: %s", (_label, html) => {
    document.body.innerHTML = `<div class="app-shell">${html}</div>`;
    expect(pressCmdA(document.getElementById("leaf")!).defaultPrevented).toBe(true);
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
    document.body.innerHTML = `<div class="app-shell"><main class="files-workbench" data-select-all-owner>
      <div class="files-list"><div class="files-list-row" id="leaf">a.md</div></div>
    </main></div>`;
    pressCmdA(document.getElementById("leaf")!);

    // The workbench selects rows itself; no text range may be left over them.
    expect(window.getSelection()?.toString() ?? "").toBe("");
  });

  // Radix mounts Dialog.Content outside .app-shell (42 dialogs do this), so
  // neither the target nor the mode surface resolves. A leftover selection
  // anchor in the pane behind must not win, or Cmd+A then copy lifts text the
  // user cannot even see.
  it("scopes to a portaled dialog, not the pane behind it", () => {
    document.body.innerHTML = `<div class="app-shell"><div class="editor-pane">
        <article class="preview-surface"><p id="behind">hidden background text</p></article>
      </div></div>
      <div role="dialog" class="dialog-content"><p id="leaf">dialog body</p></div>`;
    // leave a stale selection in the pane behind the dialog
    const stale = document.createRange();
    stale.selectNodeContents(document.getElementById("behind")!);
    window.getSelection()!.addRange(stale);

    const event = pressCmdA(document.getElementById("leaf")!);

    expect(event.defaultPrevented).toBe(true);
    const selected = window.getSelection()?.toString() ?? "";
    expect(selected).toContain("dialog body");
    expect(selected).not.toContain("hidden background text");
  });

  // DocumentList portals its context menu to the body. Selecting a menu's items
  // is meaningless, and falling through to the stale anchor would select the
  // pane behind it.
  it("selects nothing from an open menu or from chrome", () => {
    document.body.innerHTML = `<div class="app-shell">
        <header class="topbar"><button id="chrome">Maru</button></header>
        <div class="editor-pane"><article class="preview-surface">
          <p id="anchored">anchored</p>
          <p>hidden background text</p></article></div>
      </div>
      <div class="context-menu" role="menu"><button id="leaf" role="menuitem">Rename</button></div>`;

    for (const id of ["leaf", "chrome"]) {
      // A leftover anchor inside the pane behind: scoping to .preview-surface
      // would grow this to swallow the rest of the pane.
      const stale = document.createRange();
      stale.selectNodeContents(document.getElementById("anchored")!);
      window.getSelection()!.removeAllRanges();
      window.getSelection()!.addRange(stale);

      const event = pressCmdA(document.getElementById(id)!);

      expect(event.defaultPrevented).toBe(true);
      expect(window.getSelection()?.toString() ?? "").toBe("anchored");
    }
  });

  // A click on the diagram canvas targets an SVGElement, which is an Element
  // but not an HTMLElement. An instanceof HTMLElement check missed it, so the
  // owner was not recognised and the surface got text-selected underneath the
  // node selection.
  it("recognises an owner from an SVG target", () => {
    document.body.innerHTML = `<div class="app-shell">
      <div class="maru-diagram" data-select-all-owner>
        <svg><rect id="leaf" width="10" height="10"/></svg>
      </div></div>`;
    pressCmdA(document.getElementById("leaf")!);

    // The owner's own handler does the selecting; this hook must not also drop
    // a text range over it.
    expect(window.getSelection()?.toString() ?? "").toBe("");
  });

  it("lets a nested selectable pane override its outer owner", () => {
    document.body.innerHTML = `<div class="app-shell">
      <main class="files-workbench" data-select-all-owner>
        <div class="files-list"><div>a.md</div></div>
        <article class="preview-surface">
          <p>preview body with a <a id="leaf" href="#">focusable link</a></p>
        </article>
      </main>
    </div>`;
    const event = pressCmdA(document.getElementById("leaf")!);

    expect(event.defaultPrevented).toBe(true);
    expect(window.getSelection()?.toString() ?? "").toContain("preview body");
  });
});
