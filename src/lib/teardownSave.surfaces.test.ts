// Source-level pin for D-01 (REL-02): every in-scope debounced autosave
// surface must call useTeardownFlush(...) and createDebouncedSaver, and must
// not reintroduce its own hand-rolled save timer ref. HtmlVisualEditor is
// pinned as already-compliant (its 300ms timer serializes the iframe DOM into
// parent state, not a disk save, and its unmount cleanup already flushes it).
// The behavioral proof for each surface lives in its own component test.

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

function source(relativePath: string): string {
  return readFileSync(resolve(process.cwd(), relativePath), "utf8");
}

describe("teardownSave surface pin", () => {
  it("ScratchpadPane calls useTeardownFlush and createDebouncedSaver, and no longer hand-rolls its timer", () => {
    const file = source("src/components/ScratchpadPane.tsx");
    expect(file).toContain("useTeardownFlush(");
    expect(file).toContain("createDebouncedSaver");
    expect(file).not.toContain("autoSaveTimerRef");
  });

  it("StudioMode calls useTeardownFlush and createDebouncedSaver, and no longer hand-rolls its timer", () => {
    const file = source("src/components/studio/StudioMode.tsx");
    expect(file).toContain("useTeardownFlush(");
    expect(file).toContain("createDebouncedSaver");
    expect(file).not.toContain("saveTimerRef");
  });

  it("MeetingSourceWorkbench calls useTeardownFlush and createDebouncedSaver", () => {
    const file = source("src/components/meetings/MeetingSourceWorkbench.tsx");
    expect(file).toContain("useTeardownFlush(");
    expect(file).toContain("createDebouncedSaver");
  });

  it("GraphView calls useTeardownFlush and createDebouncedSaver, and no longer hand-rolls its timer", () => {
    const file = source("src/components/graph/GraphView.tsx");
    expect(file).toContain("useTeardownFlush(");
    expect(file).toContain("createDebouncedSaver");
    expect(file).not.toContain("saveTimerRef");
  });

  it("HtmlVisualEditor is pinned as already-compliant: its unmount cleanup still runs the serializer", () => {
    const file = source("src/components/HtmlVisualEditor.tsx");
    expect(file).toContain("serializeNowRef.current()");
  });
});
