import { describe, expect, it } from "vitest";
import {
  buildMaruThemeMessage,
  DEFAULT_KAKAO_RELAY_UI_URL,
  envelopePreview,
  formatHeartbeatAge,
  kakaoRelayAuthStatus,
  kakaoRelayUiSrc,
  MARU_THEME_MESSAGE_TYPE,
  normalizeKakaoRelayUiUrl,
  relayLiveness,
  type KakaoRelayEnvelope,
  type KakaoRelayStatus,
  type KakaoStageResult,
} from "./kakaoRelay";

describe("KakaoStageResult perRoom", () => {
  it("carries shaped staged/skipped counts per room (not bare numbers)", () => {
    const result: KakaoStageResult = {
      stagedMessages: 2,
      stagedMedia: 0,
      skipped: 1,
      errors: [],
      perRoom: { "koica-uzbek": { staged: 2, skipped: 1 } },
    };
    const total = Object.values(result.perRoom).reduce((sum, room) => sum + room.staged, 0);
    expect(total).toBe(2);
    expect(result.perRoom["koica-uzbek"].skipped).toBe(1);
  });
});

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
    expect(relayLiveness(status({ state: "starting" }))).toBe("unknown");
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
    expect(kakaoRelayAuthStatus(status({ state: "starting" })).state).toBe("unknown");

    const errored = kakaoRelayAuthStatus(status({ lastError: "daemon down" }));
    expect(errored.detail).toBe("daemon down");
    expect(errored.provider).toBe("kakao");

    const healthy = kakaoRelayAuthStatus(status({ heartbeatAgeSeconds: 300 }));
    expect(healthy.detail).toBe("5m ago");
  });
});

describe("normalizeKakaoRelayUiUrl", () => {
  it("trims and falls back to the default bind on blank or non-string input", () => {
    expect(normalizeKakaoRelayUiUrl(" http://relay.local:8787 ")).toBe(
      "http://relay.local:8787",
    );
    expect(normalizeKakaoRelayUiUrl("")).toBe(DEFAULT_KAKAO_RELAY_UI_URL);
    expect(normalizeKakaoRelayUiUrl("   ")).toBe(DEFAULT_KAKAO_RELAY_UI_URL);
    expect(normalizeKakaoRelayUiUrl(null)).toBe(DEFAULT_KAKAO_RELAY_UI_URL);
    expect(normalizeKakaoRelayUiUrl(undefined)).toBe(DEFAULT_KAKAO_RELAY_UI_URL);
    expect(normalizeKakaoRelayUiUrl(42)).toBe(DEFAULT_KAKAO_RELAY_UI_URL);
    expect(DEFAULT_KAKAO_RELAY_UI_URL).toBe("http://127.0.0.1:8787");
  });
});

describe("kakaoRelayUiSrc", () => {
  it("appends the theme query param to a valid http(s) URL", () => {
    expect(kakaoRelayUiSrc("http://127.0.0.1:8787", "dark")).toBe(
      "http://127.0.0.1:8787/?theme=dark",
    );
    expect(kakaoRelayUiSrc("https://relay.example/ui", "light")).toBe(
      "https://relay.example/ui?theme=light",
    );
  });

  it("replaces an existing theme param and preserves other params", () => {
    expect(kakaoRelayUiSrc("http://relay.local:8787/?theme=light&token=abc", "dark")).toBe(
      "http://relay.local:8787/?theme=dark&token=abc",
    );
  });

  it("returns null for blank, unparseable, or non-http(s) values", () => {
    expect(kakaoRelayUiSrc("", "dark")).toBeNull();
    expect(kakaoRelayUiSrc("   ", "dark")).toBeNull();
    expect(kakaoRelayUiSrc("not a url", "dark")).toBeNull();
    expect(kakaoRelayUiSrc("file:///etc/passwd", "dark")).toBeNull();
    expect(kakaoRelayUiSrc("ftp://relay.local", "dark")).toBeNull();
  });
});

describe("buildMaruThemeMessage", () => {
  it("builds the relay theme-sync postMessage payload", () => {
    expect(buildMaruThemeMessage("dark")).toEqual({
      type: MARU_THEME_MESSAGE_TYPE,
      theme: "dark",
    });
    expect(MARU_THEME_MESSAGE_TYPE).toBe("maru-theme");
    expect(buildMaruThemeMessage("system")).toEqual({
      type: "maru-theme",
      theme: "system",
    });
  });
});
