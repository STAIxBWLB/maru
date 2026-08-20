import * as Tabs from "@radix-ui/react-tabs";
import {
  Check,
  ChevronDown,
  ChevronRight,
  ChevronUp,
  Clock3,
  Columns2,
  FileText,
  GitCommit,
  Highlighter,
  Network,
  PanelRightOpen,
  Save,
  Waypoints,
  X,
} from "lucide-react";
import {
  forwardRef,
  lazy,
  memo,
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
import { EDITOR_FIND_OPEN_EVENT } from "../lib/editorFindEvents";
import { getEditorTabsState, type EditorGroupId } from "../lib/editorTabsStore";
import {
  applyFindHighlights,
  clearFindHighlights,
  cycleMatchIndex,
  findMatches,
} from "../lib/findInDocument";
import { isHtmlFileKind } from "../lib/htmlDocument";
import {
  mapSpansToRenderedText,
  refMapToCharSpans,
  type KgCharSpan,
} from "../lib/kgRefs";
import type { HtmlEditorFlushHandle } from "./HtmlVisualEditor";
import type { DocumentPayload, KgNodeRef, VaultEntry } from "../lib/types";
import { useTranslation } from "../lib/i18n";
import { useContextMenuKeyboard } from "../lib/useContextMenuKeyboard";
import { useDebouncedValue } from "../lib/useDebouncedValue";
import { buildEntryIndex, resolveTargetIndexed } from "../lib/wikilinkSuggestions";
import {
  applyKgPreviewHighlights,
  clearKgPreviewHighlights,
  KgSourceBackdrop,
} from "./KgRefHighlight";
import { Button } from "./ui/Button";
import { useWikilinkAutocomplete } from "./WikilinkAutocomplete";

export type EditorViewMode = "rich" | "source" | "preview";
export type HtmlViewMode = "visual" | "source" | "preview";

const LazyRichMarkdownEditor = lazy(() =>
  import("./RichMarkdownEditor").then((module) => ({ default: module.RichMarkdownEditor })),
);
const LazyHtmlVisualEditor = lazy(() =>
  import("./HtmlVisualEditor").then((module) => ({ default: module.HtmlVisualEditor })),
);
const LazyHtmlPreviewFrame = lazy(() =>
  import("./HtmlVisualEditor").then((module) => ({ default: module.HtmlPreviewFrame })),
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
  onOpenSourcePreview?: () => void;
  onOpenGraphRight: () => void;
  onFocusPane?: () => void;
  onToggleOutline: () => void;
  onViewModeChange: (mode: EditorViewMode) => void;
  onWikilinkClick: (target: string) => void;
  textareaRef?: React.RefObject<HTMLTextAreaElement | null>;
  /** HTML document tabs: per-pane view mode (visual/source/preview), owned by
   *  the caller — never persisted. */
  htmlViewMode?: HtmlViewMode;
  onHtmlViewModeChange?: (mode: HtmlViewMode) => void;
  htmlRiskAckDigest?: string | null;
  onHtmlRiskAck?: (digest: string) => void;
  htmlFlushRef?: React.RefObject<HtmlEditorFlushHandle | null>;
  /** Workspace absolute path, used to prepare HTML editor assets. */
  vaultPath?: string | null;
  /** Managed vault note (write_policy managed + notes/**\/*.md) — arms the
   *  schema validation strip (maru-vault-graph-spec §3 F1). */
  isManagedVaultNote?: boolean;
  /** KG reference visualization (kg_refs Phase 4). Trigger for the on-demand
   *  "Visualize references" synthesis in the graph split. */
  onVisualizeRefs?: () => void;
  /** Reference map refs while the per-document highlight toggle is on. */
  kgHighlightRefs?: KgNodeRef[] | null;
  onToggleKgHighlight?: () => void;
  /** Preview-mark click → focus the KG node in the graph split. */
  onKgRefNodeClick?: (nodePath: string) => void;
  /** Split-pane identity ("left" | "right"); the in-document find bar opens
   *  only in the focused group. */
  paneGroup?: EditorGroupId;
}

export const EditorPane = memo(forwardRef<HTMLDivElement, EditorPaneProps>(function EditorPane(
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
    onOpenSourcePreview,
    onOpenGraphRight,
    onFocusPane,
    onToggleOutline,
    onViewModeChange,
    onWikilinkClick,
    textareaRef,
    htmlViewMode,
    onHtmlViewModeChange,
    htmlRiskAckDigest,
    onHtmlRiskAck,
    htmlFlushRef,
    vaultPath,
    isManagedVaultNote,
    onVisualizeRefs,
    kgHighlightRefs = null,
    onToggleKgHighlight,
    onKgRefNodeClick,
    paneGroup,
  },
  ref,
) {
  const { t, locale } = useTranslation();
  const isHtml = document ? isHtmlFileKind(document.fileKind) : false;
  const isMarkdown = document
    ? document.fileKind.toLowerCase() === "md" ||
      document.fileKind.toLowerCase() === "markdown"
    : false;
  const activeMode: EditorViewMode | HtmlViewMode = isHtml
    ? (htmlViewMode ?? "visual")
    : viewMode;
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
  // Preview rebuilds the whole DOM per render — debounce so a keystroke
  // burst coalesces into one renderMarkdown pass. KG span mapping in preview
  // mode keys off the same debounced value (below). The debounced entry
  // carries the document it came from: a document switch is not a keystroke
  // burst, so it snaps to the live draft instead of showing the previous
  // note's body for the rest of the window.
  const previewDraftEntry = useMemo(
    () => ({ path: document?.path ?? null, text: draftContent }),
    [document?.path, draftContent],
  );
  const debouncedEntry = useDebouncedValue(previewDraftEntry, 200);
  const debouncedPreviewDraft =
    debouncedEntry.path === previewDraftEntry.path ? debouncedEntry.text : draftContent;
  useEffect(() => {
    if (!document || isHtml || viewMode !== "preview") {
      setPreviewHtml("");
      return;
    }
    let cancelled = false;
    void import("../lib/markdown").then(({ renderMarkdown }) => {
      if (!cancelled) setPreviewHtml(renderMarkdown(debouncedPreviewDraft));
    });
    return () => {
      cancelled = true;
    };
  }, [debouncedPreviewDraft, document, isHtml, viewMode]);

  // F3(b): mark unresolved wikilinks in the preview (red dotted) — clicking
  // one routes to onWikilinkClick, which seeds the note-creation dialog.
  // (The source tab is a plain textarea, so the preview surface hosts the
  // visual marking.)
  const previewRef = useRef<HTMLDivElement | null>(null);
  const previewIndex = useMemo(() => buildEntryIndex(entries), [entries]);
  useEffect(() => {
    if (isHtml || viewMode !== "preview" || !previewRef.current) return;
    const anchors = previewRef.current.querySelectorAll<HTMLElement>("[data-wikilink]");
    for (const anchor of anchors) {
      const target = anchor.getAttribute("data-wikilink") ?? "";
      const resolved = target ? resolveTargetIndexed(previewIndex, entries, target) : null;
      anchor.classList.toggle("wikilink-missing", !resolved);
    }
  }, [previewHtml, isHtml, viewMode, previewIndex, entries]);

  // KG reference highlight (Feature B): byte-offset spans → JS indices over
  // the current draft. Offsets come from the saved document; a dirty draft
  // can shift them slightly — purely decorative, never written back.
  // Preview mode keys off the debounced draft so refMapToCharSpans does not
  // run per keystroke; source/rich keep the live draft (identical char
  // coordinates are required for source-mode click hit-testing).
  const kgHighlightActive = Boolean(kgHighlightRefs && document && !isHtml);
  const kgSpanSource = viewMode === "preview" ? debouncedPreviewDraft : draftContent;
  const kgSpans = useMemo<KgCharSpan[] | null>(() => {
    if (!kgHighlightActive || !document || !kgHighlightRefs) return null;
    return refMapToCharSpans(kgSpanSource, {
      docPath: document.relPath,
      docHash: "",
      vaultStamp: "",
      refs: kgHighlightRefs,
      computedAt: "",
    });
  }, [kgHighlightActive, document, kgHighlightRefs, kgSpanSource]);
  const kgTitleFor = useCallback(
    (span: { nodeTitle: string; matchKind: "wikilink" | "entity" }) =>
      `${span.nodeTitle} · ${t(span.matchKind === "wikilink" ? "kgref.kind.wikilink" : "kgref.kind.entity")}`,
    [t],
  );

  // Preview mode: wrap rendered text ranges in <mark> after each render.
  // Cleanup unwraps, so toggling off or switching docs restores the DOM.
  useEffect(() => {
    const container = previewRef.current;
    if (!container || isHtml || viewMode !== "preview" || !kgSpans || !previewHtml) return;
    const mapped = mapSpansToRenderedText(
      container.textContent ?? "",
      kgSpans,
      (span) => kgSpanSource.slice(span.start, span.end),
    );
    applyKgPreviewHighlights(container, mapped, kgTitleFor);
    return () => clearKgPreviewHighlights(container);
  }, [kgSpans, previewHtml, isHtml, viewMode, kgSpanSource, kgTitleFor]);

  // In-document find (Cmd+F). Source drives the textarea selection; markdown
  // preview injects <mark class="find-mark">. Rich/visual and the HTML preview
  // iframe own their DOM, so there the bar shows a notice instead.
  const [findOpen, setFindOpen] = useState(false);
  const [findQuery, setFindQuery] = useState("");
  const [findIndex, setFindIndex] = useState(0);
  const findInputRef = useRef<HTMLInputElement | null>(null);
  const findSupported = activeMode === "source" || (activeMode === "preview" && !isHtml);
  const documentPath = document?.path ?? null;

  useEffect(() => {
    const open = () => {
      if (!documentPath) return;
      if (paneGroup && paneGroup !== getEditorTabsState().focusedEditorGroup) return;
      // Already open: state is unchanged, so the focus effect below does not
      // rerun — refocus the mounted input explicitly.
      if (findOpen) {
        findInputRef.current?.focus();
        findInputRef.current?.select();
        return;
      }
      setFindOpen(true);
    };
    window.addEventListener(EDITOR_FIND_OPEN_EVENT, open);
    return () => window.removeEventListener(EDITOR_FIND_OPEN_EVENT, open);
  }, [documentPath, paneGroup, findOpen]);

  // Focus after the bar has committed — a rAF from the event handler can run
  // before the input mounts.
  useEffect(() => {
    if (!findOpen) return;
    findInputRef.current?.focus();
    findInputRef.current?.select();
  }, [findOpen]);

  // A document switch is a new search context.
  useEffect(() => {
    setFindOpen(false);
    setFindQuery("");
    setFindIndex(0);
  }, [documentPath]);

  const previewText = useMemo(() => {
    if (activeMode !== "preview" || isHtml || !previewHtml) return "";
    return (
      new DOMParser().parseFromString(previewHtml, "text/html").body.textContent ?? ""
    );
  }, [activeMode, isHtml, previewHtml]);
  const findText = activeMode === "source" ? draftContent : previewText;
  const findMatchList = useMemo(
    () => (findOpen && findSupported ? findMatches(findText, findQuery) : []),
    [findOpen, findSupported, findText, findQuery],
  );
  const findCurrent =
    findMatchList.length === 0 ? 0 : Math.min(findIndex, findMatchList.length - 1);

  // Source: select the current match in the textarea and scroll to it. The
  // textarea is not focused here — the find input keeps focus while typing.
  useEffect(() => {
    if (!findOpen || activeMode !== "source" || findMatchList.length === 0) return;
    const ta = taRef.current;
    if (!ta) return;
    const match = findMatchList[findCurrent];
    ta.setSelectionRange(match.start, match.end);
    const lineHeight = parseFloat(window.getComputedStyle(ta).lineHeight) || 20;
    const linesBefore = draftContent.slice(0, match.start).split("\n").length - 1;
    ta.scrollTop = Math.max(0, linesBefore * lineHeight - ta.clientHeight / 2);
  }, [findOpen, activeMode, findMatchList, findCurrent, taRef, draftContent]);

  // Preview: mark matches after each debounced render, scroll the current one
  // into view. Runs after the KG-mark effect; cleanup touches only find marks.
  //
  // `kgSpans` is a dependency even though it is unused here: the KG effect
  // unwraps and re-wraps its ranges whenever it re-runs, which destroys find
  // marks sitting in the same container. Reference maps load asynchronously, so
  // they can land after a search is already active. Depending on `kgSpans` puts
  // this effect in the same commit, and because it is declared after the KG
  // effect React re-applies find marks on top of the rebuilt KG marks.
  useEffect(() => {
    if (!findOpen || activeMode !== "preview" || isHtml) return;
    const container = previewRef.current;
    if (!container || !previewHtml) return;
    const count = applyFindHighlights(container, findQuery, findCurrent);
    if (count > 0) {
      container
        .querySelector(".find-mark-current")
        ?.scrollIntoView({ block: "center" });
    }
    return () => clearFindHighlights(container);
  }, [findOpen, findQuery, findCurrent, activeMode, isHtml, previewHtml, kgSpans]);

  const cycleFind = useCallback(
    (dir: 1 | -1) => {
      setFindIndex((index) => cycleMatchIndex(index, findMatchList.length, dir));
    },
    [findMatchList.length],
  );
  const closeFind = useCallback(() => {
    setFindOpen(false);
    setFindQuery("");
    setFindIndex(0);
    if (activeMode === "source") taRef.current?.focus();
  }, [activeMode, taRef]);

  const handlePreviewClick = useCallback(
    (event: React.MouseEvent<HTMLElement>) => {
      const mark = (event.target as HTMLElement).closest(
        "mark.kg-ref-mark",
      ) as HTMLElement | null;
      if (mark?.dataset.kgNode && onKgRefNodeClick) {
        event.preventDefault();
        onKgRefNodeClick(mark.dataset.kgNode);
        return;
      }
      const node = (event.target as HTMLElement).closest(
        "[data-wikilink]",
      ) as HTMLElement | null;
      if (!node) return;
      event.preventDefault();
      const target = node.getAttribute("data-wikilink");
      if (target) onWikilinkClick(target);
    },
    [onWikilinkClick, onKgRefNodeClick],
  );

  // Source mode: the backdrop is pointer-events:none, so a click on a
  // highlighted span lands on the textarea. The caret offset (selectionStart)
  // is in the same char coordinates as kgSpans — hit-test directly.
  // Only a collapsed caret counts: selectionStart is the LEFT edge of a
  // range, so a drag-select or double-click that merely starts inside a span
  // is not someone clicking the reference.
  const handleSourceClick = useCallback(
    (event: React.MouseEvent<HTMLTextAreaElement>) => {
      autocompleteHandlers.onClick();
      if (!kgSpans || !onKgRefNodeClick) return;
      const { selectionStart: offset, selectionEnd } = event.currentTarget;
      if (offset !== selectionEnd) return;
      const span = kgSpans.find((candidate) => offset >= candidate.start && offset < candidate.end);
      if (span) onKgRefNodeClick(span.nodePath);
    },
    [autocompleteHandlers, kgSpans, onKgRefNodeClick],
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
      <main
        className="editor-pane editor-empty"
        ref={ref}
        onPointerDown={onFocusPane}
        onFocusCapture={onFocusPane}
      >
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
      <main
        className="editor-pane editor-empty"
        ref={ref}
        onPointerDown={onFocusPane}
        onFocusCapture={onFocusPane}
      >
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
    <main
      className="editor-pane"
      ref={ref}
      onPointerDown={onFocusPane}
      onFocusCapture={onFocusPane}
    >
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
            onClick={() => onOpenGraphRight()}
            title={t("editor.openGraphRight")}
            aria-label={t("editor.openGraphRight")}
          >
            <Waypoints size={13} />
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
          {document && !isHtml && onVisualizeRefs ? (
            <button
              type="button"
              className="icon-button"
              onClick={onVisualizeRefs}
              title={t("kgref.visualize")}
              aria-label={t("kgref.visualize")}
              data-testid="kg-visualize-refs"
            >
              <Network size={14} />
            </button>
          ) : null}
          {document && !isHtml && onToggleKgHighlight ? (
            <button
              type="button"
              className={kgHighlightActive ? "icon-button active" : "icon-button"}
              onClick={onToggleKgHighlight}
              aria-pressed={kgHighlightActive}
              title={t("kgref.highlight")}
              aria-label={t("kgref.highlight")}
              data-testid="kg-highlight-toggle"
            >
              <Highlighter size={14} />
            </button>
          ) : null}
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
          value={activeMode}
          onValueChange={(value) => {
            if (isHtml) onHtmlViewModeChange?.(value as HtmlViewMode);
            else onViewModeChange(value as EditorViewMode);
          }}
        >
          <div className="editor-view-toolbar">
            <Tabs.List className="editor-tabs-row" aria-label={t("editor.tabs.viewAria")}>
              <Tabs.Trigger className="tab-trigger" value={isHtml ? "visual" : "rich"}>
                {isHtml ? t("editor.tab.visual") : t("editor.tab.rich")}
              </Tabs.Trigger>
              <Tabs.Trigger className="tab-trigger" value="source">
                {t("editor.tab.source")}
              </Tabs.Trigger>
              <Tabs.Trigger className="tab-trigger" value="preview">
                {t("editor.tab.preview")}
              </Tabs.Trigger>
            </Tabs.List>
            {isMarkdown && onOpenSourcePreview ? (
              <button
                type="button"
                className="editor-source-preview-preset"
                onClick={onOpenSourcePreview}
                title={t("editor.sourcePreview.title")}
                aria-label={t("editor.sourcePreview.title")}
              >
                <Columns2 size={12} />
                <span>{t("editor.sourcePreview.label")}</span>
              </button>
            ) : null}
          </div>
          {findOpen ? (
            <div className="editor-find-bar" role="search">
              <input
                ref={findInputRef}
                className="editor-find-input"
                value={findQuery}
                placeholder={t("editor.find.placeholder")}
                aria-label={t("editor.find.placeholder")}
                onChange={(event) => {
                  setFindQuery(event.target.value);
                  setFindIndex(0);
                }}
                onKeyDown={(event) => {
                  if (event.key === "Enter") {
                    event.preventDefault();
                    cycleFind(event.shiftKey ? -1 : 1);
                  } else if (event.key === "Escape") {
                    event.preventDefault();
                    closeFind();
                  }
                }}
              />
              {findSupported ? (
                <>
                  <span className="editor-find-count" aria-live="polite">
                    {findQuery.trim() === ""
                      ? ""
                      : findMatchList.length === 0
                        ? t("editor.find.noResults")
                        : t("editor.find.count", {
                            current: findCurrent + 1,
                            total: findMatchList.length,
                          })}
                  </span>
                  <button
                    type="button"
                    className="editor-find-nav"
                    onClick={() => cycleFind(-1)}
                    title={t("editor.find.previous")}
                    aria-label={t("editor.find.previous")}
                  >
                    <ChevronUp size={12} />
                  </button>
                  <button
                    type="button"
                    className="editor-find-nav"
                    onClick={() => cycleFind(1)}
                    title={t("editor.find.next")}
                    aria-label={t("editor.find.next")}
                  >
                    <ChevronDown size={12} />
                  </button>
                </>
              ) : (
                <span className="editor-find-unsupported">
                  {t("editor.find.unsupported")}
                </span>
              )}
              <button
                type="button"
                className="editor-find-nav"
                onClick={closeFind}
                title={t("editor.find.close")}
                aria-label={t("editor.find.close")}
              >
                <X size={12} />
              </button>
            </div>
          ) : null}
          <Tabs.Content className="tab-panel" value={isHtml ? "visual" : "rich"}>
            <Suspense fallback={<div className="editor-loading" role="status">…</div>}>
              {isHtml && document ? (
                <LazyHtmlVisualEditor
                  value={draftContent}
                  onChange={onChange}
                  readOnly={readOnly}
                  readOnlyReason={readOnlyReason}
                  vaultPath={vaultPath ?? ""}
                  documentPath={document.path}
                  riskAckDigest={htmlRiskAckDigest}
                  onRiskAck={onHtmlRiskAck ?? (() => {})}
                  onRequestSourceMode={() => onHtmlViewModeChange?.("source")}
                  ref={htmlFlushRef}
                />
              ) : (
                <LazyRichMarkdownEditor
                  value={draftContent}
                  onChange={onChange}
                  readOnly={readOnly}
                  kgSpans={kgSpans}
                  kgTitleFor={kgTitleFor}
                  onKgRefNodeClick={onKgRefNodeClick}
                />
              )}
            </Suspense>
          </Tabs.Content>
          <Tabs.Content className="tab-panel" value="source">
            <div className={kgSpans ? "source-editor-wrap kg-active" : "source-editor-wrap"}>
              {kgSpans ? (
                <KgSourceBackdrop
                  content={draftContent}
                  spans={kgSpans}
                  textareaRef={taRef}
                  titleFor={kgTitleFor}
                />
              ) : null}
              <textarea
                ref={taRef}
                className="source-editor"
                value={draftContent}
                onChange={(event) => onChange(event.target.value)}
                readOnly={readOnly}
                onKeyDown={autocompleteHandlers.onKeyDown}
                onKeyUp={autocompleteHandlers.onKeyUp}
                onClick={handleSourceClick}
                onCompositionStart={autocompleteHandlers.onCompositionStart}
                onCompositionEnd={autocompleteHandlers.onCompositionEnd}
                spellCheck={false}
              />
            </div>
            {autocompletePopup}
          </Tabs.Content>
          <Tabs.Content className="tab-panel" value="preview">
            {isHtml && document ? (
              <Suspense fallback={<div className="editor-loading" role="status">…</div>}>
                <LazyHtmlPreviewFrame
                  value={draftContent}
                  vaultPath={vaultPath ?? ""}
                  documentPath={document.path}
                  title={document.title}
                />
              </Suspense>
            ) : (
              <article
                ref={previewRef}
                className="preview-surface"
                onClick={handlePreviewClick}
                dangerouslySetInnerHTML={{ __html: previewHtml }}
              />
            )}
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
}));
