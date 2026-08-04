import { useCallback, useEffect, useRef, useState } from "react";
import { RefreshCcw } from "lucide-react";

import {
  agentsUsageStatus,
  AGENT_PROVIDERS,
  dotSyncOverview,
  type AgentCommandOverrides,
  type AgentUsageState,
  type AgentUsageStatus,
  type DotSyncOverview,
} from "../lib/api";
import { deriveDotSyncBadge } from "../lib/dotSync";
import { useTranslation } from "../lib/i18n";
import { skillsBundleStatus, type SkillBundleStatus } from "../lib/skills";
import { useActiveMissions } from "../lib/useActiveMissions";
import { formatUsageWindowSegment } from "../lib/usageFormat";

const POLL_INTERVAL_MS = 60_000;
// Focus/visibility events fire on every alt-tab; only reload when the last
// load finished longer ago than this, so refocusing is not a backend hit.
const FOCUS_RELOAD_MIN_AGE_MS = 30_000;

/** i18n key for the short value text of a non-ok usage state. */
const USAGE_STATE_KEY: Record<Exclude<AgentUsageState, "ok">, string> = {
  unsupported: "agents.usage.state.unsupported",
  unauthenticated: "agents.usage.state.unauthenticated",
  unavailable: "agents.usage.state.unavailable",
  cli_missing: "agents.usage.state.cliMissing",
};

/** Last path segment of a workspace path, used when the registry has no label. */
function pathBasename(path: string): string {
  const parts = path.split("/").filter(Boolean);
  return parts[parts.length - 1] ?? path;
}

/**
 * Permanent main-window status bar. Agent quota chips scroll on the left;
 * running missions, workspace state, skills version, and refresh stay on the
 * right as ambient application state.
 *
 * Every segment degrades in place rather than disappearing: an agent whose CLI
 * is missing or whose backend has no usage API still gets a dimmed chip with
 * the backend's own explanation in its tooltip, and the workspace chip falls
 * back to the document count when the file scan is off.
 */
