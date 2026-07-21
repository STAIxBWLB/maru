import * as Dialog from "@radix-ui/react-dialog";
import { FileText, X } from "lucide-react";

import { useTranslation } from "../../../lib/i18n";

export interface ReportTargetDocument {
  path: string;
  title: string;
}

export interface ReportTargetDialogProps {
  open: boolean;
  documents: ReportTargetDocument[];
  onChoose: (path: string) => void;
  onClose: () => void;
}

/**
 * Recent-document chooser for "Insert/Update in report" when no Markdown
 * document is active in the editor. Plain list modal — picking an entry runs
 * the insert flow against that document.
 */
export function ReportTargetDialog({
  open,
  documents,
  onChoose,
  onClose,
}: ReportTargetDialogProps) {
  const { t } = useTranslation();
  return (
    <Dialog.Root
      open={open}
      onOpenChange={(next) => {
        if (!next) onClose();
      }}
    >
      <Dialog.Portal>
        <Dialog.Overlay className="dialog-overlay" />
        <Dialog.Content className="dialog-content maru-diagram-save-dialog">
          <div className="dialog-header">
            <Dialog.Title>{t("diagram.report.chooseTitle")}</Dialog.Title>
            <Dialog.Close asChild>
              <button
                type="button"
                className="icon-button"
                aria-label={t("diagram.report.chooseCancel")}
                title={t("diagram.report.chooseCancel")}
              >
                <X size={14} />
              </button>
            </Dialog.Close>
          </div>
          <p className="maru-diagram-save-hint">{t("diagram.report.chooseHint")}</p>
          {documents.length === 0 ? (
            <p className="maru-diagram-save-hint">{t("diagram.report.chooseEmpty")}</p>
          ) : (
            <ul className="maru-diagram-report-targets">
              {documents.map((doc) => (
                <li key={doc.path}>
                  <button type="button" onClick={() => onChoose(doc.path)}>
                    <FileText size={14} aria-hidden="true" />
                    <span className="maru-diagram-report-target-title">
                      {doc.title || doc.path}
                    </span>
                    <span className="maru-diagram-report-target-path">{doc.path}</span>
                  </button>
                </li>
              ))}
            </ul>
          )}
          <div className="maru-diagram-save-actions">
            <button type="button" onClick={onClose}>
              {t("diagram.report.chooseCancel")}
            </button>
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
