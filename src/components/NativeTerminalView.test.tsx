// @vitest-environment jsdom

import { act, createRef } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { TerminalCell, TerminalFrame } from "../lib/api";
import {
  NativeTerminalView,
  cellDisplayText,
  cellDisplayWidth,
  domButtonToTerminal,
  effectiveTerminalEnterMods,
  effectiveTerminalLineBreakMods,
  enterCommandFromMods,
  finalCompositionText,
  frameLineToText,
  frameToText,
  isTrailingCompositionDuplicate,
  isTerminalLineBreakInput,
  keyModsFromEvent,
  lineBreakCommand,
  nativeShiftEnterCommand,
  nextClickChain,
  normalizeSelection,
  normalizeTerminalInputText,
  recordTerminalKeyDown,
  recordTerminalKeyUp,
  resetTerminalModifierTracking,
  selectedTerminalText,
  selectionForClickCount,
  selectionForSelectDrag,
  selectionSpanForRow,
  terminalSearchSpanForRow,
  terminalBeforeInputToText,
  terminalColorToCss,
  terminalEnterAlreadyHandled,
  terminalEnterCommandFromMods,
  terminalInputEventToText,
  terminalKeyEventToInput,
  terminalLineBreakCommand,
  wordSpanAt,
  type ClickChain,
  type NativeTerminalViewHandle,
} from "./NativeTerminalView";

const baseCell: TerminalCell = {
  ch: " ",
  width: 1,
  fg: { kind: "named", name: "Foreground" },
  bg: { kind: "named", name: "Background" },
  bold: false,
  italic: false,
  underline: false,
  inverse: false,
};

function cell(ch: string, width = 1): TerminalCell {
  return { ...baseCell, ch, width };
}

function frame(lines: TerminalCell[][]): TerminalFrame {
  return {
    sessionId: "term-1",
    cols: Math.max(...lines.map((line) => line.length)),
    rows: lines.length,
    cursor: { row: 0, col: 0, visible: true },
    lines,
    scrollbackLen: 0,
    title: null,
    dirtyRows: null,
    displayOffset: 0,
    mouse: { click: false, motion: false, drag: false, sgr: false },
    altScreen: false,
  };
}

interface CanvasStub {
  clearRect: ReturnType<typeof vi.fn>;
  fillRect: ReturnType<typeof vi.fn>;
  fillText: ReturnType<typeof vi.fn>;
  strokeRect: ReturnType<typeof vi.fn>;
  setTransform: ReturnType<typeof vi.fn>;
}

let rectSize = { width: 800, height: 300 };
let rafQueue: FrameRequestCallback[] = [];
let canvasStub: CanvasStub;
let roots: Root[] = [];
let devicePixelRatioDescriptor: PropertyDescriptor | undefined;
let actEnvironmentDescriptor: PropertyDescriptor | undefined;
let pointerCaptureDescriptors: Record<string, PropertyDescriptor | undefined> = {};

const POINTER_CAPTURE_METHODS = [
  "setPointerCapture",
  "releasePointerCapture",
  "hasPointerCapture",
] as const;

function installDomStubs() {
  rectSize = { width: 800, height: 300 };
  rafQueue = [];
  devicePixelRatioDescriptor = Object.getOwnPropertyDescriptor(window, "devicePixelRatio");
  actEnvironmentDescriptor = Object.getOwnPropertyDescriptor(
    globalThis,
    "IS_REACT_ACT_ENVIRONMENT",
  );
  canvasStub = {
    clearRect: vi.fn(),
    fillRect: vi.fn(),
    fillText: vi.fn(),
    strokeRect: vi.fn(),
    setTransform: vi.fn(),
  };

  Object.defineProperty(window, "devicePixelRatio", {
    configurable: true,
    value: 2,
  });
  Object.defineProperty(globalThis, "IS_REACT_ACT_ENVIRONMENT", {
    configurable: true,
    value: true,
  });

  vi.spyOn(window, "requestAnimationFrame").mockImplementation((callback) => {
    rafQueue.push(callback);
    return rafQueue.length;
  });
  vi.spyOn(window, "cancelAnimationFrame").mockImplementation((id) => {
    rafQueue[id - 1] = () => undefined;
  });
  vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(
    () =>
      ({
        x: 0,
        y: 0,
        left: 0,
        top: 0,
        right: rectSize.width,
        bottom: rectSize.height,
        width: rectSize.width,
        height: rectSize.height,
        toJSON: () => ({}),
      }) as DOMRect,
  );
  vi.spyOn(window, "getComputedStyle").mockReturnValue({
    fontSize: "12px",
    fontFamily: "monospace",
    lineHeight: "15px",
    paddingLeft: "8px",
    paddingTop: "6px",
  } as CSSStyleDeclaration);
  vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockImplementation(
    () =>
      ({
        ...canvasStub,
        measureText: vi.fn(() => ({ width: 10 })),
        beginPath: vi.fn(),
        moveTo: vi.fn(),
        lineTo: vi.fn(),
        stroke: vi.fn(),
        save: vi.fn(),
        restore: vi.fn(),
        font: "",
        fillStyle: "",
        strokeStyle: "",
        lineWidth: 1,
        textBaseline: "alphabetic",
      }) as unknown as CanvasRenderingContext2D,
  );

  class TestResizeObserver {
    observe = vi.fn();
    unobserve = vi.fn();
    disconnect = vi.fn();
  }
  vi.stubGlobal("ResizeObserver", TestResizeObserver);

  // jsdom's pointer-capture methods throw for synthetic pointer ids.
  pointerCaptureDescriptors = {};
  for (const method of POINTER_CAPTURE_METHODS) {
    pointerCaptureDescriptors[method] = Object.getOwnPropertyDescriptor(
      HTMLElement.prototype,
      method,
    );
    Object.defineProperty(HTMLElement.prototype, method, {
      configurable: true,
      value: method === "hasPointerCapture" ? vi.fn(() => false) : vi.fn(),
    });
  }
}

