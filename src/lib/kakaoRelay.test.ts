import { describe, expect, it } from "vitest";
import {
  envelopePreview,
  formatHeartbeatAge,
  kakaoRelayAuthStatus,
  relayLiveness,
  type KakaoRelayEnvelope,
  type KakaoRelayStatus,
} from "./kakaoRelay";

function status(partial: Partial<KakaoRelayStatus>): KakaoRelayStatus {
  return {
    configured: true,
    root: "/relay",
    state: "running",
    heartbeat: "2026-07-30T00:00:00Z",
    heartbeatAgeSeconds: 45,
    stale: false,
    lastError: null,
    rooms: [],
    ...partial,
  };
}

describe("relayLiveness", () => {
  it("maps the raw status onto liveness buckets", () => {
    expect(relayLiveness(null)).toBe("unconfigured");
    expect(relayLiveness(undefined)).toBe("unconfigured");
    expect(relayLiveness(status({ configured: false }))).toBe("unconfigured");
    expect(relayLiveness(status({ state: "unreachable" }))).toBe("unreachable");
    expect(relayLiveness(status({ state: "paused" }))).toBe("paused");
    expect(relayLiveness(status({ state: "paused", stale: true }))).toBe("paused");
    expect(relayLiveness(status({ stale: true }))).toBe("stale");
    expect(relayLiveness(status({}))).toBe("ok");
    expect(relayLiveness(status({ state: "starting" }))).toBe("unreachable");
  });
});

describe("formatHeartbeatAge", () => {
  it("formats recent heartbeats", () => {
    expect(formatHeartbeatAge(0)).toBe("just now");
    expect(formatHeartbeatAge(59)).toBe("just now");
    expect(formatHeartbeatAge(60)).toBe("1m ago");
    expect(formatHeartbeatAge(5 * 60 + 30)).toBe("5m ago");
    expect(formatHeartbeatAge(59 * 60)).toBe("59m ago");
    expect(formatHeartbeatAge(60 * 60)).toBe("1h ago");
    expect(formatHeartbeatAge(2 * 60 * 60)).toBe("2h ago");
    expect(formatHeartbeatAge(47 * 60 * 60)).toBe("47h ago");
    expect(formatHeartbeatAge(48 * 60 * 60)).toBe("2d ago");
  });

  it("returns null for missing or invalid ages", () => {
    expect(formatHeartbeatAge(null)).toBeNull();
    expect(formatHeartbeatAge(undefined)).toBeNull();
    expect(formatHeartbeatAge(-5)).toBeNull();
    expect(formatHeartbeatAge(Number.NaN)).toBeNull();
  });
});

describe("envelopePreview", () => {
  it("extracts sender, text, and sentAt from a full envelope", () => {
    const envelope: KakaoRelayEnvelope = {
      schema: "kakao-msg/v1",
      provider: "kakao",
      kind: "message",
      message: {
        id: "m1",
        chat: "c1",
        room_slug: "koica-uzbek",
        sender: "Lee",
        is_me: false,
        text: "hello",
        sent_at: "2026-07-30T01:00:00Z",
        captured_at: "2026-07-30T01:00:05Z",
        engine: "mock",
        attachments: [],
      },
    };
    expect(envelopePreview(envelope)).toEqual({
      sender: "Lee",
      text: "hello",
      sentAt: "2026-07-30T01:00:00Z",
    });
  });

  it("tolerates missing fields", () => {
    expect(envelopePreview(null)).toEqual({ sender: "", text: "", sentAt: null });
    expect(envelopePreview(undefined)).toEqual({ sender: "", text: "", sentAt: null });
    expect(envelopePreview({} as KakaoRelayEnvelope)).toEqual({
      sender: "",
      text: "",
      sentAt: null,
    });
    expect(
      envelopePreview({ message: { text: "partial" } } as KakaoRelayEnvelope),
    ).toEqual({ sender: "", text: "partial", sentAt: null });
  });
});

describe("kakaoRelayAuthStatus", () => {
  it("maps liveness onto badge states with error detail", () => {
    expect(kakaoRelayAuthStatus(status({})).state).toBe("ok");
    expect(kakaoRelayAuthStatus(status({ state: "paused" })).state).toBe("paused");
    expect(kakaoRelayAuthStatus(status({ stale: true })).state).toBe("stale");
    expect(kakaoRelayAuthStatus(status({ state: "unreachable" })).state).toBe("cli_missing");
    expect(kakaoRelayAuthStatus(status({ configured: false })).state).toBe("cli_missing");

    const errored = kakaoRelayAuthStatus(status({ lastError: "daemon down" }));
    expect(errored.detail).toBe("daemon down");
    expect(errored.provider).toBe("kakao");

    const healthy = kakaoRelayAuthStatus(status({ heartbeatAgeSeconds: 300 }));
    expect(healthy.detail).toBe("5m ago");
  });
});
