// JobsTab — scheduled jobs (launchd) declared in `<work>/.maru/jobs.json`.
// Maru owns install/uninstall/start/stop/run-now plus a log tail view.

import { useCallback, useEffect, useState } from "react";
import {
  ChevronDown,
  ChevronRight,
  Download,
  Play,
  RefreshCcw,
  RotateCw,
  Square,
  Trash2,
} from "lucide-react";
import { useTranslation } from "../../lib/i18n";
import {
  jobsInstall,
  jobsList,
  jobsReadLog,
  jobsRunNow,
  jobsStart,
  jobsStop,
  jobsUninstall,
  type JobLogsTail,
  type JobStatus,
} from "../../lib/api";

interface JobsTabProps {
  workPath: string;
}

export function JobsTab({ workPath }: JobsTabProps) {
  const { t } = useTranslation();
  const [jobs, setJobs] = useState<JobStatus[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [openLogs, setOpenLogs] = useState<Set<string>>(() => new Set());
  const [logs, setLogs] = useState<Record<string, JobLogsTail>>({});

  const refresh = useCallback(async () => {
    try {
      setJobs(await jobsList(workPath));
      setError(null);
    } catch (err) {
      setError(String(err));
    }
  }, [workPath]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const runAction = async (
    jobId: string,
    action: (path: string, id: string) => Promise<JobStatus>,
  ) => {
    setBusyId(jobId);
    try {
      await action(workPath, jobId);
      await refresh();
      setError(null);
    } catch (err) {
      setError(String(err));
    } finally {
      setBusyId(null);
    }
  };

  const toggleLogs = async (jobId: string) => {
    const next = new Set(openLogs);
    if (next.has(jobId)) {
      next.delete(jobId);
      setOpenLogs(next);
      return;
    }
    next.add(jobId);
    setOpenLogs(next);
    try {
      const tail = await jobsReadLog(workPath, jobId);
      setLogs((prev) => ({ ...prev, [jobId]: tail }));
    } catch (err) {
      setError(String(err));
    }
  };

  return (
    <div className="settings-form jobs-settings-form">
      <section className="settings-section-panel">
        <div className="settings-section-heading">
          <div>
            <strong>{t("system.jobs.title")}</strong>
            <span>{t("system.jobs.description")}</span>
          </div>
          <button
            type="button"
            className="secondary-button"
            onClick={() => void refresh()}
            disabled={busyId !== null}
          >
            <RefreshCcw size={14} />
            <span>{t("system.jobs.refresh")}</span>
          </button>
        </div>
        {error ? <p className="jobs-error">{error}</p> : null}
        {jobs === null ? (
          <p className="muted">{t("system.jobs.loading")}</p>
        ) : jobs.length === 0 ? (
          <p className="muted">{t("system.jobs.empty")}</p>
        ) : (
          <ul className="jobs-list">
            {jobs.map((job) => (
              <li key={job.id} className="jobs-list-item">
                <div className="jobs-list-header">
                  <div className="jobs-list-title">
                    <strong>{job.title}</strong>
                    <span className="muted">{scheduleSummary(job)}</span>
                  </div>
                  <div className="jobs-list-badges">
                    <span
                      className="status-pill"
                      data-status={job.installed ? "active" : "draft"}
                    >
                      {job.installed
                        ? t("system.jobs.badge.installed")
                        : t("system.jobs.badge.notInstalled")}
                    </span>
                    <span className="status-pill" data-status={job.loaded ? "active" : ""}>
                      {job.loaded
                        ? t("system.jobs.badge.loaded")
                        : t("system.jobs.badge.notLoaded")}
                    </span>
                    <span className="status-pill" data-status={job.enabled ? "active" : "draft"}>
                      {job.enabled
                        ? t("system.jobs.badge.enabled")
                        : t("system.jobs.badge.disabled")}
                    </span>
                    {job.lastExitCode !== null ? (
                      <span
                        className="status-pill"
                        data-status={job.lastExitCode === 0 ? "active" : "draft"}
                      >
                        {t("system.jobs.badge.lastExit", { code: job.lastExitCode })}
                      </span>
                    ) : null}
                  </div>
                </div>
                {job.description ? <p className="muted">{job.description}</p> : null}
                <div className="comms-settings-actions">
                  {job.installed ? (
                    <button
                      type="button"
                      className="secondary-button"
                      disabled={busyId !== null}
                      onClick={() => void runAction(job.id, jobsUninstall)}
                    >
                      <Trash2 size={14} />
                      <span>{t("system.jobs.uninstall")}</span>
                    </button>
                  ) : (
                    <button
                      type="button"
                      className="secondary-button"
                      disabled={busyId !== null}
                      onClick={() => void runAction(job.id, jobsInstall)}
                    >
                      <Download size={14} />
                      <span>{t("system.jobs.install")}</span>
                    </button>
                  )}
                  {job.enabled ? (
                    <button
                      type="button"
                      className="secondary-button"
                      disabled={busyId !== null}
                      onClick={() => void runAction(job.id, jobsStop)}
                    >
                      <Square size={14} />
                      <span>{t("system.jobs.stop")}</span>
                    </button>
                  ) : (
                    <button
                      type="button"
                      className="secondary-button"
                      disabled={busyId !== null || !job.installed}
                      onClick={() => void runAction(job.id, jobsStart)}
                    >
                      <Play size={14} />
                      <span>{t("system.jobs.start")}</span>
                    </button>
                  )}
                  <button
                    type="button"
                    className="secondary-button"
                    disabled={busyId !== null || !job.installed}
                    onClick={() => void runAction(job.id, jobsRunNow)}
                  >
                    <RotateCw size={14} />
                    <span>{t("system.jobs.runNow")}</span>
                  </button>
                  <button
                    type="button"
                    className="secondary-button"
                    onClick={() => void toggleLogs(job.id)}
                  >
                    {openLogs.has(job.id) ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
                    <span>{t("system.jobs.logs")}</span>
                  </button>
                </div>
                {openLogs.has(job.id) ? (
                  <div className="jobs-logs">
                    <strong className="muted">{t("system.jobs.logs.stdout")}</strong>
                    <pre>{logs[job.id]?.stdout || t("system.jobs.logs.empty")}</pre>
                    <strong className="muted">{t("system.jobs.logs.stderr")}</strong>
                    <pre>{logs[job.id]?.stderr || t("system.jobs.logs.empty")}</pre>
                  </div>
                ) : null}
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}

function scheduleSummary(job: JobStatus): string {
  const pad = (value: number) => String(value).padStart(2, "0");
  const time = `${pad(job.schedule.hour)}:${pad(job.schedule.minute)}`;
  const every =
    job.schedule.recoveryIntervalSeconds > 0
      ? ` + every ${job.schedule.recoveryIntervalSeconds}s`
      : "";
  return `${time}${every}`;
}