function restoreProperty(
  target: object,
  key: PropertyKey,
  descriptor: PropertyDescriptor | undefined,
) {
  if (descriptor) {
    Object.defineProperty(target, key, descriptor);
    return;
  }
  delete (target as Record<PropertyKey, unknown>)[key];
}

function restoreDomStubGlobals() {
  restoreProperty(window, "devicePixelRatio", devicePixelRatioDescriptor);
  restoreProperty(globalThis, "IS_REACT_ACT_ENVIRONMENT", actEnvironmentDescriptor);
  devicePixelRatioDescriptor = undefined;
  actEnvironmentDescriptor = undefined;
  for (const method of POINTER_CAPTURE_METHODS) {
    restoreProperty(HTMLElement.prototype, method, pointerCaptureDescriptors[method]);
  }
  pointerCaptureDescriptors = {};
}

function flushRaf() {
  const callbacks = rafQueue;
  rafQueue = [];
  callbacks.forEach((callback, index) => callback(index + 1));
}

function renderNativeTerminalView(
  props: Partial<React.ComponentProps<typeof NativeTerminalView>> = {},
) {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  roots.push(root);
  const ref = createRef<NativeTerminalViewHandle>();
  const onResize = vi.fn();
  const onInput = vi.fn();
  act(() => {
    root.render(
      <NativeTerminalView
        ref={ref}
        sessionId="term-1"
        frame={frame([[cell("a"), cell("b")]])}
        active
        focused={false}
        resizeReady
        inputLabel="Terminal input"
        onInput={onInput}
        onResize={onResize}
        onScroll={vi.fn()}
        {...props}
      />,
    );
  });
  return { container, ref, onResize, onInput };
}

/** Dispatch a pointer event at the center of cell (row, col) using the
 *  stubbed metrics: charWidth 10, lineHeight 15, padLeft 8, padTop 6. jsdom
 *  lacks PointerEvent, so a MouseEvent with the pointer type is used — React
 *  dispatches by event type. */
function firePointer(
  target: Element,
  type: "pointerdown" | "pointermove" | "pointerup" | "pointercancel",
  opts: { row: number; col: number; button?: number; shiftKey?: boolean },
) {
  const event = new MouseEvent(type, {
    bubbles: true,
    cancelable: true,
    clientX: 8 + opts.col * 10 + 5,
    clientY: 6 + opts.row * 15 + 7,
    button: opts.button ?? 0,
    shiftKey: opts.shiftKey ?? false,
  });
  Object.defineProperty(event, "pointerId", { value: 1 });
  act(() => {
    target.dispatchEvent(event);
  });
}

function rowOf(text: string): TerminalCell[] {
  return [...text].map((ch) => cell(ch));
}

beforeEach(() => {
  installDomStubs();
});

afterEach(() => {
  roots.forEach((root) => {
    act(() => root.unmount());
  });
  roots = [];
  document.body.innerHTML = "";
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  restoreDomStubGlobals();
});

