import * as Dialog from "@radix-ui/react-dialog";
import { Trash2, X } from "lucide-react";
import { useEffect, useState } from "react";

import { useTranslation } from "../../../lib/i18n";

export interface MemoDialogProps {
  open: boolean;
  initial: string;
  nodeTitle: string;
  onSave: (memo: string) => void;
  onDelete: () => void;
  onClose: () => void;
}

export function MemoDialog({ open, initial, nodeTitle, onSave, onDelete, onClose }: MemoDialogProps) {
  const { t } = useTranslation();
  const [value, setValue] = useState(initial);

  useEffect(() => {
    if (open) setValue(initial);
  }, [open, initial]);

  return (
    <Dialog.Root open={open} onOpenChange={(next) => { if (!next) onClose(); }}>
      <Dialog.Portal>
        <Dialog.Overlay className="dialog-overlay" />
        <Dialog.Content className="dialog-content anchor-diagram-memo-dialog">
          <div className="dialog-header">
            <Dialog.Title>
              {t("diagram.memo.dialog.title")}
              {nodeTitle ? <span className="anchor-diagram-memo-target"> · {nodeTitle}</span> : null}
            </Dialog.Title>
            <Dialog.Close asChild>
              <button
                type="button"
                className="icon-button"
                aria-label={t("diagram.memo.cancel")}
                title={t("diagram.memo.cancel")}
              >
                <X size={14} />
              </button>
            </Dialog.Close>
          </div>
          <textarea
            className="anchor-diagram-memo-text"
            value={value}
            onChange={(e) => setValue(e.target.value)}
            placeholder={t("diagram.memo.placeholder")}
            rows={8}
            aria-label={t("diagram.memo.dialog.title")}
          />
          <div className="anchor-diagram-memo-actions">
            <button
              type="button"
              onClick={onDelete}
              className="anchor-diagram-memo-delete"
              disabled={initial.length === 0}
              title={t("diagram.memo.delete")}
            >
              <Trash2 size={14} /> {t("diagram.memo.delete")}
            </button>
            <div style={{ display: "flex", gap: 6 }}>
              <button type="button" onClick={onClose}>{t("diagram.memo.cancel")}</button>
              <button
                type="button"
                className="anchor-diagram-toolbar-primary"
                onClick={() => onSave(value.trim())}
              >
                {t("diagram.memo.save")}
              </button>
            </div>
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
