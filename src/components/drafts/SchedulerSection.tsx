import { listen } from "@tauri-apps/api/event";
import { ChevronDown, ChevronRight, Play, Plus, Trash2 } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import type { ApprovalInput } from "../../approval/ApprovalDialog";
import {
  addSchedule,
  gapLogList,
  isTauri,
  listAiMissions,
  listSchedules,
  removeSchedule,
  runScheduleNow,
  setScheduleEnabled,
} from "../../lib/api";
import { formatRelativeDate } from "../../lib/document";
import { formatScheduleTime } from "../../lib/drafts";
import {
  buildGapFeedbackDigest,
  GAP_FEEDBACK_DEFAULT_MAX_ENTRIES,
} from "../../lib/gapAnalysis";
import { useTranslation } from "../../lib/i18n";
import type { AiRuntime, AiTaskIngestMinImportance } from "../../lib/settings";
import type { SkillRecord } from "../../lib/skills";
import {
  ingestTaskCandidateRun,
  isCompletedSchedulerSkillMission,
  type TaskIngestResult,
} from "../../lib/taskIngestion";
import type {
  MissionRecord,
  SchedulerChangedEvent,
  SchedulerErrorEvent,
  SchedulerFiredEvent,
  SchedulerSchedule,
} from "../../lib/types";
import { Button, IconButton } from "../ui/Button";
import { DialogSurface, DialogSurfaceTitle } from "../ui/DialogSurface";
import { Field, TextArea, TextInput } from "../ui/Field";
import { EmptyState, StatusBanner } from "../ui/ModeChrome";

interface SchedulerSectionProps {
  workPath: string | null;
  skills: SkillRecord[];
  defaultRuntime: AiRuntime;
  taskIngestMinImportance: AiTaskIngestMinImportance;
  onTaskIngestMinImportanceChange: (value: AiTaskIngestMinImportance) => void;
  onConfirmApproval: (input: ApprovalInput) => Promise<string | null>;
  onError: (message: string | null) => void;
  /** Called after an ingestion run created drafts so the pane can re-list. */
  onDraftsIngested?: () => void;
}

