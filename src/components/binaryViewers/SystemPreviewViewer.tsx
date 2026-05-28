import { ExternalLink, Eye, FileText } from "lucide-react";
import { formatBytes } from "../../lib/binaryViewer";
import { useTranslation } from "../../lib/i18n";
import type { WorkspaceFileEntry } from "../../lib/types";

interface Props {
  entry: WorkspaceFileEntry;
  titleKey: string;
  descriptionKey: string;
  className?: string;
  onPreviewExternal: () => void;
  onOpenExternal: () => void;
}

export function SystemPreviewViewer({
  entry,
  titleKey,
  descriptionKey,
  className = "",
  onPreviewExternal,
  onOpenExternal,
}: Props) {
  const { t } = useTranslation();
  const format = entry.extension ?? entry.fileKind ?? "unknown";
  const classes = ["binary-viewer", "binary-viewer--system-preview", className]
    .filter(Boolean)
    .join(" ");
  return (
    <div className={classes}>
      <div className="binary-viewer-system-card">
        <div className="binary-viewer-unsupported-icon" aria-hidden>
          <FileText size={32} />
        </div>
        <strong>{t(titleKey)}</strong>
        <p>{t(descriptionKey)}</p>
        <dl className="binary-viewer-meta">
          <div>
            <dt>{t("binaryViewer.format")}</dt>
            <dd>{format}</dd>
          </div>
          <div>
            <dt>{t("binaryViewer.size")}</dt>
            <dd>{formatBytes(entry.sizeBytes)}</dd>
          </div>
        </dl>
        <div className="binary-viewer-actions">
          <button type="button" onClick={onPreviewExternal}>
            <Eye size={14} />
            {t("binaryViewer.systemPreview")}
          </button>
          <button type="button" onClick={onOpenExternal}>
            <ExternalLink size={14} />
            {t("binaryViewer.openExternal")}
          </button>
        </div>
      </div>
    </div>
  );
}
