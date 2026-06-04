import { describe, expect, it } from "vitest";
import {
  basenameOf,
  buildShareQueue,
  isDirectoryPath,
  isInboxRowShareable,
} from "./shareOutbox";

describe("basenameOf", () => {
  it("handles posix, windows, trailing slash, and no separator", () => {
    expect(basenameOf("/a/b/c.docx")).toBe("c.docx");
    expect(basenameOf("C:\\a\\b\\c.docx")).toBe("c.docx");
    expect(basenameOf("/a/b/dir/")).toBe("dir");
    expect(basenameOf("c.docx")).toBe("c.docx");
  });
});

describe("isDirectoryPath", () => {
  it("flags trailing separators", () => {
    expect(isDirectoryPath("/a/b/")).toBe(true);
    expect(isDirectoryPath("/a/b")).toBe(false);
  });
});

describe("buildShareQueue", () => {
  const doc = (dirty: boolean) => ({ path: "/ws/note.md", title: "회의록", dirty });

  it("includes a clean active document as shareable", () => {
    const queue = buildShareQueue({
      activeDocument: doc(false),
      selectedFileEntries: [],
      inboxShareablePaths: [],
      manualPaths: [],
    });
    expect(queue).toHaveLength(1);
    expect(queue[0]).toMatchObject({ source: "document", label: "회의록", shareable: true });
    expect(queue[0].disabledReason).toBeUndefined();
  });

  it("marks a dirty active document non-shareable with saveFirst", () => {
    const queue = buildShareQueue({
      activeDocument: doc(true),
      selectedFileEntries: [],
      inboxShareablePaths: [],
      manualPaths: [],
    });
    expect(queue[0].shareable).toBe(false);
    expect(queue[0].disabledReason).toBe("shareOutbox.reason.saveFirst");
  });

  it("omits the document item when there is no active document", () => {
    const queue = buildShareQueue({
      activeDocument: null,
      selectedFileEntries: [{ path: "/ws/a.docx" }],
      inboxShareablePaths: [],
      manualPaths: [],
    });
    expect(queue).toHaveLength(1);
    expect(queue[0].source).toBe("files");
  });

  it("de-dupes a path in both files and inbox, keeping files (higher priority)", () => {
    const queue = buildShareQueue({
      activeDocument: null,
      selectedFileEntries: [{ path: "/ws/a.docx" }],
      inboxShareablePaths: ["/ws/a.docx"],
      manualPaths: [],
    });
    expect(queue).toHaveLength(1);
    expect(queue[0].source).toBe("files");
  });

  it("de-dupes the document path appearing again in manual, keeping document", () => {
    const queue = buildShareQueue({
      activeDocument: doc(false),
      selectedFileEntries: [],
      inboxShareablePaths: [],
      manualPaths: ["/ws/note.md"],
    });
    expect(queue).toHaveLength(1);
    expect(queue[0].source).toBe("document");
  });

  it("marks directory paths non-shareable with directory reason", () => {
    const queue = buildShareQueue({
      activeDocument: null,
      selectedFileEntries: [{ path: "/ws/folder/" }],
      inboxShareablePaths: [],
      manualPaths: [],
    });
    expect(queue[0].shareable).toBe(false);
    expect(queue[0].disabledReason).toBe("shareOutbox.reason.directory");
  });

  it("preserves source order document -> files -> inbox -> manual", () => {
    const queue = buildShareQueue({
      activeDocument: doc(false),
      selectedFileEntries: [{ path: "/ws/f.docx" }],
      inboxShareablePaths: ["/ws/i.docx"],
      manualPaths: ["/ws/m.docx"],
    });
    expect(queue.map((q) => q.source)).toEqual(["document", "files", "inbox", "manual"]);
  });

  it("returns an empty queue for empty input", () => {
    expect(
      buildShareQueue({
        activeDocument: null,
        selectedFileEntries: [],
        inboxShareablePaths: [],
        manualPaths: [],
      }),
    ).toEqual([]);
  });
});

describe("isInboxRowShareable", () => {
  it("file rows are shareable", () => {
    expect(isInboxRowShareable({ kind: "file" })).toBe(true);
  });
  it("dropFile entries are shareable", () => {
    expect(isInboxRowShareable({ kind: "entry", entryKind: "dropFile" })).toBe(true);
  });
  it("pendingItem entries are not shareable", () => {
    expect(isInboxRowShareable({ kind: "entry", entryKind: "pendingItem" })).toBe(false);
  });
});
