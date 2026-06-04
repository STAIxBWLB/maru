import type { CommsProvider } from "./comms";
import type { InboxRuntimeConfig, InboxSourceRun } from "./types";

/**
 * Source-of-truth mapping for the Messages dashboard. The dashboard is keyed by
 * inbox CHANNEL (gws/mso/telegram/kakao) because processing, processed items,
 * and sync cursors are all channel-keyed. The legacy comms feed used provider
 * names (gmail/outlook/telegram) — `CHANNEL_TO_COMMS_PROVIDER` bridges the two.
 */
export type InboxSourceChannel = "gws" | "mso" | "telegram" | "kakao";

/** Display order for source channels in the dashboard. */
export const INBOX_SOURCE_CHANNELS: InboxSourceChannel[] = ["gws", "mso", "telegram", "kakao"];

/** i18n key per channel (resolve with `t(...)`; never hardcode the label). */
export const SOURCE_LABEL_KEY: Record<InboxSourceChannel, string> = {
  gws: "inboxSource.label.gws",
  mso: "inboxSource.label.mso",
  telegram: "inboxSource.label.telegram",
  kakao: "inboxSource.label.kakao",
};

/**
 * Legacy comms-provider bridge. `kakao` has no `CommsProvider` (processing-only,
 * no live triage feed), so it is intentionally absent.
 */
export const CHANNEL_TO_COMMS_PROVIDER: Partial<Record<InboxSourceChannel, CommsProvider>> = {
  gws: "gmail",
  mso: "outlook",
  telegram: "telegram",
};

const SOURCE_CHANNEL_SET = new Set<string>(INBOX_SOURCE_CHANNELS);
const ALL_SOURCE_VALUE_BASE = "__all_sources__";

export function isInboxSourceChannel(channel: string): channel is InboxSourceChannel {
  return SOURCE_CHANNEL_SET.has(channel);
}

export function allSourceSelectValue(sources: readonly string[]): string {
  const sourceSet = new Set(sources);
  if (!sourceSet.has(ALL_SOURCE_VALUE_BASE)) return ALL_SOURCE_VALUE_BASE;
  let suffix = 1;
  let candidate = `${ALL_SOURCE_VALUE_BASE}:${suffix}`;
  while (sourceSet.has(candidate)) {
    suffix += 1;
    candidate = `${ALL_SOURCE_VALUE_BASE}:${suffix}`;
  }
  return candidate;
}

/**
 * Enumerate the dashboard's source channels from the workspace inbox config:
 * channels that are known provider sources (not local file drops), in display
 * order. Falls back to the full default list when none are configured.
 */
export function enumerateSourceChannels(config: InboxRuntimeConfig | null | undefined): InboxSourceChannel[] {
  const channels = config?.channels;
  if (!channels) return [...INBOX_SOURCE_CHANNELS];
  const present = INBOX_SOURCE_CHANNELS.filter((channel) => {
    const entry = channels[channel];
    return entry != null && entry.provider !== "local";
  });
  return present.length > 0 ? present : [...INBOX_SOURCE_CHANNELS];
}

export function sourceDropPath(config: InboxRuntimeConfig, key: string): string {
  const configured = config.channels?.[key]?.drop_paths?.[0];
  if (configured) return configured;
  const dropRoot = config.paths.drop.replace(/\/+$/, "");
  return dropRoot ? `${dropRoot}/${key}` : key;
}

export function inboxRootPath(config: InboxRuntimeConfig): string {
  return trimTrailingPathSlashes(config.root) || ".";
}

export function sourceFolderPath(config: InboxRuntimeConfig, key: string): string {
  return joinInboxPath(inboxRootPath(config), sourceDropPath(config, key));
}

function joinInboxPath(root: string, child: string): string {
  const left = trimTrailingPathSlashes(root);
  const right = child.replace(/^\/+/, "");
  if (!right) return left || ".";
  if (!left) return right;
  if (left === "/") return `/${right}`;
  return `${left}/${right}`;
}

function trimTrailingPathSlashes(path: string): string {
  const trimmed = path.replace(/\/+$/, "");
  if (trimmed.length > 0) return trimmed;
  return path.startsWith("/") ? "/" : "";
}

/** Index source runs by channel for O(1) lookup in the dashboard. */
export function sourceRunByChannel(runs: InboxSourceRun[]): Map<string, InboxSourceRun> {
  const map = new Map<string, InboxSourceRun>();
  for (const run of runs) map.set(run.channel, run);
  return map;
}
