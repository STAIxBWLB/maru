import { useCallback, useEffect, useMemo, useState } from "react";
import { RefreshCcw } from "lucide-react";

import {
  AGENT_PROVIDERS,
  agentsAccountStatus,
  agentsUsageStatus,
  type AgentAccountStatus,
  type AgentProvider,
  type AgentUsageStatus,
} from "../../lib/api";
import { useTranslation } from "../../lib/i18n";
import {
  normalizeMaruSettings,
  type MaruSettings,
  type TerminalLauncherSettings,
} from "../../lib/settings";
import { emitSettingsTerminalLaunch } from "../../lib/settingsEvents";
import { formatUsageResetIn } from "../../lib/usageFormat";
import { SettingsSection } from "../settings/SettingsSection";
import { Button } from "../ui/Button";
import { ModeHeader } from "../ui/ModeChrome";

const LOGIN_COMMANDS: Record<AgentProvider, string> = {
  claude: "claude auth login",
  codex: "codex login",
  kimi: "kimi login",
  kiro: "kiro-cli login",
};

interface AgentsSettingsTabProps {
  workPath: string | null;
  settings: MaruSettings;
  onSettingsChange: (settings: MaruSettings) => void;
}

export function AgentsSettingsTab({
  workPath,
  settings,
  onSettingsChange,
}: AgentsSettingsTabProps) {
  const { t } = useTranslation();
  const [agent, setAgent] = useState<AgentProvider>("claude");
  const [accounts, setAccounts] = useState<AgentAccountStatus[] | null>(null);
  const [usage, setUsage] = useState<AgentUsageStatus[] | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  const [hint, setHint] = useState<string | null>(null);

  const commandOverrides = useMemo(() => {
    const overrides: Record<string, string> = {};
    for (const id of AGENT_PROVIDERS) {
      const value =
        settings.ai.commandOverrides[id] ??
        settings.terminal.launchers[id]?.command;
      if (value) overrides[id] = value;
    }
    return overrides;
  }, [settings.ai.commandOverrides, settings.terminal.launchers]);

  const load = useCallback(
    async (forceUsage = false) => {
      setRefreshing(true);
      try {
        const [nextAccounts, nextUsage] = await Promise.all([
          agentsAccountStatus(commandOverrides),
          agentsUsageStatus(commandOverrides, forceUsage),
        ]);
        setAccounts(nextAccounts);
        setUsage(nextUsage);
      } catch {
        // Keep stale data; the backend reports per-agent failures inline.
      } finally {
        setRefreshing(false);
      }
    },
    [commandOverrides],
  );

  useEffect(() => {
    void load();
  }, [load]);

  const account = accounts?.find((entry) => entry.id === agent) ?? null;
  const agentUsage = usage?.find((entry) => entry.id === agent) ?? null;
  const loginCommand = LOGIN_COMMANDS[agent];

  const runLogin = async () => {
    const [command, ...args] = loginCommand.split(" ");
    const delivered = await emitSettingsTerminalLaunch({
      command:
        settings.ai.commandOverrides[agent] ??
        settings.terminal.launchers[agent]?.command ??
        command,
      args,
      cwd: workPath,
    });
    if (delivered) {
      setHint(null);
      return;
    }
    try {
      await navigator.clipboard.writeText(loginCommand);
    } catch {
      // Clipboard may be unavailable; the hint still shows the command.
    }
    setHint(t("system.agents.copyCommandHint"));
  };

  return (
    <div className="settings-tab wide">
      <ModeHeader
        title={t("system.tab.agents")}
        actions={
          <Button
            size="sm"
            variant="ghost"
            disabled={refreshing}
            onClick={() => void load(true)}
            icon={<RefreshCcw size={14} className={refreshing ? "spin" : undefined} />}
          >
            {t("system.agents.refresh")}
          </Button>
        }
      />
      <div className="agents-subtabs" role="tablist">
        {AGENT_PROVIDERS.map((id) => (
          <button
            key={id}
            type="button"
            role="tab"
            aria-selected={agent === id}
            className={agent === id ? "system-tab active" : "system-tab"}
            onClick={() => setAgent(id)}
          >
            {t(`system.agents.agent.${id}`)}
          </button>
        ))}
      </div>
      <SettingsSection
        title={t("system.agents.authentication")}
        actions={
          <span
            className={
              account?.authStatus === "authenticated"
                ? "agents-badge connected"
                : "agents-badge"
            }
          >
            {account
              ? account.authStatus === "authenticated"
                ? t("system.agents.connected")
                : account.authStatus === "cli_missing"
                  ? t("system.agents.notInstalled")
                  : t("system.agents.notConnected")
              : "…"}
          </span>
        }
      >
        {account ? (
          <table className="agents-account-table">
            <tbody>
              <AccountInfoRow label={t("system.agents.version")} value={account.version} />
              <AccountInfoRow label={t("system.agents.provider")} value={account.provider} />
              <AccountInfoRow
                label={t("system.agents.loginMethod")}
                value={account.loginMethod}
              />
              <AccountInfoRow
                label={t("system.agents.organization")}
                value={account.organization}
              />
              <AccountInfoRow label={t("system.agents.email")} value={account.email} />
            </tbody>
          </table>
        ) : null}
        {account?.message ? <p className="settings-hint">{account.message}</p> : null}
        <div className="agents-actions">
          <Button size="sm" variant="secondary" onClick={() => void runLogin()}>
            {t("system.agents.runLogin", { command: loginCommand })}
          </Button>
        </div>
        {hint ? <p className="settings-hint">{hint}</p> : null}
      </SettingsSection>

      <SettingsSection title={t("system.agents.launchCommand")}>
        <LaunchCommandFields
          key={agent}
          agent={agent}
          settings={settings}
          onSettingsChange={onSettingsChange}
        />
      </SettingsSection>

      <SettingsSection title={t("system.agents.usage")}>
        <AgentUsageSection usage={agentUsage} />
      </SettingsSection>
    </div>
  );
}

