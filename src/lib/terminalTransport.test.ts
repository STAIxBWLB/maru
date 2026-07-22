import { describe, expect, it } from "vitest";
import { decodeTerminalWireFrame, type TerminalWireFrame } from "./api";

describe("terminal wire frames", () => {
  it("decodes palette-indexed cells without changing terminal semantics", () => {
    const wire: TerminalWireFrame = {
      sessionId: "term-1",
      cols: 2,
      rows: 1,
      cursor: { row: 0, col: 1, visible: true },
      palette: [
        {
          fg: { kind: "rgb", r: 1, g: 2, b: 3 },
          bg: { kind: "named", name: "Background" },
          bold: true,
          italic: false,
          underline: false,
          inverse: false,
        },
      ],
      lines: [[ ["한", 2, 0], ["", 0, 0] ]],
      scrollbackLen: 3,
      dirtyRows: null,
      displayOffset: 0,
      mouse: { click: false, motion: false, drag: false, sgr: false },
      altScreen: false,
      selectionSpans: [{ row: 0, start: 0, end: 1 }],
      wrappedRows: [false],
    };

    const frame = decodeTerminalWireFrame(wire);
    expect(frame.lines[0][0]).toMatchObject({ ch: "한", width: 2, bold: true });
    expect(frame.lines[0][1]).toMatchObject({ ch: "", width: 0 });
    expect(frame.selectionSpans).toEqual([{ row: 0, start: 0, end: 1 }]);
  });
});
