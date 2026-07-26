// @vitest-environment jsdom
import { afterEach, describe, expect, it } from "vitest";

import { isDiagramKeystroke, matchesShortcut } from "./shortcuts";

function key(opts: { key: string; meta?: boolean; ctrl?: boolean; shift?: boolean; alt?: boolean }): KeyboardEvent {
  // Build a plain object that satisfies the subset of KeyboardEvent we read.
  return {
    key: opts.key,
    metaKey: opts.meta ?? false,
    ctrlKey: opts.ctrl ?? false,
    shiftKey: opts.shift ?? false,
    altKey: opts.alt ?? false,
  } as KeyboardEvent;
}

describe("shortcuts", () => {
  it("matchesShortcut requires modifier when combo demands", () => {
    expect(matchesShortcut(key({ key: "s", meta: true }), { key: "s", mod: true })).toBe(true);
    expect(matchesShortcut(key({ key: "s" }), { key: "s", mod: true })).toBe(false);
  });

  it("matchesShortcut rejects bare key when modifier present", () => {
    expect(matchesShortcut(key({ key: "f", meta: true }), { key: "f" })).toBe(false);
  });

  it("matchesShortcut respects shift requirement", () => {
    expect(matchesShortcut(key({ key: "z", meta: true, shift: true }), { key: "z", mod: true, shift: true })).toBe(true);
    expect(matchesShortcut(key({ key: "z", meta: true }), { key: "z", mod: true, shift: true })).toBe(false);
  });

  it("matchesShortcut case-insensitive on key", () => {
    expect(matchesShortcut(key({ key: "S", meta: true }), { key: "s", mod: true })).toBe(true);
  });
});

describe("isDiagramKeystroke", () => {
  afterEach(() => {
    document.body.innerHTML = "";
  });

  const at = (html: string): EventTarget => {
    document.body.innerHTML = html;
    return document.getElementById("leaf")!;
  };

  // The handler is on window and the canvas is an unfocusable <svg> that
  // nothing focuses on click, so a bare-canvas keystroke arrives with target
  // BODY. Both have to count as the diagram's own.
  it("accepts SVG canvas children and a BODY target", () => {
    expect(isDiagramKeystroke(at(`<div class="maru-diagram"><svg><rect id="leaf"/></svg></div>`)))
      .toBe(true);
    expect(isDiagramKeystroke(document.body)).toBe(true);
    expect(isDiagramKeystroke(null)).toBe(true);
  });

  it("rejects text fields", () => {
    expect(isDiagramKeystroke(at(`<input id="leaf" />`))).toBe(false);
    expect(isDiagramKeystroke(at(`<textarea id="leaf"></textarea>`))).toBe(false);

    // jsdom leaves isContentEditable undefined, so the attribute alone proves
    // nothing here — stub the property a real browser would set.
    const editable = at(`<div id="leaf" contenteditable="true"></div>`) as HTMLElement;
    Object.defineProperty(editable, "isContentEditable", { value: true });
    expect(isDiagramKeystroke(editable)).toBe(false);
  });

  // The diagram's own dialogs are portaled outside the marked root.
  it("rejects portaled dialogs", () => {
    expect(isDiagramKeystroke(at(`<div role="dialog"><button id="leaf">Save</button></div>`)))
      .toBe(false);
    expect(isDiagramKeystroke(at(`<div role="alertdialog"><button id="leaf">X</button></div>`)))
      .toBe(false);
  });

  // These are the paths that let Ctrl+Z from the terminal roll back diagram
  // history, and Delete from the top bar clear selected table cells.
  it("rejects app chrome", () => {
    for (const html of [
      `<header class="topbar"><button id="leaf">M</button></header>`,
      `<nav class="activity-rail"><button id="leaf">D</button></nav>`,
      `<div role="menu"><button id="leaf">Delete</button></div>`,
      `<div role="tablist"><button id="leaf">Terminal</button></div>`,
    ]) {
      expect(isDiagramKeystroke(at(html))).toBe(false);
    }
  });
});