export function AgentUsageBar({
  commandOverrides,
  onOpenSettings,
  onOpenAgents,
  workspaceName,
  workspacePath,
  workspaceFileCount,
  workspaceDocumentCount,
}: {
  commandOverrides?: AgentCommandOverrides;
  onOpenSettings?: (tab: string) => void;
  onOpenAgents?: () => void;
  workspaceName?: string | null;
  workspacePath?: string | null;
  workspaceFileCount?: number | null;
  workspaceDocumentCount?: number | null;
}) {
  const { t } = useTranslation();
  const activeMissions = useActiveMissions();
  const [usage, setUsage] = useState<AgentUsageStatus[] | null>(null);
  const [usageError, setUsageError] = useState<string | null>(null);
  const [bundleStatus, setBundleStatus] = useState<SkillBundleStatus | null>(null);
  const [syncOverview, setSyncOverview] = useState<DotSyncOverview | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  const chipsRef = useRef<HTMLDivElement | null>(null);
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
        const [nextUsage, nextBundleStatus, nextSyncOverview] = await Promise.all([
          agentsUsageStatus(commandOverrides, force).catch((error: unknown) => {
            if (mountedRef.current) setUsageError(String(error));
            return null;
          }),
          skillsBundleStatus().catch(() => null),
          dotSyncOverview().catch(() => null),
        ]);
        if (!mountedRef.current) return;
        if (nextUsage) {
          setUsage(nextUsage);
          setUsageError(null);
          setNow(Date.now());
        }
        setBundleStatus(nextBundleStatus);
        if (nextSyncOverview) setSyncOverview(nextSyncOverview);
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

  // Chips overflow silently (hidden scrollbar); flag it so CSS can fade the
  // right edge instead of letting the row look like it simply ends there.
  const [scrollable, setScrollable] = useState(false);
  useEffect(() => {
    const measure = () => {
      const node = chipsRef.current;
      if (node) setScrollable(node.scrollWidth > node.clientWidth + 1);
    };
    measure();
    window.addEventListener("resize", measure);
    return () => window.removeEventListener("resize", measure);
  }, [usage, bundleStatus]);

  const openSettings = (tab: string) => {
    onOpenSettings?.(tab);
  };

  // Every agent the backend reports keeps a chip, including cli_missing ones:
  // a hidden chip reads as "nothing to see", a dimmed one as "here is why".
  const entries = usage ?? [];
  const skillsVersion = bundleStatus?.active?.displayVersion ?? null;
  const skillsUpdateAvailable = bundleStatus?.updateAvailable ?? false;
  const syncBadge = deriveDotSyncBadge(syncOverview);
  const workspaceLabel =
    workspaceName ?? (workspacePath ? pathBasename(workspacePath) : null);
  const workspaceCount =
    workspaceFileCount != null
      ? `${workspaceFileCount.toLocaleString()} ${t("agents.usage.filesLabel")}`
      : workspaceDocumentCount != null
        ? `${workspaceDocumentCount.toLocaleString()} ${t("agents.usage.docsLabel")}`
        : `— ${t("agents.usage.filesLabel")}`;

  return (
    <footer className="agent-usage-bar" aria-label={t("agents.usage.barLabel")}>
      <div
        className="agent-usage-chips"
        ref={chipsRef}
        data-scrollable={scrollable ? "true" : undefined}
      >
        {entries.map((entry) => (
          <button
            key={entry.id}
            type="button"
            className={
              entry.state === "ok" ? "agent-usage-chip" : "agent-usage-chip dimmed"
            }
            onClick={() => openSettings("agents")}
            title={entry.message ?? t("agents.usage.openSettings")}
          >
            <span className="agent-usage-chip-name">
              {(AGENT_PROVIDERS as readonly string[]).includes(entry.id)
                ? t(`system.agents.agent.${entry.id}`)
                : entry.id}
            </span>
            <span className="agent-usage-chip-value">
              {entry.state === "ok" && entry.windows.length > 0
                ? entry.windows
                    .map((window) =>
                      formatUsageWindowSegment(window, t("agents.usage.usedSuffix"), now),
                    )
                    .join(" · ")
                : // "ok" with no windows means the probe parsed nothing; an
                  // empty value would render as a chip with just a name.
                  t(USAGE_STATE_KEY[entry.state === "ok" ? "unavailable" : entry.state])}
            </span>
          </button>
        ))}
        {entries.length === 0 && !refreshing ? (
          <button
            type="button"
            className="agent-usage-chip dimmed"
            onClick={() => openSettings("agents")}
            title={usageError ?? t("agents.usage.usageUnavailableTitle")}
          >
            <span className="agent-usage-chip-name">{t("agents.usage.usageLabel")}</span>
            <span className="agent-usage-chip-value">
              {t("agents.usage.usageUnavailable")}
            </span>
          </button>
        ) : null}
      </div>
      <div className="agent-usage-status">
        <button
          type="button"
          className={`agent-usage-stat${activeMissions.length === 0 ? " idle" : ""}`}
          onClick={onOpenAgents}
          title={t("agents.usage.missionsTitle")}
        >
          <span className="agent-usage-stat-name">{t("agents.usage.missionsLabel")}</span>
          <span className="agent-usage-stat-value">{activeMissions.length}</span>
        </button>
        {workspaceLabel ? (
          <button
            type="button"
            className="agent-usage-stat"
            onClick={() => openSettings("projects")}
            title={
              workspaceFileCount == null && workspaceDocumentCount != null
                ? t("agents.usage.workspaceScanOff")
                : (workspacePath ?? t("agents.usage.workspaceTitle"))
            }
          >
            <span className="agent-usage-stat-name agent-usage-workspace-name">
              {workspaceLabel}
            </span>
            <span className="agent-usage-stat-value">{workspaceCount}</span>
          </button>
        ) : null}
        <button
          type="button"
          className={`agent-usage-stat dot-sync-status ${syncBadge.state}`}
          onClick={() => openSettings("jobs")}
          title={t("agents.usage.syncTitle")}
        >
          <span className="agent-usage-stat-name">{t("agents.usage.syncLabel")}</span>
          <span className="agent-usage-stat-value">
            {t(`agents.usage.sync.${syncBadge.state}`, { count: syncBadge.scheduledJobs })}
          </span>
        </button>
        <button
          type="button"
          className={skillsVersion ? "agent-usage-skills" : "agent-usage-skills dimmed"}
          onClick={() => openSettings("skills")}
          title={
            !skillsVersion
              ? t("agents.usage.skillsUnknownTitle")
              : skillsUpdateAvailable
                ? t("agents.usage.skillsUpdate")
                : t("agents.usage.openSkillsSettings")
          }
        >
          {skillsUpdateAvailable ? (
            <span className="agent-usage-skills-dot" aria-hidden="true" />
          ) : null}
          <span>
            {skillsVersion
              ? t("agents.usage.skillsVersion", { version: skillsVersion })
              : t("agents.usage.skillsUnknown")}
          </span>
        </button>
        <button
          type="button"
          className="icon-button agent-usage-refresh"
          onClick={() => void load(true)}
          title={t("agents.usage.refresh")}
          aria-label={t("agents.usage.refresh")}
        >
          <RefreshCcw size={12} className={refreshing ? "spin" : undefined} />
        </button>
      </div>
    </footer>
  );
}
