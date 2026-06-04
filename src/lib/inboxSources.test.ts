import { describe, expect, it } from "vitest";
import { sourceDropPath } from "./inboxSources";
import type { InboxRuntimeConfig } from "./types";

describe("sourceDropPath", () => {
  it("uses the configured channel drop path when present", () => {
    const config = runtimeConfig();
    config.channels.kakao = {
      provider: "kakao",
      skill: "io-kakao",
      kind: "bundle",
      drop_paths: ["custom/kakao-drop"],
      dedupe: "sha256",
    };

    expect(sourceDropPath(config, "kakao")).toBe("custom/kakao-drop");
  });

  it("falls back to the inbox drop root plus source key", () => {
    expect(sourceDropPath(runtimeConfig(), "telegram")).toBe("drop/telegram");
  });
});

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
