import type { GmailMessage, InboxGmailConfig } from "./types";
import type { InboxDecision } from "./inbox";

export interface GmailMessageState {
  message: GmailMessage;
  decision: InboxDecision;
}

export function buildGmailMessageStates(
  messages: GmailMessage[],
  decisionsById: Map<string, InboxDecision>,
): GmailMessageState[] {
  return messages.map((message) => ({
    message,
    decision: decisionsById.get(message.id) ?? "pending",
  }));
}

/** Strip RFC5322 angle-bracket form `Display Name <addr@host>` down to a
 *  short label. Falls back to the raw value when no display name is
 *  present so OAuth-issued senders like `no-reply@plaud.ai` still
 *  render readably. */
export function shortFrom(raw: string): string {
  const trimmed = raw.trim();
  if (!trimmed) return "";
  const match = trimmed.match(/^"?([^"<]+?)"?\s*<[^>]+>$/);
  if (match) return match[1].trim();
  return trimmed;
}

export function buildGmailScanQuery(config: InboxGmailConfig): string | null {
  const explicit = config.query.trim();
  if (explicit) return explicit;

  const terms: string[] = [];
  if (config.unread_only) terms.push("is:unread");
  const days = Math.floor(Number(config.scan_window_days));
  if (Number.isFinite(days) && days > 0) terms.push(`newer_than:${days}d`);
  return terms.length > 0 ? terms.join(" ") : null;
}

export function normalizeGmailScanLimit(value: number): number {
  if (!Number.isFinite(value)) return 20;
  return Math.max(1, Math.min(200, Math.floor(value)));
}

export function normalizeGmailRefreshTtl(value: number): number {
  if (!Number.isFinite(value)) return 300;
  return Math.max(0, Math.min(86400, Math.floor(value)));
}

export interface GmailRefreshPolicyInput {
  enabled: boolean;
  force: boolean;
  loading: boolean;
  now: number;
  lastFetchedAt: number | null;
  ttlSeconds: number;
  query: string | null;
  previousQuery: string | null;
  max: number;
  previousMax: number | null;
}

export type GmailRefreshPolicyDecision =
  | "start"
  | "disabled"
  | "loading"
  | "ttl";

export function gmailRefreshPolicy({
  enabled,
  force,
  loading,
  now,
  lastFetchedAt,
  ttlSeconds,
  query,
  previousQuery,
  max,
  previousMax,
}: GmailRefreshPolicyInput): GmailRefreshPolicyDecision {
  if (!enabled) return "disabled";
  if (force) return "start";
  if (loading) return "loading";
  if (lastFetchedAt === null) return "start";
  if (query !== previousQuery || max !== previousMax) return "start";
  const ttlMs = normalizeGmailRefreshTtl(ttlSeconds) * 1000;
  if (ttlMs === 0) return "start";
  return now - lastFetchedAt >= ttlMs ? "start" : "ttl";
}

export function shouldApplyGmailRefreshResult(
  requestId: number,
  latestRequestId: number,
): boolean {
  return requestId === latestRequestId;
}
