import type { InboxDecision } from "./inbox";
import type { TelegramFetchOptions, TelegramMessage } from "./types";
import type { CommsSettings } from "./settings";

export interface TelegramMessageState {
  message: TelegramMessage;
  decision: InboxDecision;
}

export function buildTelegramMessageStates(
  messages: TelegramMessage[],
  decisionsById: Map<string, InboxDecision>,
): TelegramMessageState[] {
  return messages.map((message) => ({
    message,
    decision: decisionsById.get(message.id) ?? "pending",
  }));
}

export function telegramFetchOptions(
  workPath: string | null,
  settings: CommsSettings["telegram"],
): TelegramFetchOptions {
  return {
    workPath,
    max: settings.maxResults,
    pythonPath: settings.pythonPath,
    scriptPath: settings.scriptPath,
    sessionFile: settings.sessionFile,
    legacyAutoDrop: settings.legacyAutoDrop,
  };
}

export function telegramLoginCommand(settings: CommsSettings["telegram"]): {
  command: string;
  args: string[];
} {
  const python = settings.pythonPath?.trim() || "$HOME/.anchor/env/.venv/bin/python";
  const script = settings.scriptPath?.trim()
    ? settings.scriptPath.replace(/telegram_monitor\.py$/, "auth.py")
    : "$HOME/.anchor/skills/_builtin/skills/io-telegram/scripts/auth.py";
  const session = settings.sessionFile?.trim() || "$HOME/.anchor/telegram/monitor.session";
  return {
    command: "/bin/zsh",
    args: [
      "-lc",
      `exec ${quoteShell(python)} ${quoteShell(script)} --session-file ${quoteShell(session)}`,
    ],
  };
}

function quoteShell(value: string): string {
  if (value.startsWith("$HOME/")) return `"${value}"`;
  return `'${value.replace(/'/g, "'\\''")}'`;
}
