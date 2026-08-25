import { useLayoutEffect } from "react";

import {
  patchEditorPaneViewPreview,
  setEditorPanePresentation,
  type EditorPaneOperationSlice,
  type EditorPanePresentationSlice,
} from "../lib/editorPaneStore";
import { EditorPane, type EditorPaneProps, type EditorViewMode } from "./EditorPane";

export interface EditorPaneFacadeProps extends EditorPaneProps {
  presentation: EditorPanePresentationSlice;
  operation: Pick<EditorPaneOperationSlice, "openingEntry" | "saving">;
  viewMode: EditorViewMode;
}

/**
 * Publishes shell-derived editor state after React commits the pane. Keeping
 * this boundary outside MainApp's render prevents external-store subscribers
 * from being notified while their parent is rendering.
 */
export function EditorPaneFacade({
  scope,
  presentation,
  operation,
  viewMode,
  ...editorPaneProps
}: EditorPaneFacadeProps) {
  useLayoutEffect(() => {
    setEditorPanePresentation(scope, presentation, operation);
    patchEditorPaneViewPreview(scope, { viewMode });
  }, [operation, presentation, scope, viewMode]);

  return <EditorPane scope={scope} {...editorPaneProps} />;
}
