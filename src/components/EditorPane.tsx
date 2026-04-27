import * as Tabs from "@radix-ui/react-tabs";
import {
  Check,
  ChevronRight,
  Clock3,
  FileText,
  GitCommit,
  PanelRightOpen,
  Save,
  X,
} from "lucide-react";
import { forwardRef, useCallback, useMemo, useRef } from "react";
import { documentStats } from "../lib/document";
import { renderMarkdown } from "../lib/markdown";
import type { DocumentPayload, VaultEntry } from "../lib/types";
import { useTranslation } from "../lib/i18n";
import { Button } from "./ui/Button";
import { RichMarkdownEditor } from "./RichMarkdownEditor";
import { useWikilinkAutocomplete } from "./WikilinkAutocomplete";

export type EditorViewMode = "rich" | "source" | "preview";

export interface EditorTabSummary {
  id: string;
  title: string;
  relPath: string;
  dirty: boolean;
}

interface EditorPaneProps {
  document: DocumentPayload | null;
  draftContent: string;
  saving: boolean;
  dirty: boolean;
  outlineOpen: boolean;
  activeVaultLabel: string | null;
  viewMode: EditorViewMode;
  tabs: EditorTabSummary[];
  activeTabId: string | null;
  entries: VaultEntry[];
  onChange: (content: string) => void;
  onSelectTab: (tabId: string) => void;
  onCloseTab: (tabId: string) => void;
  onSave: () => void;
  onSnapshot: () => void;
  onToggleOutline: () => void;
  onViewModeChange: (mode: EditorViewMode) => void;
  onWikilinkClick: (target: string) => void;
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
    tabs,
    activeTabId,
    entries,
    onChange,
    onSelectTab,
    onCloseTab,
    onSave,
    onSnapshot,
    onToggleOutline,
    onViewModeChange,
    onWikilinkClick,
    textareaRef,
  },
  ref,
) {
  const { t, locale } = useTranslation();
  const stats = documentStats(document, draftContent);
  const localTextareaRef = useRef<HTMLTextAreaElement | null>(null);
  const taRef = textareaRef ?? localTextareaRef;

  const { handlers: autocompleteHandlers, popup: autocompletePopup } =
    useWikilinkAutocomplete({
      textareaRef: taRef,
      value: draftContent,
      entries,
      onChange,
    });

  const previewHtml = useMemo(
    () => (document ? renderMarkdown(draftContent) : ""),
    [draftContent, document],
  );

  const handlePreviewClick = useCallback(
    (event: React.MouseEvent<HTMLElement>) => {
      const node = (event.target as HTMLElement).closest(
        "[data-wikilink]",
      ) as HTMLElement | null;
      if (!node) return;
      event.preventDefault();
      const target = node.getAttribute("data-wikilink");
      if (target) onWikilinkClick(target);
    },
    [onWikilinkClick],
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
      <div className="document-tabs-row" aria-label={t("editor.tabs.label")}>
        {tabs.map((tab, index) => (
          <div
            className={tab.id === activeTabId ? "document-tab active" : "document-tab"}
            key={tab.id}
            title={tab.relPath}
          >
            <button
              type="button"
              className="document-tab-main"
              onClick={() => onSelectTab(tab.id)}
              aria-current={tab.id === activeTabId ? "page" : undefined}
            >
              <span className="document-tab-title">{tab.title}</span>
              {tab.dirty ? <span className="document-tab-dirty" aria-hidden="true" /> : null}
              {index < 8 ? <span className="document-tab-kbd">⌘{index + 1}</span> : null}
            </button>
            <button
              type="button"
              className="document-tab-close"
              onClick={() => onCloseTab(tab.id)}
              aria-label={t("editor.tabs.close", { title: tab.title })}
              title={t("editor.tabs.close", { title: tab.title })}
            >
              <X size={12} />
            </button>
          </div>
        ))}
      </div>
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
          <Tabs.Trigger className="tab-trigger" value="rich">
            {t("editor.tab.rich")}
          </Tabs.Trigger>
          <Tabs.Trigger className="tab-trigger" value="source">
            {t("editor.tab.source")}
          </Tabs.Trigger>
          <Tabs.Trigger className="tab-trigger" value="preview">
            {t("editor.tab.preview")}
          </Tabs.Trigger>
        </Tabs.List>
        <Tabs.Content className="tab-panel" value="rich" forceMount>
          <RichMarkdownEditor value={draftContent} onChange={onChange} />
        </Tabs.Content>
        <Tabs.Content className="tab-panel" value="source" forceMount>
          <textarea
            ref={taRef}
            className="source-editor"
            value={draftContent}
            onChange={(event) => onChange(event.target.value)}
            onKeyDown={autocompleteHandlers.onKeyDown}
            onKeyUp={autocompleteHandlers.onKeyUp}
            onClick={autocompleteHandlers.onClick}
            onCompositionStart={autocompleteHandlers.onCompositionStart}
            onCompositionEnd={autocompleteHandlers.onCompositionEnd}
            spellCheck={false}
          />
          {autocompletePopup}
        </Tabs.Content>
        <Tabs.Content className="tab-panel" value="preview" forceMount>
          <article
            className="preview-surface"
            onClick={handlePreviewClick}
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
