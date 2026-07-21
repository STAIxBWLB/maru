// Shared task detail form: title/status/project/priority/due/calendar range/
// estimate fields + markdown body editor, with pristine-draft dirty tracking
// and save/reset actions. Extracted from TaskDetailDrawer so the Today task
// sheet can render the exact same controls without forking the form.

import { RotateCcw, Save } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { useTranslation } from "../../lib/i18n";
import type { TaskEntry, TaskPriority } from "../../lib/tasks";
import type { TaskDetailsPatch, TaskMetadata, TaskStatus } from "../../lib/types";
import { Button } from "../ui/Button";
import { MarkdownSourceEditor } from "../studio/MarkdownSourceEditor";

interface TaskFormFieldsProps {
  entry: TaskEntry;
  metadata: TaskMetadata | null;
  loading: boolean;
  onSaveDetails: (entry: TaskEntry, fields: TaskDetailsPatch) => Promise<void>;
  onDirtyChange: (dirty: boolean) => void;
  /** Hide done/cancelled in the status picker. The Today sheet sets this:
   *  completion/cancellation must flow through `task_transition` (hash guard,
   *  outbox, events), never through this generic details save. */
  lifecycleStatusLocked?: boolean;
}

interface TaskDetailDraft {
  relPath: string;
  title: string;
  status: TaskStatus;
  project: string;
  priority: TaskPriority;
  due: string;
  calendarStart: string;
  calendarEnd: string;
  estimateMinutes: string;
  body: string;
}

export function TaskFormFields({
  entry,
  metadata,
  loading,
  onSaveDetails,
  onDirtyChange,
  lifecycleStatusLocked = false,
}: TaskFormFieldsProps) {
  const { t } = useTranslation();
  const [title, setTitle] = useState("");
  const [status, setStatus] = useState<TaskStatus>("active");
  const [project, setProject] = useState("");
  const [priority, setPriority] = useState<TaskPriority>("medium");
  const [due, setDue] = useState("");
  const [calendarStart, setCalendarStart] = useState("");
  const [calendarEnd, setCalendarEnd] = useState("");
  const [estimateMinutes, setEstimateMinutes] = useState("");
  const [body, setBody] = useState("");
  const [pristine, setPristine] = useState<TaskDetailDraft | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    const next = draftFromEntry(entry, metadata?.relPath === entry.relPath ? metadata : null);
    applyDraft(next);
    setPristine(next);
  }, [entry?.relPath]);

  const currentDraft = useMemo<TaskDetailDraft>(() => ({
    relPath: entry.relPath,
    title,
    status,
    project,
    priority,
    due,
    calendarStart,
    calendarEnd,
    estimateMinutes,
    body,
  }), [body, calendarEnd, calendarStart, due, entry.relPath, estimateMinutes, priority, project, status, title]);

  const dirty = pristine ? !draftsEqual(currentDraft, pristine) : false;

  useEffect(() => {
    onDirtyChange(dirty);
  }, [dirty, onDirtyChange]);

  useEffect(() => {
    if (metadata?.relPath !== entry.relPath) return;
    const next = draftFromEntry(entry, metadata);
    if (!dirty) {
      applyDraft(next);
      setPristine(next);
      return;
    }
    if (!body && metadata.body) {
      setBody(metadata.body);
      setPristine((current) => current ? { ...current, body: metadata.body } : next);
    }
  }, [body, dirty, entry, metadata]);

  const saveDetails = async () => {
    setBusy(true);
    try {
      const next = normalizeDraft(currentDraft);
      await onSaveDetails(entry, {
        title: next.title,
        status: next.status,
        project: next.project || null,
        priority: next.priority,
        due: next.due || null,
        calendarStart: next.calendarStart || null,
        calendarEnd: next.calendarEnd || null,
        estimateMinutes: parseEstimateMinutes(next.estimateMinutes),
        body: next.body,
      });
      applyDraft(next);
      setPristine(next);
    } finally {
      setBusy(false);
    }
  };

  const resetDetails = () => {
    if (!pristine) return;
    applyDraft(pristine);
  };

  return (
    <>
      <section className="task-schedule-editor">
        <header>
          <h3>{t("tasks.detail.edit")}</h3>
          <div className="task-detail-save-actions">
            <Button
              size="sm"
              variant="ghost"
              icon={<RotateCcw size={14} />}
              disabled={busy || !dirty}
              onClick={resetDetails}
            >
              {t("tasks.actions.resetDetails")}
            </Button>
            <Button
              size="sm"
              variant="primary"
              icon={<Save size={14} />}
              disabled={busy || loading || !dirty || !title.trim()}
              onClick={() => void saveDetails()}
            >
              {t("tasks.actions.saveDetails")}
            </Button>
          </div>
        </header>
        <label className="field">
          <span>{t("tasks.field.title")}</span>
          <input value={title} onChange={(event) => setTitle(event.target.value)} />
        </label>
        <div className="settings-grid two">
          <label className="field">
            <span>{t("tasks.field.status")}</span>
            <select value={status} onChange={(event) => setStatus(event.target.value as TaskStatus)}>
              <option value="active">{t("tasks.status.active")}</option>
              <option value="in-progress">{t("tasks.status.inProgress")}</option>
              {!lifecycleStatusLocked || status === "done" ? (
                <option value="done" disabled={lifecycleStatusLocked}>
                  {t("tasks.status.done")}
                </option>
              ) : null}
              {!lifecycleStatusLocked || status === "cancelled" ? (
                <option value="cancelled" disabled={lifecycleStatusLocked}>
                  {t("tasks.status.cancelled")}
                </option>
              ) : null}
              <option value="backlog">{t("tasks.status.backlog")}</option>
            </select>
          </label>
          <label className="field">
            <span>{t("tasks.field.project")}</span>
            <input value={project} onChange={(event) => setProject(event.target.value)} />
          </label>
        </div>
        <div className="settings-grid two">
          <label className="field">
            <span>{t("tasks.field.priority")}</span>
            <select value={priority} onChange={(event) => setPriority(event.target.value as TaskPriority)}>
              <option value="highest">{t("tasks.priority.highest")}</option>
              <option value="high">{t("tasks.priority.high")}</option>
              <option value="medium">{t("tasks.priority.medium")}</option>
              <option value="low">{t("tasks.priority.low")}</option>
              <option value="none">{t("tasks.priority.none")}</option>
            </select>
          </label>
        </div>
        <div className="settings-grid two">
          <label className="field">
            <span>{t("tasks.field.due")}</span>
            <input type="date" value={due} onChange={(event) => setDue(event.target.value)} />
          </label>
          <label className="field">
            <span>{t("tasks.field.estimate")}</span>
            <input
              type="number"
              min="1"
              step="1"
              value={estimateMinutes}
              onChange={(event) => setEstimateMinutes(event.target.value)}
            />
          </label>
        </div>
        <label className="field">
          <span>{t("tasks.field.start")}</span>
          <input
            type="datetime-local"
            value={calendarStart}
            onChange={(event) => setCalendarStart(event.target.value)}
          />
        </label>
        <label className="field">
          <span>{t("tasks.field.end")}</span>
          <input
            type="datetime-local"
            value={calendarEnd}
            onChange={(event) => setCalendarEnd(event.target.value)}
          />
        </label>
      </section>
      <section className="task-detail-section task-body-section">
        <h3>{t("tasks.detail.body")}</h3>
        {loading ? (
          <p className="muted">{t("tasks.loading")}</p>
        ) : (
          <div className="task-body-editor">
            <MarkdownSourceEditor value={body} onChange={setBody} readOnly={busy} />
          </div>
        )}
      </section>
    </>
  );

  function applyDraft(draft: TaskDetailDraft) {
    setTitle(draft.title);
    setStatus(draft.status);
    setProject(draft.project);
    setPriority(draft.priority);
    setDue(draft.due);
    setCalendarStart(draft.calendarStart);
    setCalendarEnd(draft.calendarEnd);
    setEstimateMinutes(draft.estimateMinutes);
    setBody(draft.body);
  }
}

