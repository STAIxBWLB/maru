import { useEffect, useState } from "react";
import DOMPurify from "dompurify";
import { binaryViewerExtractHwpx, type BinaryViewerHwpxPreview } from "../../lib/api";
import { INLINE_HWPX_MAX_BYTES } from "../../lib/binaryViewer";
import { useTranslation } from "../../lib/i18n";
import type { WorkspaceFileEntry } from "../../lib/types";
import { SystemPreviewViewer } from "./SystemPreviewViewer";

interface Props {
  entry: WorkspaceFileEntry;
  workspacePath: string;
  onPreviewExternal: () => void;
  onOpenExternal: () => void;
}

export function HwpxViewer({
  entry,
  workspacePath,
  onPreviewExternal,
  onOpenExternal,
}: Props) {
  const { t } = useTranslation();
  const [state, setState] = useState<{
    status: "loading" | "ready" | "error";
    preview?: BinaryViewerHwpxPreview;
    sanitizedHtml?: string;
    error?: string;
  }>({ status: "loading" });

  useEffect(() => {
    if (entry.sizeBytes > INLINE_HWPX_MAX_BYTES) return;
    let cancelled = false;
    setState({ status: "loading" });
    binaryViewerExtractHwpx(workspacePath, entry.path)
      .then((preview) => {
        if (cancelled) return;
        const sanitizedHtml = DOMPurify.sanitize(preview.html, {
          USE_PROFILES: { html: true },
        });
        setState({ status: "ready", preview, sanitizedHtml });
      })
      .catch((err: unknown) => {
        if (cancelled) return;
        const message = err instanceof Error ? err.message : String(err);
        setState({ status: "error", error: message });
      });
    return () => {
      cancelled = true;
    };
  }, [entry.path, entry.sizeBytes, workspacePath]);

  if (entry.sizeBytes > INLINE_HWPX_MAX_BYTES) {
    return (
      <SystemPreviewViewer
        entry={entry}
        titleKey="binaryViewer.systemPreviewTitle"
        descriptionKey="binaryViewer.hwpxLargePreviewDescription"
        className="binary-viewer--hwpx"
        onPreviewExternal={onPreviewExternal}
        onOpenExternal={onOpenExternal}
      />
    );
  }

  if (state.status === "loading") {
    return <div className="binary-viewer-loading">{t("binaryViewer.loading")}</div>;
  }
  if (state.status === "error") {
    return (
      <div className="binary-viewer-error">
        {t("binaryViewer.loadError", { message: state.error ?? "" })}
      </div>
    );
  }
  const { preview, sanitizedHtml } = state;
  if (!preview || sanitizedHtml === undefined) return null;
  if (!sanitizedHtml.trim()) {
    return <div className="binary-viewer-empty">{t("binaryViewer.empty")}</div>;
  }
  return (
    <div className="binary-viewer binary-viewer--hwpx">
      <div className="binary-viewer-toolbar binary-viewer-toolbar--meta">
        <span>{t("binaryViewer.hwpxWarning")}</span>
        <span>
          {t("binaryViewer.hwpxSections", { count: preview.sections })}
        </span>
        {preview.warnings.length > 0 ? (
          <span className="binary-viewer-meta-warning">
            {t("binaryViewer.hwpxWarnings", { count: preview.warnings.length })}
          </span>
        ) : null}
      </div>
      <div
        className="binary-viewer-canvas binary-viewer-canvas--hwpx markdown-body"
        dangerouslySetInnerHTML={{ __html: sanitizedHtml }}
      />
    </div>
  );
}
