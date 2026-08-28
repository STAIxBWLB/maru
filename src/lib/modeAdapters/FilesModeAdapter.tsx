import { InlineDocumentEditor } from "../../components/InlineDocumentEditor";
import { FilesWorkbench } from "../../components/FilesWorkbench";
import { useFilesModeSlice } from "../documentOpsModeStore";
import type { ModeAdapterProps } from "../modeRegistry";

/** Dedicated lazy Files surface; its host is owned by the document-ops controller. */
export function FilesModeAdapter(_props: ModeAdapterProps) {
  const files = useFilesModeSlice();
  if (!files.host) return null;
  const { host } = files;
  return (
    <FilesWorkbench
      {...host.props}
      documentEditorNode={host.editor ? <InlineDocumentEditor key={host.editor.document.path} {...host.editor} /> : null}
    />
  );
}
