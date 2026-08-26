import { useEffect, type MutableRefObject } from "react";

import { visualModeController } from "./visualModeStore";

interface EditorHighlight {
  docPath: string;
}

interface EditorKgLifecycleOptions<T extends EditorHighlight> {
  workspacePath: string | null;
  documentPath: string | null;
  highlight: T | null;
  setHighlight(next: T | null): void;
  requestRef: MutableRefObject<number>;
  ownerRef: MutableRefObject<"editor" | "drafts" | "gap" | null>;
}

/**
 * Owns cleanup of editor-scoped KG interactions. It invalidates only the
 * existing editor request generation and never touches drafts/gap ownership.
 */
export function useEditorKgLifecycle<T extends EditorHighlight>({
  workspacePath,
  documentPath,
  highlight,
  setHighlight,
  requestRef,
  ownerRef,
}: EditorKgLifecycleOptions<T>): void {
  useEffect(() => {
    if (highlight && highlight.docPath !== documentPath) setHighlight(null);
    if (ownerRef.current === "editor") {
      requestRef.current += 1;
      ownerRef.current = null;
    }
    const referenceFocus = visualModeController.getGraphModeSlice().referenceFocus;
    if (referenceFocus?.source === "editor" && referenceFocus.docPath !== documentPath) {
      visualModeController.setGraphReferenceFocus(null);
    }
  }, [documentPath, highlight, ownerRef, requestRef, setHighlight, workspacePath]);
}
