import {
  FolderOpen,
  PanelRightClose,
  PanelRightOpen,
  Play,
  Save,
  WandSparkles,
} from "lucide-react";
import { useEffect, useState } from "react";
import { useTranslation } from "../../lib/i18n";
import type { TaskEntry } from "../../lib/tasks";
import type { TaskMetadata, TaskSchedulePatch } from "../../lib/types";
import type { SkillContextItem, SkillRecord } from "../../lib/skills";
import type { DocumentLabelMode } from "../../lib/settings";
import { resolveDisplayLabel } from "../../lib/document";
import { Button } from "../ui/Button";

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
  onUpdateSchedule: (entry: TaskEntry, fields: TaskSchedulePatch) => Promise<void>;
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
  onUpdateSchedule,
}: TaskDetailDrawerProps) {
  const { t } = useTranslation();
  const [project, setProject] = useState("");
  const [priority, setPriority] = useState("medium");
  const [due, setDue] = useState("");
  const [calendarStart, setCalendarStart] = useState("");
  const [calendarEnd, setCalendarEnd] = useState("");
  const [estimateMinutes, setEstimateMinutes] = useState("");
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    setProject(entry?.project ?? "");
    setPriority(entry?.priority === "none" ? "medium" : entry?.priority ?? "medium");
    setDue(entry?.due ?? "");
    setCalendarStart(toDateTimeInput(entry?.calendarStart));
    setCalendarEnd(toDateTimeInput(entry?.calendarEnd));
    setEstimateMinutes(String(readEstimateMinutes(entry?.frontmatter) ?? ""));
  }, [entry]);

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

  const context = [{ path: entry.absPath, kind: "document" }];
  const taskManagement = findSkill(skills, "task-management");

  const saveSchedule = async () => {
    setBusy(true);
    try {
      await onUpdateSchedule(entry, {
        project: project.trim() || null,
        priority,
        due: due || null,
        calendarStart: calendarStart || null,
        calendarEnd: calendarEnd || null,
        estimateMinutes: estimateMinutes.trim() ? Number(estimateMinutes) : null,
      });
    } finally {
      setBusy(false);
    }
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
          <h3>{t("tasks.detail.schedule")}</h3>
          <Button
            size="sm"
            variant="primary"
            icon={<Save size={14} />}
            disabled={busy}
            onClick={() => void saveSchedule()}
          >
            {t("tasks.actions.saveSchedule")}
          </Button>
        </header>
        <div className="settings-grid two">
          <label className="field">
            <span>{t("tasks.field.project")}</span>
            <input value={project} onChange={(event) => setProject(event.target.value)} />
          </label>
          <label className="field">
            <span>{t("tasks.field.priority")}</span>
            <select value={priority} onChange={(event) => setPriority(event.target.value)}>
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
              min="0"
              step="15"
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
          <dt>{t("tasks.field.status")}</dt>
          <dd>{t(`tasks.status.${statusKey(entry.status)}`)}</dd>
        </div>
        <div>
          <dt>{t("tasks.field.bucket")}</dt>
          <dd>{entry.bucket}</dd>
        </div>
      </dl>
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
      <section className="task-detail-section">
        <h3>{t("tasks.detail.preview")}</h3>
        {loading ? (
          <p className="muted">{t("tasks.loading")}</p>
        ) : (
          <pre className="task-preview">{metadata?.preview || t("tasks.detail.noPreview")}</pre>
        )}
      </section>
    </aside>
  );
}

function findSkill(skills: SkillRecord[], name: string): SkillRecord | null {
  const normalized = name.toLowerCase();
  return (
    skills.find((skill) => skill.id.toLowerCase() === normalized)
    ?? skills.find((skill) => skill.name.toLowerCase() === normalized)
    ?? null
  );
}

function statusKey(status: TaskEntry["status"]): string {
  return status === "in-progress" ? "inProgress" : status;
}

function toDateTimeInput(value: string | null | undefined): string {
  if (!value) return "";
  return value.slice(0, 16);
}

function readEstimateMinutes(frontmatter: Record<string, unknown> | undefined): number | null {
  const value = frontmatter?.estimateMinutes ?? frontmatter?.estimate_minutes;
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim() && Number.isFinite(Number(value))) {
    return Number(value);
  }
  return null;
}

function formatValue(value: unknown): string {
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  return JSON.stringify(value);
}
