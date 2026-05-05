import { describe, expect, it } from "vitest";
import {
  EXPLORER_DRAG_MIME,
  clearExplorerDragPayload,
  dropOperationFromEvent,
  hasExplorerDragPayload,
  isSameParentMove,
  readExplorerDragPayload,
  targetDirForDropTarget,
  writeExplorerDragPayload,
  type ExplorerDragPayload,
} from "./fileDrag";

class FakeDataTransfer {
  private values = new Map<string, string>();
  types: string[] = [];
  effectAllowed = "all";
  dropEffect = "none";

  setData(format: string, data: string): void {
    if (!this.values.has(format)) this.types.push(format);
    this.values.set(format, data);
  }

  getData(format: string): string {
    return this.values.get(format) ?? "";
  }
}

describe("explorer drag payload", () => {
  it("encodes and decodes explorer drag items", () => {
    const payload: ExplorerDragPayload = {
      origin: "files",
      workspacePath: "/workspace",
      items: [
        {
          path: "/workspace/a.md",
          relPath: "a.md",
          fileName: "a.md",
          sourceKind: "file",
        },
        {
          path: "/workspace/assets",
          relPath: "assets",
          fileName: "assets",
          sourceKind: "directory",
        },
      ],
    };
    const dataTransfer = new FakeDataTransfer();

    writeExplorerDragPayload({ dataTransfer }, payload);

    expect(dataTransfer.effectAllowed).toBe("copyMove");
    expect(dataTransfer.getData("text/plain")).toBe("a.md\nassets");
    expect(hasExplorerDragPayload(dataTransfer)).toBe(true);
    expect(readExplorerDragPayload(dataTransfer)).toEqual(payload);
  });

  it("rejects malformed payloads", () => {
    const dataTransfer = new FakeDataTransfer();
    dataTransfer.setData(EXPLORER_DRAG_MIME, JSON.stringify({ origin: "files", items: [] }));

    expect(readExplorerDragPayload(dataTransfer)).toBeNull();
  });

  it("falls back to the active in-memory drag payload", () => {
    const payload: ExplorerDragPayload = {
      origin: "documents",
      workspacePath: "/workspace",
      items: [
        {
          path: "/workspace/a.md",
          relPath: "a.md",
          fileName: "a.md",
          sourceKind: "file",
        },
      ],
    };
    const dataTransfer = new FakeDataTransfer();

    writeExplorerDragPayload({ dataTransfer }, payload);
    const restricted = new FakeDataTransfer();

    expect(hasExplorerDragPayload(restricted)).toBe(true);
    expect(readExplorerDragPayload(restricted)).toEqual(payload);
    clearExplorerDragPayload();
    expect(hasExplorerDragPayload(restricted)).toBe(false);
  });

  it("resolves drop target directories and same-parent move no-ops", () => {
    const item = {
      path: "/workspace/docs/a.md",
      relPath: "docs/a.md",
      fileName: "a.md",
      sourceKind: "file" as const,
    };

    expect(targetDirForDropTarget("/workspace/docs", "directory")).toBe("/workspace/docs");
    expect(targetDirForDropTarget("/workspace/docs/b.md", "file")).toBe("/workspace/docs");
    expect(isSameParentMove(item, "/workspace/docs")).toBe(true);
    expect(isSameParentMove(item, "/workspace/archive")).toBe(false);
  });

  it("uses copy by default and move with Alt", () => {
    expect(dropOperationFromEvent({ altKey: false })).toBe("copy");
    expect(dropOperationFromEvent({ altKey: true })).toBe("move");
  });
});
