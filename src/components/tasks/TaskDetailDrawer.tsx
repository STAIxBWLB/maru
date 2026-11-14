import {
  FolderOpen,
  PanelRightClose,
  PanelRightOpen,
  Play,
  WandSparkles,
} from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { findSkill } from "../../lib/agents";
import { useTranslation } from "../../lib/i18n";
import type { TaskEntry } from "../../lib/tasks";
import type { TaskDetailsPatch, TaskMetadata } from "../../lib/types";
import type { SkillContextItem, SkillRecord } from "../../lib/skills";
import type { DocumentLabelMode } from "../../lib/settings";
import { resolveDisplayLabel } from "../../lib/document";
import { Button } from "../ui/Button";
import { TaskFormFields } from "./TaskFormFields";
import { TaskCompletionSection } from "./TaskCompletionSection";
import type { ApprovalInput } from "../../approval/ApprovalDialog";
import { readDocument } from "../../lib/api";
import { setError } from "../../lib/errorStore";

interface TaskDetailDrawerProps {
  workPath: string | null;
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
    cwd?: string | null,
    onDispatched?: () => void | Promise<void>,
    metadata?: Record<string, unknown>,
  ) => void;
  onSaveDetails: (entry: TaskEntry, fields: TaskDetailsPatch) => Promise<void>;
  onDirtyChange: (dirty: boolean) => void;
  onCompletionChanged: () => void;
  onConfirmApproval: (input: ApprovalInput) => Promise<string | null>;
  onMissionStarted?: (id: string) => void;
  completionRefreshKey?: string | number;
}

export function TaskDetailDrawer({
  workPath,
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
  onCompletionChanged,
  onConfirmApproval,
  onMissionStarted,
  completionRefreshKey,
}: TaskDetailDrawerProps) {
  const { t } = useTranslation();
  const [dirty, setDirty] = useState(false);
  const [preparingRun, setPreparingRun] = useState(false);
  const runEpoch = useRef(0);
  const selectedTaskPath = entry?.relPath;
  useEffect(() => {
    runEpoch.current += 1;
    setPreparingRun(false);
    return () => { ++runEpoch.current; };
  }, [selectedTaskPath, workPath]);

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

  const openTaskRun = async (skill: SkillRecord | null, prompt?: string) => {
    if (preparingRun || !workPath) return;
    const generation = runEpoch.current;
    setPreparingRun(true);
    try {
      // A policy toggle changes the source revision. Capture both from the
      // same current document before seeding a tracked execution request.
      const current = await readDocument(workPath, entry.relPath);
      if (generation !== runEpoch.current) return;
      if (current.meta.maruCompletionRequired === true) {
        onOpenSkillCompose(skill, context, prompt, workPath, undefined, {
          taskExecution: { requestId: crypto.randomUUID(), taskPath: entry.relPath, sourceRevision: current.revision },
        });
      } else {
        onOpenSkillCompose(skill, context, prompt);
      }
    } catch (failure) {
      if (generation === runEpoch.current) setError(failure instanceof Error ? failure.message : String(failure));
    } finally {
      if (generation === runEpoch.current) setPreparingRun(false);
    }
  };

  const handleDirtyChange = (next: boolean) => {
    setDirty(next);
    onDirtyChange(next);
  };

  return (
    <aside className="task-detail-drawer">
      <header className="task-detail-header">
        <div>
          <span>{entry.projectLabels.join(", ") || t("tasks.project.none")}</span>
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
          disabled={preparingRun || !workPath}
          icon={<Play size={14} />}
          onClick={() =>
            void openTaskRun(
              taskManagement,
              `Review and update this task through task-management: ${entry.relPath}`,
            )
          }
        >
          {t("tasks.actions.runSkill")}
        </Button>
        <Button
          size="sm"
          variant="ghost"
          disabled={preparingRun || !workPath}
          icon={<WandSparkles size={14} />}
          onClick={() => { void openTaskRun(null); }}
        >
          {t("tasks.actions.otherSkill")}
        </Button>
      </div>
      <TaskFormFields
        entry={entry}
        metadata={metadata}
        loading={loading}
        onSaveDetails={onSaveDetails}
        onDirtyChange={handleDirtyChange}
      />
      {workPath ? <TaskCompletionSection
        workPath={workPath}
        taskPath={entry.relPath}
        onChanged={onCompletionChanged}
        onConfirmApproval={onConfirmApproval}
        onMissionStarted={onMissionStarted}
        refreshKey={completionRefreshKey}
      /> : null}
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
}


function formatValue(value: unknown): string {
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  return JSON.stringify(value);
}
