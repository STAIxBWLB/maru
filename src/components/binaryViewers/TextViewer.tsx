import { useEffect, useState } from "react";
import { binaryViewerReadText, type BinaryViewerTextPreview } from "../../lib/api";
import { formatBytes } from "../../lib/binaryViewer";
import { useTranslation } from "../../lib/i18n";
import type { WorkspaceFileEntry } from "../../lib/types";

interface Props {
  entry: WorkspaceFileEntry;
  workspacePath: string;
}

export function TextViewer({ entry, workspacePath }: Props) {
  const { t } = useTranslation();
  const [state, setState] = useState<{
    status: "loading" | "ready" | "error";
    preview?: BinaryViewerTextPreview;
    error?: string;
  }>({ status: "loading" });

  useEffect(() => {
    let cancelled = false;
    setState({ status: "loading" });
    binaryViewerReadText(workspacePath, entry.path)
      .then((preview) => {
        if (!cancelled) setState({ status: "ready", preview });
      })
      .catch((err: unknown) => {
        if (cancelled) return;
        const message = err instanceof Error ? err.message : String(err);
        setState({ status: "error", error: message });
      });
    return () => {
      cancelled = true;
    };
  }, [entry.path, workspacePath]);

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
  const { preview } = state;
  if (!preview) return null;

  return (
    <div className="binary-viewer binary-viewer--text">
      <div className="binary-viewer-toolbar binary-viewer-toolbar--meta">
        <span>
          {t("binaryViewer.encoding")}: {preview.encoding}
        </span>
        {preview.truncated ? (
          <span className="binary-viewer-truncated">
            {t("binaryViewer.truncatedNotice", {
              bytes: formatBytes(preview.byteCount),
              shown: formatBytes(preview.shownBytes),
            })}
          </span>
        ) : null}
      </div>
      <pre className="binary-viewer-canvas binary-viewer-canvas--text">{preview.content}</pre>
    </div>
  );
}
