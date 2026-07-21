// Maru Today — right-side overlay sheet for editing a task without leaving
// the Today workflow. Reuses the exact TaskFormFields controls the Tasks
// drawer renders (same updateTaskDetails save path); closes on backdrop
// click / Escape and restores focus to the previously focused element.

import { X } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { readTaskMetadata, updateTaskDetails } from "../../lib/api";
import { useTranslation } from "../../lib/i18n";
import type { TaskEntry } from "../../lib/tasks";
import type { TaskDetailsPatch, TaskMetadata } from "../../lib/types";
import { TaskFormFields } from "../tasks/TaskFormFields";
import { useToday } from "./todayContext";

interface TaskSheetProps {
  /** Task to edit. Null (or open=false) renders nothing. */
  entry: TaskEntry | null;
  open: boolean;
  onClose: () => void;
  /** Called after a successful save so the parent can refresh its task list. */
  onSaved?: () => void;
}

export function TaskSheet({ entry, open, onClose, onSaved }: TaskSheetProps) {
  const { t } = useTranslation();
  const { workPath } = useToday();
  const [metadata, setMetadata] = useState<TaskMetadata | null>(null);
  const [loading, setLoading] = useState(false);
  const [loadFailed, setLoadFailed] = useState(false);
  const closeRef = useRef<HTMLButtonElement | null>(null);
  const previousFocusRef = useRef<HTMLElement | null>(null);
  const entryRelPath = entry?.relPath ?? null;

  useEffect(() => {
    if (!open || !entryRelPath || !workPath) return;
    let cancelled = false;
    setMetadata(null);
    setLoadFailed(false);
    setLoading(true);
    readTaskMetadata(workPath, entryRelPath)
      .then((next) => {
        if (!cancelled) setMetadata(next);
      })
      .catch(() => {
        if (!cancelled) setLoadFailed(true);
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [open, entryRelPath, workPath]);

  useEffect(() => {
    if (!open) return;
    previousFocusRef.current =
      document.activeElement instanceof HTMLElement ? document.activeElement : null;
    closeRef.current?.focus();
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("keydown", onKeyDown);
      previousFocusRef.current?.focus();
    };
  }, [open, onClose]);

  if (!open || !entry) return null;

  const saveDetails = async (target: TaskEntry, fields: TaskDetailsPatch) => {
    if (!workPath) return;
    await updateTaskDetails(workPath, target.relPath, fields);
    onSaved?.();
  };

  return (
    <>
      <div className="dialog-overlay task-sheet-backdrop" onClick={onClose} />
      <aside
        className="task-sheet"
        role="dialog"
        aria-modal="true"
        aria-label={t("today.sheet.title")}
      >
        <header className="task-sheet-header">
          <h2 className="task-sheet-title">{entry.title}</h2>
          <button
            ref={closeRef}
            type="button"
            className="today-icon-button today-icon-button-sm"
            aria-label={t("today.sheet.close")}
            title={t("today.sheet.close")}
            onClick={onClose}
          >
            <X size={15} strokeWidth={1.9} aria-hidden="true" />
          </button>
        </header>
        <div className="task-sheet-body">
          {loadFailed ? (
            <p className="today-panel-empty">{t("today.sheet.loadError")}</p>
          ) : (
            <TaskFormFields
              entry={entry}
              metadata={metadata}
              loading={loading}
              onSaveDetails={saveDetails}
              onDirtyChange={() => {}}
            />
          )}
        </div>
      </aside>
    </>
  );
}
