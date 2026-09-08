// SystemJobsPanel — user LaunchAgents Maru does not own (com.maru.job.* stays
// in the section above) plus the user's crontab entries.

import { useCallback, useEffect, useState } from "react";
import { Play, RefreshCcw, RotateCw, Square, Trash2 } from "lucide-react";
import { useTranslation } from "../../lib/i18n";
import { SettingsSection } from "../settings/SettingsSection";
import {
  systemCrontabRemove,
  systemJobRunNow,
  systemJobSetEnabled,
  systemJobsList,
  type SystemAgent,
  type SystemJobsOverview,
} from "../../lib/api";

export function SystemJobsPanel() {
  const { t } = useTranslation();
  const [overview, setOverview] = useState<SystemJobsOverview | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busyLabel, setBusyLabel] = useState<string | null>(null);
  const [busyCron, setBusyCron] = useState<number | null>(null);

  const refresh = useCallback(async () => {
    try {
      setOverview(await systemJobsList());
      setError(null);
    } catch (err) {
      setError(String(err));
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const runAgentAction = async (
    label: string,
    action: (target: string) => Promise<SystemAgent>,
  ) => {
    setBusyLabel(label);
    try {
      await action(label);
      await refresh();
      setError(null);
    } catch (err) {
      setError(String(err));
    } finally {
      setBusyLabel(null);
    }
  };

  const removeCronEntry = async (index: number, entry: string) => {
    if (!window.confirm(t("system.systemJobs.crontab.confirmRemove", { entry }))) return;
    setBusyCron(index);
    try {
      await systemCrontabRemove(index);
      await refresh();
      setError(null);
    } catch (err) {
      setError(String(err));
    } finally {
      setBusyCron(null);
    }
  };

  return (
    <SettingsSection
      title={t("system.systemJobs.title")}
      description={t("system.systemJobs.description")}
      padded
      actions={
        <button
          type="button"
          className="secondary-button"
          onClick={() => void refresh()}
          disabled={busyLabel !== null || busyCron !== null}
        >
          <RefreshCcw size={14} />
          <span>{t("system.systemJobs.refresh")}</span>
        </button>
      }
    >
      {error ? <p className="jobs-error">{error}</p> : null}
      {overview === null ? (
        <p className="muted">{t("system.systemJobs.loading")}</p>
      ) : overview.agents.length === 0 ? (
        <p className="muted">{t("system.systemJobs.empty")}</p>
      ) : (
        <ul className="jobs-list">
          {overview.agents.map((agent) => (
            <li key={agent.label} className="jobs-list-item">
              <div className="jobs-list-header">
                <div className="jobs-list-title">
                  <strong>{agent.label}</strong>
                  {agent.program ? <span className="muted">{agent.program}</span> : null}
                </div>
                <div className="jobs-list-badges">
                  <span className="status-pill" data-status={agent.loaded ? "active" : ""}>
                    {agent.loaded
                      ? t("system.jobs.badge.loaded")
                      : t("system.jobs.badge.notLoaded")}
                  </span>
                  <span className="status-pill" data-status={agent.enabled ? "active" : "draft"}>
                    {agent.enabled
                      ? t("system.jobs.badge.enabled")
                      : t("system.jobs.badge.disabled")}
                  </span>
                  {agent.lastExitCode !== null ? (
                    <span
                      className="status-pill"
                      data-status={agent.lastExitCode === 0 ? "active" : "draft"}
                    >
                      {t("system.jobs.badge.lastExit", { code: agent.lastExitCode })}
                    </span>
                  ) : null}
                </div>
              </div>
              <div className="comms-settings-actions">
                {agent.enabled ? (
                  <button
                    type="button"
                    className="secondary-button"
                    disabled={busyLabel !== null}
                    onClick={() => void runAgentAction(agent.label, (label) => systemJobSetEnabled(label, false))}
                  >
                    <Square size={14} />
                    <span>{t("system.systemJobs.disable")}</span>
                  </button>
                ) : (
                  <button
                    type="button"
                    className="secondary-button"
                    disabled={busyLabel !== null}
                    onClick={() => void runAgentAction(agent.label, (label) => systemJobSetEnabled(label, true))}
                  >
                    <Play size={14} />
                    <span>{t("system.systemJobs.enable")}</span>
                  </button>
                )}
                <button
                  type="button"
                  className="secondary-button"
                  disabled={busyLabel !== null || !agent.loaded}
                  onClick={() => void runAgentAction(agent.label, systemJobRunNow)}
                >
                  <RotateCw size={14} />
                  <span>{t("system.systemJobs.runNow")}</span>
                </button>
              </div>
            </li>
          ))}
        </ul>
      )}
      <div className="system-crontab">
        <h4 className="system-crontab-title">{t("system.systemJobs.crontab.title")}</h4>
        {overview !== null && overview.crontab.length === 0 ? (
          <p className="muted">{t("system.systemJobs.crontab.empty")}</p>
        ) : (
          <ul className="jobs-list">
            {overview?.crontab.map((entry, index) => (
              <li key={`${index}-${entry}`} className="jobs-list-item">
                <div className="jobs-list-header">
                  <div className="jobs-list-title">
                    <code>{entry}</code>
                  </div>
                  <div className="comms-settings-actions">
                    <button
                      type="button"
                      className="secondary-button"
                      disabled={busyCron !== null}
                      onClick={() => void removeCronEntry(index, entry)}
                    >
                      <Trash2 size={14} />
                      <span>{t("system.systemJobs.crontab.remove")}</span>
                    </button>
                  </div>
                </div>
              </li>
            ))}
          </ul>
        )}
      </div>
    </SettingsSection>
  );
}
