// @vitest-environment jsdom

import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn(),
}));

vi.mock("@tauri-apps/plugin-dialog", () => ({
  open: vi.fn(),
  save: vi.fn(),
}));

import { invoke } from "@tauri-apps/api/core";
import {
  applyScratchpadTempCleanup,
  renameScratchpadDocument,
  saveScratchpadDocument,
  saveMemoAs,
  startScratchpadWatcher,
  transitionScratchpadIdea,
} from "./api";

const invokeMock = vi.mocked(invoke);

describe("scratchpad API", () => {
  beforeEach(() => {
    invokeMock.mockReset();
    Object.defineProperty(window, "__TAURI_INTERNALS__", {
      configurable: true,
      value: {},
    });
  });

  it("sends revision-safe save and rename arguments", async () => {
    invokeMock.mockResolvedValue({});
    await saveScratchpadDocument(
      "/work",
      "memos",
      "memo.md",
      "markdown",
      "body",
      "rev-1",
      false,
    );
    expect(invokeMock).toHaveBeenNthCalledWith(1, "scratchpad_save", {
      workPath: "/work",
      collection: "memos",
      relativePath: "memo.md",
      format: "markdown",
      content: "body",
      expectedRevision: "rev-1",
      force: false,
    });

    await renameScratchpadDocument(
      "/work",
      "ideation",
      "seeds/a.md",
      "developing/a.md",
      "rev-2",
    );
    expect(invokeMock).toHaveBeenNthCalledWith(2, "scratchpad_rename", {
      workPath: "/work",
      collection: "ideation",
      relativePath: "seeds/a.md",
      newRelativePath: "developing/a.md",
      expectedRevision: "rev-2",
    });
  });

  it("sends ideation transitions and selected temp revisions", async () => {
    invokeMock.mockResolvedValue({ trashed: [], skipped: [] });
    await transitionScratchpadIdea("/work", "seeds/a.md", "developing", "rev-3");
    expect(invokeMock).toHaveBeenNthCalledWith(1, "scratchpad_transition_idea", {
      workPath: "/work",
      relativePath: "seeds/a.md",
      stage: "developing",
      expectedRevision: "rev-3",
    });

    await applyScratchpadTempCleanup("/work", [
      { relativePath: "codex/run/result.json", revision: "rev-4" },
    ]);
    expect(invokeMock).toHaveBeenNthCalledWith(2, "scratchpad_cleanup_apply", {
      workPath: "/work",
      selections: [{ relativePath: "codex/run/result.json", revision: "rev-4" }],
    });
  });

  it("keeps the expected revision on an explicit forced overwrite", async () => {
    invokeMock.mockResolvedValue({});
    await saveScratchpadDocument(
      "/work",
      "memos",
      "memo.md",
      "markdown",
      "replacement",
      "current-revision",
      true,
    );
    expect(invokeMock).toHaveBeenCalledWith("scratchpad_save", {
      workPath: "/work",
      collection: "memos",
      relativePath: "memo.md",
      format: "markdown",
      content: "replacement",
      expectedRevision: "current-revision",
      force: true,
    });
  });

  it("returns the watcher generation assigned by the backend", async () => {
    invokeMock.mockResolvedValue(42);
    await expect(startScratchpadWatcher("/work")).resolves.toBe(42);
    expect(invokeMock).toHaveBeenCalledWith("start_scratchpad_watcher", { workPath: "/work" });
  });

  it("includes the owning workPath when exporting with Save As", async () => {
    invokeMock.mockResolvedValue({});
    await saveMemoAs("/work", "/exports/memo.md", "body");
    expect(invokeMock).toHaveBeenCalledWith("save_memo_as", {
      vaultPath: "/work",
      targetPath: "/exports/memo.md",
      content: "body",
    });
  });
});
