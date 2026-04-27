import * as Tabs from "@radix-ui/react-tabs";
import {
  Check,
  ChevronRight,
  Clock3,
  FileText,
  GitCommit,
  PanelRightOpen,
  Save,
} from "lucide-react";
import { forwardRef, useMemo } from "react";
import { documentStats } from "../lib/document";
import { renderMarkdown } from "../lib/markdown";
import type { DocumentPayload } from "../lib/types";
import { useTranslation } from "../lib/i18n";
import { Button } from "./ui/Button";

export type EditorViewMode = "edit" | "preview";

interface EditorPaneProps {
  document: DocumentPayload | null;
  draftContent: string;
  saving: boolean;
  dirty: boolean;
  outlineOpen: boolean;
  activeVaultLabel: string | null;
  viewMode: EditorViewMode;
  onChange: (content: string) => void;
  onSave: () => void;
  onSnapshot: () => void;
  onToggleOutline: () => void;
  onViewModeChange: (mode: EditorViewMode) => void;
  textareaRef?: React.RefObject<HTMLTextAreaElement | null>;
}

export const EditorPane = forwardRef<HTMLDivElement, EditorPaneProps>(function EditorPane(
  {
    document,
    draftContent,
    saving,
    dirty,
    outlineOpen,
    activeVaultLabel,
    viewMode,
    onChange,
    onSave,
    onSnapshot,
    onToggleOutline,
    onViewModeChange,
    textareaRef,
  },
  ref,
) {
  const { t, locale } = useTranslation();
  const stats = documentStats(document, draftContent);

  const previewHtml = useMemo(
    () => (document ? renderMarkdown(draftContent) : ""),
    [draftContent, document],
  );

  if (!document) {
    return (
      <main className="editor-pane editor-empty" ref={ref}>
        <div className="empty-document-plate">
          <div className="icon-circle">
            <FileText size={26} />
          </div>
          <h2>{t("editor.empty.title")}</h2>
          <p>{t("editor.empty.description")}</p>
        </div>
      </main>
    );
  }

  const pathSegments = document.relPath.split("/").filter(Boolean);
  const folder = pathSegments.length > 1 ? pathSegments.slice(0, -1).join(" / ") : null;

  return (
    <main className="editor-pane" ref={ref}>
      <header className="editor-topbar">
        <div className="breadcrumb" title={document.relPath}>
          {activeVaultLabel ? (
            <>
              <span className="crumb">{activeVaultLabel}</span>
              <ChevronRight size={12} className="sep" />
            </>
          ) : null}
          {folder ? (
            <>
              <span className="crumb">{folder}</span>
              <ChevronRight size={12} className="sep" />
            </>
          ) : null}
          <strong>{document.title}</strong>
        </div>
        <div className="editor-actions">
          <span className={dirty ? "save-state dirty" : "save-state saved"}>
            {dirty ? <Clock3 size={12} /> : <Check size={12} />}
            {dirty ? t("editor.dirty") : t("editor.saved")}
          </span>
          <Button
            variant="ghost"
            size="sm"
            onClick={onSnapshot}
            icon={<GitCommit size={14} />}
            title={t("editor.snapshot")}
          >
            {t("editor.snapshot")}
          </Button>
          <Button
            variant="primary"
            size="sm"
            onClick={onSave}
            disabled={saving || !dirty}
            icon={<Save size={14} />}
          >
            {saving ? t("editor.saving") : t("editor.save")}
          </Button>
          <button
            type="button"
            className={outlineOpen ? "icon-button active" : "icon-button"}
            onClick={onToggleOutline}
            title={outlineOpen ? t("outline.close") : t("outline.open")}
            aria-label={outlineOpen ? t("outline.close") : t("outline.open")}
          >
            <PanelRightOpen size={14} />
          </button>
        </div>
      </header>

      <Tabs.Root
        className="editor-tabs"
        value={viewMode}
        onValueChange={(value) => onViewModeChange(value as EditorViewMode)}
      >
        <Tabs.List className="editor-tabs-row" aria-label="document view">
          <Tabs.Trigger className="tab-trigger" value="edit">
            {t("editor.tab.edit")}
          </Tabs.Trigger>
          <Tabs.Trigger className="tab-trigger" value="preview">
            {t("editor.tab.preview")}
          </Tabs.Trigger>
        </Tabs.List>
        <Tabs.Content className="tab-panel" value="edit">
          <textarea
            ref={textareaRef}
            className="source-editor"
            value={draftContent}
            onChange={(event) => onChange(event.target.value)}
            spellCheck={false}
          />
        </Tabs.Content>
        <Tabs.Content className="tab-panel" value="preview">
          <article
            className="preview-surface"
            dangerouslySetInnerHTML={{ __html: previewHtml }}
          />
        </Tabs.Content>
      </Tabs.Root>

      <footer className="editor-status">
        <span>{t("editor.status.lines", { count: stats.lines.toLocaleString(locale) })}</span>
        <span>{t("editor.status.words", { count: stats.words.toLocaleString(locale) })}</span>
        <span>{t("editor.status.chars", { count: stats.chars.toLocaleString(locale) })}</span>
        <span className="spacer" />
        <span>{document.fileKind.toUpperCase()}</span>
      </footer>
    </main>
  );
});
