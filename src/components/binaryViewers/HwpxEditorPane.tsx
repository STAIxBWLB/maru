import { lazy, Suspense, useState } from "react";
import { useTranslation } from "../../lib/i18n";
import { INLINE_HWPX_MAX_BYTES } from "../../lib/binaryViewer";
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
 * editor is opened on request. Edits stay in this window: maru has no write
 * path for an edited document yet, so the note says so rather than offering a
 * save the app cannot honour.
 *
 * Once opened, the editor stays mounted while the preview is shown again: its
 * edits are in that component's memory, and unmounting would drop them without
 * a word. Above the preview's own inline bound it is not offered at all, so the
 * two views agree on which files they will open.
 */
export function HwpxEditorPane({
  entry,
  workspacePath,
  onPreviewExternal,
  onOpenExternal,
}: Props) {
  const { t } = useTranslation();
  const [editing, setEditing] = useState(false);
  const [opened, setOpened] = useState(false);
  const [dirty, setDirty] = useState(false);
  const overInlineLimit = entry.sizeBytes > INLINE_HWPX_MAX_BYTES;

  return (
    <div className="hwp-editor-pane">
      <div className="hwp-editor-pane-bar">
        {overInlineLimit ? null : (
          <button
            type="button"
            className="hwp-editor-pane-toggle"
            aria-pressed={editing}
            onClick={() => {
              setOpened(true);
              setEditing((current) => !current);
            }}
          >
            {editing ? t("binaryViewer.hwpEditorClose") : t("binaryViewer.hwpEditorOpen")}
          </button>
        )}
        {opened && (editing || dirty) ? (
          <p className="hwp-editor-pane-note" role="note">
            {t("binaryViewer.hwpEditorNotSaved")}
          </p>
        ) : null}
      </div>
      {opened ? (
        <div className="hwp-editor-host" hidden={!editing}>
          <Suspense
            fallback={
              <p className="hwp-editor-pane-note">{t("binaryViewer.loading")}</p>
            }
          >
            <HwpEditorSurface
              entry={entry}
              workspacePath={workspacePath}
              onDirtyChange={setDirty}
            />
          </Suspense>
        </div>
      ) : null}
      {editing ? null : (
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
