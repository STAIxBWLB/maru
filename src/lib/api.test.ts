import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { invoke } from "@tauri-apps/api/core";

vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn(),
}));

vi.mock("@tauri-apps/plugin-dialog", () => ({
  open: vi.fn(),
  save: vi.fn(),
}));

const mocks = vi.hoisted(() => ({ notice: vi.fn() }));
vi.mock("./errorStore", () => ({ publishOperationNotice: mocks.notice }));

import "./i18n/testing";
import {
  acceptInboxItem,
  acceptInboxItems,
  applyFileQueue,
  applyInboxDecisions,
  binaryViewerExtractHwpx,
  createWorkspaceDirectory,
  duplicateWorkspaceEntries,
  pasteWorkspaceEntries,
  prepareShareOutboxFiles,
  rejectInboxItem,
  rejectInboxItems,
  renameWorkspaceEntry,
  scanInboxProcessedSnapshot,
  stageInboxDropFiles,
  trashInboxItems,
  trashWorkspaceEntries,
  updateFrontmatterField,
} from "./api";
import { getProcessingOperation } from "./processingOperations";
import { IpcError } from "./ipcError";

beforeEach(() => {
  vi.mocked(invoke).mockReset();
});

describe("applyInboxDecisions fallback", () => {
  it("returns the done item directory for accepted decisions", async () => {
    const [outcome] = await applyInboxDecisions(
      "/workspace",
      [
        {
          itemDir: "inbox/items/pending/260604-kakao-a",
          decision: "accept",
          destination: "projects/rise/inbox",
          classification: "action",
          project: "rise",
        },
      ],
      "approval-1",
    );

    expect(outcome).toMatchObject({
      id: "inbox/items/pending/260604-kakao-a",
      decision: "accepted",
      sourcePath: "inbox/items/pending/260604-kakao-a",
      targetPath: "inbox/items/done/260604-kakao-a",
      fileName: "260604-kakao-a",
      ok: true,
      error: null,
    });
  });

  it("returns the rejected item directory for rejected decisions", async () => {
    const [outcome] = await applyInboxDecisions(
      "/workspace",
      [
        {
          itemDir: "inbox/items/pending/260604-kakao-b",
          decision: "reject",
        },
      ],
      "approval-1",
    );

    expect(outcome).toMatchObject({
      decision: "rejected",
      targetPath: "rejected/260604-kakao-b",
      fileName: "260604-kakao-b",
      ok: true,
      error: null,
    });
  });
});

describe("scanInboxProcessedSnapshot", () => {
  it("invokes the combined snapshot command with the backend query payload", async () => {
    (globalThis as { window?: unknown }).window = { __TAURI_INTERNALS__: {} };
    vi.mocked(invoke).mockResolvedValueOnce({
      items: [],
      counts: { gws: 2 },
    });
    try {
      await expect(
        scanInboxProcessedSnapshot({
          workPath: "/workspace",
          channel: "gws",
          statuses: ["done"],
          query: "budget",
          limit: 120,
        }),
      ).resolves.toEqual({ items: [], counts: { gws: 2 } });
      expect(invoke).toHaveBeenCalledWith("scan_inbox_processed_snapshot", {
        workPath: "/workspace",
        channel: "gws",
        statuses: ["done"],
        query: "budget",
        limit: 120,
      });
    } finally {
      delete (globalThis as { window?: unknown }).window;
    }
  });
});

describe("updateFrontmatterField", () => {
  it("normalizes a document conflict into an IpcError", async () => {
    (globalThis as { window?: unknown }).window = { __TAURI_INTERNALS__: {} };
    vi.mocked(invoke).mockRejectedValueOnce({
      code: "document_conflict",
      message: "expected revision a, found b",
    });

    try {
      let caught: unknown;
      try {
        await updateFrontmatterField("/workspace", "note.md", "status", "done", "rev-a");
      } catch (err) {
        caught = err;
      }

      expect(caught).toBeInstanceOf(IpcError);
      expect(caught).toMatchObject({
        code: "document_conflict",
        message: "document_conflict: expected revision a, found b",
      });
      expect(invoke).toHaveBeenCalledWith("update_frontmatter_field", {
        vaultPath: "/workspace",
        documentPath: "note.md",
        key: "status",
        value: "done",
        expectedRevision: "rev-a",
      });
    } finally {
      delete (globalThis as { window?: unknown }).window;
    }
  });

  it("preserves the message of an uncoded legacy error", async () => {
    (globalThis as { window?: unknown }).window = { __TAURI_INTERNALS__: {} };
    vi.mocked(invoke).mockRejectedValueOnce({
      code: "",
      message: "frontmatter editing is not supported for HTML documents",
    });

    try {
      await expect(
        updateFrontmatterField("/workspace", "page.html", "status", "done"),
      ).rejects.toThrow("frontmatter editing is not supported for HTML documents");
    } finally {
      delete (globalThis as { window?: unknown }).window;
    }
  });
});

