import {
  FolderOpen,
  PanelRightClose,
  PanelRightOpen,
  Play,
  RotateCcw,
  Save,
  WandSparkles,
} from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { useTranslation } from "../../lib/i18n";
import type { TaskEntry, TaskPriority } from "../../lib/tasks";
import type { TaskDetailsPatch, TaskMetadata, TaskStatus } from "../../lib/types";
import type { SkillContextItem, SkillRecord } from "../../lib/skills";
import type { DocumentLabelMode } from "../../lib/settings";
import { resolveDisplayLabel } from "../../lib/document";
import { Button } from "../ui/Button";
import { MarkdownSourceEditor } from "../studio/MarkdownSourceEditor";

interface TaskDetailDrawerProps {
  entry: TaskEntry | null;
  metadata: TaskMetadata | null;
  loading: boolean;
  labelMode: DocumentLabelMode;
  skills: SkillRecord[];
  collapsed: boolean;
  onToggleCollapsed: () => void;
  onRevealPath?: (path: string) => void;
  onOpenSkillCompose: (
    skill: SkillRecord | null,
    context: SkillContextItem[],
    prompt?: string,
  ) => void;
  onSaveDetails: (entry: TaskEntry, fields: TaskDetailsPatch) => Promise<void>;
  onDirtyChange: (dirty: boolean) => void;
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

export function TaskDetailDrawer({
  entry,
  metadata,
  loading,
  labelMode,
  skills,
  collapsed,
  onToggleCollapsed,
  onRevealPath,
  onOpenSkillCompose,
  onSaveDetails,
  onDirtyChange,
}: TaskDetailDrawerProps) {
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
    if (!entry) {
      const empty = emptyDraft();
      applyDraft(empty);
      setPristine(empty);
      return;
    }
    const next = draftFromEntry(entry, metadata?.relPath === entry.relPath ? metadata : null);
    applyDraft(next);
    setPristine(next);
  }, [entry?.relPath]);

  const currentDraft = useMemo<TaskDetailDraft>(() => ({
    relPath: entry?.relPath ?? "",
    title,
    status,
    project,
    priority,
    due,
    calendarStart,
    calendarEnd,
    estimateMinutes,
    body,
  }), [body, calendarEnd, calendarStart, due, entry?.relPath, estimateMinutes, priority, project, status, title]);

  const dirty = pristine ? !draftsEqual(currentDraft, pristine) : false;

  useEffect(() => {
    onDirtyChange(dirty);
  }, [dirty, onDirtyChange]);

  useEffect(() => {
    if (!entry || metadata?.relPath !== entry.relPath) return;
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

  if (collapsed) {
    return (
      <aside className="task-detail-drawer collapsed">
        <button
          type="button"
          className="icon-button"
          onClick={onToggleCollapsed}
          title={t("tasks.actions.expandDetails")}
          aria-label={t("tasks.actions.expandDetails")}
        >
          <PanelRightOpen size={15} />
        </button>
      </aside>
    );
  }

  if (!entry) {
    return (
      <aside className="task-detail-drawer empty">
        <button
          type="button"
          className="icon-button"
          onClick={onToggleCollapsed}
          title={t("tasks.actions.collapseDetails")}
          aria-label={t("tasks.actions.collapseDetails")}
        >
          <PanelRightClose size={15} />
        </button>
        <span>{t("tasks.detail.empty")}</span>
      </aside>
    );
  }

  const context: SkillContextItem[] = [{ path: entry.absPath, kind: "document" }];
  const taskManagement = findSkill(skills, "task-management");

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
    <aside className="task-detail-drawer">
      <header className="task-detail-header">
        <div>
          <span>{entry.project ?? t("tasks.project.none")}</span>
          <h2>{resolveDisplayLabel(entry.title, entry.fileName, labelMode).primary}</h2>
          <p>{entry.relPath}</p>
        </div>
        <div className="task-detail-header-actions">
          <span className={dirty ? "save-state dirty" : "save-state saved"}>
            {dirty ? t("tasks.detail.unsaved") : t("tasks.detail.saved")}
          </span>
          {onRevealPath ? (
            <button
              type="button"
              className="icon-button"
              onClick={() => onRevealPath(entry.absPath)}
              title={t("context.revealInFinder")}
              aria-label={t("context.revealInFinder")}
            >
              <FolderOpen size={14} />
            </button>
          ) : null}
          <button
            type="button"
            className="icon-button"
            onClick={onToggleCollapsed}
            title={t("tasks.actions.collapseDetails")}
            aria-label={t("tasks.actions.collapseDetails")}
          >
            <PanelRightClose size={15} />
          </button>
        </div>
      </header>
      <div className="task-detail-actions">
        <Button
          size="sm"
          variant="secondary"
          icon={<Play size={14} />}
          onClick={() =>
            onOpenSkillCompose(
              taskManagement,
              context,
              `Review and update this task through task-management: ${entry.relPath}`,
            )
          }
        >
          {t("tasks.actions.runSkill")}
        </Button>
        <Button
          size="sm"
          variant="ghost"
          icon={<WandSparkles size={14} />}
          onClick={() => onOpenSkillCompose(null, context)}
        >
          {t("tasks.actions.otherSkill")}
        </Button>
      </div>
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
              <option value="done">{t("tasks.status.done")}</option>
              <option value="cancelled">{t("tasks.status.cancelled")}</option>
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
      <dl className="task-detail-meta">
        <div>
          <dt>{t("tasks.field.bucket")}</dt>
          <dd>{entry.bucket}</dd>
        </div>
        <div>
          <dt>{t("tasks.detail.stats")}</dt>
          <dd>{metadata ? t("tasks.detail.statsValue", { lines: metadata.lineCount, chars: metadata.charCount }) : "—"}</dd>
        </div>
      </dl>
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
      <section className="task-detail-section">
        <h3>{t("tasks.detail.frontmatter")}</h3>
        <div className="task-frontmatter-list">
          {Object.entries(metadata?.frontmatter ?? entry.frontmatter).map(([key, value]) => (
            <div key={key}>
              <span>{key}</span>
              <code>{formatValue(value)}</code>
            </div>
          ))}
        </div>
      </section>
    </aside>
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

function findSkill(skills: SkillRecord[], name: string): SkillRecord | null {
  const normalized = name.toLowerCase();
  return (
    skills.find((skill) => skill.id.toLowerCase() === normalized)
    ?? skills.find((skill) => skill.name.toLowerCase() === normalized)
    ?? null
  );
}

function emptyDraft(): TaskDetailDraft {
  return {
    relPath: "",
    title: "",
    status: "active",
    project: "",
    priority: "medium",
    due: "",
    calendarStart: "",
    calendarEnd: "",
    estimateMinutes: "",
    body: "",
  };
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

function formatValue(value: unknown): string {
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  return JSON.stringify(value);
}