const RUNTIMES: AiRuntime[] = ["claude", "codex", "kimi", "kiro"];
const WEEKDAYS = [0, 1, 2, 3, 4, 5, 6];
const IMPORTANCE_LEVELS: AiTaskIngestMinImportance[] = ["low", "medium", "high"];

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function SchedulerSection({
  workPath,
  skills,
  defaultRuntime,
  taskIngestMinImportance,
  onTaskIngestMinImportanceChange,
  onConfirmApproval,
  onError,
  onDraftsIngested,
}: SchedulerSectionProps) {
  const { t, locale } = useTranslation();
  const [open, setOpen] = useState(false);
  const [schedules, setSchedules] = useState<SchedulerSchedule[]>([]);
  const [addOpen, setAddOpen] = useState(false);
  const [schedulerError, setSchedulerError] = useState<string | null>(null);
  const [ingesting, setIngesting] = useState(false);
  const [lastIngest, setLastIngest] = useState<TaskIngestResult | null>(null);

  const refresh = useCallback(async () => {
    if (!workPath) {
      setSchedules([]);
      return;
    }
    try {
      setSchedules(await listSchedules(workPath));
    } catch (error) {
      onError(errorMessage(error));
    }
  }, [onError, workPath]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  // Draft ingestion: a completed scheduler skill mission may carry a
  // maru_task_candidates_v1 artifact in its run events; import it as task
  // drafts once per run. Runs that finished while the pane was unmounted are
  // caught by the mount scan below; live completions arrive via mission
  // updates. Once-per-run and mutual exclusion live in ingestTaskCandidateRun,
  // not here — this section remounts on every mode switch while mission records
  // are process-global, so a ref-based guard replayed every completed run.
  const ingestRun = useCallback(
    async (runId: string) => {
      if (!workPath) return;
      setIngesting(true);
      try {
        const result = await ingestTaskCandidateRun(
          workPath,
          runId,
          taskIngestMinImportance,
        );
        if (!result) return;
        setLastIngest(result);
        if (result.created > 0) onDraftsIngested?.();
      } catch (error) {
        onError(errorMessage(error));
      } finally {
        setIngesting(false);
      }
    },
    [onDraftsIngested, onError, taskIngestMinImportance, workPath],
  );

  useEffect(() => {
    if (!workPath) return;
    let cancelled = false;
    void listAiMissions()
      .then((missions) => {
        if (cancelled) return;
        const completed = missions
          .filter(isCompletedSchedulerSkillMission)
          .sort((a, b) => a.startedAt.localeCompare(b.startedAt));
        for (const mission of completed) {
          void ingestRun(mission.id);
        }
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [ingestRun, workPath]);

  useEffect(() => {
    if (!workPath || !isTauri()) return;
    let disposed = false;
    let unlisten: (() => void) | null = null;
    void listen<MissionRecord>("ai://mission_update", (event) => {
      if (disposed || !isCompletedSchedulerSkillMission(event.payload)) return;
      void ingestRun(event.payload.id);
    })
      .then((off) => {
        unlisten = off;
      })
      .catch(() => undefined);
    return () => {
      disposed = true;
      unlisten?.();
    };
  }, [ingestRun, workPath]);

  useEffect(() => {
    if (!workPath || !isTauri()) return;
    let disposed = false;
    const unlisteners: Array<() => void> = [];
    const setup = async () => {
      unlisteners.push(
        await listen<SchedulerChangedEvent>("scheduler://changed", (event) => {
          if (disposed || event.payload.workPath !== workPath) return;
          void refresh();
        }),
        await listen<SchedulerFiredEvent>("scheduler://fired", (event) => {
          if (disposed || event.payload.workPath !== workPath) return;
          void refresh();
        }),
        await listen<SchedulerErrorEvent>("scheduler://error", (event) => {
          if (disposed || event.payload.workPath !== workPath) return;
          setSchedulerError(event.payload.message);
        }),
      );
      if (disposed) unlisteners.forEach((unlisten) => unlisten());
    };
    void setup().catch(() => undefined);
    return () => {
      disposed = true;
      unlisteners.forEach((unlisten) => unlisten());
    };
  }, [refresh, workPath]);

  const toggleEnabled = async (schedule: SchedulerSchedule) => {
    if (!workPath) return;
    try {
      await setScheduleEnabled(workPath, schedule.id, !schedule.enabled);
      void refresh();
    } catch (error) {
      onError(errorMessage(error));
    }
  };

  const runNow = async (schedule: SchedulerSchedule) => {
    if (!workPath) return;
    try {
      await runScheduleNow(workPath, schedule.id);
      void refresh();
    } catch (error) {
      onError(errorMessage(error));
    }
  };

  const remove = async (schedule: SchedulerSchedule) => {
    if (!workPath) return;
    if (!window.confirm(t("drafts.automation.removeConfirm", { name: schedule.name }))) return;
    try {
      await removeSchedule(workPath, schedule.id);
      void refresh();
    } catch (error) {
      onError(errorMessage(error));
    }
  };

  const daysLabel = (schedule: SchedulerSchedule) =>
    schedule.daysOfWeek.length === 0
      ? t("drafts.automation.daily")
      : schedule.daysOfWeek.map((day) => t(`drafts.weekday.${day}`)).join(" ");

  return (
    <section className="drafts-automation" aria-label={t("drafts.automation.title")}>
      <div className="drafts-automation-header">
        <button
          type="button"
          className="drafts-automation-toggle"
          onClick={() => setOpen((current) => !current)}
          aria-expanded={open}
          title={t("drafts.automation.toggle")}
        >
          {open ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
          <strong>{t("drafts.automation.title")}</strong>
          <span className="drafts-automation-count">{schedules.length}</span>
        </button>
        {open ? (
          <Button
            type="button"
            size="sm"
            variant="ghost"
            icon={<Plus size={13} />}
            onClick={() => setAddOpen(true)}
            disabled={!workPath}
          >
            {t("drafts.automation.add")}
          </Button>
        ) : null}
      </div>

      {open ? (
        <div className="drafts-automation-body">
          {schedulerError ? (
            <StatusBanner tone="danger">
              <span>{schedulerError}</span>
            </StatusBanner>
          ) : null}
          <div className="drafts-automation-settings">
            <label className="drafts-automation-threshold">
              <span>{t("drafts.automation.minImportance")}</span>
              <select
                className="compact-select"
                value={taskIngestMinImportance}
                onChange={(event) =>
                  onTaskIngestMinImportanceChange(
                    event.target.value as AiTaskIngestMinImportance,
                  )
                }
              >
                {IMPORTANCE_LEVELS.map((level) => (
                  <option key={level} value={level}>
                    {t(`drafts.importance.${level}`)}
                  </option>
                ))}
              </select>
            </label>
            {ingesting ? (
              <span className="drafts-automation-ingest" role="status">
                {t("drafts.automation.ingesting")}
              </span>
            ) : lastIngest ? (
              <span className="drafts-automation-ingest" role="status">
                {t("drafts.automation.lastIngest", {
                  created: lastIngest.created,
                  skippedLow: lastIngest.skippedLow,
                  skippedDup: lastIngest.skippedDup,
                })}
              </span>
            ) : null}
          </div>
          {schedules.length === 0 ? (
            <EmptyState title={t("drafts.automation.empty")} />
          ) : (
            <ul className="drafts-schedule-list">
              {schedules.map((schedule) => (
                <li key={schedule.id} className="drafts-schedule-row">
                  <label className="drafts-schedule-enabled">
                    <input
                      type="checkbox"
                      checked={schedule.enabled}
                      onChange={() => void toggleEnabled(schedule)}
                      aria-label={t("drafts.automation.enabled")}
                    />
                  </label>
                  <div className="drafts-schedule-info">
                    <strong>{schedule.name}</strong>
                    <span>
                      {formatScheduleTime(schedule.hour, schedule.minute)} · {daysLabel(schedule)} ·{" "}
                      {schedule.skillId}
                    </span>
                    <span className="drafts-schedule-runs">
                      {t("drafts.automation.lastRun", {
                        time: schedule.lastRunAt
                          ? formatRelativeDate(schedule.lastRunAt, locale)
                          : t("drafts.automation.never"),
                      })}
                      {" · "}
                      {t("drafts.automation.nextRun", {
                        time: schedule.nextRunAt
                          ? formatRelativeDate(schedule.nextRunAt, locale)
                          : t("drafts.automation.never"),
                      })}
                    </span>
                  </div>
                  <div className="drafts-schedule-actions">
                    <IconButton
                      label={t("drafts.automation.runNow")}
                      size="sm"
                      onClick={() => void runNow(schedule)}
                    >
                      <Play size={13} />
                    </IconButton>
                    <IconButton
                      label={t("drafts.automation.remove")}
                      size="sm"
                      onClick={() => void remove(schedule)}
                    >
                      <Trash2 size={13} />
                    </IconButton>
                  </div>
                </li>
              ))}
            </ul>
          )}
        </div>
      ) : null}

      <AddScheduleDialog
        open={addOpen}
        workPath={workPath}
        skills={skills}
        defaultRuntime={defaultRuntime}
        onConfirmApproval={onConfirmApproval}
        onClose={() => setAddOpen(false)}
        onError={onError}
        onAdded={() => {
          setAddOpen(false);
          void refresh();
        }}
      />
    </section>
  );
}

interface AddScheduleDialogProps {
  open: boolean;
  workPath: string | null;
  skills: SkillRecord[];
  defaultRuntime: AiRuntime;
  onConfirmApproval: (input: ApprovalInput) => Promise<string | null>;
  onClose: () => void;
  onError: (message: string | null) => void;
  onAdded: () => void;
}

function AddScheduleDialog({
  open,
  workPath,
  skills,
  defaultRuntime,
  onConfirmApproval,
  onClose,
  onError,
  onAdded,
}: AddScheduleDialogProps) {
  const { t } = useTranslation();
  const [name, setName] = useState("");
  const [skillId, setSkillId] = useState("");
  const [runtime, setRuntime] = useState<AiRuntime>(defaultRuntime);
  const [prompt, setPrompt] = useState("");
  const [hour, setHour] = useState(7);
  const [minute, setMinute] = useState(0);
  const [daysOfWeek, setDaysOfWeek] = useState<number[]>([]);
  const [enabled, setEnabled] = useState(true);
  const [busy, setBusy] = useState(false);
  const [gapDigest, setGapDigest] = useState<string | null>(null);

  const showGapDigest = skillId.includes("inbox-process");

  useEffect(() => {
    if (!open) return;
    setName("");
    setSkillId(skills[0]?.id ?? "");
    setRuntime(defaultRuntime);
    setPrompt("");
    setHour(7);
    setMinute(0);
    setDaysOfWeek([]);
    setEnabled(true);
  }, [open, skills, defaultRuntime]);

  // Read-only preview of the gap-feedback digest. The stored prompt stays
  // bare: the Rust scheduler strips any stale section and attaches the digest
  // fresh at each dispatch (see build_dispatch_prompt in scheduler.rs). A
  // gap-log read failure just hides the preview.
  useEffect(() => {
    if (!open || !workPath || !showGapDigest) {
      setGapDigest(null);
      return;
    }
    let cancelled = false;
    gapLogList(workPath, GAP_FEEDBACK_DEFAULT_MAX_ENTRIES)
      .then((entries) => {
        if (!cancelled) {
          setGapDigest(buildGapFeedbackDigest(entries, GAP_FEEDBACK_DEFAULT_MAX_ENTRIES));
        }
      })
      .catch(() => {
        if (!cancelled) setGapDigest(null);
      });
    return () => {
      cancelled = true;
    };
  }, [open, workPath, showGapDigest]);

  if (!open) return null;

  const submit = async () => {
    // The Rust side rejects a blank prompt; the digest is attached at
    // dispatch time, so the stored prompt carries the user's words only.
    if (!workPath || busy || !name.trim() || !skillId.trim() || !prompt.trim()) return;
    setBusy(true);
    onError(null);
    try {
      const approvalId = await onConfirmApproval({
        kind: "scheduler.add",
        summary: t("approval.scheduler.add.summary", { name: name.trim() }),
        target: `${formatScheduleTime(hour, minute)} ${skillId.trim()}`,
      });
      if (!approvalId) return;
      await addSchedule(
        workPath,
        {
          name: name.trim(),
          skillId: skillId.trim(),
          runtime,
          prompt: prompt.trim(),
          hour,
          minute,
          daysOfWeek,
          enabled,
        },
        approvalId,
      );
      onAdded();
    } catch (error) {
      onError(errorMessage(error));
    } finally {
      setBusy(false);
    }
  };

  return (
    <DialogSurface
      open
      onOpenChange={(nextOpen) => {
        if (!nextOpen) onClose();
      }}
      ariaLabel={t("drafts.schedule.title")}
      className="drafts-schedule-dialog"
    >
      <DialogSurfaceTitle>{t("drafts.schedule.title")}</DialogSurfaceTitle>
      <div className="drafts-schedule-form">
        <Field label={t("drafts.schedule.name")}>
          <TextInput value={name} onChange={(event) => setName(event.target.value)} />
        </Field>
        <Field label={t("drafts.schedule.skill")}>
          {skills.length > 0 ? (
            <select
              className="compact-select"
              value={skillId}
              onChange={(event) => setSkillId(event.target.value)}
            >
              {skills.map((skill) => (
                <option key={skill.id} value={skill.id}>
                  {skill.title || skill.name || skill.id}
                </option>
              ))}
            </select>
          ) : (
            <TextInput value={skillId} onChange={(event) => setSkillId(event.target.value)} />
          )}
        </Field>
        <Field label={t("drafts.schedule.runtime")}>
          <select
            className="compact-select"
            value={runtime}
            onChange={(event) => setRuntime(event.target.value as AiRuntime)}
          >
            {RUNTIMES.map((id) => (
              <option key={id} value={id}>
                {id}
              </option>
            ))}
          </select>
        </Field>
        <Field label={t("drafts.schedule.prompt")}>
          <TextArea
            rows={3}
            value={prompt}
            onChange={(event) => setPrompt(event.target.value)}
          />
        </Field>
        {showGapDigest && (
          <div className="drafts-schedule-gap-digest">
            <div className="drafts-schedule-gap-digest-title">
              {t("drafts.schedule.gapDigest.title")}
            </div>
            <p className="drafts-schedule-gap-digest-note">
              {t("drafts.schedule.gapDigest.note")}
            </p>
            {gapDigest && (
              <pre className="drafts-schedule-gap-digest-body">{gapDigest}</pre>
            )}
          </div>
        )}
        <Field label={t("drafts.schedule.time")}>
          <div className="drafts-schedule-time">
            <TextInput
              type="number"
              min={0}
              max={23}
              value={hour}
              onChange={(event) => setHour(Number(event.target.value))}
            />
            <TextInput
              type="number"
              min={0}
              max={59}
              value={minute}
              onChange={(event) => setMinute(Number(event.target.value))}
            />
          </div>
        </Field>
        <Field label={t("drafts.schedule.days")}>
          <div className="drafts-schedule-days">
            {WEEKDAYS.map((day) => (
              <label key={day}>
                <input
                  type="checkbox"
                  checked={daysOfWeek.includes(day)}
                  onChange={(event) =>
                    setDaysOfWeek((current) =>
                      event.target.checked
                        ? [...current, day].sort((a, b) => a - b)
                        : current.filter((value) => value !== day),
                    )
                  }
                />
                <span>{t(`drafts.weekday.${day}`)}</span>
              </label>
            ))}
          </div>
        </Field>
        <label className="drafts-schedule-enabled-field">
          <input
            type="checkbox"
            checked={enabled}
            onChange={(event) => setEnabled(event.target.checked)}
          />
          <span>{t("drafts.schedule.enabled")}</span>
        </label>
      </div>
      <div className="dialog-actions">
        <Button type="button" variant="ghost" onClick={onClose} disabled={busy}>
          {t("dialog.cancel")}
        </Button>
        <Button
          type="button"
          onClick={() => void submit()}
          disabled={busy || !name.trim() || !skillId.trim() || !prompt.trim()}
        >
          {t("drafts.schedule.submit")}
        </Button>
      </div>
    </DialogSurface>
  );
}
