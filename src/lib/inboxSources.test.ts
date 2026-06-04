import { describe, expect, it } from "vitest";
import {
  allSourceSelectValue,
  inboxRootPath,
  sourceDropPath,
  sourceFolderPath,
} from "./inboxSources";
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

describe("allSourceSelectValue", () => {
  it("uses the base sentinel when no source collides", () => {
    expect(allSourceSelectValue(["gws", "kakao"])).toBe("__all_sources__");
  });

  it("derives a non-colliding sentinel when a channel uses the base value", () => {
    expect(allSourceSelectValue(["__all_sources__", "__all_sources__:1", "kakao"])).toBe(
      "__all_sources__:2",
    );
  });
});

describe("sourceFolderPath", () => {
  it("joins tilde inbox roots with channel drop paths without stripping tilde", () => {
    const config = runtimeConfig();
    config.root = "~/workspace/work/inbox";
    config.channels.kakao = {
      provider: "kakao",
      skill: "io-kakao",
      kind: "bundle",
      drop_paths: ["drop/kakao"],
      dedupe: "sha256",
    };

    expect(inboxRootPath(config)).toBe("~/workspace/work/inbox");
    expect(sourceFolderPath(config, "kakao")).toBe("~/workspace/work/inbox/drop/kakao");
  });

  it("trims duplicate boundary slashes while preserving absolute roots", () => {
    const config = runtimeConfig();
    config.root = "/Users/yj.lee/workspace/work/inbox/";
    config.channels.gws = {
      provider: "gws",
      skill: "io-gws",
      kind: "bundle",
      drop_paths: ["/drop/gws/"],
      dedupe: "provider-native",
    };

    expect(sourceFolderPath(config, "gws")).toBe("/Users/yj.lee/workspace/work/inbox/drop/gws/");
  });

  it("falls back to a relative inbox root and configured drop root", () => {
    const config = runtimeConfig();
    config.root = "inbox/";
    config.paths.drop = "drop/";

    expect(sourceFolderPath(config, "telegram")).toBe("inbox/drop/telegram");
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
