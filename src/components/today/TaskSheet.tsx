// Maru Today — right-side overlay sheet for editing a task without leaving
// the Today workflow. Reuses the exact TaskFormFields controls the Tasks
// drawer renders (same updateTaskDetails save path); closes on backdrop
// click / Escape and restores focus to the previously focused element.

import { X } from "lucide-react";
import * as Dialog from "@radix-ui/react-dialog";
import { useEffect, useState } from "react";
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
  const [lastEntry, setLastEntry] = useState<TaskEntry | null>(entry);
  const entryRelPath = entry?.relPath ?? null;

  useEffect(() => {
    if (entry) setLastEntry(entry);
  }, [entry]);

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

  const renderEntry = entry ?? lastEntry;
  if (!renderEntry) return null;

  const saveDetails = async (target: TaskEntry, fields: TaskDetailsPatch) => {
    if (!workPath) return;
    await updateTaskDetails(workPath, target.relPath, fields);
    onSaved?.();
  };

  return (
    <Dialog.Root
      open={open && Boolean(entry)}
      onOpenChange={(nextOpen) => {
        if (!nextOpen) onClose();
      }}
    >
      <Dialog.Portal>
        <Dialog.Overlay className="dialog-overlay task-sheet-backdrop" />
        <Dialog.Content className="task-sheet" aria-describedby={undefined}>
          <header className="task-sheet-header">
            <Dialog.Title className="task-sheet-title">{renderEntry.title}</Dialog.Title>
            <Dialog.Close asChild>
              <button
                type="button"
                className="today-icon-button today-icon-button-sm"
                aria-label={t("today.sheet.close")}
                title={t("today.sheet.close")}
              >
                <X size={15} strokeWidth={1.9} aria-hidden="true" />
              </button>
            </Dialog.Close>
          </header>
          <div className="task-sheet-body">
            {loadFailed ? (
              <p className="today-panel-empty">{t("today.sheet.loadError")}</p>
            ) : (
              <TaskFormFields
                entry={renderEntry}
                metadata={metadata}
                loading={loading}
                onSaveDetails={saveDetails}
                onDirtyChange={() => {}}
                lifecycleStatusLocked
              />
            )}
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
