import { ExternalLink } from "lucide-react";
import { useState } from "react";
import { useTranslation } from "../../lib/i18n";
import { kakaoRelayUiSrc } from "../../lib/kakaoRelay";
import type { ThemeMode } from "../../lib/settings";
import { siteViewOpenExternal } from "../../lib/siteView";
import { resolveThemeMode } from "../../lib/theme";

interface KakaoRelayConsoleProps {
  relayUiUrl: string;
  themeMode: ThemeMode;
}

/** The standalone relay UI lives in the system browser, with its own cookies
 *  and lifetime. The initial theme travels in the URL; no remote frame or
 *  live postMessage bridge is hosted inside Maru. */
export function KakaoRelayConsole({ relayUiUrl, themeMode }: KakaoRelayConsoleProps) {
  const { t } = useTranslation();
  const [openError, setOpenError] = useState<string | null>(null);
  const src = kakaoRelayUiSrc(relayUiUrl, resolveThemeMode(themeMode));

  const open = async () => {
    const target = kakaoRelayUiSrc(relayUiUrl, resolveThemeMode(themeMode));
    if (!target) return;
    setOpenError(null);
    try {
      await siteViewOpenExternal(target);
    } catch (error) {
      setOpenError(error instanceof Error ? error.message : String(error));
    }
  };

  return (
    <div className="kakao-relay-console">
      <div className="kakao-relay-console-toolbar">
        <span className="kakao-relay-console-url">{relayUiUrl}</span>
        <button
          type="button"
          className="secondary-button"
          onClick={() => void open()}
          disabled={!src}
        >
          <ExternalLink size={14} />
          <span>{t("comms.kakao.console.openExternal")}</span>
        </button>
      </div>
      {!src ? (
        <p className="kakao-relay-hint">{t("comms.kakao.console.invalidUrl")}</p>
      ) : null}
      {openError ? (
        <p className="kakao-relay-error" role="alert">
          {t("comms.kakao.console.openFailed", { error: openError })}
        </p>
      ) : null}
    </div>
  );
}
