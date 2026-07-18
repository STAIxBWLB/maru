import { Check, FolderInput, Play, X } from "lucide-react";
import { useTranslation } from "../lib/i18n";
import { Button } from "./ui/Button";

interface BulkActionBarProps {
  count: number;
  fileCount: number;
  entryCount: number;
  decisionCount: number;
  busy?: boolean;
  onAccept: () => void;
  onReject: () => void;
  onMoveFiles: () => void;
  onProcess: () => void;
  onCancel: () => void;
}

export function BulkActionBar({
  count,
  fileCount,
  entryCount,
  decisionCount,
  busy = false,
  onAccept,
  onReject,
  onMoveFiles,
  onProcess,
  onCancel,
}: BulkActionBarProps) {
  const { t } = useTranslation();
  if (count <= 0) return null;
  return (
    <div className="bulk-action-bar" role="toolbar" aria-label={t("inbox.bulk.toolbar")}>
      <strong>{t("inbox.bulk.selectedCount", { count })}</strong>
      <Button type="button" size="sm" disabled={busy || decisionCount === 0} onClick={onAccept}>
        <Check size={14} />
        {t("inbox.bulk.acceptAll")}
      </Button>
      <Button
        type="button"
        size="sm"
        variant="ghost"
        disabled={busy || decisionCount === 0}
        onClick={onReject}
      >
        <X size={14} />
        {t("inbox.bulk.rejectAll")}
      </Button>
      <Button
        type="button"
        size="sm"
        variant="ghost"
        disabled={busy || fileCount === 0}
        onClick={onMoveFiles}
      >
        <FolderInput size={14} />
        {t("inbox.bulk.moveToFolder")}
      </Button>
      <Button
        type="button"
        size="sm"
        variant="ghost"
        disabled={busy || entryCount === 0}
        onClick={onProcess}
      >
        <Play size={14} />
        {t("inbox.process")}
      </Button>
      <button
        type="button"
        className="icon-button"
        disabled={busy}
        onClick={onCancel}
        aria-label={t("inbox.bulk.clearSelection")}
        title={t("inbox.bulk.clearSelection")}
      >
        <X size={14} />
      </button>
    </div>
  );
}
