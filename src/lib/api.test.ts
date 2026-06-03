import { describe, expect, it, vi } from "vitest";

vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn(),
}));

vi.mock("@tauri-apps/plugin-dialog", () => ({
  open: vi.fn(),
  save: vi.fn(),
}));

import { applyInboxDecisions } from "./api";

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