describe("processing completion ownership (phase 08-25)", () => {
  const WORKSPACE = "/workspace";

  function deferred<T>() {
    let resolve!: (value: T) => void;
    let reject!: (reason: unknown) => void;
    const promise = new Promise<T>((yes, no) => {
      resolve = yes;
      reject = no;
    });
    return { promise, resolve, reject };
  }

  const mutation = (name: string, status: "done" | "error", error: string | null = null) => ({
    sourcePath: `/workspace/${name}`,
    targetPath: status === "done" ? `/workspace/done/${name}` : null,
    name,
    status,
    error,
  });
  const decision = (id: string, ok: boolean, error: string | null = null) => ({
    id,
    decision: "accepted" as const,
    sourcePath: id,
    targetPath: ok ? `done/${id}` : null,
    fileName: id,
    ok,
    error,
  });
  const trashOutcome = (id: string, ok: boolean, error: string | null = null) => ({
    id,
    kind: "dropFile" as const,
    originalPath: `/workspace/inbox/drop/${id}`,
    ok,
    error,
  });
  const stageOutcome = (id: string, ok: boolean, error: string | null = null) => ({
    id,
    sourcePath: `/ext/${id}`,
    targetPath: ok ? `/workspace/inbox/drop/incoming/${id}` : null,
    fileName: id,
    channel: "incoming",
    dropPath: "drop/incoming",
    ok,
    error,
  });
  const shareOutcome = (name: string, ok: boolean, error: string | null = null) => ({
    source: `/workspace/out/${name}`,
    ok,
    dryRun: false,
    output: ok ? `/share/${name}` : null,
    error,
  });

  interface ProcessingRow {
    command: string;
    labelKey: string;
    rejectionOnly?: boolean;
    call: () => Promise<unknown>;
    allSuccess: () => unknown;
    allFailed: () => unknown;
    allFailedReason: string;
    mixed?: () => unknown;
  }

  const PROCESSING_COMMAND_CONTEXT: ProcessingRow[] = [
    {
      command: "apply_file_queue",
      labelKey: "processing.label.applyFileQueue",
      rejectionOnly: true,
      call: () =>
        applyFileQueue(WORKSPACE, [
          {
            id: "q1",
            sourcePath: "/ext/a.md",
            sourceKind: "file",
            targetDir: "/workspace/docs",
            operation: "copy",
          },
        ]),
      allSuccess: () => [
        { id: "q1", sourcePath: "/ext/a.md", targetPath: "/workspace/docs/a.md", fileName: "a.md", operation: "copy" },
      ],
      allFailed: () => [],
      allFailedReason: "rejection-only",
    },
    {
      command: "create_workspace_directory",
      labelKey: "processing.label.createWorkspaceDirectory",
      call: () => createWorkspaceDirectory(WORKSPACE, WORKSPACE, "folder-a"),
      allSuccess: () => mutation("folder-a", "done"),
      allFailed: () => mutation("folder-a", "error", "parent missing"),
      allFailedReason: "parent missing",
    },
    {
      command: "rename_workspace_entry",
      labelKey: "processing.label.renameWorkspaceEntry",
      call: () => renameWorkspaceEntry(WORKSPACE, "/workspace/a.md", "b.md"),
      allSuccess: () => mutation("a.md", "done"),
      allFailed: () => mutation("a.md", "error", "target exists"),
      allFailedReason: "target exists",
    },
    {
      command: "duplicate_workspace_entries",
      labelKey: "processing.label.duplicateWorkspaceEntries",
      call: () => duplicateWorkspaceEntries(WORKSPACE, ["/workspace/a.md", "/workspace/b.md"]),
      allSuccess: () => [mutation("a.md", "done"), mutation("b.md", "done")],
      allFailed: () => [mutation("a.md", "error", "disk full"), mutation("b.md", "error", "disk full")],
      allFailedReason: "disk full",
      mixed: () => [mutation("a.md", "done"), mutation("b.md", "error", "disk full")],
    },
    {
      command: "paste_workspace_entries",
      labelKey: "processing.label.pasteWorkspaceEntries",
      call: () => pasteWorkspaceEntries(WORKSPACE, ["/workspace/a.md", "/workspace/b.md"], "/workspace/docs", "copy"),
      allSuccess: () => [mutation("a.md", "done"), mutation("b.md", "done")],
      allFailed: () => [mutation("a.md", "error", "denied by guard"), mutation("b.md", "error", "denied by guard")],
      allFailedReason: "denied by guard",
      mixed: () => [mutation("a.md", "done"), mutation("b.md", "error", "denied by guard")],
    },
    {
      command: "trash_workspace_entries",
      labelKey: "processing.label.trashWorkspaceEntries",
      call: () => trashWorkspaceEntries(WORKSPACE, ["/workspace/a.md", "/workspace/b.md"]),
      allSuccess: () => [mutation("a.md", "done"), mutation("b.md", "done")],
      allFailed: () => [mutation("a.md", "error", "locked"), mutation("b.md", "error", "locked")],
      allFailedReason: "locked",
      mixed: () => [mutation("a.md", "done"), mutation("b.md", "error", "locked")],
    },
    {
      command: "trash_inbox_items",
      labelKey: "processing.label.trashInboxItems",
      call: () =>
        trashInboxItems(
          WORKSPACE,
          [
            { id: "t1", kind: "dropFile", path: "/workspace/inbox/drop/a.md" },
            { id: "t2", kind: "pendingItem", path: "/workspace/inbox/items/pending/b" },
          ],
          "approval-1",
        ),
      allSuccess: () => [trashOutcome("a.md", true), trashOutcome("b", true)],
      allFailed: () => [trashOutcome("a.md", false, "already processed"), trashOutcome("b", false, "already processed")],
      allFailedReason: "already processed",
      mixed: () => [trashOutcome("a.md", true), trashOutcome("b", false, "already processed")],
    },
    {
      command: "stage_inbox_drop_files",
      labelKey: "processing.label.stageInboxDropFiles",
      call: () => stageInboxDropFiles(WORKSPACE, { sourcePaths: ["/ext/a.md", "/ext/b.md"] }),
      allSuccess: () => [stageOutcome("a.md", true), stageOutcome("b.md", true)],
      allFailed: () => [stageOutcome("a.md", false, "containment rejected"), stageOutcome("b.md", false, "containment rejected")],
      allFailedReason: "containment rejected",
      mixed: () => [stageOutcome("a.md", true), stageOutcome("b.md", false, "containment rejected")],
    },
    {
      command: "accept_inbox_item",
      labelKey: "processing.label.acceptInboxItem",
      call: () => acceptInboxItem(WORKSPACE, "inbox/items/pending/a", "projects", "approval-1"),
      allSuccess: () => decision("a", true),
      allFailed: () => decision("a", false, "target missing"),
      allFailedReason: "target missing",
    },
    {
      command: "accept_inbox_items",
      labelKey: "processing.label.acceptInboxItem",
      call: () => acceptInboxItems(WORKSPACE, [{ id: "a" }, { id: "b" }], "approval-1"),
      allSuccess: () => [decision("a", true), decision("b", true)],
      allFailed: () => [decision("a", false, "target missing"), decision("b", false, "target missing")],
      allFailedReason: "target missing",
      mixed: () => [decision("a", true), decision("b", false, "target missing")],
    },
    {
      command: "apply_inbox_decisions",
      labelKey: "processing.label.applyInboxDecisions",
      call: () =>
        applyInboxDecisions(
          WORKSPACE,
          [
            { itemDir: "inbox/items/pending/a", decision: "accept", destination: "projects/rise" },
            { itemDir: "inbox/items/pending/b", decision: "reject" },
          ],
          "approval-1",
        ),
      allSuccess: () => [decision("a", true), decision("b", true)],
      allFailed: () => [decision("a", false, "item locked"), decision("b", false, "item locked")],
      allFailedReason: "item locked",
      mixed: () => [decision("a", true), decision("b", false, "item locked")],
    },
    {
      command: "reject_inbox_item",
      labelKey: "processing.label.rejectInboxItem",
      call: () => rejectInboxItem(WORKSPACE, "inbox/items/pending/a", "approval-1"),
      allSuccess: () => ({ ...decision("a", true), decision: "rejected" as const }),
      allFailed: () => ({ ...decision("a", false, "item locked"), decision: "rejected" as const }),
      allFailedReason: "item locked",
    },
    {
      command: "reject_inbox_items",
      labelKey: "processing.label.rejectInboxItem",
      call: () => rejectInboxItems(WORKSPACE, ["a", "b"], "approval-1"),
      allSuccess: () => [
        { ...decision("a", true), decision: "rejected" as const },
        { ...decision("b", true), decision: "rejected" as const },
      ],
      allFailed: () => [
        { ...decision("a", false, "item locked"), decision: "rejected" as const },
        { ...decision("b", false, "item locked"), decision: "rejected" as const },
      ],
      allFailedReason: "item locked",
      mixed: () => [
        { ...decision("a", true), decision: "rejected" as const },
        { ...decision("b", false, "item locked"), decision: "rejected" as const },
      ],
    },
    {
      command: "prepare_share_outbox_files",
      labelKey: "processing.label.prepareShareOutboxFiles",
      call: () =>
        prepareShareOutboxFiles(
          WORKSPACE,
          [{ path: "/workspace/out/a.md" }, { path: "/workspace/out/b.md" }],
          { author: null, replace: true, dryRun: false },
        ),
      allSuccess: () => [shareOutcome("a.md", true), shareOutcome("b.md", true)],
      allFailed: () => [shareOutcome("a.md", false, "root missing"), shareOutcome("b.md", false, "root missing")],
      allFailedReason: "root missing",
      mixed: () => [shareOutcome("a.md", true), shareOutcome("b.md", false, "root missing")],
    },
    {
      command: "binary_viewer_extract_hwpx",
      labelKey: "processing.label.binaryViewerExtractHwpx",
      call: () => binaryViewerExtractHwpx(WORKSPACE, "/workspace/doc.hwpx"),
      allSuccess: () => ({ html: "<p>body</p>", sections: 3, warnings: [] }),
      allFailed: () => ({ html: "  ", sections: 0, warnings: ["zip unreadable"] }),
      allFailedReason: "zip unreadable",
    },
  ];

  beforeEach(() => {
    mocks.notice.mockReset();
    (globalThis as { window?: unknown }).window = { __TAURI_INTERNALS__: {} };
  });

  afterEach(() => {
    delete (globalThis as { window?: unknown }).window;
  });

  it.each(PROCESSING_COMMAND_CONTEXT.map((row) => [row.command, row] as const))(
    "%s all-success publishes exactly one success notice with payload identity",
    async (_command, row) => {
      const payload = row.allSuccess();
      vi.mocked(invoke).mockReturnValueOnce(Promise.resolve(payload));
      const result = await row.call();
      expect(result).toBe(payload);
      if (row.rejectionOnly) {
        expect(mocks.notice).not.toHaveBeenCalled();
      } else {
        expect(mocks.notice).toHaveBeenCalledTimes(1);
        expect(mocks.notice.mock.calls[0][0]).toMatchObject({ kind: "success" });
        expect(mocks.notice.mock.calls[0][0].message).toContain(WORKSPACE);
      }
      expect(invoke).toHaveBeenCalledTimes(1);
    },
  );

  it.each(
    PROCESSING_COMMAND_CONTEXT.filter((row) => !row.rejectionOnly).map(
      (row) => [row.command, row] as const,
    ),
  )(
    "%s mixed fulfilled payload after view disposal publishes exactly one info notice retaining successes",
    async (_command, row) => {
      const payload = row.mixed ? row.mixed() : row.allFailed();
      const kind = row.mixed ? "info" : "error";
      const settled = deferred<unknown>();
      vi.mocked(invoke).mockReturnValueOnce(settled.promise);
      const promise = row.call();
      settled.resolve(payload);
      const result = await promise;
      expect(result).toBe(payload);
      expect(invoke).toHaveBeenCalledTimes(1);
      expect(mocks.notice).toHaveBeenCalledTimes(1);
      expect(mocks.notice.mock.calls[0][0]).toMatchObject({ kind });
      const message = mocks.notice.mock.calls[0][0].message as string;
      expect(message).toContain(WORKSPACE);
      expect(message).toContain(row.allFailedReason);
      const record = getProcessingOperation(mocks.notice.mock.calls[0][0].operationId as string);
      expect(record?.workspace).toBe(WORKSPACE);
      expect(record?.completion?.failed.map((failure) => failure.reason)).toContain(
        row.allFailedReason,
      );
    },
  );

  it.each(
    PROCESSING_COMMAND_CONTEXT.filter((row) => row.mixed).map((row) => [row.command, row] as const),
  )(
    "%s all-failed fulfilled payload publishes exactly one error notice with actionable reasons",
    async (_command, row) => {
      const payload = row.allFailed();
      vi.mocked(invoke).mockReturnValueOnce(Promise.resolve(payload));
      const result = await row.call();
      expect(result).toBe(payload);
      expect(mocks.notice).toHaveBeenCalledTimes(1);
      expect(mocks.notice.mock.calls[0][0]).toMatchObject({ kind: "error" });
      expect(mocks.notice.mock.calls[0][0].message).toContain(row.allFailedReason);
    },
  );

  it.each(PROCESSING_COMMAND_CONTEXT.map((row) => [row.command, row] as const))(
    "%s typed rejection publishes one error notice and rethrows the original rejection",
    async (_command, row) => {
      const rejection = { code: "workspace_denied", message: "denied by policy" };
      vi.mocked(invoke).mockReturnValueOnce(Promise.reject(rejection));
      let caught: unknown;
      try {
        await row.call();
      } catch (error) {
        caught = error;
      }
      expect(caught).toBe(rejection);
      expect(mocks.notice).toHaveBeenCalledTimes(1);
      expect(mocks.notice.mock.calls[0][0]).toMatchObject({ kind: "error" });
      expect(mocks.notice.mock.calls[0][0].message).toContain("denied by policy");
      expect(invoke).toHaveBeenCalledTimes(1);
    },
  );

  it("paste after A -> B -> A navigation still reports exactly once with the initiating workspace", async () => {
    const settled = deferred<unknown>();
    vi.mocked(invoke).mockReturnValueOnce(settled.promise);
    const promise = pasteWorkspaceEntries(
      WORKSPACE,
      ["/workspace/a.md"],
      "/workspace/docs",
      "copy",
    );
    delete (globalThis as { window?: unknown }).window;
    (globalThis as { window?: unknown }).window = { __TAURI_INTERNALS__: {} };
    delete (globalThis as { window?: unknown }).window;
    (globalThis as { window?: unknown }).window = { __TAURI_INTERNALS__: {} };
    settled.resolve([mutation("a.md", "done")]);
    await promise;
    expect(mocks.notice).toHaveBeenCalledTimes(1);
    expect(mocks.notice.mock.calls[0][0].message).toContain(WORKSPACE);
    expect(invoke).toHaveBeenCalledTimes(1);
  });

  it("applyFileQueue rejection-only contract: fulfilled payload returns unchanged without a fabricated success notice", async () => {
    const payload = PROCESSING_COMMAND_CONTEXT[0].allSuccess();
    vi.mocked(invoke).mockReturnValueOnce(Promise.resolve(payload));
    const result = await applyFileQueue(WORKSPACE, [
      {
        id: "q1",
        sourcePath: "/ext/a.md",
        sourceKind: "file",
        targetDir: "/workspace/docs",
        operation: "copy",
      },
    ]);
    expect(result).toBe(payload);
    expect(mocks.notice).not.toHaveBeenCalled();
  });
});
