import { describe, expect, it } from "vitest";
import { buildCommsFeedRows } from "./comms";

describe("buildCommsFeedRows", () => {
  it("merges provider rows newest first and preserves decisions", () => {
    const rows = buildCommsFeedRows({
      gmail: [
        {
          message: {
            id: "g",
            from: "g@example.com",
            subject: "Gmail",
            date: "2026-05-10T01:00:00Z",
          },
          decision: "accepted",
        },
      ],
      outlook: [
        {
          message: {
            id: "o",
            from: "o@example.com",
            subject: "Outlook",
            date: "2026-05-10T02:00:00Z",
            bodyPreview: "preview",
            webLink: null,
            categories: [],
            isRead: false,
          },
          decision: "pending",
        },
      ],
      telegram: [
        {
          message: {
            id: "t",
            chatId: "42",
            chatTitle: "Ops",
            sender: "Lee",
            text: "message",
            date: "2026-05-10T00:30:00Z",
            permalink: null,
          },
          decision: "rejected",
        },
      ],
    });

    expect(rows.map((row) => row.key)).toEqual(["outlook:o", "gmail:g", "telegram:t"]);
    expect(rows.map((row) => row.decision)).toEqual(["pending", "accepted", "rejected"]);
  });
});
