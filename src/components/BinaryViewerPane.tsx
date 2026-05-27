import { ExternalLink, FolderOpen } from "lucide-react";
import {
  binaryViewerOpenExternal,
  revealInFileManager,
  type BinaryViewerClassification,
} from "../lib/api";
import {
  formatBytes,
  viewerCategoryLabel,
  type ViewerCategory,
} from "../lib/binaryViewer";
import { useTranslation } from "../lib/i18n";
import type { WorkspaceFileEntry } from "../lib/types";
import { ImageViewer } from "./binaryViewers/ImageViewer";
import { PdfViewer } from "./binaryViewers/PdfViewer";
import { DocxViewer } from "./binaryViewers/DocxViewer";
import { XlsxViewer } from "./binaryViewers/XlsxViewer";
import { HwpxViewer } from "./binaryViewers/HwpxViewer";
import { MediaViewer } from "./binaryViewers/MediaViewer";
import { TextViewer } from "./binaryViewers/TextViewer";
import { ArchiveViewer } from "./binaryViewers/ArchiveViewer";
import { UnsupportedViewer } from "./binaryViewers/UnsupportedViewer";

interface Props {
  entry: WorkspaceFileEntry;
  workspacePath: string;
  classification: BinaryViewerClassification;
  onError?: (message: string) => void;
}

export function BinaryViewerPane({ entry, workspacePath, classification, onError }: Props) {
  const { t } = useTranslation();
  const category: ViewerCategory = classification.category;

  const reportError = (label: string, err: unknown) => {
    const message = err instanceof Error ? err.message : String(err);
    onError?.(`${label}: ${message}`);
  };

  const handleOpenExternal = () => {
    void binaryViewerOpenExternal(workspacePath, entry.path).catch((err) =>
      reportError(t("binaryViewer.openExternal"), err),
    );
  };

  const handleRevealInFinder = () => {
    void revealInFileManager(workspacePath, entry.path).catch((err) =>
      reportError(t("binaryViewer.revealInFinder"), err),
    );
  };

  return (
    <div className="binary-viewer-shell">
      <header className="binary-viewer-header">
        <div className="binary-viewer-header-text">
          <strong title={entry.relPath}>{entry.name}</strong>
          <span className="binary-viewer-header-meta">
            <span>{viewerCategoryLabel(category)}</span>
            {classification.detectedFormat !== "unknown" &&
            classification.detectedFormat !== category ? (
              <>
                <span aria-hidden>·</span>
                <span>{classification.detectedFormat.toUpperCase()}</span>
              </>
            ) : null}
            <span aria-hidden>·</span>
            <span>{formatBytes(classification.sizeBytes || entry.sizeBytes)}</span>
            {entry.updatedAt ? (
              <>
                <span aria-hidden>·</span>
                <span>{new Date(entry.updatedAt).toLocaleString()}</span>
              </>
            ) : null}
          </span>
        </div>
        <div className="binary-viewer-header-actions">
          <button type="button" onClick={handleRevealInFinder}>
            <FolderOpen size={14} />
            {t("binaryViewer.revealInFinder")}
          </button>
          <button type="button" onClick={handleOpenExternal}>
            <ExternalLink size={14} />
            {t("binaryViewer.openExternal")}
          </button>
        </div>
      </header>
      <div className="binary-viewer-body">
        <ViewerBody
          category={category}
          entry={entry}
          workspacePath={workspacePath}
          classification={classification}
          onOpenExternal={handleOpenExternal}
          onRevealInFinder={handleRevealInFinder}
        />
      </div>
    </div>
  );
}

function ViewerBody({
  category,
  entry,
  workspacePath,
  classification,
  onOpenExternal,
  onRevealInFinder,
}: {
  category: ViewerCategory;
  entry: WorkspaceFileEntry;
  workspacePath: string;
  classification: BinaryViewerClassification;
  onOpenExternal: () => void;
  onRevealInFinder: () => void;
}) {
  switch (category) {
    case "image":
    case "svg":
      return <ImageViewer entry={entry} />;
    case "pdf":
      return <PdfViewer entry={entry} />;
    case "docx":
      return <DocxViewer entry={entry} />;
    case "xlsx":
      return <XlsxViewer entry={entry} />;
    case "hwpx":
      return <HwpxViewer entry={entry} workspacePath={workspacePath} />;
    case "audio":
      return <MediaViewer entry={entry} kind="audio" />;
    case "video":
      return <MediaViewer entry={entry} kind="video" />;
    case "text":
      return <TextViewer entry={entry} workspacePath={workspacePath} />;
    case "archive":
      return <ArchiveViewer entry={entry} workspacePath={workspacePath} />;
    default:
      return (
        <UnsupportedViewer
          entry={entry}
          classification={classification}
          onOpenExternal={onOpenExternal}
          onRevealInFinder={onRevealInFinder}
        />
      );
  }
}
