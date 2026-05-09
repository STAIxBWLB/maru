import { describe, expect, it } from "vitest";
import {
  buildInboxProcessPrompt,
  firstPendingInboxKey,
  inboxEntryProcessPath,
  nextInboxFocusKey,
  toggleInboxSelectionKeys,
} from "../lib/inbox";
import type { InboxEntry, InboxRuntimeConfig } from "../lib/types";

describe("inbox keyboard helpers", () => {
  const keys = ["file:a", "file:b", "gmail:c", "gmail:d"];

  it("finds the first pending row across file and gmail keys", () => {
    expect(
      firstPendingInboxKey([
        { key: "file:a", decision: "accepted" },
        { key: "gmail:c", decision: "pending" },
      ]),
    ).toBe("gmail:c");
  });

  it("moves focus with clamped arrow navigation", () => {
    expect(nextInboxFocusKey(keys, null, 1)).toBe("file:a");
    expect(nextInboxFocusKey(keys, "file:a", 1)).toBe("file:b");
    expect(nextInboxFocusKey(keys, "gmail:d", 1)).toBe("gmail:d");
    expect(nextInboxFocusKey(keys, "file:a", -1)).toBe("file:a");
  });

  it("toggles command-click style selection", () => {
    const selected = toggleInboxSelectionKeys(keys, new Set(), "file:b", null, false);
    expect([...selected]).toEqual(["file:b"]);
    expect([...toggleInboxSelectionKeys(keys, selected, "file:b", "file:b", false)]).toEqual([]);
  });

  it("adds a shift range without dropping existing selections", () => {
    const selected = toggleInboxSelectionKeys(
      keys,
      new Set(["file:a"]),
      "gmail:d",
      "file:b",
      true,
    );
    expect([...selected]).toEqual(["file:a", "file:b", "gmail:c", "gmail:d"]);
  });

  it("uses manifest paths for pending item process context", () => {
    const entry = inboxEntry("pendingItem", "items/pending/a/manifest.yaml");
    expect(inboxEntryProcessPath(entry)).toBe("/work/inbox/items/pending/a/manifest.yaml");
  });

  it("builds inbox-process prompt with selected files and naming settings", () => {
    const config = runtimeConfig();
    const prompt = buildInboxProcessPrompt({
      channel: "kakao",
      config,
      entries: [
        inboxEntry("dropFile", "drop/kakao/messages/chat.txt"),
        inboxEntry("pendingItem", "items/pending/a/manifest.yaml"),
      ],
    });

    expect(prompt).toContain("inbox-process kakao");
    expect(prompt).toContain("/work/inbox/drop/kakao/messages/chat.txt");
    expect(prompt).toContain("/work/inbox/items/pending/a/manifest.yaml");
    expect(prompt).toContain('"summary_file": "summary.md"');
    expect(prompt).toContain("Do not fetch providers");
  });
});

function inboxEntry(kind: InboxEntry["kind"], relPath: string): InboxEntry {
  const path = `/work/inbox/${relPath}`;
  return {
    id: relPath,
    kind,
    path: kind === "pendingItem" ? path.replace(/\/manifest\.yaml$/, "") : path,
    relPath: `inbox/${relPath}`,
    title: "chat.txt",
    channel: "kakao",
    sourceKind: "message",
    dropPath: kind === "dropFile" ? "drop/kakao" : null,
    configuredRoot: "/work/inbox",
    itemId: kind === "pendingItem" ? "a" : null,
    status: kind === "pendingItem" ? "pending" : "drop",
    manifestPath: kind === "pendingItem" ? path : null,
    summaryPath: null,
    routePath: null,
    sizeBytes: 4,
    receivedAt: null,
  };
}

function runtimeConfig(): InboxRuntimeConfig {
  return {
    root: "inbox",
    schema_version: 1,
    paths: {
      drop: "drop",
      items: "items",
      pending: "items/pending",
      done: "items/done",
      failed: "items/failed",
      duplicate: "items/duplicate",
      state: "_state",
      receipts: "_state/index.jsonl",
    },
    naming: {
      item_id_template: "{date}-{channel}-{slug}",
      raw_dir: "raw",
      manifest_file: "manifest.yaml",
      extracted_file: "extracted.md",
      summary_file: "summary.md",
      route_file: "route.md",
    },
    file_drop: {
      channel: "incoming",
      drop_path: "drop/incoming",
      operation: "copy",
    },
    gmail: {
      enabled: true,
      scan_window_days: 14,
      max_results: 20,
      unread_only: true,
      query: "",
      gws_path: null,
    },
    dedupe: {},
    channels: {},
    processing: {},
    hooks: {},
  };
}
