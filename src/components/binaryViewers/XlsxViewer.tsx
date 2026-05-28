import type { WorkspaceFileEntry } from "../../lib/types";
import { SystemPreviewViewer } from "./SystemPreviewViewer";

interface Props {
  entry: WorkspaceFileEntry;
  onPreviewExternal: () => void;
  onOpenExternal: () => void;
}

export function XlsxViewer({ entry, onPreviewExternal, onOpenExternal }: Props) {
  return (
    <SystemPreviewViewer
      entry={entry}
      titleKey="binaryViewer.officePreviewTitle"
      descriptionKey="binaryViewer.xlsxPreviewDescription"
      className="binary-viewer--xlsx"
      onPreviewExternal={onPreviewExternal}
      onOpenExternal={onOpenExternal}
    />
  );
}