function draftFromEntry(entry: TaskEntry, metadata: TaskMetadata | null): TaskDetailDraft {
  return {
    relPath: entry.relPath,
    title: scalarString(metadata?.frontmatter.title) ?? entry.title,
    status: entry.status,
    project: entry.project ?? "",
    priority: entry.priority,
    due: entry.due ?? "",
    calendarStart: toDateTimeInput(entry.calendarStart),
    calendarEnd: toDateTimeInput(entry.calendarEnd),
    estimateMinutes: String(readEstimateMinutes(entry.frontmatter) ?? ""),
    body: metadata?.body ?? "",
  };
}

function normalizeDraft(draft: TaskDetailDraft): TaskDetailDraft {
  return {
    ...draft,
    title: draft.title.trim(),
    project: draft.project.trim(),
    due: draft.due.trim(),
    calendarStart: draft.calendarStart.trim(),
    calendarEnd: draft.calendarEnd.trim(),
    estimateMinutes: draft.estimateMinutes.trim(),
  };
}

function draftsEqual(left: TaskDetailDraft, right: TaskDetailDraft): boolean {
  return (
    left.relPath === right.relPath
    && left.title.trim() === right.title.trim()
    && left.status === right.status
    && left.project.trim() === right.project.trim()
    && left.priority === right.priority
    && left.due.trim() === right.due.trim()
    && left.calendarStart.trim() === right.calendarStart.trim()
    && left.calendarEnd.trim() === right.calendarEnd.trim()
    && left.estimateMinutes.trim() === right.estimateMinutes.trim()
    && left.body === right.body
  );
}

function parseEstimateMinutes(value: string): number | null {
  const trimmed = value.trim();
  if (!trimmed) return null;
  const parsed = Number(trimmed);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
}

function toDateTimeInput(value: string | null | undefined): string {
  if (!value) return "";
  return value.slice(0, 16);
}

function readEstimateMinutes(frontmatter: Record<string, unknown> | undefined): number | null {
  const value = frontmatter?.estimateMinutes ?? frontmatter?.estimate_minutes;
  if (typeof value === "number" && Number.isFinite(value) && value > 0) return value;
  if (typeof value === "string" && value.trim() && Number.isFinite(Number(value))) {
    const parsed = Number(value);
    return parsed > 0 ? parsed : null;
  }
  return null;
}

function scalarString(value: unknown): string | null {
  if (typeof value === "string") {
    const trimmed = value.trim();
    return trimmed || null;
  }
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  return null;
}
