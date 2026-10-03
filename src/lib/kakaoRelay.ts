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
  perRoom: Record<string, KakaoStageRoomOutcome>;
}

/** Per-room breakdown of a stage run, as serialized by the Rust side. */
export interface KakaoStageRoomOutcome {
  staged: number;
  skipped: number;
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

export type KakaoRelayLiveness =
  | "ok"
  | "paused"
  | "stale"
  | "unreachable"
  | "unconfigured"
  | "unknown";

// --- Relay operator console (web UI) ----------------------------------------
// The relay daemon serves a plain operator console on its own bind (default
// http://127.0.0.1:8787), independent of the Dropbox sync bus above. Maru
// embeds that console in an iframe and keeps its theme in sync through the
// contract from STAIxBWLB/maru-kakao-relay#68: a `?theme=` query param on
// load plus live `maru-theme` postMessages afterwards.

export const DEFAULT_KAKAO_RELAY_UI_URL = "http://127.0.0.1:8787";

/** Theme names the relay console understands (`?theme=` and postMessage). */
export type KakaoRelayTheme = "light" | "dark" | "system";

export const MARU_THEME_MESSAGE_TYPE = "maru-theme";

export interface MaruThemeMessage {
  type: typeof MARU_THEME_MESSAGE_TYPE;
  theme: KakaoRelayTheme;
}

/** Trim + fall back to the default bind when the stored value is blank. */
export function normalizeKakaoRelayUiUrl(value: unknown): string {
  if (typeof value !== "string") return DEFAULT_KAKAO_RELAY_UI_URL;
  const trimmed = value.trim();
  return trimmed || DEFAULT_KAKAO_RELAY_UI_URL;
}

/** Console URL with the resolved theme appended, or null when the configured
 *  value is not a valid http(s) URL (the UI shows the empty state then). */
export function kakaoRelayUiSrc(
  baseUrl: string,
  theme: KakaoRelayTheme,
): string | null {
  const trimmed = baseUrl.trim();
  if (!trimmed) return null;
  let url: URL;
  try {
    url = new URL(trimmed);
  } catch {
    return null;
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") return null;
  url.searchParams.set("theme", theme);
  return url.toString();
}

/** Live theme-switch message posted to the embedded console (relay contract). */
export function buildMaruThemeMessage(theme: KakaoRelayTheme): MaruThemeMessage {
  return { type: MARU_THEME_MESSAGE_TYPE, theme };
}

// --- Native origin channel + reachability probe ------------------------------
// Two event round-trips keep the native app working without a new Tauri
// command (command isolation stays at its recorded count) and without
// widening the webview CSP (`connect-src` forbids the frontend from
// fetching the console origin directly):
// - KAKAO_RELAY_UI_ORIGIN_EVENT publishes the effective console URL so the
//   external-link navigation guard can exempt exactly its origin (#418).
// - KAKAO_RELAY_UI_PROBE_EVENT / _RESULT_EVENT probe daemon reachability.

export const KAKAO_RELAY_UI_ORIGIN_EVENT = "maru:kakao-relay-ui-origin";
export const KAKAO_RELAY_UI_PROBE_RESULT_EVENT = "maru:kakao-relay-ui-probe-result";
const KAKAO_RELAY_UI_PROBE_EVENT = "maru:kakao-relay-ui-probe";

const isTauriRuntime = (): boolean =>
  typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;

/** Publish the effective console URL for the native navigation guard.
 *  Best effort and a no-op outside Tauri (the guard only exists there). */
export async function publishKakaoRelayUiUrl(url: string): Promise<void> {
  if (!isTauriRuntime()) return;
  try {
    const { emit } = await import("@tauri-apps/api/event");
    await emit(KAKAO_RELAY_UI_ORIGIN_EVENT, url);
  } catch {
    // The localhost default keeps working even if the publish fails.
  }
}

/**
 * no-cors fetch probe: resolves on ANY HTTP response, so a resolved promise
 * means the daemon is listening (whatever the status); a rejection means a
 * transport failure (daemon down, host unreachable). Used in the browser
 * dev shell; the native app probes through Rust (see probeKakaoRelayUi).
 */
export async function probeKakaoRelayUiFetch(
  url: string,
  fetchImpl: typeof fetch = fetch,
  timeoutMs = 4000,
): Promise<boolean> {
  try {
    await fetchImpl(url, {
      mode: "no-cors",
      cache: "no-store",
      signal: AbortSignal.timeout(timeoutMs),
    });
    return true;
  } catch {
    return false;
  }
}

export interface KakaoRelayUiProbeResult {
  url: string;
  ok: boolean;
}

/** Probe the console bind. Native: round-trip through the Rust listener
 *  (the webview CSP blocks a direct fetch). Browser: no-cors fetch. */
export async function probeKakaoRelayUi(url: string, timeoutMs = 4000): Promise<boolean> {
  if (!isTauriRuntime()) return probeKakaoRelayUiFetch(url, fetch, timeoutMs);
  try {
    const { emit, listen } = await import("@tauri-apps/api/event");
    return await new Promise<boolean>((resolve) => {
      let settled = false;
      let unlisten: (() => void) | null = null;
      const finish = (ok: boolean) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        unlisten?.();
        resolve(ok);
      };
      const timer = setTimeout(() => finish(false), timeoutMs);
      void listen<KakaoRelayUiProbeResult>(
        KAKAO_RELAY_UI_PROBE_RESULT_EVENT,
        (event) => {
          if (event.payload.url === url) finish(event.payload.ok);
        },
      )
        .then((off) => {
          if (settled) {
            off();
            return;
          }
          unlisten = off;
          // Emit only after the listener is registered so a fast loopback
          // result cannot race ahead of it.
          void emit(KAKAO_RELAY_UI_PROBE_EVENT, url).catch(() => finish(false));
        })
        .catch(() => finish(false));
    });
  } catch {
    return false;
  }
}

/** Collapse the raw relay status into one liveness bucket for the UI. */
export function relayLiveness(status: KakaoRelayStatus | null | undefined): KakaoRelayLiveness {
  if (!status || !status.configured) return "unconfigured";
  if (status.state === "unreachable") return "unreachable";
  if (status.state === "paused") return "paused";
  if (status.stale) return "stale";
  if (status.state === "running") return "ok";
  return "unknown";
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
          : liveness === "unknown"
            ? "unknown"
            : "cli_missing";
  return {
    provider: "kakao",
    state,
    detail: status.lastError ?? formatHeartbeatAge(status.heartbeatAgeSeconds),
    cliPath: status.root,
    account: null,
  };
}