describe("NativeTerminalView helpers", () => {
  it("extracts row and frame text while ignoring wide spacers", () => {
    const row = [cell("안", 2), cell("", 0), cell("녕"), cell(" ")];
    expect(frameLineToText(row)).toBe("안녕");
    expect(frameToText(frame([row, [cell("o"), cell("k")]]))).toBe("안녕\nok");
  });

  it("renders wide cells across their width and spacer cells without text", () => {
    expect(cellDisplayWidth(cell("안", 2))).toBe("2ch");
    expect(cellDisplayText(cell("안", 2))).toBe("안");
    expect(cellDisplayWidth(cell("", 0))).toBe("0");
    expect(cellDisplayText(cell("", 0))).toBe("");
    expect(cellDisplayText(cell("", 1))).toBe(" ");
  });

  it("extracts selected text across rows from the retained grid", () => {
    const lines = [
      [cell("a"), cell("b"), cell("c")],
      [cell("d"), cell("e"), cell("f")],
    ];
    expect(
      selectedTerminalText(lines, {
        anchor: { row: 0, col: 1 },
        focus: { row: 1, col: 1 },
      }),
    ).toBe("bc\nde");
  });

  it("normalizes selection regardless of drag direction", () => {
    const range = normalizeSelection({
      anchor: { row: 2, col: 5 },
      focus: { row: 1, col: 0 },
    });
    expect(range).toEqual({ start: { row: 1, col: 0 }, end: { row: 2, col: 5 } });
  });

  it("computes per-row selection spans with clamping", () => {
    const range = { start: { row: 1, col: 3 }, end: { row: 3, col: 2 } };
    expect(selectionSpanForRow(range, 0, 10)).toBeNull();
    expect(selectionSpanForRow(range, 1, 10)).toEqual({ start: 3, end: 9 });
    expect(selectionSpanForRow(range, 2, 10)).toEqual({ start: 0, end: 9 });
    expect(selectionSpanForRow(range, 3, 10)).toEqual({ start: 0, end: 2 });
    expect(selectionSpanForRow(range, 4, 10)).toBeNull();
  });

  it("computes visible terminal search highlight spans", () => {
    const match = { row: 1, col: 2, length: 4 };
    expect(terminalSearchSpanForRow(match, 0, 10)).toBeNull();
    expect(terminalSearchSpanForRow(match, 1, 10)).toEqual({ start: 2, end: 5 });
    expect(terminalSearchSpanForRow({ row: 1, col: 8, length: 5 }, 1, 10)).toEqual({
      start: 8,
      end: 9,
    });
  });

  it("builds Enter commands and promotes simple Shift+Enter to lineBreak", () => {
    expect(
      enterCommandFromMods({ shift: true, alt: false, ctrl: false, meta: false }),
    ).toEqual({
      type: "key",
      key: "Enter",
      code: "Enter",
      shiftKey: true,
      altKey: false,
      ctrlKey: false,
      metaKey: false,
    });
    expect(
      terminalEnterCommandFromMods({ shift: true, alt: false, ctrl: false, meta: false }),
    ).toEqual(lineBreakCommand());
    expect(
      terminalEnterCommandFromMods({ shift: false, alt: false, ctrl: false, meta: false }),
    ).toMatchObject({ type: "key", key: "Enter", shiftKey: false });
  });

  it("maps DOM mouse buttons to terminal button codes", () => {
    expect(domButtonToTerminal(0)).toBe(0);
    expect(domButtonToTerminal(1)).toBe(1);
    expect(domButtonToTerminal(2)).toBe(2);
    expect(domButtonToTerminal(4)).toBe(0);
  });

  it("does not send printable keydown text before input events commit it", () => {
    expect(
      terminalKeyEventToInput({
        key: "a",
        code: "KeyA",
        shiftKey: false,
        altKey: false,
        ctrlKey: false,
        metaKey: false,
        isComposing: false,
      }),
    ).toBeNull();

    expect(
      terminalKeyEventToInput({
        key: "ㅎ",
        code: "KeyG",
        shiftKey: false,
        altKey: false,
        ctrlKey: false,
        metaKey: false,
        isComposing: false,
      }),
    ).toBeNull();
  });

  it("maps Shift+Enter to structured key input", () => {
    expect(
      terminalKeyEventToInput({
        key: "Enter",
        code: "Enter",
        shiftKey: true,
        altKey: false,
        ctrlKey: false,
        metaKey: false,
        isComposing: false,
      }),
    ).toEqual({
      type: "key",
      key: "Enter",
      code: "Enter",
      shiftKey: true,
      altKey: false,
      ctrlKey: false,
      metaKey: false,
    });
  });

  it("keeps captured Shift+Enter when the React Enter event is stripped", () => {
    let tracking = resetTerminalModifierTracking();
    tracking = recordTerminalKeyDown(
      {
        key: "Shift",
        code: "ShiftLeft",
        shiftKey: true,
        altKey: false,
        ctrlKey: false,
        metaKey: false,
      },
      tracking,
      10,
    );
    tracking = recordTerminalKeyDown(
      {
        key: "Enter",
        code: "Enter",
        shiftKey: false,
        altKey: false,
        ctrlKey: false,
        metaKey: false,
      },
      tracking,
      20,
    );

    const mods = effectiveTerminalEnterMods(
      {
        shiftKey: false,
        altKey: false,
        ctrlKey: false,
        metaKey: false,
      },
      tracking,
      21,
    );

    expect(terminalEnterCommandFromMods(mods)).toEqual({ type: "lineBreak" });
  });

  it("uses getModifierState when WebKit strips shiftKey on Enter", () => {
    const stripped = {
      shiftKey: false,
      altKey: false,
      ctrlKey: false,
      metaKey: false,
      getModifierState: (key: string) => key === "Shift",
    };

    expect(keyModsFromEvent(stripped)).toMatchObject({
      shift: true,
      alt: false,
      ctrl: false,
      meta: false,
    });
    expect(
      nativeShiftEnterCommand(
        {
          key: "Enter",
          code: "Enter",
          ...stripped,
        },
        resetTerminalModifierTracking(),
        30,
        false,
      ),
    ).toEqual({ type: "lineBreak" });
  });

  it("does not native-capture plain Enter or modified Shift+Enter chords", () => {
    expect(
      nativeShiftEnterCommand(
        {
          key: "Enter",
          code: "Enter",
          shiftKey: false,
          altKey: false,
          ctrlKey: false,
          metaKey: false,
        },
        resetTerminalModifierTracking(),
        30,
        false,
      ),
    ).toBeNull();
    expect(
      nativeShiftEnterCommand(
        {
          key: "Enter",
          code: "Enter",
          shiftKey: true,
          altKey: true,
          ctrlKey: false,
          metaKey: false,
        },
        resetTerminalModifierTracking(),
        30,
        false,
      ),
    ).toBeNull();
  });

  it("uses tracked Shift for beforeinput line breaks", () => {
    let tracking = resetTerminalModifierTracking();
    tracking = recordTerminalKeyDown(
      {
        key: "Shift",
        code: "ShiftLeft",
        shiftKey: true,
        altKey: false,
        ctrlKey: false,
        metaKey: false,
      },
      tracking,
      10,
    );

    expect(isTerminalLineBreakInput({ inputType: "insertLineBreak" })).toBe(true);
    expect(effectiveTerminalLineBreakMods(tracking, 15, "insertLineBreak")).toMatchObject({
      shift: true,
    });
    expect(
      terminalLineBreakCommand("insertLineBreak", tracking, 15, 0, false, false),
    ).toEqual({
      type: "lineBreak",
    });
  });

  it("treats bare insertLineBreak as a newline intent even when Shift was stripped", () => {
    const tracking = resetTerminalModifierTracking();

    expect(
      terminalLineBreakCommand("insertLineBreak", tracking, 25, 0, false, false),
    ).toEqual({ type: "lineBreak" });
  });

  it("treats bare insertParagraph as a newline intent when no keydown handled it", () => {
    const tracking = resetTerminalModifierTracking();

    expect(
      terminalLineBreakCommand("insertParagraph", tracking, 25, 0, false, false),
    ).toEqual({ type: "lineBreak" });
  });

  it("treats insertText newline payloads as line-break input", () => {
    const tracking = resetTerminalModifierTracking();

    expect(isTerminalLineBreakInput({ inputType: "insertText", data: "\n" })).toBe(true);
    expect(terminalLineBreakCommand("insertText", tracking, 25, 0, false, false)).toEqual({
      type: "lineBreak",
    });
  });

  it("treats fallback-only insertParagraph as a newline intent", () => {
    let tracking = resetTerminalModifierTracking();
    tracking = recordTerminalKeyDown(
      {
        key: "Shift",
        code: "ShiftLeft",
        shiftKey: true,
        altKey: false,
        ctrlKey: false,
        metaKey: false,
      },
      tracking,
      10,
    );

    expect(isTerminalLineBreakInput({ inputType: "insertParagraph" })).toBe(true);
    expect(
      terminalLineBreakCommand("insertParagraph", tracking, 25, 0, false, false),
    ).toEqual({ type: "lineBreak" });
  });

  it("keeps plain Enter plain when no Shift is tracked or captured", () => {
    let tracking = resetTerminalModifierTracking();
    tracking = recordTerminalKeyDown(
      {
        key: "Enter",
        code: "Enter",
        shiftKey: false,
        altKey: false,
        ctrlKey: false,
        metaKey: false,
      },
      tracking,
      10,
    );

    const mods = effectiveTerminalEnterMods(
      {
        shiftKey: false,
        altKey: false,
        ctrlKey: false,
        metaKey: false,
      },
      tracking,
      11,
    );

    expect(terminalEnterCommandFromMods(mods)).toMatchObject({
      type: "key",
      key: "Enter",
      shiftKey: false,
    });
  });

  it("dedupes keydown Enter against the beforeinput line-break fallback", () => {
    expect(terminalEnterAlreadyHandled(50, 0)).toBe(false);
    expect(terminalEnterAlreadyHandled(1050, 1000)).toBe(true);
    expect(terminalEnterAlreadyHandled(1125, 1000)).toBe(false);
    expect(
      terminalLineBreakCommand(
        "insertLineBreak",
        resetTerminalModifierTracking(),
        1050,
        1000,
        false,
        false,
      ),
    ).toBeNull();
  });

  it("clears tracked modifiers on reset while preserving keyup updates", () => {
    let tracking = resetTerminalModifierTracking();
    tracking = recordTerminalKeyDown(
      {
        key: "Shift",
        code: "ShiftLeft",
        shiftKey: true,
        altKey: false,
        ctrlKey: false,
        metaKey: false,
      },
      tracking,
      10,
    );
    expect(tracking.mods.shift).toBe(true);

    tracking = recordTerminalKeyUp(
      {
        key: "Shift",
        code: "ShiftLeft",
        shiftKey: false,
        altKey: false,
        ctrlKey: false,
        metaKey: false,
      },
      tracking,
    );
    expect(tracking.mods.shift).toBe(false);

    tracking = recordTerminalKeyDown(
      {
        key: "Enter",
        code: "Enter",
        shiftKey: true,
        altKey: false,
        ctrlKey: false,
        metaKey: false,
      },
      tracking,
      20,
    );
    expect(tracking.capturedEnter).not.toBeNull();
    expect(resetTerminalModifierTracking()).toEqual({
      mods: { shift: false, alt: false, ctrl: false, meta: false },
      capturedEnter: null,
    });
  });

  it("extracts committed text from beforeinput and input events", () => {
    expect(
      terminalBeforeInputToText(
        { inputType: "insertText", data: "a", isComposing: false },
        false,
      ),
    ).toBe("a");
    expect(
      terminalInputEventToText(
        { inputType: "insertText", data: null, isComposing: false },
        "b",
        false,
      ),
    ).toBe("b");
    expect(
      terminalBeforeInputToText(
        { inputType: "insertCompositionText", data: "ㅎ", isComposing: true },
        true,
      ),
    ).toBeNull();
  });

  it("keeps Alt-modified printable keys on the structured key path", () => {
    expect(
      terminalKeyEventToInput({
        key: "f",
        code: "KeyF",
        shiftKey: false,
        altKey: true,
        ctrlKey: false,
        metaKey: false,
        isComposing: false,
      }),
    ).toEqual({
      type: "key",
      key: "f",
      code: "KeyF",
      shiftKey: false,
      altKey: true,
      ctrlKey: false,
      metaKey: false,
    });

    expect(
      terminalKeyEventToInput({
        key: "b",
        code: "KeyB",
        shiftKey: false,
        altKey: true,
        ctrlKey: false,
        metaKey: false,
        isComposing: false,
      }),
    ).toMatchObject({ type: "key", key: "b", altKey: true });
  });

  it("suppresses keydown while IME is composing and emits final composition text", () => {
    expect(
      terminalKeyEventToInput({
        key: "Process",
        code: "KeyA",
        shiftKey: false,
        altKey: false,
        ctrlKey: false,
        metaKey: false,
        isComposing: true,
      }),
    ).toBeNull();
    expect(finalCompositionText("안녕하세요", "ㅇㅏㄴ")).toBe("안녕하세요");
    expect(finalCompositionText("", "안녕")).toBe("안녕");
    expect(normalizeTerminalInputText("한")).toBe("한");
  });

  it("drops only the tight post-composition trailing duplicate", () => {
    const session = { text: "한글 입력", at: 1000 };
    // Trailing insertText echo right after compositionend → dropped.
    expect(isTrailingCompositionDuplicate("한글 입력", session, 1050)).toBe(true);
    // Same text, but outside the 100ms guard → kept (a fresh composition).
    expect(isTrailingCompositionDuplicate("한글 입력", session, 1200)).toBe(false);
    // Different text → kept.
    expect(isTrailingCompositionDuplicate("한글", session, 1050)).toBe(false);
    // No prior committed session → kept.
    expect(isTrailingCompositionDuplicate("한글 입력", null, 1050)).toBe(false);
  });

  it("converts terminal colors to CSS", () => {
    expect(terminalColorToCss({ kind: "named", name: "Red" }, "#fff")).toBe("#f87171");
    expect(terminalColorToCss({ kind: "indexed", index: 2 }, "#fff")).toBe("#8bc891");
    expect(terminalColorToCss({ kind: "rgb", r: 1, g: 2, b: 3 }, "#fff")).toBe(
      "rgb(1, 2, 3)",
    );
  });

  it("resolves the full xterm-256 indexed palette, not just the 16 themed entries", () => {
    // 6x6x6 cube: 16 = rgb(0,0,0), 21 = pure blue end of the first row,
    // 196 = pure red, 231 = white corner.
    expect(terminalColorToCss({ kind: "indexed", index: 16 }, "#fff")).toBe("rgb(0, 0, 0)");
    expect(terminalColorToCss({ kind: "indexed", index: 21 }, "#fff")).toBe(
      "rgb(0, 0, 255)",
    );
    expect(terminalColorToCss({ kind: "indexed", index: 196 }, "#fff")).toBe(
      "rgb(255, 0, 0)",
    );
    expect(terminalColorToCss({ kind: "indexed", index: 231 }, "#fff")).toBe(
      "rgb(255, 255, 255)",
    );
    // Grayscale ramp: 232 = rgb(8,8,8), 255 = rgb(238,238,238).
    expect(terminalColorToCss({ kind: "indexed", index: 232 }, "#fff")).toBe(
      "rgb(8, 8, 8)",
    );
    expect(terminalColorToCss({ kind: "indexed", index: 255 }, "#fff")).toBe(
      "rgb(238, 238, 238)",
    );
    // Out of range falls back.
    expect(terminalColorToCss({ kind: "indexed", index: 256 }, "#fff")).toBe("#fff");
  });
});

