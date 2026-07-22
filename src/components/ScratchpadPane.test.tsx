// @vitest-environment jsdom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  applyCleanup: vi.fn(),
  chooseSaveFile: vi.fn(),
  createIdea: vi.fn(),
  isTauri: vi.fn(),
  list: vi.fn(),
  listen: vi.fn(),
  migrate: vi.fn(),
  planCleanup: vi.fn(),
  read: vi.fn(),
  rename: vi.fn(),
  saveAs: vi.fn(),
  save: vi.fn(),
  startWatcher: vi.fn(),
  stopWatcher: vi.fn(),
  transition: vi.fn(),
  trash: vi.fn(),
}));

const watcherListeners = new Map<string, (event: { payload: never }) => void>();

vi.mock("@tauri-apps/api/event", () => ({
  listen: mocks.listen,
}));

vi.mock("dompurify", () => ({
  default: { sanitize: (html: string) => html },
}));

vi.mock("../lib/api", () => ({
  applyScratchpadTempCleanup: mocks.applyCleanup,
  chooseSaveFile: mocks.chooseSaveFile,
  createScratchpadIdea: mocks.createIdea,
  isTauri: mocks.isTauri,
  listScratchpad: mocks.list,
  migrateLegacyMemos: mocks.migrate,
  planScratchpadTempCleanup: mocks.planCleanup,
  readScratchpadDocument: mocks.read,
  renameScratchpadDocument: mocks.rename,
  saveMemoAs: mocks.saveAs,
  saveScratchpadDocument: mocks.save,
  startScratchpadWatcher: mocks.startWatcher,
  stopScratchpadWatcher: mocks.stopWatcher,
  transitionScratchpadIdea: mocks.transition,
  trashScratchpadDocument: mocks.trash,
}));

import { ScratchpadPane } from "./ScratchpadPane";
import type { ScratchpadDocument, ScratchpadEntry } from "../lib/types";

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const t = (key: string, vars?: Record<string, string | number>) => {
  let result = key;
  for (const [name, value] of Object.entries(vars ?? {})) {
    result = result.replace(`{${name}}`, String(value));
  }
  return result;
};

function memoEntry(patch: Partial<ScratchpadEntry> = {}): ScratchpadEntry {
  return {
    collection: "memos",
    relativePath: "memo.md",
    name: "memo.md",
    source: "maru",
    format: "markdown",
    updatedAt: "2026-07-22T01:00:00Z",
    sizeBytes: 12,
    preview: "memo",
    revision: "rev-1",
    stale: false,
    editable: true,
    ...patch,
  };
}

function memoDocument(patch: Partial<ScratchpadDocument> = {}): ScratchpadDocument {
  return { ...memoEntry(), content: "saved", ...patch };
}

async function settle(): Promise<void> {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
  });
}

