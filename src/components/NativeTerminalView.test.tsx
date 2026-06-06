import { describe, expect, it } from "vitest";
import type { TerminalCell, TerminalFrame } from "../lib/api";
import {
  cellDisplayText,
  cellDisplayWidth,
  finalCompositionText,
  frameLineToText,
  frameToText,
  isDuplicateCompositionInput,
  normalizeTerminalInputText,
  selectedTerminalText,
  terminalBeforeInputToText,
  terminalColorToCss,
  terminalInputEventToText,
  terminalKeyEventToInput,
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

  it("extracts selected text across rows", () => {
    const terminalFrame = frame([
      [cell("a"), cell("b"), cell("c")],
      [cell("d"), cell("e"), cell("f")],
    ]);
    expect(
      selectedTerminalText(terminalFrame, {
        anchor: { row: 0, col: 1 },
        focus: { row: 1, col: 1 },
      }),
    ).toBe("bc\nde");
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
    expect(normalizeTerminalInputText("\u1112\u1161\u11AB")).toBe("한");
  });

  it("detects duplicate post-composition input", () => {
    const recent = { text: "한글 입력", at: 1000 };
    expect(isDuplicateCompositionInput("한글 입력", recent, 1200)).toBe(true);
    expect(isDuplicateCompositionInput("한글 입력", recent, 1600)).toBe(false);
    expect(isDuplicateCompositionInput("한글", recent, 1200)).toBe(false);
  });

  it("converts terminal colors to CSS", () => {
    expect(terminalColorToCss({ kind: "named", name: "Red" }, "#fff")).toBe("#f87171");
    expect(terminalColorToCss({ kind: "indexed", index: 2 }, "#fff")).toBe("#8bc891");
    expect(terminalColorToCss({ kind: "rgb", r: 1, g: 2, b: 3 }, "#fff")).toBe(
      "rgb(1, 2, 3)",
    );
  });
});