describe("terminal word and click-chain helpers", () => {
  it("selects whole words including path characters", () => {
    const line = rowOf("cd ~/dev/my-app/file.test.ts now");
    expect(wordSpanAt(line, 1)).toEqual({ start: 0, end: 1 });
    // `~ / . - _` are word characters: the path is one word.
    expect(wordSpanAt(line, 10)).toEqual({ start: 3, end: 27 });
    expect(wordSpanAt(line, 30)).toEqual({ start: 29, end: 31 });
  });

  it("breaks words at separators and selects a lone separator cell", () => {
    const line = rowOf("foo,bar|baz");
    expect(wordSpanAt(line, 1)).toEqual({ start: 0, end: 2 });
    expect(wordSpanAt(line, 3)).toEqual({ start: 3, end: 3 });
    expect(wordSpanAt(line, 5)).toEqual({ start: 4, end: 6 });
    expect(wordSpanAt(line, 7)).toEqual({ start: 7, end: 7 });
    expect(wordSpanAt(line, 9)).toEqual({ start: 8, end: 10 });
  });

  it("selects whitespace runs and clamps out-of-range columns", () => {
    const line = rowOf("a   b");
    expect(wordSpanAt(line, 2)).toEqual({ start: 1, end: 3 });
    expect(wordSpanAt(line, -5)).toEqual({ start: 0, end: 0 });
    expect(wordSpanAt(line, 99)).toEqual({ start: 4, end: 4 });
    expect(wordSpanAt(undefined, 3)).toEqual({ start: 0, end: 0 });
    expect(wordSpanAt([], 3)).toEqual({ start: 0, end: 0 });
  });

  it("treats wide CJK glyphs and their spacers as one word", () => {
    const line = [cell("안", 2), cell("", 0), cell("녕", 2), cell("", 0), cell(" ")];
    for (const col of [0, 1, 2, 3]) {
      expect(wordSpanAt(line, col)).toEqual({ start: 0, end: 3 });
    }
  });

  it("chains left clicks within the window and tolerance, cycling 1→2→3→1", () => {
    const point = { row: 2, col: 4 };
    let chain: ClickChain | null = null;
    chain = nextClickChain(chain, point, 0, 1000);
    expect(chain.count).toBe(1);
    chain = nextClickChain(chain, { row: 2, col: 5 }, 0, 1300);
    expect(chain.count).toBe(2);
    chain = nextClickChain(chain, point, 0, 1600);
    expect(chain.count).toBe(3);
    chain = nextClickChain(chain, point, 0, 1900);
    expect(chain.count).toBe(1);
  });

  it("starts a fresh chain on timeout, distance, or non-left buttons", () => {
    const point = { row: 2, col: 4 };
    const first = nextClickChain(null, point, 0, 1000);
    expect(nextClickChain(first, point, 0, 1600).count).toBe(1);
    expect(nextClickChain(first, { row: 3, col: 4 }, 0, 1100).count).toBe(1);
    expect(nextClickChain(first, { row: 2, col: 6 }, 0, 1100).count).toBe(1);
    expect(nextClickChain(first, point, 2, 1100).count).toBe(1);
    const right = nextClickChain(null, point, 2, 1000);
    expect(nextClickChain(right, point, 2, 1100).count).toBe(1);
  });

  it("maps click counts to selections: none, word, line", () => {
    const lines = [rowOf("hello world")];
    expect(selectionForClickCount(lines, { row: 0, col: 2 }, 1, 11)).toBeNull();
    expect(selectionForClickCount(lines, { row: 0, col: 2 }, 2, 11)).toEqual({
      anchor: { row: 0, col: 0 },
      focus: { row: 0, col: 4 },
    });
    expect(selectionForClickCount(lines, { row: 0, col: 2 }, 3, 11)).toEqual({
      anchor: { row: 0, col: 0 },
      focus: { row: 0, col: 10 },
    });
  });

  it("resolves drags per granularity: cell tracks, word and line extend", () => {
    const lines = [rowOf("hello world"), rowOf("second row!")];
    expect(
      selectionForSelectDrag(lines, "cell", { row: 0, col: 1 }, null, { row: 1, col: 5 }, 11),
    ).toEqual({ anchor: { row: 0, col: 1 }, focus: { row: 1, col: 5 } });

    const helloSpan = { start: { row: 0, col: 0 }, end: { row: 0, col: 4 } };
    expect(
      selectionForSelectDrag(lines, "word", { row: 0, col: 2 }, helloSpan, { row: 0, col: 8 }, 11),
    ).toEqual({ anchor: { row: 0, col: 0 }, focus: { row: 0, col: 10 } });
    const worldSpan = { start: { row: 0, col: 6 }, end: { row: 0, col: 10 } };
    expect(
      selectionForSelectDrag(lines, "word", { row: 0, col: 8 }, worldSpan, { row: 0, col: 2 }, 11),
    ).toEqual({ anchor: { row: 0, col: 10 }, focus: { row: 0, col: 0 } });
    expect(
      selectionForSelectDrag(lines, "word", { row: 0, col: 2 }, helloSpan, { row: 0, col: 3 }, 11),
    ).toEqual({ anchor: { row: 0, col: 0 }, focus: { row: 0, col: 4 } });

    const lineSpan = { start: { row: 0, col: 0 }, end: { row: 0, col: 10 } };
    expect(
      selectionForSelectDrag(lines, "line", { row: 0, col: 2 }, lineSpan, { row: 1, col: 3 }, 11),
    ).toEqual({ anchor: { row: 0, col: 0 }, focus: { row: 1, col: 10 } });
    const secondSpan = { start: { row: 1, col: 0 }, end: { row: 1, col: 10 } };
    expect(
      selectionForSelectDrag(lines, "line", { row: 1, col: 2 }, secondSpan, { row: 0, col: 3 }, 11),
    ).toEqual({ anchor: { row: 1, col: 10 }, focus: { row: 0, col: 0 } });
  });
});

