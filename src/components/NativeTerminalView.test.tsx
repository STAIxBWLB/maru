import { describe, expect, it } from "vitest";
import type { TerminalCell, TerminalFrame } from "../lib/api";
import {
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
  normalizeSelection,
  normalizeTerminalInputText,
  recordTerminalKeyDown,
  recordTerminalKeyUp,
  resetTerminalModifierTracking,
  selectedTerminalText,
  selectionSpanForRow,
  terminalBeforeInputToText,
  terminalColorToCss,
  terminalEnterAlreadyHandled,
  terminalEnterCommandFromMods,
  terminalInputEventToText,
  terminalKeyEventToInput,
  terminalLineBreakCommand,
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
