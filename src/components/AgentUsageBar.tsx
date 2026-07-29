import { useCallback, useEffect, useRef, useState } from "react";
import { RefreshCcw } from "lucide-react";

import {
  agentsUsageStatus,
  AGENT_PROVIDERS,
  type AgentCommandOverrides,
  type AgentUsageStatus,
} from "../lib/api";
import { useTranslation } from "../lib/i18n";
import { formatUsageWindowSegment } from "../lib/usageFormat";
import { openSettingsWindow } from "../lib/windowLayout";

const POLL_INTERVAL_MS = 60_000;

/**
 * Main-window footer with one quota chip per agent. Polls usage every 60s and
 * on window focus; clicking a chip opens the settings window Agents tab.
 */
export function AgentUsageBar({
  workPath,
  commandOverrides,
}: {
  workPath: string | null;
  commandOverrides?: AgentCommandOverrides;
}) {
  const { t } = useTranslation();
  const [usage, setUsage] = useState<AgentUsageStatus[] | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  // Ticks once per poll so "reset in" text stays roughly current.
  const [now, setNow] = useState(() => Date.now());
  const mountedRef = useRef(true);

  const load = useCallback(
    async (force = false) => {
      setRefreshing(true);
      try {
        const next = await agentsUsageStatus(commandOverrides, force);
        if (!mountedRef.current) return;
        setUsage(next);
        setNow(Date.now());
      } catch {
        // Keep stale chips; per-agent failures are modeled in the payload.
      } finally {
        if (mountedRef.current) setRefreshing(false);
      }
    },
    [commandOverrides],
  );

  useEffect(() => {
    mountedRef.current = true;
    void load();
    const timer = window.setInterval(() => void load(), POLL_INTERVAL_MS);
    const onFocus = () => void load();
    const onVisibility = () => {
      if (document.visibilityState === "visible") void load();
    };
    window.addEventListener("focus", onFocus);
    document.addEventListener("visibilitychange", onVisibility);
    return () => {
      mountedRef.current = false;
      window.clearInterval(timer);
      window.removeEventListener("focus", onFocus);
      document.removeEventListener("visibilitychange", onVisibility);
    };
  }, [load]);

  const openAgentsSettings = () => {
    void openSettingsWindow(workPath, "agents").catch(() => {
      // Settings window requires the Tauri shell; ignore in browser dev.
    });
  };

  if (!usage) return null;
  const usable = usage.filter((entry) => entry.state !== "cli_missing");
  if (usable.length === 0) return null;

  return (
    <footer className="agent-usage-bar" aria-label={t("agents.usage.openSettings")}>
      <div className="agent-usage-chips">
        {usable.map((entry) => (
          <button
            key={entry.id}
            type="button"
            className={
              entry.state === "ok" ? "agent-usage-chip" : "agent-usage-chip dimmed"
            }
            onClick={openAgentsSettings}
            title={t("agents.usage.openSettings")}
          >
            <span className="agent-usage-chip-name">
              {(AGENT_PROVIDERS as readonly string[]).includes(entry.id)
                ? t(`system.agents.agent.${entry.id}`)
                : entry.id}
            </span>
            <span className="agent-usage-chip-value">
              {entry.state === "ok"
                ? entry.windows
                    .map((window) =>
                      formatUsageWindowSegment(window, t("agents.usage.usedSuffix"), now),
                    )
                    .join(" · ")
                : "—"}
            </span>
          </button>
        ))}
      </div>
      <button
        type="button"
        className="icon-button agent-usage-refresh"
        onClick={() => void load(true)}
        title={t("agents.usage.refresh")}
        aria-label={t("agents.usage.refresh")}
      >
        <RefreshCcw size={12} className={refreshing ? "spin" : undefined} />
      </button>
    </footer>
  );
}
