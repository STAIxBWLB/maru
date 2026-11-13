import { useMemo } from "react";
import { HwpEditor } from "@hwp-editor/react";
import "@hwp-editor/react/style.css";
import type { DocumentHandle } from "@hwp-editor/core";
import { useTranslation } from "../../lib/i18n";
import { createHwpedEngine } from "../../lib/hwped";
import type { WorkspaceFileEntry } from "../../lib/types";

interface Props {
  entry: WorkspaceFileEntry;
  workspacePath: string;
  /** Lifted so the pane keeps saying the edits are unsaved after the reader
   *  switches back to the preview without unmounting the editor. */
  onDirtyChange?: (dirty: boolean) => void;
}

/**
 * The mounted editor. Kept in its own module so `HwpxEditorPane` can load the
 * package, its CSS and the engine factory only when someone opens an editor.
 */
export function HwpEditorSurface({ entry, workspacePath, onDirtyChange }: Props) {
  const { locale } = useTranslation();

  const engine = useMemo(
    () =>
      createHwpedEngine({
        workspaceRoot: workspacePath,
        pathOf: (document) =>
          document.name === entry.name ? entry.relPath : undefined,
      }),
    [entry.name, entry.relPath, workspacePath],
  );

  // The document crosses the bridge as a path (`pathOf`), so `data` is the
  // fallback the engine never reads while that path answers.
  const file = useMemo<DocumentHandle>(
    () => ({ name: entry.name, data: new Uint8Array() }),
    [entry.name],
  );

  return (
    <HwpEditor
      engine={engine}
      file={file}
      locale={locale}
      onDirtyChange={onDirtyChange}
    />
  );
}
