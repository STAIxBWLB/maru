import { useCallback, useEffect, useRef, useState } from "react";
import { RefreshCcw } from "lucide-react";

import {
  agentsUsageStatus,
  AGENT_PROVIDERS,
  type AgentCommandOverrides,
  type AgentUsageStatus,
} from "../lib/api";
import { useTranslation } from "../lib/i18n";
import { skillsBundleStatus, type SkillBundleStatus } from "../lib/skills";
import { formatUsageWindowSegment } from "../lib/usageFormat";

const POLL_INTERVAL_MS = 60_000;
// Focus/visibility events fire on every alt-tab; only reload when the last
// load finished longer ago than this, so refocusing is not a backend hit.
const FOCUS_RELOAD_MIN_AGE_MS = 30_000;

/**
 * Main-window footer. Left: one quota chip per agent (when usage data is
 * available). When it is not, the right end falls back to the next most
 * important status — the active skills bundle version — so the bar still
 * says something useful.
 */
export function AgentUsageBar({
  commandOverrides,
  onOpenSettings,
}: {
  commandOverrides?: AgentCommandOverrides;
  onOpenSettings?: (tab: string) => void;
}) {
  const { t } = useTranslation();
  const [usage, setUsage] = useState<AgentUsageStatus[] | null>(null);
  const [bundleStatus, setBundleStatus] = useState<SkillBundleStatus | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  // Ticks once per poll so "reset in" text stays roughly current.
  const [now, setNow] = useState(() => Date.now());
  const mountedRef = useRef(true);
  // When the last load finished; initialized to mount time so an immediate
  // focus event does not double-load alongside the initial load.
  const lastLoadedAtRef = useRef(Date.now());

  const load = useCallback(
    async (force = false) => {
      setRefreshing(true);
      try {
        const [nextUsage, nextBundleStatus] = await Promise.all([
          agentsUsageStatus(commandOverrides, force).catch(() => null),
          skillsBundleStatus().catch(() => null),
        ]);
        if (!mountedRef.current) return;
        if (nextUsage) {
          setUsage(nextUsage);
          setNow(Date.now());
        }
        setBundleStatus(nextBundleStatus);
      } finally {
        lastLoadedAtRef.current = Date.now();
        if (mountedRef.current) setRefreshing(false);
      }
    },
    [commandOverrides],
  );

  useEffect(() => {
    mountedRef.current = true;
    void load();
    const timer = window.setInterval(() => void load(), POLL_INTERVAL_MS);
    const reloadIfStale = () => {
      if (Date.now() - lastLoadedAtRef.current > FOCUS_RELOAD_MIN_AGE_MS) void load();
    };
    const onFocus = () => reloadIfStale();
    const onVisibility = () => {
      if (document.visibilityState === "visible") reloadIfStale();
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

  const openSettings = (tab: string) => {
    onOpenSettings?.(tab);
  };

  const usable = (usage ?? []).filter((entry) => entry.state !== "cli_missing");
  const skillsVersion = bundleStatus?.active?.displayVersion ?? null;
  const skillsUpdateAvailable = bundleStatus?.updateAvailable ?? false;

  // Agent chips take priority; the skills bundle status fills the bar when
  // no agent usage data is available.
  if (usable.length === 0 && !skillsVersion) return null;

  return (
    <footer className="agent-usage-bar" aria-label={t("agents.usage.openSettings")}>
      {usable.length > 0 ? (
        <div className="agent-usage-chips">
          {usable.map((entry) => (
            <button
              key={entry.id}
              type="button"
              className={
                entry.state === "ok" ? "agent-usage-chip" : "agent-usage-chip dimmed"
              }
              onClick={() => openSettings("agents")}
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
      ) : (
        <span className="agent-usage-spacer" />
      )}
      {usable.length === 0 && skillsVersion ? (
        <button
          type="button"
          className="agent-usage-skills"
          onClick={() => openSettings("skills")}
          title={
            skillsUpdateAvailable
              ? t("agents.usage.skillsUpdate")
              : t("agents.usage.openSkillsSettings")
          }
        >
          {skillsUpdateAvailable ? (
            <span className="agent-usage-skills-dot" aria-hidden="true" />
          ) : null}
          <span>{t("agents.usage.skillsVersion", { version: skillsVersion })}</span>
        </button>
      ) : null}
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