function AccountInfoRow({ label, value }: { label: string; value: string | null }) {
  if (!value) return null;
  return (
    <tr>
      <th scope="row">{label}</th>
      <td>{value}</td>
    </tr>
  );
}

function LaunchCommandFields({
  agent,
  settings,
  onSettingsChange,
}: {
  agent: AgentProvider;
  settings: MaruSettings;
  onSettingsChange: (settings: MaruSettings) => void;
}) {
  const { t } = useTranslation();
  const launcher: TerminalLauncherSettings | undefined = settings.terminal.launchers[agent];
  const overrideFromSettings =
    settings.ai.commandOverrides[agent] ?? launcher?.command ?? "";
  const argsFromSettings = (launcher?.args ?? []).join(" ");
  const [overrideDraft, setOverrideDraft] = useState(overrideFromSettings);
  const [argsDraft, setArgsDraft] = useState(argsFromSettings);

  // Settings load asynchronously after mount; sync the drafts once they arrive
  // (and after external updates). Blur commits echo back the same values, so
  // this never clobbers in-progress typing.
  useEffect(() => setOverrideDraft(overrideFromSettings), [overrideFromSettings]);
  useEffect(() => setArgsDraft(argsFromSettings), [argsFromSettings]);

  const commitOverride = (value: string) => {
    const trimmed = value.trim();
    onSettingsChange(
      normalizeMaruSettings({
        ...settings,
        ai: {
          ...settings.ai,
          commandOverrides: {
            ...settings.ai.commandOverrides,
            [agent]: trimmed ? trimmed : null,
          },
        },
        terminal: {
          ...settings.terminal,
          launchers: {
            ...settings.terminal.launchers,
            [agent]: {
              enabled: launcher?.enabled ?? true,
              label: launcher?.label ?? agent,
              command: trimmed ? trimmed : null,
              args: launcher?.args ?? [],
            },
          },
        },
      }),
    );
  };

  const commitArgs = (value: string) => {
    const trimmed = value.trim();
    const args = trimmed ? trimmed.split(/\s+/) : [];
    onSettingsChange(
      normalizeMaruSettings({
        ...settings,
        terminal: {
          ...settings.terminal,
          launchers: {
            ...settings.terminal.launchers,
            [agent]: {
              enabled: launcher?.enabled ?? true,
              label: launcher?.label ?? agent,
              command: launcher?.command ?? null,
              args,
            },
          },
        },
      }),
    );
  };

  return (
    <>
      <label className="field">
        <span>{t("system.agents.commandOverride")}</span>
        <input
          type="text"
          value={overrideDraft}
          placeholder={t("system.ai.commandOverride.help")}
          onChange={(event) => setOverrideDraft(event.target.value)}
          onBlur={(event) => commitOverride(event.target.value)}
        />
      </label>
      <label className="field">
        <span>{t("system.agents.extraArgs")}</span>
        <input
          type="text"
          value={argsDraft}
          placeholder={t("system.agents.extraArgs.help")}
          onChange={(event) => setArgsDraft(event.target.value)}
          onBlur={(event) => commitArgs(event.target.value)}
        />
      </label>
    </>
  );
}

function AgentUsageSection({ usage }: { usage: AgentUsageStatus | null }) {
  const { t } = useTranslation();
  if (!usage) return <p className="settings-hint">…</p>;
  if (usage.state !== "ok") {
    const messageKey =
      usage.state === "unsupported"
        ? "system.agents.usageUnsupported"
        : usage.state === "cli_missing"
          ? "system.agents.usageCliMissing"
          : usage.state === "unauthenticated"
            ? "system.agents.usageUnauthenticated"
            : "system.agents.usageUnavailable";
    return (
      <p className="settings-hint">
        {t(messageKey)}
        {usage.message ? ` — ${usage.message}` : ""}
      </p>
    );
  }
  return (
    <>
      <table className="agents-account-table">
        <tbody>
          {usage.windows.map((window) => {
            const resetIn = formatUsageResetIn(window.resetsAt);
            return (
              <tr key={window.label}>
                <th scope="row">{window.label}</th>
                <td>
                  {t("agents.usage.used", { percent: Math.round(window.usedPercent) })}
                  {resetIn
                    ? ` · ${t("system.agents.resetsIn", { time: resetIn })}`
                    : ""}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
      <p className="settings-hint">
        {t("system.agents.updatedAt", {
          time: new Date(usage.updatedAt).toLocaleTimeString(),
        })}
      </p>
    </>
  );
}
