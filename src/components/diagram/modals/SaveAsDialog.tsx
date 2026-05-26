import * as Dialog from "@radix-ui/react-dialog";
import { X } from "lucide-react";
import { useEffect, useRef, useState, type FormEvent } from "react";

import { useTranslation } from "../../../lib/i18n";

export interface SaveAsDialogProps {
  open: boolean;
  initialName: string;
  workspace: string | null;
  onConfirm: (name: string) => void;
  onCancel: () => void;
}

export function SaveAsDialog({ open, initialName, workspace, onConfirm, onCancel }: SaveAsDialogProps) {
  const { t } = useTranslation();
  const [name, setName] = useState(initialName);
  const inputRef = useRef<HTMLInputElement | null>(null);

  useEffect(() => {
    if (open) {
      setName(initialName);
      // Focus + select after the next paint.
      requestAnimationFrame(() => {
        inputRef.current?.focus();
        inputRef.current?.select();
      });
    }
  }, [open, initialName]);

  const submit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const trimmed = name.trim();
    if (!trimmed) return;
    onConfirm(trimmed);
  };

  return (
    <Dialog.Root
      open={open}
      onOpenChange={(next) => {
        if (!next) onCancel();
      }}
    >
      <Dialog.Portal>
        <Dialog.Overlay className="dialog-overlay" />
        <Dialog.Content className="dialog-content anchor-diagram-save-dialog">
          <form onSubmit={submit}>
            <div className="dialog-header">
              <Dialog.Title>{t("diagram.saveDialog.title")}</Dialog.Title>
              <Dialog.Close asChild>
                <button
                  type="button"
                  className="icon-button"
                  aria-label={t("diagram.saveDialog.cancel")}
                  title={t("diagram.saveDialog.cancel")}
                >
                  <X size={14} />
                </button>
              </Dialog.Close>
            </div>
            <label className="anchor-diagram-save-field">
              <span>{t("diagram.saveDialog.nameLabel")}</span>
              <input
                ref={inputRef}
                value={name}
                onChange={(e) => setName(e.target.value)}
                spellCheck={false}
                required
              />
            </label>
            <p className="anchor-diagram-save-hint">
              {t("diagram.saveDialog.hint", { workspace: workspace ?? "—" })}
            </p>
            <div className="anchor-diagram-save-actions">
              <button type="button" onClick={onCancel}>
                {t("diagram.saveDialog.cancel")}
              </button>
              <button type="submit" disabled={name.trim().length === 0} className="anchor-diagram-toolbar-primary">
                {t("diagram.saveDialog.confirm")}
              </button>
            </div>
          </form>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
