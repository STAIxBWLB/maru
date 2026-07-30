// KakaoTalk relay ("maru-kakao-relay") shared types and pure helpers.
//
// The relay daemon runs on a separate Mac: it drops captured KakaoTalk
// message envelopes into a Dropbox-synced folder and consumes send requests
// from it. The Tauri commands (`read_kakao_relay_status`,
// `read_kakao_relay_messages`, `stage_kakao_relay_new`, `enqueue_kakao_send`,
// `read_kakao_send_results`) wrap that folder; these types mirror their
// FIXED response contract (camelCase serde).

import type { ProviderAuthStatus } from "./types";

export interface KakaoRelayRoom {
  name: string;
  slug: string;
  managed: boolean;
  sendAllowed: boolean;
  priority: number;
  messageDays: number;
}

export interface KakaoRelayStatus {
  configured: boolean;
  root: string | null;
  state: string;
  heartbeat: string | null;
  heartbeatAgeSeconds: number | null;
  stale: boolean;
  lastError: string | null;
  rooms: KakaoRelayRoom[];
}

export interface KakaoRelayAttachment {
  type: string;
  name: string;
  path: string;
}

/** Inner `message` payload of a `kakao-msg/v1` envelope (snake_case on the wire). */
export interface KakaoRelayMessage {
  id: string;
  chat: string;
  room_slug: string;
  sender: string;
  is_me: boolean;
  text: string;
  sent_at: string;
  captured_at: string;
  engine: string;
  attachments: KakaoRelayAttachment[];
}

export interface KakaoRelayEnvelope {
  schema: string;
  provider: string;
  kind: string;
  message: KakaoRelayMessage;
}

export interface KakaoStageResult {
  stagedMessages: number;
  stagedMedia: number;
  skipped: number;
  errors: string[];
  perRoom: Record<string, number>;
}

export interface KakaoEnqueueResult {
  id: string;
  path: string;
}

export interface KakaoSendResult {
  id: string;
  status: string;
  ok: boolean | null;
  error: string | null;
}

export type KakaoRelayLiveness = "ok" | "paused" | "stale" | "unreachable" | "unconfigured";

/** Collapse the raw relay status into one liveness bucket for the UI. */
export function relayLiveness(status: KakaoRelayStatus | null | undefined): KakaoRelayLiveness {
  if (!status || !status.configured) return "unconfigured";
  if (status.state === "unreachable") return "unreachable";
  if (status.state === "paused") return "paused";
  if (status.stale) return "stale";
  if (status.state === "running") return "ok";
  return "unreachable";
}

export interface KakaoEnvelopePreview {
  sender: string;
  text: string;
  sentAt: string | null;
}

/** Extract a display preview from an envelope, tolerating partial data. */
export function envelopePreview(
  envelope: KakaoRelayEnvelope | null | undefined,
): KakaoEnvelopePreview {
  const message = (envelope?.message ?? {}) as Partial<KakaoRelayMessage>;
  return {
    sender: typeof message.sender === "string" ? message.sender : "",
    text: typeof message.text === "string" ? message.text : "",
    sentAt: typeof message.sent_at === "string" ? message.sent_at : null,
  };
}

/** Human-readable heartbeat age ("just now", "5m ago", "2h ago"). */
export function formatHeartbeatAge(seconds: number | null | undefined): string | null {
  if (seconds == null || !Number.isFinite(seconds) || seconds < 0) return null;
  if (seconds < 60) return "just now";
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 48) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  return `${days}d ago`;
}

/** Map relay liveness onto the shared comms auth-status badge model. */
export function kakaoRelayAuthStatus(status: KakaoRelayStatus): ProviderAuthStatus {
  const liveness = relayLiveness(status);
  const state =
    liveness === "ok"
      ? "ok"
      : liveness === "paused"
        ? "paused"
        : liveness === "stale"
          ? "stale"
          : "cli_missing";
  return {
    provider: "kakao",
    state,
    detail: status.lastError ?? formatHeartbeatAge(status.heartbeatAgeSeconds),
    cliPath: status.root,
    account: null,
  };
}
