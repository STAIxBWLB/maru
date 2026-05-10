import * as Tabs from "@radix-ui/react-tabs";
import {
  Check,
  ChevronRight,
  Clock3,
  Columns2,
  FileText,
  GitCommit,
  PanelRightOpen,
  Save,
  X,
} from "lucide-react";
import { forwardRef, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { documentStats } from "../lib/document";
import { renderMarkdown } from "../lib/markdown";
import type { DocumentPayload, VaultEntry } from "../lib/types";
import { useTranslation } from "../lib/i18n";
import { useContextMenuKeyboard } from "../lib/useContextMenuKeyboard";
import { Button } from "./ui/Button";
import { RichMarkdownEditor } from "./RichMarkdownEditor";
import { useWikilinkAutocomplete } from "./WikilinkAutocomplete";

export type EditorViewMode = "rich" | "source" | "preview";

export interface EditorTabSummary {
  id: string;
  title: string;
  path: string;
  relPath: string;
  dirty: boolean;
  canRenameMove: boolean;
  canCreate: boolean;
  canDelete: boolean;
  writeBlockedReason: string | null;
}

interface EditorPaneProps {
  document: DocumentPayload | null;
  openingEntry: VaultEntry | null;
  draftContent: string;
  saving: boolean;
  dirty: boolean;
  outlineOpen: boolean;
  activeWorkspaceLabel: string | null;
  documentLabel: string | null;
  readOnly: boolean;
  canSnapshot: boolean;
  readOnlyReason: string | null;
  viewMode: EditorViewMode;
  tabs: EditorTabSummary[];
  activeTabId: string | null;
  entries: VaultEntry[];
  onChange: (content: string) => void;
  onSelectTab: (tabId: string) => void;
  onCloseTab: (tabId: string) => void;
  onCloseOtherTabs: (tabId: string) => void;
  onCloseTabsToRight: (tabId: string) => void;
  onCloseSavedTabs: () => void;
  onCloseAllTabs: () => void;
  onCopyTabName: (tabId: string) => void;
  onCopyTabPath: (tabId: string) => void;
  onCopyTabRelativePath: (tabId: string) => void;
  onRenameTab: (tabId: string) => void;
  onMoveTab: (tabId: string) => void;
  onDuplicateTab: (tabId: string) => void;
  onDeleteTab: (tabId: string) => void;
  onOpenTabPreview: (tabId: string) => void;
  onRevealTabInFinder: (tabId: string) => void;
  onRevealTabInExplorer: (tabId: string) => void;
  onSave: () => void;
  onSnapshot: () => void;
  onSplitRight: () => void;
  onFocusPane?: () => void;
  onToggleOutline: () => void;
  onViewModeChange: (mode: EditorViewMode) => void;
  onWikilinkClick: (target: string) => void;
  textareaRef?: React.RefObject<HTMLTextAreaElement | null>;
}

export const EditorPane = forwardRef<HTMLDivElement, EditorPaneProps>(function EditorPane(
  {
    document,
    openingEntry,
    draftContent,
    saving,
    dirty,
    outlineOpen,
    activeWorkspaceLabel,
    documentLabel,
    readOnly,
    canSnapshot,
    readOnlyReason,
    viewMode,
    tabs,
    activeTabId,
    entries,
    onChange,
    onSelectTab,
    onCloseTab,
    onCloseOtherTabs,
    onCloseTabsToRight,
    onCloseSavedTabs,
    onCloseAllTabs,
    onCopyTabName,
    onCopyTabPath,
    onCopyTabRelativePath,
    onRenameTab,
    onMoveTab,
    onDuplicateTab,
    onDeleteTab,
    onOpenTabPreview,
    onRevealTabInFinder,
    onRevealTabInExplorer,
    onSave,
    onSnapshot,
    onSplitRight,
    onFocusPane,
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
  const [contextMenu, setContextMenu] = useState<{
    x: number;
    y: number;
    tab: EditorTabSummary;
  } | null>(null);
  const contextMenuRef = useRef<HTMLDivElement>(null);
  const handleContextMenuKeyDown = useContextMenuKeyboard(
    contextMenuRef,
    !!contextMenu,
    () => setContextMenu(null),
  );

  const { handlers: autocompleteHandlers, popup: autocompletePopup } =
    useWikilinkAutocomplete({
      textareaRef: taRef,
      value: draftContent,
      entries,
      onChange,
    });

  const previewHtml = useMemo(
    () => (document && viewMode === "preview" ? renderMarkdown(draftContent) : ""),
    [draftContent, document, viewMode],
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

  useEffect(() => {
    if (!contextMenu) return;
    const close = () => setContextMenu(null);
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") close();
    };
    window.addEventListener("pointerdown", close);
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("pointerdown", close);
      window.removeEventListener("keydown", onKey);
    };
  }, [contextMenu]);

  const runTabAction = useCallback(
    (handler: (tabId: string) => void) => {
      const tabId = contextMenu?.tab.id;
      setContextMenu(null);
      if (tabId) handler(tabId);
    },
    [contextMenu],
  );

  const mutationDisabledTitle = contextMenu?.tab.writeBlockedReason ?? undefined;

  if (openingEntry && openingEntry.path !== document?.path) {
    return (
      <main className="editor-pane editor-empty" ref={ref} onPointerDown={onFocusPane}>
        <div className="empty-document-plate">
          <div className="icon-circle" title={openingEntry.title}>
            <FileText size={26} />
          </div>
          <h2>{openingEntry.title}</h2>
          <p>{openingEntry.relPath}</p>
        </div>
      </main>
    );
  }

  if (!document) {
    return (
      <main className="editor-pane editor-empty" ref={ref} onPointerDown={onFocusPane}>
        <div className="empty-document-plate">
          <div className="icon-circle" title={t("editor.empty.title")}>
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
    <main className="editor-pane" ref={ref} onPointerDown={onFocusPane}>
      <div className="document-tabs-row" aria-label={t("editor.tabs.label")}>
        {tabs.map((tab, index) => (
          <div
            className={tab.id === activeTabId ? "document-tab active" : "document-tab"}
            key={tab.id}
            title={tab.relPath}
            onContextMenu={(event) => {
              event.preventDefault();
              event.stopPropagation();
              setContextMenu({ x: event.clientX, y: event.clientY, tab });
            }}
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
        <div className="document-tab-tools">
          <button
            type="button"
            className="icon-button"
            onClick={onSplitRight}
            title={t("editor.splitRight")}
            aria-label={t("editor.splitRight")}
          >
            <Columns2 size={13} />
          </button>
          <button
            type="button"
            className="icon-button"
            onClick={onCloseAllTabs}
            title={t("editor.tabs.closeAll")}
            aria-label={t("editor.tabs.closeAll")}
          >
            <X size={13} />
          </button>
        </div>
      </div>
      {contextMenu ? (
        <div
          ref={contextMenuRef}
          className="context-menu document-tab-context-menu"
          role="menu"
          tabIndex={-1}
          style={{ left: contextMenu.x, top: contextMenu.y }}
          onPointerDown={(event) => event.stopPropagation()}
          onKeyDown={handleContextMenuKeyDown}
        >
          <div className="context-menu-title" title={contextMenu.tab.relPath}>
            {contextMenu.tab.title}
          </div>
          <button type="button" role="menuitem" onClick={() => runTabAction(onCloseTab)}>
            <span>{t("editor.tabs.menu.close")}</span>
            <span className="context-menu-shortcut" aria-hidden="true">
              ⌘W
            </span>
          </button>
          <button type="button" role="menuitem" onClick={() => runTabAction(onCloseOtherTabs)}>
            <span>{t("editor.tabs.menu.closeOthers")}</span>
          </button>
          <button type="button" role="menuitem" onClick={() => runTabAction(onCloseTabsToRight)}>
            <span>{t("editor.tabs.menu.closeRight")}</span>
          </button>
          <button type="button" role="menuitem" onClick={() => runTabAction(onCloseSavedTabs)}>
            <span>{t("editor.tabs.menu.closeSaved")}</span>
          </button>
          <button type="button" role="menuitem" onClick={() => runTabAction(onCloseAllTabs)}>
            <span>{t("editor.tabs.menu.closeAllSaved")}</span>
          </button>
          <div className="context-menu-separator" role="separator" />
          <button type="button" role="menuitem" onClick={() => runTabAction(onCopyTabName)}>
            <span>{t("editor.tabs.menu.copyName")}</span>
          </button>
          <button type="button" role="menuitem" onClick={() => runTabAction(onCopyTabPath)}>
            <span>{t("editor.tabs.menu.copyPath")}</span>
          </button>
          <button type="button" role="menuitem" onClick={() => runTabAction(onCopyTabRelativePath)}>
            <span>{t("editor.tabs.menu.copyRelativePath")}</span>
          </button>
          <div className="context-menu-separator" role="separator" />
          <button
            type="button"
            role="menuitem"
            disabled={!contextMenu.tab.canRenameMove}
            title={!contextMenu.tab.canRenameMove ? mutationDisabledTitle : undefined}
            onClick={() => runTabAction(onRenameTab)}
          >
            <span>{t("editor.tabs.menu.rename")}</span>
          </button>
          <button
            type="button"
            role="menuitem"
            disabled={!contextMenu.tab.canRenameMove}
            title={!contextMenu.tab.canRenameMove ? mutationDisabledTitle : undefined}
            onClick={() => runTabAction(onMoveTab)}
          >
            <span>{t("editor.tabs.menu.move")}</span>
          </button>
          <button
            type="button"
            role="menuitem"
            disabled={!contextMenu.tab.canCreate}
            title={!contextMenu.tab.canCreate ? mutationDisabledTitle : undefined}
            onClick={() => runTabAction(onDuplicateTab)}
          >
            <span>{t("editor.tabs.menu.duplicate")}</span>
          </button>
          <button
            type="button"
            role="menuitem"
            className="danger"
            disabled={!contextMenu.tab.canDelete}
            title={!contextMenu.tab.canDelete ? mutationDisabledTitle : undefined}
            onClick={() => runTabAction(onDeleteTab)}
          >
            <span>{t("editor.tabs.menu.delete")}</span>
          </button>
          <div className="context-menu-separator" role="separator" />
          <button type="button" role="menuitem" onClick={() => runTabAction(onOpenTabPreview)}>
            <span>{t("editor.tabs.menu.openPreview")}</span>
          </button>
          <button type="button" role="menuitem" onClick={() => runTabAction(onRevealTabInFinder)}>
            <span>{t("editor.tabs.menu.revealFinder")}</span>
          </button>
          <button type="button" role="menuitem" onClick={() => runTabAction(onRevealTabInExplorer)}>
            <span>{t("editor.tabs.menu.revealExplorer")}</span>
          </button>
        </div>
      ) : null}
      <header className="editor-topbar">
        <div className="breadcrumb" title={document.relPath}>
          {activeWorkspaceLabel ? (
            <>
              <span className="crumb">{activeWorkspaceLabel}</span>
              <ChevronRight size={12} className="sep" />
            </>
          ) : null}
          {folder ? (
            <>
              <span className="crumb">{folder}</span>
              <ChevronRight size={12} className="sep" />
            </>
          ) : null}
          <strong>{documentLabel ?? document.title}</strong>
        </div>
        <div className="editor-actions">
          <span
            className={dirty ? "save-state dirty" : "save-state saved"}
            title={dirty ? t("editor.dirty") : t("editor.saved")}
          >
            {dirty ? <Clock3 size={12} /> : <Check size={12} />}
            {dirty ? t("editor.dirty") : t("editor.saved")}
          </span>
          {readOnly ? (
            <span className="save-state readonly" title={readOnlyReason ?? undefined}>
              {t("editor.readOnly")}
            </span>
          ) : null}
          <Button
            variant="ghost"
            size="sm"
            onClick={onSnapshot}
            disabled={!canSnapshot}
            icon={<GitCommit size={14} />}
            title={!canSnapshot && readOnlyReason ? readOnlyReason : t("editor.snapshot")}
          >
            {t("editor.snapshot")}
          </Button>
          <Button
            variant="primary"
            size="sm"
            onClick={onSave}
            disabled={readOnly || saving || !dirty}
            icon={<Save size={14} />}
            title={readOnly && readOnlyReason ? readOnlyReason : undefined}
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
        <Tabs.Content className="tab-panel" value="rich">
          <RichMarkdownEditor value={draftContent} onChange={onChange} readOnly={readOnly} />
        </Tabs.Content>
        <Tabs.Content className="tab-panel" value="source">
          <textarea
            ref={taRef}
            className="source-editor"
            value={draftContent}
            onChange={(event) => onChange(event.target.value)}
            readOnly={readOnly}
            onKeyDown={autocompleteHandlers.onKeyDown}
            onKeyUp={autocompleteHandlers.onKeyUp}
            onClick={autocompleteHandlers.onClick}
            onCompositionStart={autocompleteHandlers.onCompositionStart}
            onCompositionEnd={autocompleteHandlers.onCompositionEnd}
            spellCheck={false}
          />
          {autocompletePopup}
        </Tabs.Content>
        <Tabs.Content className="tab-panel" value="preview">
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
