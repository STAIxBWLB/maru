import { useEffect, useMemo, useState } from "react";
import { binaryViewerReadArchive, type BinaryViewerArchivePreview } from "../../lib/api";
import { formatBytes } from "../../lib/binaryViewer";
import { useTranslation } from "../../lib/i18n";
import type { WorkspaceFileEntry } from "../../lib/types";

interface Props {
  entry: WorkspaceFileEntry;
  workspacePath: string;
}

export function ArchiveViewer({ entry, workspacePath }: Props) {
  const { t } = useTranslation();
  const [state, setState] = useState<{
    status: "loading" | "ready" | "error";
    preview?: BinaryViewerArchivePreview;
    error?: string;
  }>({ status: "loading" });

  useEffect(() => {
    let cancelled = false;
    setState({ status: "loading" });
    binaryViewerReadArchive(workspacePath, entry.path)
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

  const sorted = useMemo(() => {
    if (!state.preview) return [];
    return [...state.preview.entries].sort((a, b) => a.name.localeCompare(b.name));
  }, [state.preview]);

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
  if (!sorted.length) {
    return <div className="binary-viewer-empty">{t("binaryViewer.empty")}</div>;
  }
  const truncated = Boolean(state.preview?.truncated);
  const count = state.preview?.totalEntries ?? sorted.length;
  return (
    <div className="binary-viewer binary-viewer--archive">
      <div className="binary-viewer-toolbar binary-viewer-toolbar--meta">
        <span>
          {truncated
            ? t("binaryViewer.archiveEntriesTruncated", { count })
            : t("binaryViewer.archiveEntries", { count })}
        </span>
      </div>
      <div className="binary-viewer-canvas binary-viewer-canvas--archive">
        <table className="binary-viewer-archive-table">
          <thead>
            <tr>
              <th>{t("binaryViewer.archiveName")}</th>
              <th>{t("binaryViewer.archiveSize")}</th>
              <th>{t("binaryViewer.archiveCompressedSize")}</th>
            </tr>
          </thead>
          <tbody>
            {sorted.map((row) => (
              <tr key={row.name} className={row.isDir ? "is-dir" : undefined}>
                <td title={row.name}>{row.name}</td>
                <td>{row.isDir ? "—" : formatBytes(row.size)}</td>
                <td>{row.isDir ? "—" : formatBytes(row.compressedSize)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
