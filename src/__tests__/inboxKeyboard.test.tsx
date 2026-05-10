import { describe, expect, it } from "vitest";
import {
  buildInboxFeedRowKeys,
  buildInboxProcessPrompt,
  countInboxSources,
  filterProcessedItems,
  firstPendingInboxKey,
  inboxEntryProcessPath,
  isInboxProcessMission,
  nextInboxFocusKey,
  toggleInboxSelectionKeys,
} from "../lib/inbox";
import type { InboxEntry, InboxProcessedItem, InboxRuntimeConfig, MissionRecord } from "../lib/types";

describe("inbox keyboard helpers", () => {
  const keys = ["entry:a", "file:a", "file:b", "file:c"];

  it("finds the first pending local inbox row", () => {
    expect(
      firstPendingInboxKey([
        { key: "file:a", decision: "accepted" },
        { key: "file:b", decision: "pending" },
      ]),
    ).toBe("file:b");
  });

  it("moves focus with clamped arrow navigation", () => {
    expect(nextInboxFocusKey(keys, null, 1)).toBe("entry:a");
    expect(nextInboxFocusKey(keys, "entry:a", 1)).toBe("file:a");
    expect(nextInboxFocusKey(keys, "file:c", 1)).toBe("file:c");
    expect(nextInboxFocusKey(keys, "entry:a", -1)).toBe("entry:a");
  });

  it("toggles command-click style selection", () => {
    const selected = toggleInboxSelectionKeys(keys, new Set(), "file:a", null, false);
    expect([...selected]).toEqual(["file:a"]);
    expect([...toggleInboxSelectionKeys(keys, selected, "file:a", "file:a", false)]).toEqual([]);
  });

  it("adds a shift range without dropping existing selections", () => {
    const selected = toggleInboxSelectionKeys(
      keys,
      new Set(["entry:a"]),
      "file:c",
      "file:b",
      true,
    );
    expect([...selected]).toEqual(["entry:a", "file:b", "file:c"]);
  });

  it("keeps configured and staged file row order without collapse filtering", () => {
    expect(
      buildInboxFeedRowKeys({
        entries: [{ id: "configured-a" }, { id: "configured-b" }],
        files: [{ item: { id: "file-a" } }],
      }),
    ).toEqual(["entry:configured-a", "entry:configured-b", "file:file-a"]);
  });

  it("counts inbox sources in one pass for filter chips", () => {
    const counts = countInboxSources([
      { item: { source: "gmail" } },
      { item: { source: "gmail" } },
      { item: { source: "kakao" } },
    ]);
    expect(counts.get("gmail")).toBe(2);
    expect(counts.get("kakao")).toBe(1);
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

  it("filters processed item history by status and search text", () => {
    const items = [
      processedItem("done", "a", "kakao", "Project A", "reference", "alpha summary"),
      processedItem("failed", "b", "gws", "Project B", "task", "beta summary"),
    ];

    expect(filterProcessedItems(items, "done", "").map((item) => item.id)).toEqual(["a"]);
    expect(filterProcessedItems(items, "all", "project b").map((item) => item.id)).toEqual(["b"]);
    expect(filterProcessedItems(items, "all", "reference").map((item) => item.id)).toEqual(["a"]);
  });

  it("recognizes inbox-process mission metadata", () => {
    expect(isInboxProcessMission(mission("inboxProcess"))).toBe(true);
    expect(isInboxProcessMission(mission("other"))).toBe(false);
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
      auto_refresh_ttl_seconds: 300,
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

function processedItem(
  status: InboxProcessedItem["status"],
  id: string,
  channel: string,
  project: string,
  classification: string,
  summaryPreview: string,
): InboxProcessedItem {
  return {
    id,
    status,
    channel,
    provider: channel,
    kind: "bundle",
    receivedAt: `2026-05-10T00:00:0${id === "a" ? "2" : "1"}Z`,
    itemDir: `/work/inbox/items/${status}/${id}`,
    manifestPath: `/work/inbox/items/${status}/${id}/manifest.yaml`,
    summaryPath: `/work/inbox/items/${status}/${id}/summary.md`,
    routePath: `/work/inbox/items/${status}/${id}/route.md`,
    extractedPath: `/work/inbox/items/${status}/${id}/extracted.md`,
    title: `${id} title`,
    description: null,
    project,
    classification,
    routeStatus: "routed",
    summaryPreview,
    rawFileCount: 1,
    updatedAt: null,
    error: null,
  };
}

function mission(origin: string): MissionRecord {
  return {
    id: "ai-test",
    kind: "skill",
    startedAt: "2026-05-10T00:00:00Z",
    lastOutputAt: "2026-05-10T00:00:01Z",
    status: "running",
    exitCode: null,
    outputLogPath: null,
    metadata: { origin },
  };
}
