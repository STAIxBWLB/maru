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
import { getEditorTabsState } from "../lib/editorTabsStore";
import {
  patchEditorPaneViewPreview,
  updateEditorPaneDraft,
  useEditorDocumentSlice,
  useEditorOperationSlice,
  useEditorPresentationSlice,
  useEditorTabsSlice,
  useEditorViewPreviewSlice,
  type EditorPaneScope,
} from "../lib/editorPaneStore";
import type { EditorPaneCommands } from "../lib/editorSurfaceAdapter";
import {
  applyFindHighlights,
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
import type { KgNodeRef, VaultEntry } from "../lib/types";
import { useTranslation } from "../lib/i18n";
import { useContextMenuKeyboard } from "../lib/useContextMenuKeyboard";
import { useDebouncedValue } from "../lib/useDebouncedValue";
import { buildEntryIndex, resolveTargetIndexed } from "../lib/wikilinkSuggestions";
import {
  applyKgPreviewHighlights,
  KgSourceBackdrop,
} from "./KgRefHighlight";
import { Button } from "./ui/Button";
import { useWikilinkAutocomplete } from "./WikilinkAutocomplete";
import {
  DocumentModeSurface,
  type DocumentMode,
  type EditorViewMode,
  type HtmlViewMode,
} from "./DocumentModeSurface";

export type { EditorViewMode, HtmlViewMode } from "./DocumentModeSurface";

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

export interface EditorPaneProps {
  scope: EditorPaneScope;
  commands: EditorPaneCommands;
  textareaRef?: React.RefObject<HTMLTextAreaElement | null>;
  htmlFlushRef?: React.RefObject<HtmlEditorFlushHandle | null>;
}

interface PreviewDecoration {
  kgSpans: KgCharSpan[] | null;
  kgSource: string;
  kgTitleFor: (span: { nodeTitle: string; matchKind: "wikilink" | "entity" }) => string;
  /** Empty when find is closed or not applicable to the preview. */
  findQuery: string;
  findCurrent: number;
  resolveWikilink: (target: string) => boolean;
}

/**
 * Fold the reference marks, the find marks and the unresolved-wikilink class
 * into the html React renders, so React owns every node in the preview.
 *
 * These used to be three effects mutating the mounted container. React assigns
 * `dangerouslySetInnerHTML` unconditionally whenever the prop value is not
 * identity-equal, so any re-render restored the container and dropped whatever
 * they had applied, with nothing to put it back.
 *
 * Two invariants hold this together:
 *   - Only DOM-constructed nodes may be added here. Everything below goes
 *     through createElement/textContent/dataset, so nothing can escape its
 *     element or attribute and the already-sanitized base html stays safe
 *     without a second DOMPurify pass.
 *   - Reference marks are applied before find marks, so a match inside a
 *     reference nests as <mark kg><mark find>, which is what the DOM passes
 *     produced when they ran in that commit order.
 */
export function decoratePreviewHtml(baseHtml: string, decoration: PreviewDecoration): string {
  if (!baseHtml) return "";
  const needsKg = Boolean(decoration.kgSpans?.length);
  const needsFind = decoration.findQuery.trim().length > 0;
  const needsWikilink = baseHtml.includes("data-wikilink");
  if (!needsKg && !needsFind && !needsWikilink) return baseHtml;

  // Parsed as a fragment inside an inert document. Both halves matter:
  // `DOMParser(html, "text/html")` would move a leading <style> into <head>,
  // and returning only the body would silently drop it; a detached <div> in
  // this document would parse correctly but still fetch <img> sources, once
  // per find-bar keystroke. The helpers below reach for the global `document`
  // to build nodes across this boundary, which is legal because insertion
  // adopts them; they do not need an ownerDocument parameter.
  const body = document.implementation.createHTMLDocument("").createElement("div");
  body.innerHTML = baseHtml;

  if (needsKg) {
    applyKgPreviewHighlights(
      body,
      mapSpansToRenderedText(body.textContent ?? "", decoration.kgSpans!, (span) =>
        decoration.kgSource.slice(span.start, span.end),
      ),
      decoration.kgTitleFor,
    );
  }
  if (needsFind) applyFindHighlights(body, decoration.findQuery, decoration.findCurrent);
  if (needsWikilink) {
    for (const anchor of body.querySelectorAll<HTMLElement>("[data-wikilink]")) {
      const target = anchor.getAttribute("data-wikilink") ?? "";
      anchor.classList.toggle("wikilink-missing", !(target && decoration.resolveWikilink(target)));
    }
  }
  return body.innerHTML;
}

export const EditorPane = memo(forwardRef<HTMLDivElement, EditorPaneProps>(function EditorPane(
  { scope, commands, textareaRef, htmlFlushRef },
  ref,
) {
  const documentSlice = useEditorDocumentSlice(scope);
  const tabsSlice = useEditorTabsSlice(scope);
  const viewPreview = useEditorViewPreviewSlice(scope);
  const operation = useEditorOperationSlice(scope);
  const presentation = useEditorPresentationSlice(scope);
  const document = documentSlice.document;
  const draftContent = documentSlice.draftContent;
  const tabs = presentation.tabs;
  const activeTabId = presentation.activeTabId ?? tabsSlice.activeTabId;
  const openingEntry = operation.openingEntry;
  const saving = operation.saving;
  const dirty = Boolean(documentSlice.tab && draftContent !== document?.content);
  const viewMode = viewPreview.viewMode;
  const htmlViewMode = viewPreview.htmlViewMode;
  const htmlRiskAckDigest = viewPreview.htmlRiskAckDigest;
  const {
    outlineOpen,
    activeWorkspaceLabel,
    documentLabel,
    readOnly,
    canSnapshot,
    readOnlyReason,
    entries: presentationEntries,
    bodyOverride,
    vaultPath,
    isManagedVaultNote,
  } = presentation;
  const entries = presentationEntries as VaultEntry[];
  const kgHighlightRefs = presentation.kgHighlightRefs as KgNodeRef[] | null;
  const paneGroup = scope.group;
  const onChange = useCallback(
    (content: string) => updateEditorPaneDraft(scope, content),
    [scope],
  );
  const onSelectTab = (tabId: string) => void commands.selectTab(tabId);
  const onCloseTab = (tabId: string) => void commands.closeTab(tabId);
  const onCloseOtherTabs = (tabId: string) => void commands.closeOtherTabs(tabId);
  const onCloseTabsToRight = (tabId: string) => void commands.closeTabsToRight(tabId);
  const onCloseSavedTabs = () => void commands.closeSavedTabs();
  const onCloseAllTabs = () => void commands.closeAllTabs();
  const onCopyTabName = (tabId: string) => void commands.copyTabName(tabId);
  const onCopyTabPath = (tabId: string) => void commands.copyTabPath(tabId);
  const onCopyTabRelativePath = (tabId: string) => void commands.copyTabRelativePath(tabId);
  const onRenameTab = (tabId: string) => void commands.renameTab(tabId);
  const onMoveTab = (tabId: string) => void commands.moveTab(tabId);
  const onDuplicateTab = (tabId: string) => void commands.duplicateTab(tabId);
  const onDeleteTab = (tabId: string) => void commands.deleteTab(tabId);
  const onOpenTabPreview = (tabId: string) => void commands.openTabPreview(tabId);
  const onRevealTabInFinder = (tabId: string) => void commands.revealTabInFinder(tabId);
  const onRevealTabInExplorer = (tabId: string) => void commands.revealTabInExplorer(tabId);
  const onSave = () => void commands.save();
  const onSnapshot = () => void commands.snapshot();
  const onSplitRight = () => void commands.splitRight();
  const onOpenSourcePreview = () => void commands.openSourcePreview();
  const onOpenGraphRight = () => void commands.openGraphRight();
  const onFocusPane = () => void commands.focusPane();
  const onToggleOutline = () => void commands.toggleOutline();
  const onViewModeChange = (mode: EditorViewMode) => {
    patchEditorPaneViewPreview(scope, { viewMode: mode });
    void commands.persistViewMode(mode);
  };
  const onHtmlViewModeChange = (mode: HtmlViewMode) => {
    void commands.flushHtmlDraft();
    patchEditorPaneViewPreview(scope, { htmlViewMode: mode });
  };
  const onHtmlRiskAck = (digest: string) =>
    patchEditorPaneViewPreview(scope, { htmlRiskAckDigest: digest });
  const onVisualizeRefs = () => void commands.visualizeRefs();
  const onToggleKgHighlight = () => void commands.toggleKgHighlight();
  const onKgRefNodeClick = useCallback(
    (nodePath: string) => void commands.openKgRefNode(nodePath),
    [commands],
  );
  const onWikilinkClick = useCallback(
    (target: string) => void commands.openWikilink(target),
    [commands],
  );
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

  const [previewBaseHtml, setPreviewBaseHtml] = useState("");
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
      setPreviewBaseHtml("");
      return;
    }
    let cancelled = false;
    void import("../lib/markdown").then(({ renderMarkdown }) => {
      if (!cancelled) setPreviewBaseHtml(renderMarkdown(debouncedPreviewDraft));
    });
    return () => {
      cancelled = true;
    };
  }, [debouncedPreviewDraft, document, isHtml, viewMode]);

  const previewRef = useRef<HTMLDivElement | null>(null);
  const previewIndex = useMemo(() => buildEntryIndex(entries), [entries]);

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
    if (activeMode !== "preview" || isHtml || !previewBaseHtml) return "";
    return (
      new DOMParser().parseFromString(previewBaseHtml, "text/html").body.textContent ?? ""
    );
  }, [activeMode, isHtml, previewBaseHtml]);
  const findText = activeMode === "source" ? draftContent : previewText;
  const findMatchList = useMemo(
    () => (findOpen && findSupported ? findMatches(findText, findQuery) : []),
    [findOpen, findSupported, findText, findQuery],
  );
  const findCurrent =
    findMatchList.length === 0 ? 0 : Math.min(findIndex, findMatchList.length - 1);

  // Everything that used to be applied to the mounted container is folded into
  // the html React renders, so React is the only writer and a re-render cannot
  // discard it.
  const previewHtml = useMemo(
    () =>
      decoratePreviewHtml(previewBaseHtml, {
        kgSpans,
        kgSource: kgSpanSource,
        kgTitleFor,
        findQuery:
          findOpen && findSupported && activeMode === "preview" && !isHtml ? findQuery : "",
        findCurrent,
        resolveWikilink: (target) => Boolean(resolveTargetIndexed(previewIndex, entries, target)),
      }),
    [
      previewBaseHtml,
      kgSpans,
      kgSpanSource,
      kgTitleFor,
      findOpen,
      findSupported,
      activeMode,
      isHtml,
      findQuery,
      findCurrent,
      previewIndex,
      entries,
    ],
  );

  // React 19 skips a prop only when the value is identity-equal, and its
  // dangerouslySetInnerHTML branch then assigns innerHTML unconditionally
  // without comparing the string. An inline object literal is new every render,
  // so the container was rewritten on every render and anything applied to it
  // imperatively was discarded. Memoizing on the string means a recompute that
  // yields identical HTML returns the same object and React writes nothing.
  const previewMarkup = useMemo(() => ({ __html: previewHtml }), [previewHtml]);

  // Derived from the undecorated html on purpose: the decoration depends on
  // findCurrent, which depends on this match list, which would depend on the
  // decorated html. Marks are additive, so the text is the same either way.

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

  // The marks themselves are part of the rendered html now; the only thing
  // left to do after the commit is bring the current match into view.
  // `previewHtml` is a dependency because it is value-compared, so this fires
  // exactly when the preview DOM actually changed. Trimming it to the find
  // state alone would silently stop re-centering when content changes under an
  // active search.
  useEffect(() => {
    if (!findOpen || activeMode !== "preview" || isHtml) return;
    previewRef.current?.querySelector(".find-mark-current")?.scrollIntoView({ block: "center" });
  }, [findOpen, activeMode, isHtml, findQuery, findCurrent, previewHtml]);

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
        <DocumentModeSurface
          t={t}
          kind={isHtml ? "html" : isMarkdown ? "markdown" : "plain"}
          mode={activeMode}
          onModeChange={(value: DocumentMode) => {
            if (isHtml) onHtmlViewModeChange?.(value as HtmlViewMode);
            else onViewModeChange(value as EditorViewMode);
          }}
          toolbarAction={
            isMarkdown && onOpenSourcePreview ? (
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
            ) : null
          }
          auxiliary={
            findOpen ? (
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
            ) : null
          }
          richPanel={
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
          }
          sourcePanel={
            <>
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
            </>
          }
          previewPanel={
            isHtml && document ? (
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
                dangerouslySetInnerHTML={previewMarkup}
              />
            )
          }
        />
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
