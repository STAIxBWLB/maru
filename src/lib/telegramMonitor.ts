import type {
  TelegramMonitorChat,
  TelegramMonitorConfigSave,
  TelegramMonitorConfigView,
} from "./types";

export const TELEGRAM_SECRET_UNCHANGED = "__ANCHOR_KEEP_SECRET__";

export type TelegramChatMappingAction =
  | { type: "add"; chat?: Partial<TelegramMonitorChat> }
  | { type: "remove"; chatId: number }
  | { type: "setProject"; chatId: number; projectId: string | null }
  | { type: "toggleEnabled"; chatId: number; enabled: boolean }
  | { type: "setTags"; chatId: number; tags: string[] | string }
  | { type: "setPriority"; chatId: number; priority: string | null }
  | { type: "setProfile"; chatId: number; profile: string | null }
  | { type: "update"; chatId: number; patch: Partial<TelegramMonitorChat> };

export function normalizeTelegramMonitorConfig(
  config: TelegramMonitorConfigView | null | undefined,
): TelegramMonitorConfigView {
  return {
    path: config?.path ?? "",
    exists: Boolean(config?.exists),
    warnings: Array.isArray(config?.warnings) ? config.warnings.filter(isString) : [],
    telegram: {
      apiId: stringOrNull(config?.telegram?.apiId),
      apiHash: config?.telegram?.hasApiHash
        ? (stringOrNull(config?.telegram?.apiHash) ?? TELEGRAM_SECRET_UNCHANGED)
        : stringOrNull(config?.telegram?.apiHash),
      hasApiHash: Boolean(config?.telegram?.hasApiHash),
      phone: stringOrNull(config?.telegram?.phone),
      selfId: stringOrNull(config?.telegram?.selfId),
    },
    polling: {
      ...(config?.polling ?? {}),
      interval_seconds: normalizeOptionalInteger(config?.polling?.interval_seconds, 60),
    },
    chats: Array.isArray(config?.chats)
      ? config.chats.map(normalizeTelegramChat).filter((chat) => chat.chat_id !== 0)
      : [],
    notification: {
      telegram: {
        botToken: config?.notification?.telegram?.hasBotToken
          ? (stringOrNull(config?.notification?.telegram?.botToken) ?? TELEGRAM_SECRET_UNCHANGED)
          : stringOrNull(config?.notification?.telegram?.botToken),
        hasBotToken: Boolean(config?.notification?.telegram?.hasBotToken),
        chatId: stringOrNull(config?.notification?.telegram?.chatId),
      },
    },
  };
}

export function telegramMonitorConfigToSave(
  config: TelegramMonitorConfigView,
): TelegramMonitorConfigSave {
  const normalized = normalizeTelegramMonitorConfig(config);
  return {
    telegram: {
      apiId: normalized.telegram.apiId,
      apiHash: normalized.telegram.hasApiHash
        ? secretForSave(normalized.telegram.apiHash)
        : "",
      phone: normalized.telegram.phone,
      selfId: normalized.telegram.selfId,
    },
    polling: normalized.polling,
    chats: normalized.chats,
    notification: {
      telegram: {
        botToken: normalized.notification.telegram.hasBotToken
          ? secretForSave(normalized.notification.telegram.botToken)
          : "",
        chatId: normalized.notification.telegram.chatId,
      },
    },
  };
}

export function telegramChatMappingReducer(
  chats: TelegramMonitorChat[],
  action: TelegramChatMappingAction,
): TelegramMonitorChat[] {
  switch (action.type) {
    case "add": {
      const chat = normalizeTelegramChat({
        chat_id: action.chat?.chat_id ?? nextTemporaryChatId(chats),
        name: action.chat?.name ?? "",
        enabled: action.chat?.enabled ?? true,
        priority: action.chat?.priority ?? "normal",
        tags: action.chat?.tags ?? [],
        contexts: action.chat?.contexts ?? [],
        profile: action.chat?.profile ?? "standard",
        ...(action.chat ?? {}),
      });
      return [...chats, chat];
    }
    case "remove":
      return chats.filter((chat) => chat.chat_id !== action.chatId);
    case "setProject":
      return updateChat(chats, action.chatId, {
        contexts: action.projectId?.trim() ? [action.projectId.trim()] : [],
      });
    case "toggleEnabled":
      return updateChat(chats, action.chatId, { enabled: action.enabled });
    case "setTags":
      return updateChat(chats, action.chatId, {
        tags: normalizeTags(action.tags),
      });
    case "setPriority":
      return updateChat(chats, action.chatId, {
        priority: stringOrNull(action.priority),
      });
    case "setProfile":
      return updateChat(chats, action.chatId, {
        profile: stringOrNull(action.profile),
      });
    case "update":
      return updateChat(chats, action.chatId, action.patch);
    default:
      return chats;
  }
}

export function selectedProjectId(chat: TelegramMonitorChat): string {
  return normalizeStringArray(chat.contexts)[0] ?? "";
}

function updateChat(
  chats: TelegramMonitorChat[],
  chatId: number,
  patch: Partial<TelegramMonitorChat>,
): TelegramMonitorChat[] {
  return chats.map((chat) =>
    chat.chat_id === chatId ? normalizeTelegramChat({ ...chat, ...patch }) : chat,
  );
}

function normalizeTelegramChat(chat: Partial<TelegramMonitorChat>): TelegramMonitorChat {
  return {
    ...chat,
    chat_id: normalizeChatId(chat.chat_id),
    name: stringOrNull(chat.name),
    enabled: chat.enabled !== false,
    priority: stringOrNull(chat.priority),
    tags: normalizeTags(chat.tags ?? []),
    contexts: normalizeStringArray(chat.contexts),
    profile: stringOrNull(chat.profile),
  };
}

function normalizeChatId(value: unknown): number {
  const number = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(number)) return 0;
  return Math.trunc(number);
}

function normalizeTags(value: string[] | string): string[] {
  if (typeof value === "string") {
    return normalizeStringArray(value.split(","));
  }
  return normalizeStringArray(value);
}

function normalizeStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  const out: string[] = [];
  for (const item of value) {
    if (typeof item !== "string") continue;
    const trimmed = item.trim();
    if (trimmed && !out.includes(trimmed)) out.push(trimmed);
  }
  return out;
}

function normalizeOptionalInteger(value: unknown, fallback: number): number {
  if (value === null || value === undefined) return fallback;
  if (typeof value === "string" && value.trim() === "") return fallback;
  const number = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(number)) return fallback;
  return Math.max(30, Math.trunc(number));
}

function stringOrNull(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed ? trimmed : null;
}

function secretForSave(value: string | null): string {
  if (!value || value.startsWith("****")) return TELEGRAM_SECRET_UNCHANGED;
  return value;
}

function isString(value: unknown): value is string {
  return typeof value === "string";
}

function nextTemporaryChatId(chats: TelegramMonitorChat[]): number {
  const min = chats.reduce((lowest, chat) => Math.min(lowest, chat.chat_id), 0);
  return Math.min(-1, min - 1);
}
