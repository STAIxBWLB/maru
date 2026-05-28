import { Eye } from "lucide-react";
import { assetUrlForPath } from "../../lib/binaryViewer";
import { useTranslation } from "../../lib/i18n";
import type { WorkspaceFileEntry } from "../../lib/types";

interface Props {
  entry: WorkspaceFileEntry;
  onPreviewExternal: () => void;
}

export function PdfViewer({ entry, onPreviewExternal }: Props) {
  const { t } = useTranslation();
  const url = assetUrlForPath(entry.path);

  return (
    <div className="binary-viewer binary-viewer--pdf">
      <div className="binary-viewer-toolbar binary-viewer-toolbar--meta">
        <span>{t("binaryViewer.pdfNativePreview")}</span>
        <button type="button" onClick={onPreviewExternal}>
          <Eye size={14} />
          {t("binaryViewer.systemPreview")}
        </button>
      </div>
      <object
        className="binary-viewer-native-pdf"
        data={url}
        type="application/pdf"
        title={entry.name}
        aria-label={entry.name}
      >
        <div className="binary-viewer-system-fallback">
          <p>{t("binaryViewer.pdfNativeFallback")}</p>
          <button type="button" onClick={onPreviewExternal}>
            <Eye size={14} />
            {t("binaryViewer.systemPreview")}
          </button>
        </div>
      </object>
    </div>
  );
}
