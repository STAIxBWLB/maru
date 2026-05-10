import { Check, FolderInput, Play, X } from "lucide-react";
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
  if (count <= 0) return null;
  return (
    <div className="bulk-action-bar" role="toolbar" aria-label="Selected inbox actions">
      <strong>선택 {count}건</strong>
      <Button type="button" size="sm" disabled={busy || decisionCount === 0} onClick={onAccept}>
        <Check size={14} />
        모두 accept
      </Button>
      <Button
        type="button"
        size="sm"
        variant="ghost"
        disabled={busy || decisionCount === 0}
        onClick={onReject}
      >
        <X size={14} />
        모두 reject
      </Button>
      <Button
        type="button"
        size="sm"
        variant="ghost"
        disabled={busy || fileCount === 0}
        onClick={onMoveFiles}
      >
        <FolderInput size={14} />
        폴더로 이동
      </Button>
      <Button
        type="button"
        size="sm"
        variant="ghost"
        disabled={busy || entryCount === 0}
        onClick={onProcess}
      >
        <Play size={14} />
        Process
      </Button>
      <button
        type="button"
        className="icon-button"
        disabled={busy}
        onClick={onCancel}
        aria-label="선택 해제"
        title="선택 해제"
      >
        <X size={14} />
      </button>
    </div>
  );
}
