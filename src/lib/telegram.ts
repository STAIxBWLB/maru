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
    monitorConfigPath: settings.monitorConfigPath,
    legacyAutoDrop: settings.legacyAutoDrop,
  };
}

export function telegramLoginCommand(settings: CommsSettings["telegram"]): {
  command: string | null;
  args: string[];
} {
  const python = settings.pythonPath?.trim() || "$HOME/.anchor/env/.venv/bin/python";
  const script = settings.scriptPath?.trim()
    ? settings.scriptPath.replace(/telegram_monitor\.py$/, "auth.py")
    : "$HOME/.anchor/skills/_builtin/skills/io-telegram/scripts/auth.py";
  const session = settings.sessionFile?.trim() || "$HOME/.anchor/telegram/monitor.session";
  const configArg = settings.monitorConfigPath?.trim()
    ? ` --config-file ${quoteShell(settings.monitorConfigPath.trim())}`
    : "";
  return {
    command: null,
    args: [
      "-lc",
      `exec ${quoteShell(python)} ${quoteShell(script)} --session-file ${quoteShell(session)}${configArg}`,
    ],
  };
}

export function gwsAuthCommand(gwsPath?: string | null): {
  command: string | null;
  args: string[];
} {
  const gws = gwsPath?.trim() || "gws";
  return {
    command: null,
    args: ["-lc", `exec ${quoteShell(gws)} auth`],
  };
}

export function m365LoginCommand(m365Path?: string | null): {
  command: string | null;
  args: string[];
} {
  const m365 = m365Path?.trim() || "m365";
  return {
    command: null,
    args: ["-lc", `exec ${quoteShell(m365)} login`],
  };
}

export function isTelegramMonitorConfigOutsideAnchor(
  path: string | null | undefined,
): boolean {
  const trimmed = path?.trim();
  if (!trimmed) return false;
  if (trimmed === "~/.anchor" || trimmed.startsWith("~/.anchor/")) return false;
  if (trimmed === "$HOME/.anchor" || trimmed.startsWith("$HOME/.anchor/")) return false;
  if (trimmed.endsWith("/.anchor") || trimmed.includes("/.anchor/")) return false;
  return true;
}

/** Escape shell-active characters inside a double-quoted string body. */
function escapeDoubleQuoted(value: string): string {
  return value.replace(/([\\"$`])/g, "\\$1");
}

function quoteShell(value: string): string {
  // ~/ and $HOME/ prefixes stay double-quoted so the shell expands $HOME;
  // everything after the prefix is user-controlled and must be escaped.
  if (value.startsWith("~/")) return `"$HOME/${escapeDoubleQuoted(value.slice(2))}"`;
  if (value.startsWith("$HOME/")) return `"$HOME/${escapeDoubleQuoted(value.slice(6))}"`;
  return `'${value.replace(/'/g, "'\\''")}'`;
}
