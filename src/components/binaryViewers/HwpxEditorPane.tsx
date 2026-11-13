import { lazy, Suspense, useState } from "react";
import { useTranslation } from "../../lib/i18n";
import type { WorkspaceFileEntry } from "../../lib/types";
import { HwpxViewer } from "./HwpxViewer";

/**
 * The editor package, its CSS and the engine factory ride their own chunk, so
 * a reader who never opens the editor pays nothing for them.
 */
const HwpEditorSurface = lazy(() =>
  import("./HwpEditorSurface").then((module) => ({
    default: module.HwpEditorSurface,
  })),
);

interface Props {
  entry: WorkspaceFileEntry;
  workspacePath: string;
  onPreviewExternal: () => void;
  onOpenExternal: () => void;
}

/**
 * The `.hwpx` surface: the read-only preview is the default view, and the
 * editor is opened on request. Edits stay in this window — maru has no write
 * path for an edited document yet, so the note says so rather than offering a
 * save the app cannot honour.
 */
export function HwpxEditorPane({
  entry,
  workspacePath,
  onPreviewExternal,
  onOpenExternal,
}: Props) {
  const { t } = useTranslation();
  const [editing, setEditing] = useState(false);

  return (
    <div className="hwp-editor-pane">
      <div className="hwp-editor-pane-bar">
        <button
          type="button"
          className="hwp-editor-pane-toggle"
          aria-pressed={editing}
          onClick={() => setEditing((current) => !current)}
        >
          {editing ? t("binaryViewer.hwpEditorClose") : t("binaryViewer.hwpEditorOpen")}
        </button>
        {editing ? (
          <p className="hwp-editor-pane-note" role="note">
            {t("binaryViewer.hwpEditorNotSaved")}
          </p>
        ) : null}
      </div>
      {editing ? (
        <div className="hwp-editor-host">
          <Suspense
            fallback={
              <p className="hwp-editor-pane-note">{t("binaryViewer.loading")}</p>
            }
          >
            <HwpEditorSurface entry={entry} workspacePath={workspacePath} />
          </Suspense>
        </div>
      ) : (
        <HwpxViewer
          entry={entry}
          workspacePath={workspacePath}
          onPreviewExternal={onPreviewExternal}
          onOpenExternal={onOpenExternal}
        />
      )}
    </div>
  );
}