describe("ScratchpadPane safety flows", () => {
  let container: HTMLDivElement;
  let root: Root | null;

  beforeEach(() => {
    const values = new Map<string, string>();
    Object.defineProperty(window, "localStorage", {
      configurable: true,
      value: {
        getItem: (key: string) => values.get(key) ?? null,
        setItem: (key: string, value: string) => values.set(key, value),
        removeItem: (key: string) => values.delete(key),
        clear: () => values.clear(),
      },
    });
    vi.clearAllMocks();
    watcherListeners.clear();
    mocks.isTauri.mockReturnValue(false);
    mocks.list.mockResolvedValue([]);
    mocks.listen.mockImplementation(async (name: string, handler: (event: { payload: never }) => void) => {
      watcherListeners.set(name, handler);
      return vi.fn();
    });
    mocks.startWatcher.mockResolvedValue(1);
    mocks.stopWatcher.mockResolvedValue(undefined);
    mocks.migrate.mockResolvedValue({ migrated: [], skipped: [], markerPath: "marker" });
    mocks.planCleanup.mockResolvedValue([]);
    mocks.applyCleanup.mockResolvedValue({ trashed: [], skipped: [] });
    mocks.save.mockResolvedValue(memoDocument());
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(async () => {
    if (root) await act(async () => root?.unmount());
    container?.remove();
    root = null;
    vi.useRealTimers();
  });

  async function render(workPath = "/work") {
    await act(async () => {
      root?.render(
        <ScratchpadPane
          workPath={workPath}
          onError={vi.fn()}
          onRefreshWorkspace={vi.fn()}
          t={t}
        />,
      );
    });
    await settle();
  }

  it("never migrates tracked memos on mount and exposes an explicit action", async () => {
    await render();
    expect(mocks.migrate).not.toHaveBeenCalled();

    vi.spyOn(window, "confirm").mockReturnValue(true);
    const button = Array.from(container.querySelectorAll("button")).find((candidate) =>
      candidate.textContent?.includes("rightPane.scratchpad.migrateMemos"),
    );
    expect(button).toBeTruthy();
    await act(async () => button?.click());
    await settle();
    expect(mocks.migrate).toHaveBeenCalledWith("/work");
  });

  it("shows every cleanup candidate and applies only checked files", async () => {
    mocks.planCleanup.mockResolvedValue([
      { relativePath: "codex/a.json", sizeBytes: 5, updatedAt: null, revision: "a", stale: true },
      { relativePath: "claude/b.png", sizeBytes: 8, updatedAt: null, revision: "b", stale: true },
    ]);
    mocks.applyCleanup.mockResolvedValue({ trashed: ["codex/a.json"], skipped: [] });
    await render();

    const review = Array.from(container.querySelectorAll("button")).find((candidate) =>
      candidate.textContent?.includes("rightPane.scratchpad.reviewTemp"),
    );
    await act(async () => review?.click());
    await settle();

    expect(container.querySelector('[role="dialog"]')).toBeTruthy();
    expect(container.textContent).toContain("codex/a.json");
    expect(container.textContent).toContain("claude/b.png");
    const checkboxes = container.querySelectorAll<HTMLInputElement>('input[type="checkbox"]');
    expect(checkboxes).toHaveLength(2);
    expect(Array.from(checkboxes).every((checkbox) => !checkbox.checked)).toBe(true);

    await act(async () => checkboxes[0].click());
    const apply = Array.from(container.querySelectorAll("button")).find((candidate) =>
      candidate.textContent?.includes("rightPane.scratchpad.moveSelectedToTrash"),
    );
    await act(async () => apply?.click());
    await settle();
    expect(mocks.applyCleanup).toHaveBeenCalledWith("/work", [
      { relativePath: "codex/a.json", revision: "a" },
    ]);
  });

  it("excludes the currently open Temp file even when it is clean", async () => {
    const current = memoEntry({
      collection: "temp",
      relativePath: "codex/current.md",
      name: "current.md",
      source: "codex",
    });
    mocks.list.mockResolvedValue([current]);
    mocks.read.mockResolvedValue({ ...current, content: "clean" });
    mocks.planCleanup.mockResolvedValue([
      { relativePath: "codex/current.md", sizeBytes: 5, updatedAt: null, revision: "rev-1", stale: true },
      { relativePath: "codex/other.md", sizeBytes: 8, updatedAt: null, revision: "rev-2", stale: true },
    ]);
    await render();
    await act(async () => container.querySelector<HTMLButtonElement>('button[title="temp/codex/current.md"]')?.click());
    await settle();
    const review = Array.from(container.querySelectorAll("button")).find((candidate) =>
      candidate.textContent?.includes("rightPane.scratchpad.reviewTemp"),
    );
    await act(async () => review?.click());
    await settle();
    const dialog = container.querySelector('[role="dialog"]');
    expect(dialog?.textContent).not.toContain("codex/current.md");
    expect(dialog?.textContent).toContain("codex/other.md");
  });

  it("traps cleanup focus and restores it to the review trigger on Escape", async () => {
    mocks.planCleanup.mockResolvedValue([
      { relativePath: "codex/a.md", sizeBytes: 5, updatedAt: null, revision: "a", stale: true },
    ]);
    await render();
    const review = Array.from(container.querySelectorAll<HTMLButtonElement>("button")).find((candidate) =>
      candidate.textContent?.includes("rightPane.scratchpad.reviewTemp"),
    );
    await act(async () => review?.click());
    await settle();
    const dialog = container.querySelector<HTMLElement>('[role="dialog"]');
    expect(dialog).toBeTruthy();
    dialog?.focus();
    await act(async () => dialog?.dispatchEvent(new KeyboardEvent("keydown", { key: "Tab", bubbles: true })));
    const first = dialog?.querySelector<HTMLButtonElement>("button");
    expect(document.activeElement).toBe(first);
    await act(async () => first?.dispatchEvent(new KeyboardEvent("keydown", { key: "Tab", shiftKey: true, bubbles: true })));
    const focusable = dialog?.querySelectorAll<HTMLElement>('button:not(:disabled), input:not(:disabled)');
    expect(document.activeElement).toBe(focusable?.[focusable.length - 1]);
    await act(async () => dialog?.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true })));
    await act(async () => {
      await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
    });
    expect(container.querySelector('[role="dialog"]')).toBeNull();
    expect(document.activeElement).toBe(review);
  });

  it("surfaces a revision conflict and overwrites only after reading the current revision", async () => {
    vi.useFakeTimers();
    const entry = memoEntry();
    mocks.list.mockResolvedValue([entry]);
    mocks.read
      .mockResolvedValueOnce(memoDocument())
      .mockResolvedValueOnce(memoDocument({ revision: "rev-2", content: "external" }));
    mocks.save
      .mockRejectedValueOnce(new Error("scratchpad_conflict: revision changed"))
      .mockResolvedValueOnce(memoDocument({ revision: "rev-3", content: "draft" }));
    await render();

    const item = container.querySelector<HTMLButtonElement>('button[title="memos/memo.md"]');
    await act(async () => item?.click());
    await settle();
    const textarea = container.querySelector<HTMLTextAreaElement>("textarea.scratchpad-editor");
    expect(textarea).toBeTruthy();
    await act(async () => {
      const setter = Object.getOwnPropertyDescriptor(
        HTMLTextAreaElement.prototype,
        "value",
      )?.set;
      setter?.call(textarea, "draft");
      textarea?.dispatchEvent(new Event("input", { bubbles: true }));
      await vi.advanceTimersByTimeAsync(700);
    });
    await settle();
    expect(container.textContent).toContain("rightPane.scratchpad.conflict");

    const overwrite = Array.from(container.querySelectorAll("button")).find((candidate) =>
      candidate.textContent?.includes("rightPane.scratchpad.overwrite"),
    );
    await act(async () => overwrite?.click());
    await settle();
    expect(mocks.save).toHaveBeenLastCalledWith(
      "/work",
      "memos",
      "memo.md",
      "markdown",
      "draft",
      "rev-2",
      true,
    );
  });

  it("serializes watcher stop/start transitions across workspace changes", async () => {
    mocks.isTauri.mockReturnValue(true);
    mocks.startWatcher.mockResolvedValueOnce(11).mockResolvedValueOnce(22);
    await render("/work-a");
    expect(mocks.startWatcher).toHaveBeenCalledWith("/work-a");

    await act(async () => {
      root?.render(
        <ScratchpadPane
          workPath="/work-b"
          onError={vi.fn()}
          onRefreshWorkspace={vi.fn()}
          t={t}
        />,
      );
    });
    await settle();
    expect(mocks.startWatcher).toHaveBeenCalledWith("/work-b");
    const firstStartOrder = mocks.startWatcher.mock.invocationCallOrder[0];
    const secondStartOrder = mocks.startWatcher.mock.invocationCallOrder[1];
    const stopOrders = mocks.stopWatcher.mock.invocationCallOrder;
    expect(stopOrders.some((order) => order < firstStartOrder)).toBe(true);
    expect(stopOrders.some((order) => order > firstStartOrder && order < secondStartOrder)).toBe(true);
  });

  it("ignores watcher events from a stale generation", async () => {
    vi.useFakeTimers();
    mocks.isTauri.mockReturnValue(true);
    mocks.startWatcher.mockResolvedValue(7);
    await render("/work");
    const callsBeforeEvents = mocks.list.mock.calls.length;
    const changed = watcherListeners.get("scratchpad://changed");
    expect(changed).toBeTruthy();
    await act(async () => {
      changed?.({ payload: { workPath: "/work", paths: ["memos/a.md"], generation: 6 } as never });
      await vi.advanceTimersByTimeAsync(200);
    });
    expect(mocks.list).toHaveBeenCalledTimes(callsBeforeEvents);
    await act(async () => {
      changed?.({ payload: { workPath: "/work", paths: ["memos/a.md"], generation: 7 } as never });
      await vi.advanceTimersByTimeAsync(200);
    });
    expect(mocks.list.mock.calls.length).toBeGreaterThan(callsBeforeEvents);
  });

  it("keeps a workspace-scoped draft across a switch without cross-saving", async () => {
    vi.useFakeTimers();
    const entry = memoEntry();
    mocks.list.mockImplementation(async (workPath: string) => (workPath === "/work-a" ? [entry] : []));
    mocks.read.mockResolvedValue(memoDocument());
    await render("/work-a");
    const item = container.querySelector<HTMLButtonElement>('button[title="memos/memo.md"]');
    await act(async () => item?.click());
    await settle();
    const textarea = container.querySelector<HTMLTextAreaElement>("textarea.scratchpad-editor");
    await act(async () => {
      const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")?.set;
      setter?.call(textarea, "recover me");
      textarea?.dispatchEvent(new Event("input", { bubbles: true }));
    });

    await act(async () => {
      root?.render(
        <ScratchpadPane
          workPath="/work-b"
          onError={vi.fn()}
          onRefreshWorkspace={vi.fn()}
          t={t}
        />,
      );
    });
    await act(async () => vi.advanceTimersByTimeAsync(800));
    await settle();
    expect(mocks.save).not.toHaveBeenCalled();

    await act(async () => {
      root?.render(
        <ScratchpadPane
          workPath="/work-a"
          onError={vi.fn()}
          onRefreshWorkspace={vi.fn()}
          t={t}
        />,
      );
    });
    await settle();
    expect(container.textContent).toContain("rightPane.scratchpad.recoveryAvailable");
  });
});
