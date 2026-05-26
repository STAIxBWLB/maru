import * as Dialog from "@radix-ui/react-dialog";
import { X } from "lucide-react";
import { useState } from "react";

import { mermaidToDoc } from "../../../lib/diagram/mermaid";
import type { DiagramDoc } from "../../../lib/diagram/types";
import { useTranslation } from "../../../lib/i18n";

export interface ImportMermaidDialogProps {
  open: boolean;
  onApply: (doc: DiagramDoc) => void;
  onCancel: () => void;
}

const SAMPLE = `flowchart TD
  A[Start] --> B{Decide}
  B -->|yes| C((Ship))
  B -->|no| D((Wait))`;

export function ImportMermaidDialog({ open, onApply, onCancel }: ImportMermaidDialogProps) {
  const { t } = useTranslation();
  const [text, setText] = useState(SAMPLE);

  return (
    <Dialog.Root open={open} onOpenChange={(next) => { if (!next) onCancel(); }}>
      <Dialog.Portal>
        <Dialog.Overlay className="dialog-overlay" />
        <Dialog.Content className="dialog-content anchor-diagram-import-dialog">
          <div className="dialog-header">
            <Dialog.Title>{t("diagram.dialog.importMermaid.title")}</Dialog.Title>
            <Dialog.Close asChild>
              <button
                type="button"
                className="icon-button"
                aria-label={t("diagram.dialog.importMermaid.cancel")}
                title={t("diagram.dialog.importMermaid.cancel")}
              >
                <X size={14} />
              </button>
            </Dialog.Close>
          </div>
          <textarea
            value={text}
            onChange={(e) => setText(e.target.value)}
            placeholder={t("diagram.dialog.importMermaid.placeholder")}
            rows={10}
            spellCheck={false}
          />
          <p className="anchor-diagram-import-hint">{t("diagram.dialog.importMermaid.hint")}</p>
          <div className="anchor-diagram-import-actions">
            <button type="button" onClick={onCancel}>
              {t("diagram.dialog.importMermaid.cancel")}
            </button>
            <button
              type="button"
              className="anchor-diagram-toolbar-primary"
              onClick={() => onApply(mermaidToDoc(text))}
              disabled={text.trim().length === 0}
            >
              {t("diagram.dialog.importMermaid.apply")}
            </button>
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
