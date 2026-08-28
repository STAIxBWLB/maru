import { beforeEach, describe, expect, it, vi } from "vitest";
import { invoke } from "@tauri-apps/api/core";

vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn(),
}));

vi.mock("@tauri-apps/plugin-dialog", () => ({
  open: vi.fn(),
  save: vi.fn(),
}));

import { applyInboxDecisions, scanInboxProcessedSnapshot, updateFrontmatterField } from "./api";
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