describe("NativeTerminalView pointer selection", () => {
  function renderWithLines(
    lines: TerminalCell[][],
    props: Partial<React.ComponentProps<typeof NativeTerminalView>> = {},
  ) {
    const rendered = renderNativeTerminalView({ frame: frame(lines), ...props });
    act(() => {
      flushRaf();
    });
    const view = rendered.container.querySelector(".native-terminal-view");
    if (!view) throw new Error("terminal view not rendered");
    return { ...rendered, view };
  }

  it("leaves nothing selected after a plain click, clearing a prior drag selection", () => {
    const { ref, view } = renderWithLines([rowOf("hello world")]);

    firePointer(view, "pointerdown", { row: 0, col: 0 });
    firePointer(view, "pointermove", { row: 0, col: 4 });
    firePointer(view, "pointerup", { row: 0, col: 4 });
    expect(ref.current?.copySelection()).toBe("hello");

    firePointer(view, "pointerdown", { row: 0, col: 8 });
    firePointer(view, "pointerup", { row: 0, col: 8 });
    expect(ref.current?.copySelection()).toBeNull();
  });

  it("copies drag selections on release when copy-on-select is enabled", () => {
    const onCopyOnSelect = vi.fn();
    const { view } = renderWithLines([rowOf("hello world")], {
      copyOnSelect: true,
      onCopyOnSelect,
    });

    firePointer(view, "pointerdown", { row: 0, col: 6 });
    firePointer(view, "pointermove", { row: 0, col: 10 });
    firePointer(view, "pointerup", { row: 0, col: 10 });
    expect(onCopyOnSelect).toHaveBeenCalledTimes(1);
    expect(onCopyOnSelect).toHaveBeenCalledWith("world");
  });

  it("selects the word under a double click and the row under a triple click", () => {
    const onCopyOnSelect = vi.fn();
    const { ref, view } = renderWithLines([rowOf("cd /tmp/logs now")], {
      copyOnSelect: true,
      onCopyOnSelect,
    });

    firePointer(view, "pointerdown", { row: 0, col: 5 });
    firePointer(view, "pointerup", { row: 0, col: 5 });
    firePointer(view, "pointerdown", { row: 0, col: 5 });
    firePointer(view, "pointerup", { row: 0, col: 5 });
    expect(ref.current?.copySelection()).toBe("/tmp/logs");
    expect(onCopyOnSelect).toHaveBeenLastCalledWith("/tmp/logs");

    firePointer(view, "pointerdown", { row: 0, col: 5 });
    firePointer(view, "pointerup", { row: 0, col: 5 });
    expect(ref.current?.copySelection()).toBe("cd /tmp/logs now");
    expect(onCopyOnSelect).toHaveBeenLastCalledWith("cd /tmp/logs now");
  });

  it("extends an existing selection with shift+click", () => {
    const onCopyOnSelect = vi.fn();
    const { ref, view } = renderWithLines([rowOf("hello world")], {
      copyOnSelect: true,
      onCopyOnSelect,
    });

    firePointer(view, "pointerdown", { row: 0, col: 0 });
    firePointer(view, "pointermove", { row: 0, col: 2 });
    firePointer(view, "pointerup", { row: 0, col: 2 });
    expect(ref.current?.copySelection()).toBe("hel");

    firePointer(view, "pointerdown", { row: 0, col: 8, shiftKey: true });
    firePointer(view, "pointerup", { row: 0, col: 8, shiftKey: true });
    expect(ref.current?.copySelection()).toBe("hello wor");
    expect(onCopyOnSelect).toHaveBeenLastCalledWith("hello wor");
  });

  it("stops tracking after pointercancel so bare hover cannot change the selection", () => {
    const { ref, view } = renderWithLines([rowOf("hello world")]);

    firePointer(view, "pointerdown", { row: 0, col: 0 });
    firePointer(view, "pointermove", { row: 0, col: 3 });
    expect(ref.current?.copySelection()).toBe("hell");

    firePointer(view, "pointercancel", { row: 0, col: 3 });
    firePointer(view, "pointermove", { row: 0, col: 9 });
    expect(ref.current?.copySelection()).toBe("hell");
  });

  it("forwards mouse-mode presses to the PTY and synthesizes a release on cancel", () => {
    const lines = [rowOf("hello world")];
    const tuiFrame = {
      ...frame(lines),
      mouse: { click: true, motion: false, drag: false, sgr: true },
    };
    const { ref, view, onInput } = renderWithLines(lines, { frame: tuiFrame });

    firePointer(view, "pointerdown", { row: 0, col: 2 });
    expect(onInput).toHaveBeenCalledWith(
      expect.objectContaining({ type: "mouse", action: "press", row: 0, col: 2 }),
    );

    firePointer(view, "pointercancel", { row: 0, col: 2 });
    expect(onInput).toHaveBeenCalledWith(
      expect.objectContaining({ type: "mouse", action: "release", row: 0, col: 2 }),
    );

    // Shift overrides mouse mode: selection stays local.
    onInput.mockClear();
    firePointer(view, "pointerdown", { row: 0, col: 0, shiftKey: true });
    firePointer(view, "pointermove", { row: 0, col: 4, shiftKey: true });
    firePointer(view, "pointerup", { row: 0, col: 4, shiftKey: true });
    expect(ref.current?.copySelection()).toBe("hello");
    expect(onInput).not.toHaveBeenCalled();
  });

  it("synthesizes the cancel release at this gesture's press cell, not a stale hover cell", () => {
    const lines = [rowOf("hello world")];
    const tuiFrame = {
      ...frame(lines),
      mouse: { click: true, motion: true, drag: false, sgr: true },
    };
    const { view, onInput } = renderWithLines(lines, { frame: tuiFrame });

    // Bare hover (1003 any-motion) forwards a move and records its cell.
    firePointer(view, "pointermove", { row: 0, col: 5 });
    expect(onInput).toHaveBeenCalledWith(
      expect.objectContaining({ type: "mouse", action: "move", col: 5 }),
    );

    onInput.mockClear();
    firePointer(view, "pointerdown", { row: 0, col: 2 });
    firePointer(view, "pointercancel", { row: 0, col: 2 });
    expect(onInput).toHaveBeenCalledWith(
      expect.objectContaining({ type: "mouse", action: "release", row: 0, col: 2 }),
    );
  });
});

