import { useState } from "react";
import { X } from "lucide-react";
import { useTranslation } from "../../lib/i18n";
import type { CreateTaskDraft, TaskBucket } from "../../lib/types";
import { Button } from "../ui/Button";
import {
  DialogSurface,
  DialogSurfaceClose,
  DialogSurfaceTitle,
} from "../ui/DialogSurface";

interface NewTaskDialogProps {
  open: boolean;
  onClose: () => void;
  onCreate: (draft: CreateTaskDraft) => Promise<void>;
}

export function NewTaskDialog({ open, onClose, onCreate }: NewTaskDialogProps) {
  const { t } = useTranslation();
  const [title, setTitle] = useState("");
  const [project, setProject] = useState("");
  const [due, setDue] = useState("");
  const [calendarStart, setCalendarStart] = useState("");
  const [calendarEnd, setCalendarEnd] = useState("");
  const [estimateMinutes, setEstimateMinutes] = useState("");
  const [priority, setPriority] = useState("medium");
  const [bucket, setBucket] = useState<TaskBucket>("active");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const submit = async () => {
    if (!title.trim()) {
      setError(t("tasks.new.titleRequired"));
      return;
    }
    const parsedEstimateMinutes = parseEstimateMinutes(estimateMinutes);
    setBusy(true);
    setError(null);
    try {
      await onCreate({
        slug: title,
        title,
        bucket,
        frontmatter: {
          title,
          status: bucket === "backlog" ? "backlog" : "active",
          priority,
          ...(project.trim() ? { project: project.trim() } : {}),
          ...(due ? { due } : {}),
          ...(calendarStart ? { calendarStart } : {}),
          ...(calendarEnd ? { calendarEnd } : {}),
          ...(parsedEstimateMinutes ? { estimateMinutes: parsedEstimateMinutes } : {}),
        },
        body: `# ${title.trim()}\n\n`,
      });
      setTitle("");
      setProject("");
      setDue("");
      setCalendarStart("");
      setCalendarEnd("");
      setEstimateMinutes("");
      setPriority("medium");
      setBucket("active");
      onClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <DialogSurface
      open={open}
      onOpenChange={(nextOpen) => {
        if (!nextOpen) onClose();
      }}
      className="task-new-dialog"
    >
        <header>
          <div>
            <DialogSurfaceTitle>{t("tasks.new.title")}</DialogSurfaceTitle>
            <p>{t("tasks.new.description")}</p>
          </div>
          <DialogSurfaceClose>
            <button
              type="button"
              className="icon-button"
              title={t("app.close")}
              aria-label={t("app.close")}
            >
              <X size={16} />
            </button>
          </DialogSurfaceClose>
        </header>
        {error ? <div className="inbox-error">{error}</div> : null}
        <div className="settings-form">
          <label className="field">
            <span>{t("tasks.new.field.title")}</span>
            <input value={title} onChange={(event) => setTitle(event.target.value)} autoFocus />
          </label>
          <div className="settings-grid two">
            <label className="field">
              <span>{t("tasks.new.field.project")}</span>
              <input value={project} onChange={(event) => setProject(event.target.value)} />
            </label>
            <label className="field">
              <span>{t("tasks.new.field.due")}</span>
              <input type="date" value={due} onChange={(event) => setDue(event.target.value)} />
            </label>
          </div>
          <div className="settings-grid two">
            <label className="field">
              <span>{t("tasks.new.field.start")}</span>
              <input
                type="datetime-local"
                value={calendarStart}
                onChange={(event) => setCalendarStart(event.target.value)}
              />
            </label>
            <label className="field">
              <span>{t("tasks.new.field.end")}</span>
              <input
                type="datetime-local"
                value={calendarEnd}
                onChange={(event) => setCalendarEnd(event.target.value)}
              />
            </label>
          </div>
          <div className="settings-grid two">
            <label className="field">
              <span>{t("tasks.new.field.priority")}</span>
              <select value={priority} onChange={(event) => setPriority(event.target.value)}>
                <option value="highest">{t("tasks.priority.highest")}</option>
                <option value="high">{t("tasks.priority.high")}</option>
                <option value="medium">{t("tasks.priority.medium")}</option>
                <option value="low">{t("tasks.priority.low")}</option>
              </select>
            </label>
            <label className="field">
              <span>{t("tasks.new.field.bucket")}</span>
              <select value={bucket} onChange={(event) => setBucket(event.target.value as TaskBucket)}>
                <option value="active">{t("tasks.filter.active")}</option>
                <option value="backlog">{t("tasks.filter.backlog")}</option>
                <option value="calendar">{t("tasks.filter.calendar")}</option>
              </select>
            </label>
          </div>
          <label className="field">
            <span>{t("tasks.new.field.estimate")}</span>
            <input
              type="number"
              min="1"
              step="1"
              value={estimateMinutes}
              onChange={(event) => setEstimateMinutes(event.target.value)}
            />
          </label>
        </div>
        <footer>
          <Button size="sm" variant="ghost" onClick={onClose}>
            {t("dialog.cancel")}
          </Button>
          <Button size="sm" variant="primary" disabled={busy} onClick={() => void submit()}>
            {t("tasks.actions.create")}
          </Button>
        </footer>
    </DialogSurface>
  );
}

function parseEstimateMinutes(value: string): number | null {
  const trimmed = value.trim();
  if (!trimmed) return null;
  const parsed = Number(trimmed);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
}
