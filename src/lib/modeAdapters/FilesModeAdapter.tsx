import { InlineDocumentEditor } from "../../components/InlineDocumentEditor";
import { FilesWorkbench } from "../../components/FilesWorkbench";
import type { ModeAdapterProps } from "../modeRegistry";

/** Dedicated lazy Files surface; editor composition stays outside MainApp. */
export function FilesModeAdapter({ commands }: ModeAdapterProps) {
  const files = commands.documentOps?.files;
  if (!files) return null;
  return (
    <FilesWorkbench
      {...files.props}
      documentEditorNode={files.editor ? <InlineDocumentEditor key={files.editor.document.path} {...files.editor} /> : null}
    />
  );
}