describe("NativeTerminalView window focus restore", () => {
  it("restores textarea focus after the window regains focus", () => {
    const { container } = renderNativeTerminalView({ focused: true });
    const textarea = container.querySelector(
      ".native-terminal-input",
    ) as HTMLTextAreaElement;
    expect(document.activeElement).toBe(textarea);

    act(() => {
      window.dispatchEvent(new Event("blur"));
      textarea.blur();
    });
    expect(document.activeElement).not.toBe(textarea);

    act(() => {
      window.dispatchEvent(new Event("focus"));
    });
    expect(document.activeElement).toBe(textarea);
  });

  it("does not grab focus when the terminal was not focused at blur time", () => {
    const { container } = renderNativeTerminalView({ focused: false });
    const textarea = container.querySelector(
      ".native-terminal-input",
    ) as HTMLTextAreaElement;
    expect(document.activeElement).not.toBe(textarea);

    act(() => {
      window.dispatchEvent(new Event("blur"));
      window.dispatchEvent(new Event("focus"));
    });
    expect(document.activeElement).not.toBe(textarea);
  });

  it("does not restore focus into a terminal whose pane lost focus meanwhile", () => {
    const { container } = renderNativeTerminalView({ focused: false });
    const textarea = container.querySelector(
      ".native-terminal-input",
    ) as HTMLTextAreaElement;
    act(() => {
      textarea.focus();
      window.dispatchEvent(new Event("blur"));
      textarea.blur();
      window.dispatchEvent(new Event("focus"));
    });
    expect(document.activeElement).not.toBe(textarea);
  });
});

