import type { WorkspaceFileEntry } from "../../lib/types";
import { SystemPreviewViewer } from "./SystemPreviewViewer";

interface Props {
  entry: WorkspaceFileEntry;
  onPreviewExternal: () => void;
  onOpenExternal: () => void;
}

export function DocxViewer({ entry, onPreviewExternal, onOpenExternal }: Props) {
  return (
    <SystemPreviewViewer
      entry={entry}
      titleKey="binaryViewer.officePreviewTitle"
      descriptionKey="binaryViewer.docxPreviewDescription"
      className="binary-viewer--docx"
      onPreviewExternal={onPreviewExternal}
      onOpenExternal={onOpenExternal}
    />
  );
}
