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
import {
  forwardRef,
  lazy,
  Suspense,
  useCallback,
  useDeferredValue,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { vaultValidateNote, type VaultSchemaReport } from "../lib/api";
import { documentStats } from "../lib/document";
import type { DocumentPayload, VaultEntry } from "../lib/types";
import { useTranslation } from "../lib/i18n";
import { useContextMenuKeyboard } from "../lib/useContextMenuKeyboard";
import { useDebouncedValue } from "../lib/useDebouncedValue";
import { buildEntryIndex, resolveTargetIndexed } from "../lib/wikilinkSuggestions";
import { Button } from "./ui/Button";
import { useWikilinkAutocomplete } from "./WikilinkAutocomplete";

export type EditorViewMode = "rich" | "source" | "preview";

const LazyRichMarkdownEditor = lazy(() =>
  import("./RichMarkdownEditor").then((module) => ({ default: module.RichMarkdownEditor })),
);

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
  bodyOverride?: React.ReactNode;
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
  /** Managed vault note (write_policy managed + notes/**\/*.md) — arms the
   *  schema validation strip (maru-vault-graph-spec §3 F1). */
  isManagedVaultNote?: boolean;
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
    bodyOverride,
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
    isManagedVaultNote,
  },
  ref,
) {
  const { t, locale } = useTranslation();
  const deferredStatsDraft = useDeferredValue(draftContent);
  const stats = useMemo(
    () => documentStats(document, deferredStatsDraft),
    [document, deferredStatsDraft],
  );
  const localTextareaRef = useRef<HTMLTextAreaElement | null>(null);
  const taRef = textareaRef ?? localTextareaRef;

  // Managed-vault schema strip: debounce the draft 500ms → vault_validate_note
  // (spec §3 F1). Only armed for managed notes/**/*.md.
  const debouncedDraft = useDebouncedValue(draftContent, 500);
  const [schemaReport, setSchemaReport] = useState<VaultSchemaReport | null>(null);
  useEffect(() => {
    if (!isManagedVaultNote || !document) {
      setSchemaReport(null);
      return;
    }
    let cancelled = false;
    vaultValidateNote(debouncedDraft, document.relPath)
      .then((report) => {
        if (!cancelled) setSchemaReport(report);
      })
      .catch(() => {
        if (!cancelled) setSchemaReport(null);
      });
    return () => {
      cancelled = true;
    };
  }, [isManagedVaultNote, document, debouncedDraft]);
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

  const [previewHtml, setPreviewHtml] = useState("");
  useEffect(() => {
    if (!document || viewMode !== "preview") {
      setPreviewHtml("");
      return;
    }
    let cancelled = false;
    void import("../lib/markdown").then(({ renderMarkdown }) => {
      if (!cancelled) setPreviewHtml(renderMarkdown(draftContent));
    });
    return () => {
      cancelled = true;
    };
  }, [draftContent, document, viewMode]);

  // F3(b): mark unresolved wikilinks in the preview (red dotted) — clicking
  // one routes to onWikilinkClick, which seeds the note-creation dialog.
  // (The source tab is a plain textarea, so the preview surface hosts the
  // visual marking.)
  const previewRef = useRef<HTMLDivElement | null>(null);
  const previewIndex = useMemo(() => buildEntryIndex(entries), [entries]);
  useEffect(() => {
    if (viewMode !== "preview" || !previewRef.current) return;
    const anchors = previewRef.current.querySelectorAll<HTMLElement>("[data-wikilink]");
    for (const anchor of anchors) {
      const target = anchor.getAttribute("data-wikilink") ?? "";
      const resolved = target ? resolveTargetIndexed(previewIndex, entries, target) : null;
      anchor.classList.toggle("wikilink-missing", !resolved);
    }
  }, [previewHtml, viewMode, previewIndex, entries]);

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

  if (!bodyOverride && openingEntry && openingEntry.path !== document?.path) {
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

  if (!document && !bodyOverride) {
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

  const pathSegments = document ? document.relPath.split("/").filter(Boolean) : [];
  const folder = pathSegments.length > 1 ? pathSegments.slice(0, -1).join(" / ") : null;
  const breadcrumbTitle = document?.relPath ?? documentLabel ?? "";
  const headerTitle = documentLabel ?? document?.title ?? "";

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
        <div className="breadcrumb" title={breadcrumbTitle}>
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
          <strong>{headerTitle}</strong>
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

      {schemaReport ? (
        <div
          className={schemaReport.valid ? "schema-strip valid" : "schema-strip invalid"}
          data-testid="schema-strip"
          role="status"
        >
          {schemaReport.valid ? (
            <span className="schema-strip-ok">
              <Check size={12} /> {t("editor.schema.ok")}
            </span>
          ) : (
            <ul className="schema-strip-issues">
              {schemaReport.issues.map((issue) => (
                <li key={`${issue.field}:${issue.code}`}>
                  <strong>{issue.field}</strong> — {issue.message}
                </li>
              ))}
            </ul>
          )}
        </div>
      ) : null}

      {bodyOverride ? (
        <div className="editor-body editor-body--override">{bodyOverride}</div>
      ) : (
        <Tabs.Root
          className="editor-tabs"
          value={viewMode}
          onValueChange={(value) => onViewModeChange(value as EditorViewMode)}
        >
          <Tabs.List className="editor-tabs-row" aria-label={t("editor.tabs.viewAria")}>
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
            <Suspense fallback={<div className="editor-loading" role="status">…</div>}>
              <LazyRichMarkdownEditor value={draftContent} onChange={onChange} readOnly={readOnly} />
            </Suspense>
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
              ref={previewRef}
              className="preview-surface"
              onClick={handlePreviewClick}
              dangerouslySetInnerHTML={{ __html: previewHtml }}
            />
          </Tabs.Content>
        </Tabs.Root>
      )}

      <footer className="editor-status">
        {document ? (
          <>
            <span>{t("editor.status.lines", { count: stats.lines.toLocaleString(locale) })}</span>
            <span>{t("editor.status.words", { count: stats.words.toLocaleString(locale) })}</span>
            <span>{t("editor.status.chars", { count: stats.chars.toLocaleString(locale) })}</span>
            <span className="spacer" />
            <span>{document.fileKind.toUpperCase()}</span>
          </>
        ) : (
          <span className="spacer" />
        )}
      </footer>
    </main>
  );
});