describe("NativeTerminalView input recovery", () => {
  // jsdom lacks TextEvent, so React's polyfilled onBeforeInput cannot be
  // driven by dispatching native beforeinput — committed text is driven
  // through the native "input" event (onTextInput) instead. A dispatched
  // compositionend with data also makes React synthesize an onBeforeInput
  // via its fallback path; the component discards it because inputType is
  // undefined, so no double-emit.
  function fireComposition(target: HTMLTextAreaElement, type: string, data = "") {
    act(() => {
      target.dispatchEvent(new CompositionEvent(type, { bubbles: true, data }));
    });
  }

  function fireInsertText(target: HTMLTextAreaElement, data: string) {
    act(() => {
      target.dispatchEvent(
        new InputEvent("input", { bubbles: true, data, inputType: "insertText" }),
      );
    });
  }

  function fireEnterKey(target: HTMLTextAreaElement) {
    act(() => {
      target.dispatchEvent(
        new KeyboardEvent("keydown", {
          key: "Enter",
          code: "Enter",
          bubbles: true,
          cancelable: true,
        }),
      );
    });
  }

  function textCommands(onInput: ReturnType<typeof vi.fn>): string[] {
    return onInput.mock.calls
      .filter(([command]) => command.type === "text")
      .map(([command]) => command.text as string);
  }

  function enterCommands(onInput: ReturnType<typeof vi.fn>): unknown[] {
    return onInput.mock.calls
      .map(([command]) => command)
      .filter(
        (command) =>
          command.type === "lineBreak" ||
          (command.type === "key" && command.key === "Enter"),
      );
  }

  function setupFocused() {
    const rendered = renderNativeTerminalView({ focused: true });
    const textarea = rendered.container.querySelector(
      ".native-terminal-input",
    ) as HTMLTextAreaElement;
    expect(document.activeElement).toBe(textarea);
    return { ...rendered, textarea };
  }

  it("recovers from a stuck composition when the textarea blurs", () => {
    const { textarea, onInput } = setupFocused();

    fireComposition(textarea, "compositionstart");
    expect(textarea.style.background).not.toBe("transparent");
    fireInsertText(textarea, "a");
    expect(textCommands(onInput)).toEqual([]);

    act(() => {
      textarea.blur();
      textarea.focus();
    });
    expect(textarea.style.background).toBe("transparent");
    expect(textarea.value).toBe("");

    fireInsertText(textarea, "b");
    expect(textCommands(onInput)).toEqual(["b"]);
  });

  it("recovers from a stuck composition across an app switch that keeps DOM focus", () => {
    const { textarea, onInput } = setupFocused();

    fireComposition(textarea, "compositionstart");
    fireEnterKey(textarea); // shelved for replay-after-composition
    expect(enterCommands(onInput)).toEqual([]);

    act(() => {
      window.dispatchEvent(new Event("blur"));
    });
    act(() => {
      window.dispatchEvent(new Event("focus"));
    });
    expect(document.activeElement).toBe(textarea);

    fireInsertText(textarea, "b");
    expect(textCommands(onInput)).toEqual(["b"]);

    fireEnterKey(textarea);
    // The shelved Enter was dropped by the reset; only the new one fires.
    expect(enterCommands(onInput)).toHaveLength(1);
  });

  it("commits a late compositionend exactly once after a window-blur reset", () => {
    const { textarea, onInput } = setupFocused();

    fireComposition(textarea, "compositionstart");
    act(() => {
      window.dispatchEvent(new Event("blur"));
    });
    fireComposition(textarea, "compositionend", "안");
    expect(textCommands(onInput)).toEqual(["안"]);

    fireInsertText(textarea, "b");
    expect(textCommands(onInput)).toEqual(["안", "b"]);
  });

  it("restores focus even when the textarea blurs before the window does", () => {
    const { textarea } = setupFocused();

    act(() => {
      textarea.blur();
      window.dispatchEvent(new Event("blur"));
    });
    expect(document.activeElement).not.toBe(textarea);

    act(() => {
      window.dispatchEvent(new Event("focus"));
    });
    expect(document.activeElement).toBe(textarea);
  });

  it("does not steal focus after an in-page focus move to another element", () => {
    const { textarea } = setupFocused();
    const other = document.createElement("input");
    document.body.appendChild(other);

    act(() => {
      other.focus();
    });
    act(() => {
      window.dispatchEvent(new Event("blur"));
    });
    act(() => {
      window.dispatchEvent(new Event("focus"));
    });
    expect(document.activeElement).toBe(other);
    expect(document.activeElement).not.toBe(textarea);
  });

  it("does not steal focus when blur-to-body precedes focusing another element", () => {
    const { textarea } = setupFocused();
    const other = document.createElement("input");
    document.body.appendChild(other);

    act(() => {
      textarea.blur(); // e.g. click on non-focusable chrome
    });
    act(() => {
      other.focus(); // then the user focuses the editor
    });
    act(() => {
      window.dispatchEvent(new Event("blur"));
    });
    act(() => {
      window.dispatchEvent(new Event("focus"));
    });
    expect(document.activeElement).toBe(other);
  });
});

