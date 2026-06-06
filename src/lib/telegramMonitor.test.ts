import { describe, expect, it } from "vitest";
import {
  TELEGRAM_SECRET_UNCHANGED,
  normalizeTelegramMonitorConfig,
  selectedProjectId,
  telegramChatMappingReducer,
  telegramMonitorConfigToSave,
} from "./telegramMonitor";
import type { TelegramMonitorConfigView } from "./types";

const baseConfig: TelegramMonitorConfigView = {
  path: "/tmp/telegram.yaml",
  exists: true,
  warnings: [],
  telegram: {
    apiId: "123",
    apiHash: "****abcd",
    hasApiHash: true,
    phone: "+8210",
    selfId: null,
  },
  polling: { interval_seconds: 60 },
  chats: [
    {
      chat_id: -100,
      name: "Ops",
      enabled: true,
      priority: "high",
      tags: ["ops"],
      contexts: ["rise-admin"],
      profile: "deep-digest",
    },
  ],
  notification: {
    telegram: {
      botToken: "****wxyz",
      hasBotToken: true,
      chatId: "999",
    },
  },
};

describe("normalizeTelegramMonitorConfig", () => {
  it("preserves masked secrets as unchanged sentinels on save", () => {
    const save = telegramMonitorConfigToSave(normalizeTelegramMonitorConfig(baseConfig));
    expect(save.telegram.apiHash).toBe(TELEGRAM_SECRET_UNCHANGED);
    expect(save.notification.telegram.botToken).toBe(TELEGRAM_SECRET_UNCHANGED);
  });

  it("normalizes null polling interval to the fallback", () => {
    const normalized = normalizeTelegramMonitorConfig({
      ...baseConfig,
      polling: { interval_seconds: null },
    });
    expect(normalized.polling.interval_seconds).toBe(60);
  });

  it("serializes cleared existing secrets as empty strings", () => {
    const save = telegramMonitorConfigToSave({
      ...baseConfig,
      telegram: {
        ...baseConfig.telegram,
        apiHash: null,
        hasApiHash: false,
      },
      notification: {
        telegram: {
          ...baseConfig.notification.telegram,
          botToken: null,
          hasBotToken: false,
        },
      },
    });
    expect(save.telegram.apiHash).toBe("");
    expect(save.notification.telegram.botToken).toBe("");
  });

  it("coerces contexts and keeps the first selected project", () => {
    const normalized = normalizeTelegramMonitorConfig({
      ...baseConfig,
      chats: [{ ...baseConfig.chats[0], contexts: [" rise-admin ", "rise-admin", ""] }],
    });
    expect(normalized.chats[0].contexts).toEqual(["rise-admin"]);
    expect(selectedProjectId(normalized.chats[0])).toBe("rise-admin");
  });
});

describe("telegramChatMappingReducer", () => {
  it("sets and clears a project immutably", () => {
    const next = telegramChatMappingReducer(baseConfig.chats, {
      type: "setProject",
      chatId: -100,
      projectId: "oda-koica-tiu",
    });
    expect(next).not.toBe(baseConfig.chats);
    expect(next[0].contexts).toEqual(["oda-koica-tiu"]);
    expect(baseConfig.chats[0].contexts).toEqual(["rise-admin"]);

    const cleared = telegramChatMappingReducer(next, {
      type: "setProject",
      chatId: -100,
      projectId: "",
    });
    expect(cleared[0].contexts).toEqual([]);
  });

  it("adds and removes rows", () => {
    const added = telegramChatMappingReducer([], { type: "add" });
    expect(added).toHaveLength(1);
    expect(added[0].enabled).toBe(true);
    expect(telegramChatMappingReducer(added, { type: "remove", chatId: added[0].chat_id })).toEqual([]);
  });
});
