import { FileQuestion, ExternalLink, FolderOpen } from "lucide-react";
import type { BinaryViewerClassification } from "../../lib/api";
import { useTranslation } from "../../lib/i18n";
import { formatBytes } from "../../lib/binaryViewer";
import type { WorkspaceFileEntry } from "../../lib/types";

interface Props {
  entry: WorkspaceFileEntry;
  classification: BinaryViewerClassification;
  onOpenExternal: () => void;
  onRevealInFinder: () => void;
}

export function UnsupportedViewer({
  entry,
  classification,
  onOpenExternal,
  onRevealInFinder,
}: Props) {
  const { t } = useTranslation();
  const format =
    classification.extension ??
    classification.mime ??
    entry.extension ??
    entry.fileKind ??
    "unknown";
  return (
    <div className="binary-viewer binary-viewer--unsupported">
      <div className="binary-viewer-unsupported-card">
        <div className="binary-viewer-unsupported-icon" aria-hidden>
          <FileQuestion size={32} />
        </div>
        <strong>{t("binaryViewer.unsupportedTitle")}</strong>
        <p>{t("binaryViewer.unsupportedDescription")}</p>
        <dl className="binary-viewer-meta">
          <div>
            <dt>{t("binaryViewer.format")}</dt>
            <dd>{format}</dd>
          </div>
          <div>
            <dt>{t("binaryViewer.size")}</dt>
            <dd>{formatBytes(classification.sizeBytes || entry.sizeBytes)}</dd>
          </div>
        </dl>
        <div className="binary-viewer-actions">
          <button type="button" onClick={onOpenExternal}>
            <ExternalLink size={14} />
            {t("binaryViewer.openExternal")}
          </button>
          <button type="button" onClick={onRevealInFinder}>
            <FolderOpen size={14} />
            {t("binaryViewer.revealInFinder")}
          </button>
        </div>
      </div>
    </div>
  );
}