describe("NativeTerminalView test harness cleanup", () => {
  it("restores globals changed by installDomStubs", () => {
    expect(Object.getOwnPropertyDescriptor(window, "devicePixelRatio")?.value).toBe(2);
    expect(Object.getOwnPropertyDescriptor(globalThis, "IS_REACT_ACT_ENVIRONMENT")?.value).toBe(
      true,
    );

    restoreDomStubGlobals();

    expect(Object.getOwnPropertyDescriptor(window, "devicePixelRatio")?.value).not.toBe(2);
    expect(
      Object.getOwnPropertyDescriptor(globalThis, "IS_REACT_ACT_ENVIRONMENT"),
    ).toBeUndefined();

    installDomStubs();
  });
});

describe("NativeTerminalView layout refresh", () => {
  it("refreshLayout remeasures and focuses the textarea without prop focus changes", () => {
    const { container, ref, onResize } = renderNativeTerminalView();

    act(() => {
      flushRaf();
    });
    expect(onResize).toHaveBeenLastCalledWith(78, 19);
    expect(document.activeElement).not.toBe(
      container.querySelector(".native-terminal-input"),
    );

    rectSize = { width: 640, height: 180 };
    act(() => {
      ref.current?.refreshLayout({ focus: true });
      flushRaf();
    });

    expect(onResize).toHaveBeenLastCalledWith(62, 11);
    expect(document.activeElement).toBe(
      container.querySelector(".native-terminal-input"),
    );
  });

  it("full repaint after unchanged refresh clears the entire canvas bitmap without resizing", () => {
    const { ref, onResize } = renderNativeTerminalView();
    act(() => {
      flushRaf();
    });
    expect(onResize).toHaveBeenCalledTimes(1);
    canvasStub.clearRect.mockClear();

    act(() => {
      ref.current?.refreshLayout({ focus: false });
      flushRaf();
    });

    expect(onResize).toHaveBeenCalledTimes(1);
    expect(canvasStub.clearRect).toHaveBeenCalled();
    expect(canvasStub.clearRect.mock.calls[0]).toEqual([0, 0, 1600, 600]);
  });
});
