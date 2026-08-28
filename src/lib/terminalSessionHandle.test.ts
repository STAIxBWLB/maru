import { describe, expect, expectTypeOf, it } from "vitest";

import API_SOURCE from "./api.ts?raw";
import TERMINAL_PANEL_SOURCE from "../components/TerminalPanel.tsx?raw";
import {
  type TerminalSessionHandle,
  type terminalAck,
  type terminalClear,
  type terminalCopySelection,
  type terminalInput,
  type terminalInputBatch,
  type terminalKill,
  type terminalRequestFull,
  type terminalResize,
  type terminalScroll,
  type terminalSearch,
  type terminalSelection,
  type terminalSetVisibility,
  type terminalText,
  type terminalWrite,
} from "./api";

const sessionOperations = [
  "terminalWrite",
  "terminalInput",
  "terminalInputBatch",
  "terminalAck",
  "terminalRequestFull",
  "terminalSetVisibility",
  "terminalSelection",
  "terminalCopySelection",
  "terminalScroll",
  "terminalClear",
  "terminalText",
  "terminalSearch",
  "terminalResize",
  "terminalKill",
] as const;

describe("terminal session handle contract", () => {
  it("keeps session commands handle-only with a single nested IPC payload", () => {
    expect(API_SOURCE).toContain("export interface TerminalSessionHandle");
    expect(API_SOURCE).toContain("export function createTerminalSessionHandle");

    for (const operation of sessionOperations) {
      expect(API_SOURCE).toMatch(new RegExp(`function ${operation}\\(\\s*handle: TerminalSessionHandle`));
    }

    expect(API_SOURCE).not.toMatch(/function terminal(?:Write|Input|Scroll|Clear|Text|Resize|Kill)\(sessionId: string/);
    expect(API_SOURCE).not.toMatch(/function terminal(?:InputBatch|Ack|RequestFull|SetVisibility|Selection|CopySelection)\(\s*sessionId: string/);
    expect(API_SOURCE).toMatch(/terminal_write", \{ handle, data \}/);
    expect(API_SOURCE).toMatch(
      /terminal_search", \{\s*handle,\s*query,\s*direction,\s*caseSensitive,?\s*\}/s,
    );
  });

  it("returns the requested ID and generation together from terminalSpawn", () => {
    expect(API_SOURCE).toMatch(/interface TerminalSpawnHandle \{\s*handle: TerminalSessionHandle;/s);
    expect(API_SOURCE).toMatch(/createTerminalSessionHandle\(sessionId, generation\)/);
  });

  it("does not allow a bare string session ID at the exported command boundary", () => {
    expectTypeOf<Parameters<typeof terminalWrite>[0]>().toEqualTypeOf<TerminalSessionHandle>();
    expectTypeOf<Parameters<typeof terminalInput>[0]>().toEqualTypeOf<TerminalSessionHandle>();
    expectTypeOf<Parameters<typeof terminalInputBatch>[0]>().toEqualTypeOf<TerminalSessionHandle>();
    expectTypeOf<Parameters<typeof terminalAck>[0]>().toEqualTypeOf<TerminalSessionHandle>();
    expectTypeOf<Parameters<typeof terminalRequestFull>[0]>().toEqualTypeOf<TerminalSessionHandle>();
    expectTypeOf<Parameters<typeof terminalSetVisibility>[0]>().toEqualTypeOf<TerminalSessionHandle>();
    expectTypeOf<Parameters<typeof terminalSelection>[0]>().toEqualTypeOf<TerminalSessionHandle>();
    expectTypeOf<Parameters<typeof terminalCopySelection>[0]>().toEqualTypeOf<TerminalSessionHandle>();
    expectTypeOf<Parameters<typeof terminalScroll>[0]>().toEqualTypeOf<TerminalSessionHandle>();
    expectTypeOf<Parameters<typeof terminalClear>[0]>().toEqualTypeOf<TerminalSessionHandle>();
    expectTypeOf<Parameters<typeof terminalText>[0]>().toEqualTypeOf<TerminalSessionHandle>();
    expectTypeOf<Parameters<typeof terminalSearch>[0]>().toEqualTypeOf<TerminalSessionHandle>();
    expectTypeOf<Parameters<typeof terminalResize>[0]>().toEqualTypeOf<TerminalSessionHandle>();
    expectTypeOf<Parameters<typeof terminalKill>[0]>().toEqualTypeOf<TerminalSessionHandle>();
  });

  it("captures each spawned identity once and passes the handle through terminal runtime paths", () => {
    expect(TERMINAL_PANEL_SOURCE).toContain("handleBySessionRef");
    expect(TERMINAL_PANEL_SOURCE).not.toContain("generationBySessionRef");
    expect(TERMINAL_PANEL_SOURCE).toContain("terminalInputBatch(handle, clientSeq, commands)");
    expect(TERMINAL_PANEL_SOURCE).toContain("terminalAck(");
    expect(TERMINAL_PANEL_SOURCE).toContain("terminalResize(handle, size.cols, size.rows)");
    expect(TERMINAL_PANEL_SOURCE).toContain("terminalKill(handle)");
  });
});
