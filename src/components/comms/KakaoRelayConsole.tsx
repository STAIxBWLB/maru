import { ExternalLink, RefreshCcw } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "../../lib/i18n";
import {
  buildMaruThemeMessage,
  kakaoRelayUiSrc,
} from "../../lib/kakaoRelay";
import type { ThemeMode } from "../../lib/settings";
import { siteViewOpenExternal } from "../../lib/siteView";
import {
  resolveThemeMode,
  subscribeToSystemTheme,
  type ResolvedThemeMode,
} from "../../lib/theme";

interface KakaoRelayConsoleProps {
  relayUiUrl: string;
  themeMode: ThemeMode;
}

/**
 * Embedded maru-kakao-relay operator console. The relay daemon serves the
 * console on its own bind; Maru only frames it and keeps its theme in sync
 * (contract: STAIxBWLB/maru-kakao-relay#68): the iframe src carries
 * `?theme=<resolved>`, and live theme changes go over a `maru-theme`
 * postMessage so the console switches without a reload.
 */
export function KakaoRelayConsole({ relayUiUrl, themeMode }: KakaoRelayConsoleProps) {
  const { t } = useTranslation();
  const frameRef = useRef<HTMLIFrameElement | null>(null);
  const [resolvedTheme, setResolvedTheme] = useState<ResolvedThemeMode>(() =>
    resolveThemeMode(themeMode),
  );
  // Theme baked into the iframe src: refreshed only when the configured URL
  // changes or the user reloads, so a live theme switch does not reload the
  // console (it arrives via postMessage instead).
  const [reloadKey, setReloadKey] = useState(0);
  const [frameLoadedKey, setFrameLoadedKey] = useState(0);
  const [loadFailed, setLoadFailed] = useState(false);

  useEffect(() => {
    const apply = () => setResolvedTheme(resolveThemeMode(themeMode));
    apply();
    return subscribeToSystemTheme(themeMode, apply);
  }, [themeMode]);

  const resolvedThemeRef = useRef(resolvedTheme);
  resolvedThemeRef.current = resolvedTheme;

  const src = useMemo(() => {
    // reloadKey is a manual recompute trigger: a reload bakes the current
    // resolved theme back into the src, while live theme switches between
    // reloads go over postMessage (no frame reload).
    void reloadKey;
    return kakaoRelayUiSrc(relayUiUrl, resolvedThemeRef.current);
  }, [relayUiUrl, reloadKey]);
  const targetOrigin = useMemo(() => {
    if (!src) return null;
    try {
      return new URL(src).origin;
    } catch {
      return null;
    }
  }, [src]);

  useEffect(() => {
    setLoadFailed(false);
    setFrameLoadedKey(0);
  }, [src]);

  // Post the resolved theme once the frame reports a load, and again on every
  // later theme change (live switching without a reload).
  useEffect(() => {
    if (!src || !targetOrigin || frameLoadedKey === 0) return;
    frameRef.current?.contentWindow?.postMessage(
      buildMaruThemeMessage(resolvedTheme),
      targetOrigin,
    );
  }, [src, targetOrigin, resolvedTheme, frameLoadedKey]);

  return (
    <div className="kakao-relay-console">
      <div className="kakao-relay-console-toolbar">
        <span className="kakao-relay-console-url">{relayUiUrl}</span>
        <div className="kakao-relay-console-actions">
          <button
            type="button"
            className="icon-button"
            onClick={() => setReloadKey((key) => key + 1)}
            disabled={!src}
            title={t("comms.kakao.console.reload")}
            aria-label={t("comms.kakao.console.reload")}
          >
            <RefreshCcw size={14} />
          </button>
          <button
            type="button"
            className="icon-button"
            onClick={() => void siteViewOpenExternal(src ?? relayUiUrl)}
            title={t("comms.kakao.console.openExternal")}
            aria-label={t("comms.kakao.console.openExternal")}
          >
            <ExternalLink size={14} />
          </button>
        </div>
      </div>
      {!src ? (
        <p className="kakao-relay-hint">{t("comms.kakao.console.invalidUrl")}</p>
      ) : loadFailed ? (
        <p className="kakao-relay-hint">
          {t("comms.kakao.console.loadFailed", { url: relayUiUrl })}
        </p>
      ) : (
        <iframe
          key={`${src}:${reloadKey}`}
          ref={frameRef}
          className="kakao-relay-console-frame"
          src={src}
          title={t("comms.kakao.console.title")}
          onLoad={() => setFrameLoadedKey((key) => key + 1)}
          onError={() => setLoadFailed(true)}
        />
      )}
    </div>
  );
}
