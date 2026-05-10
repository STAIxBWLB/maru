import { describe, expect, it } from "vitest";
import { buildCommsFeedRows } from "./comms";

describe("buildCommsFeedRows", () => {
  it("merges provider rows newest first and preserves decisions", () => {
    const rows = buildCommsFeedRows({
      gmail: [
        {
          message: {
            id: "g:thread",
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

    expect(rows.map((row) => row.key)).toEqual(["outlook:o", "gmail:g:thread", "telegram:t"]);
    expect(rows.map((row) => row.id)).toEqual(["o", "g:thread", "t"]);
    expect(rows.map((row) => row.decision)).toEqual(["pending", "accepted", "rejected"]);
  });

  it("keeps raw provider ids separate from render keys", () => {
    const rows = buildCommsFeedRows({
      gmail: [
        {
          message: {
            id: "provider:id:with:colons",
            from: "g@example.com",
            subject: "Gmail",
            date: "2026-05-10T01:00:00Z",
          },
          decision: "pending",
        },
      ],
      outlook: [],
      telegram: [],
    });

    expect(rows[0].key).toBe("gmail:provider:id:with:colons");
    expect(rows[0].id).toBe("provider:id:with:colons");
  });

  it("keeps empty provider titles for the rendering layer to localize", () => {
    const rows = buildCommsFeedRows({
      gmail: [
        {
          message: {
            id: "g",
            from: "g@example.com",
            subject: "",
            date: "2026-05-10T01:00:00Z",
          },
          decision: "pending",
        },
      ],
      outlook: [],
      telegram: [
        {
          message: {
            id: "t",
            chatId: "42",
            chatTitle: "",
            sender: "Lee",
            text: "message",
            date: "2026-05-10T00:30:00Z",
            permalink: null,
          },
          decision: "pending",
        },
      ],
    });

    expect(rows.map((row) => row.title)).toEqual(["", ""]);
  });
});
