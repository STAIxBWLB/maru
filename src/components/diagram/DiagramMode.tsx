import { Eye, Network } from "lucide-react";
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ChangeEvent,
  type PointerEvent as ReactPointerEvent,
} from "react";

import {
  addNode,
  defaultCoalescer,
  duplicateSelection,
  nudgeSelection,
  redo as redoAction,
  removeEdges,
  removeNodes,
  replaceDoc,
  selectAllNodes,
  setDocTitle,
  setNodeMeta,
  setSnapSize,
  setViewport,
  toggleFocusMode,
  undo as undoAction,
  updateNode,
  withSnapshot,
} from "../../lib/diagram/actions";
import {
  addTableNode,
  clearCellsText,
  copyCellsToClipboard,
  copyNodesToClipboard,
  matrixForTableNode,
  pasteClipboard,
  setCellText,
  setTableSelection,
  updateMatrix,
} from "../../lib/diagram/tableActions";
import {
  cellAtAddr,
  cellRect,
  computeTableLayout,
  moveFocus,
  parseTsv,
  pasteTextGridAt,
} from "../../lib/diagram/tableEditing";
import { nextTableKeyAction } from "../../lib/diagram/tableKeys";
import { isInEditable, matchesShortcut } from "../../lib/diagram/shortcuts";
import { fitView } from "../../lib/diagram/geometry";
import {
  clipboardWriteHtml,
  clipboardWriteImagePng,
  clipboardWriteText,
} from "../../lib/clipboard";
import {
  expandMatrixToGrid,
  htmlTableToMatrix,
  matrixExceedsLimits,
  matrixFromTextGrid,
  parseMarkdownTable,
  serializeMatrixToHtml,
  serializeMatrixToMarkdown,
} from "../../lib/diagram/codecs";
import { readClipboardCandidate } from "../../lib/diagram/clipboardImport";
import { blobToUint8Array, exportPng, exportSvg } from "../../lib/diagram/export";
import {
  TABLE_PATTERN_ID,
  type MatrixDataset,
  type ReportDataset,
} from "../../lib/diagram/reportTypes";
import { readMaruSettings, saveMaruSettings } from "../../lib/maruDir";
import { readDocument } from "../../lib/api";
import { defaultReportInsertDeps, insertDiagramIntoReport } from "../../lib/diagram/reportInsert";
import { findManagedBlock } from "../../lib/diagram/reportLink";
import {
  DIAGRAM_FAVORITE_PATTERNS_CAP,
  DIAGRAM_RECENT_PATTERNS_CAP,
} from "../../lib/settings";
import {
  classifyConversion,
  switchViewPatternAction,
  type CrossConversionResult,
} from "../../lib/diagram/convert";
import { getPattern } from "../../lib/diagram/patterns";
import {
  analyzeViewDrag,
  detachViewMembersSnippetAction,
  insertPatternAt,
  insertPatternAtAction,
  newDocumentFromPattern,
  presetApplyOpts,
  singleLinkedViewId,
} from "../../lib/diagram/patternStudio";
import type { MkNodeOpts } from "../../lib/diagram/nodeKinds";
import {
  deleteDiagram,
  listDiagrams,
  readDiagramDetailed,
  serializeDoc,
  UnsupportedDiagramVersionError,
  type DiagramFile,
  writeDiagram,
} from "../../lib/diagram/persistence";
import { diagramBackupDocument } from "../../lib/diagram";
import {
  createAutoSnapshotScheduler,
  saveSnapshotForDoc,
  type AutoSnapshotScheduler,
} from "../../lib/diagram/versionHistory";
import {
  createDiagramId,
  createEmptyDoc,
  type NodeId,
  type NodeKind,
  type RibbonTab,
  type TableCellAddress,
} from "../../lib/diagram/types";
import { useTranslation } from "../../lib/i18n";
import {
  DiagramStoreProvider,
  getDiagramSession,
  setDiagramSession,
  useDiagram,
  useDiagramCoalescer,
  useDiagramGestureCoalescers,
  useDiagramStore,
} from "./DiagramStoreContext";
import { CanvasSurface } from "./canvas/CanvasSurface";
import { InlineTextEditor, type InlineEditField } from "./canvas/InlineTextEditor";
import { LeftPanel } from "./panels/LeftPanel";
import { RightPanel } from "./panels/RightPanel";
import { Ribbon } from "./ribbon/Ribbon";
import { ImportExportDialog } from "./modals/ImportExportDialog";
import { MappingPreviewDialog } from "./modals/MappingPreviewDialog";
import { MemoDialog } from "./modals/MemoDialog";
import {
  PatternGalleryDialog,
  type GallerySelection,
} from "./modals/PatternGalleryDialog";
import { SaveAsDialog } from "./modals/SaveAsDialog";
import { ReportTargetDialog } from "./modals/ReportTargetDialog";
import { SpecialCharsPicker } from "./modals/SpecialCharsPicker";
import { VersionHistoryDialog } from "./modals/VersionHistoryDialog";
import { FindBar } from "./canvas/FindBar";
import "./diagram.css";

export interface DiagramActiveDocument {
  /** Workspace-relative path (what `readDocument`/`saveDocument` take). */
  path: string;
  title: string;
  revision?: string;
  fileKind?: string;
}

export interface DiagramRecentDocument {
  path: string;
  title: string;
}

export interface DiagramModeProps {
  workPath: string | null;
  onError?: (message: string | null) => void;
  /** Active editor document — the direct "Insert in report" target when it is
   *  a Markdown file (fileKind "md"). Anything else goes to the chooser. */
  activeDocument?: DiagramActiveDocument | null;
  /** Recent documents for the target chooser (path + display title). */
  recentDocuments?: DiagramRecentDocument[];
  /** Revision-checked save callback injected by the app shell so Diagram mode
   *  stays decoupled from the editor's save path. */
  onSaveDocument?: (
    path: string,
    content: string,
    expectedRevision: string | null,
  ) => Promise<unknown>;
}

const ZOOM_STEP = 1.25;
const MIN_ZOOM = 0.2;
const MAX_ZOOM = 3;
const SNAP_STORAGE_KEY = "maru:diagram:snap-size";
const PANEL_STORAGE_KEY = "maru:diagram:panels-v1";
const LAST_DOCUMENT_STORAGE_KEY = "maru:diagram:last-document";
const MAX_IMAGE_BYTES = 2 * 1024 * 1024;

interface PersistedPanelState {
  left: boolean;
  right: boolean;
  ribbon: RibbonTab;
  leftWidth: number;
  rightWidth: number;
}

const PANEL_MIN_WIDTH = 200;
const PANEL_MAX_WIDTH = 520;
const PANEL_DEFAULT_WIDTH = 260;

function clampWidth(value: unknown): number {
  if (typeof value !== "number" || !Number.isFinite(value)) return PANEL_DEFAULT_WIDTH;
  return Math.max(PANEL_MIN_WIDTH, Math.min(PANEL_MAX_WIDTH, Math.round(value)));
}

function readPanelState(): PersistedPanelState {
  try {
    const raw = window.localStorage.getItem(PANEL_STORAGE_KEY);
    if (raw) {
      const parsed = JSON.parse(raw) as Partial<PersistedPanelState>;
      return {
        left: parsed.left !== false,
        right: parsed.right !== false,
        ribbon: (parsed.ribbon ?? "edit") as RibbonTab,
        leftWidth: clampWidth(parsed.leftWidth),
        rightWidth: clampWidth(parsed.rightWidth),
      };
    }
  } catch {
    /* ignore */
  }
  return {
    left: true,
    right: true,
    ribbon: "edit",
    leftWidth: PANEL_DEFAULT_WIDTH,
    rightWidth: PANEL_DEFAULT_WIDTH,
  };
}

function writePanelState(state: PersistedPanelState): void {
  try {
    window.localStorage.setItem(PANEL_STORAGE_KEY, JSON.stringify(state));
  } catch {
    /* ignore */
  }
}

function lastDocumentStorageKey(workPath: string): string {
  return `${LAST_DOCUMENT_STORAGE_KEY}:${workPath}`;
}

function readLastDocumentFallback(workPath: string): string | null {
  try {
    return window.localStorage.getItem(lastDocumentStorageKey(workPath)) || null;
  } catch {
    return null;
  }
}

function writeLastDocumentFallback(workPath: string, lastDocument: string | null): void {
  try {
    const key = lastDocumentStorageKey(workPath);
    if (lastDocument) window.localStorage.setItem(key, lastDocument);
    else window.localStorage.removeItem(key);
  } catch {
    /* ignore */
  }
}

export function DiagramMode(props: DiagramModeProps) {
  const storeKey = props.workPath ?? "__no-workspace__";
  return (
    <DiagramStoreProvider storeKey={storeKey}>
      <DiagramShell key={storeKey} {...props} />
    </DiagramStoreProvider>
  );
}

function DiagramShell({
  workPath,
  onError,
  activeDocument = null,
  recentDocuments = [],
  onSaveDocument,
}: DiagramModeProps) {
  const { t } = useTranslation();
  const store = useDiagramStore();
  const coalescer = useDiagramCoalescer();
  const gestureCoalescers = useDiagramGestureCoalescers();
  const sessionKey = workPath ?? "__no-workspace__";
  const doc = useDiagram((s) => s.doc);
  const nodes = doc.nodes;
  const edges = doc.edges;
  const docTitle = doc.docTitle;
  const selection = useDiagram((s) => s.ephemeral.selection);
  const viewport = useDiagram((s) => s.ephemeral.viewport);

  // Read once on mount from the session singleton so switching activity-rail
  // tabs and coming back resumes the in-progress work without losing the
  // active filename or dirty/saved status.
  const [activeName, setActiveNameState] = useState<string | null>(() => getDiagramSession(sessionKey).activeName);
  const [lastSavedBody, setLastSavedBodyState] = useState<string | null>(
    () => getDiagramSession(sessionKey).lastSavedBody,
  );
  const setActiveName = useCallback((value: string | null) => {
    setActiveNameState(value);
    setDiagramSession({ activeName: value }, sessionKey);
  }, [sessionKey]);
  const setLastSavedBody = useCallback((value: string | null) => {
    setLastSavedBodyState(value);
    setDiagramSession({ lastSavedBody: value }, sessionKey);
  }, [sessionKey]);
  const [saving, setSaving] = useState(false);
  const [listOpen, setListOpen] = useState(false);
  const [files, setFiles] = useState<DiagramFile[]>([]);
  const [saveDialogOpen, setSaveDialogOpen] = useState(false);
  const [galleryOpen, setGalleryOpen] = useState(false);
  const [galleryMode, setGalleryMode] = useState<"apply" | "convert">("apply");
  const [mappingPreview, setMappingPreview] = useState<{
    sourceViewId: string;
    targetPatternId: string;
  } | null>(null);
  const [ioDialog, setIoDialog] = useState<"import" | "export" | null>(null);
  const [historyOpen, setHistoryOpen] = useState(false);
  const [memoOpen, setMemoOpen] = useState<string | null>(null);
  const [findOpen, setFindOpen] = useState(false);
  const [specialOpen, setSpecialOpen] = useState(false);
  const [inlineEdit, setInlineEdit] = useState<{ nodeId: NodeId; field: InlineEditField } | null>(null);
  // Cell editing: which cell the overlay editor is attached to (+ optional
  // quick-entry seed character). Null when no cell editor is open.
  const [cellEdit, setCellEdit] = useState<{
    nodeId: NodeId;
    addr: TableCellAddress;
    initial?: string;
  } | null>(null);
  const [theme, setTheme] = useState<"light" | "dark">(() => {
    if (typeof document === "undefined") return "light";
    return (document.documentElement.dataset.theme === "dark" ? "dark" : "light");
  });
  const focusMode = useDiagram((s) => s.ephemeral.ui.focusMode);
  const [panels, setPanels] = useState<PersistedPanelState>(() => readPanelState());
  const viewportRef = useRef<HTMLDivElement | null>(null);
  const titleInputRef = useRef<HTMLInputElement | null>(null);
  const insertOffsetRef = useRef(0);
  /** Last canvas-space pointer position — the gallery's "insert at pointer" target. */
  const lastPointerRef = useRef({ x: 400, y: 300 });
  const titleCoalescerRef = useRef(defaultCoalescer());
  const inlineEditCoalescerRef = useRef(defaultCoalescer());
  const cellEditCoalescerRef = useRef(defaultCoalescer());

  // Hydrate persisted snap-size once.
  useEffect(() => {
    try {
      const raw = window.localStorage.getItem(SNAP_STORAGE_KEY);
      const value = raw ? parseInt(raw, 10) : NaN;
      if (Number.isFinite(value) && value > 0) store.setState(setSnapSize(value));
    } catch {
      /* ignore */
    }
  }, [store]);

  // Persist panel layout whenever it changes.
  useEffect(() => {
    writePanelState(panels);
  }, [panels]);

  // Mirror Maru's data-theme onto our root so chrome can opt in to dark mode
  // while the canvas stays light (source rule: canvas always light).
  useEffect(() => {
    if (typeof document === "undefined") return;
    const root = document.documentElement;
    const apply = () => {
      setTheme(root.dataset.theme === "dark" ? "dark" : "light");
    };
    apply();
    const observer = new MutationObserver(apply);
    observer.observe(root, { attributes: true, attributeFilter: ["data-theme"] });
    return () => observer.disconnect();
  }, []);

  const docBody = useMemo(() => serializeDoc(doc), [doc]);
  const dirty =
    lastSavedBody !== null
      ? docBody !== lastSavedBody
      : nodes.length > 0 || edges.length > 0 || docTitle.trim().length > 0;
  const hasSelection = selection.nodes.size + selection.edges.size > 0;

  // Auto-snapshot scheduler — created once per workspace, re-armed on every
  // doc mutation (tracked via doc.updatedAt) so the quiet-debounce collapses
  // a flurry of edits into one snapshot. Each fire bypasses the human-facing
  // save and stores a versioned copy under .maru/diagrams/history/<docId>/.
  const snapshotSchedRef = useRef<AutoSnapshotScheduler | null>(null);
  useEffect(() => {
    if (!workPath) return;
    const sched = createAutoSnapshotScheduler({
      enabled: true,
      getDoc: () => store.getState().doc,
      onFire: async (_content, doc) => {
        try {
          await saveSnapshotForDoc(workPath, doc);
        } catch {
          /* ignore — snapshots are best-effort */
        }
      },
    });
    snapshotSchedRef.current = sched;
    return () => {
      sched.dispose();
      if (snapshotSchedRef.current === sched) snapshotSchedRef.current = null;
    };
  }, [store, workPath]);

  const docUpdatedAt = doc.updatedAt;
  useEffect(() => {
    if (dirty) snapshotSchedRef.current?.markDirty();
  }, [dirty, docUpdatedAt]);

  const reportError = useCallback((message: string | null) => onError?.(message), [onError]);

  const persistLastDocument = useCallback(
    async (lastDocument: string | null) => {
      if (!workPath) return;
      try {
        const base = await readMaruSettings(workPath);
        const next = {
          ...base,
          diagram: {
            ...base.diagram,
            lastDocument,
          },
        };
        await saveMaruSettings(workPath, next, base);
      } catch {
        /* Last-document restore is helpful state, not a save blocker. */
      }
      writeLastDocumentFallback(workPath, lastDocument);
    },
    [workPath],
  );

  useEffect(() => {
    if (!workPath) return;
    let cancelled = false;
    void (async () => {
      try {
        const settings = await readMaruSettings(workPath);
        const lastDocument = settings.diagram.lastDocument ?? readLastDocumentFallback(workPath);
        if (!lastDocument || cancelled) return;
        if (getDiagramSession(sessionKey).activeName) return;
        const current = store.getState().doc;
        if (current.nodes.length > 0 || current.edges.length > 0 || current.docTitle.trim()) return;
        const { doc: restored, migratedFromLegacy } = await readDiagramDetailed(workPath, lastDocument);
        if (cancelled) return;
        store.setState(replaceDoc(restored));
        setActiveName(lastDocument);
        setLastSavedBody(serializeDoc(restored));
        setDiagramSession({ migratedFromLegacy, legacyBackupAttempted: false }, sessionKey);
      } catch {
        /* Best-effort restore only: a missing/deleted last diagram should not block Diagram mode. */
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [sessionKey, setActiveName, setLastSavedBody, store, workPath]);

  // --- Pattern gallery (Phase 2b) ------------------------------------------
  // Favorites + recents persist in DiagramSettings (.maru/settings.json).

  const [patternPrefs, setPatternPrefs] = useState<{ favorites: string[]; recents: string[] }>({
    favorites: [],
    recents: [],
  });

  useEffect(() => {
    if (!workPath) return;
    let cancelled = false;
    void readMaruSettings(workPath)
      .then((settings) => {
        if (cancelled) return;
        setPatternPrefs({
          favorites: settings.diagram.favoritePatterns,
          recents: settings.diagram.recentPatterns,
        });
      })
      .catch(() => {
        /* best effort */
      });
    return () => {
      cancelled = true;
    };
  }, [workPath]);

  const persistPatternPrefs = useCallback(
    async (next: { favorites: string[]; recents: string[] }) => {
      setPatternPrefs(next);
      if (!workPath) return;
      try {
        const base = await readMaruSettings(workPath);
        await saveMaruSettings(
          workPath,
          {
            ...base,
            diagram: {
              ...base.diagram,
              favoritePatterns: next.favorites,
              recentPatterns: next.recents,
            },
          },
          base,
        );
      } catch {
        /* Favorites/recents are convenience state, not a save blocker. */
      }
    },
    [workPath],
  );

  const toggleFavoritePattern = useCallback(
    (patternId: string) => {
      const favorites = patternPrefs.favorites.includes(patternId)
        ? patternPrefs.favorites.filter((id) => id !== patternId)
        : [patternId, ...patternPrefs.favorites].slice(0, DIAGRAM_FAVORITE_PATTERNS_CAP);
      void persistPatternPrefs({ ...patternPrefs, favorites });
    },
    [patternPrefs, persistPatternPrefs],
  );

  const recordRecentPattern = useCallback(
    (patternId: string) => {
      const recents = [
        patternId,
        ...patternPrefs.recents.filter((id) => id !== patternId),
      ].slice(0, DIAGRAM_RECENT_PATTERNS_CAP);
      void persistPatternPrefs({ ...patternPrefs, recents });
    },
    [patternPrefs, persistPatternPrefs],
  );

  // The conversion source: exactly one selected node linked to a live view.
  const convertViewId = useMemo(
    () => singleLinkedViewId(doc, selection.nodes),
    [doc, selection.nodes],
  );

  // "Insert/Update in report" scope: the single selected pattern view, else
  // the whole document.
  const reportScope = convertViewId ? `pattern:${convertViewId}` : "doc";

  // "Save as workspace preset" captures the selected view's pattern config.
  const presetDraft = useMemo(() => {
    if (!convertViewId) return null;
    const view = (doc.views ?? []).find((v) => v.id === convertViewId);
    if (!view) return null;
    const member = view.nodeIds
      .map((id) => doc.nodes.find((n) => n.id === id))
      .find((n) => n !== undefined);
    const style = member?.style
      ? ({ ...member.style } as Record<string, string | number | boolean>)
      : undefined;
    return {
      patternId: view.patternId,
      ...(view.theme !== undefined ? { theme: view.theme } : {}),
      ...(style !== undefined ? { style } : {}),
    };
  }, [doc, convertViewId]);

  const openGallery = useCallback((mode: "apply" | "convert") => {
    setGalleryMode(mode);
    setGalleryOpen(true);
  }, []);

  const handleGalleryNewDocument = useCallback(
    (sel: GallerySelection) => {
      const patternId = sel.kind === "pattern" ? sel.patternId : sel.preset.patternId;
      const opts = sel.kind === "preset" ? presetApplyOpts(sel.preset, t) : { t };
      try {
        const next = newDocumentFromPattern(patternId, {
          ...opts,
          docTitle:
            sel.kind === "preset"
              ? sel.preset.name
              : t(getPattern(patternId)?.labelKey ?? ""),
        });
        store.setState(replaceDoc(next));
        setActiveName(null);
        setLastSavedBody(null);
        void persistLastDocument(null);
        recordRecentPattern(patternId);
        setGalleryOpen(false);
        reportError(null);
      } catch (err) {
        reportError(t("diagram.error.load", { message: (err as Error).message ?? "unknown" }));
      }
    },
    [persistLastDocument, recordRecentPattern, reportError, setActiveName, setLastSavedBody, store, t],
  );

  const handleGalleryInsert = useCallback(
    (sel: GallerySelection) => {
      const patternId = sel.kind === "pattern" ? sel.patternId : sel.preset.patternId;
      const opts = sel.kind === "preset" ? presetApplyOpts(sel.preset, t) : { t };
      const at = lastPointerRef.current;
      try {
        // Pre-compute so unknown patterns throw before any state mutation.
        insertPatternAt(store.getState().doc, patternId, at, opts);
      } catch (err) {
        reportError(t("diagram.error.load", { message: (err as Error).message ?? "unknown" }));
        return;
      }
      store.setState(withSnapshot(insertPatternAtAction(patternId, at, opts), coalescer));
      recordRecentPattern(patternId);
      setGalleryOpen(false);
      reportError(null);
    },
    [coalescer, recordRecentPattern, reportError, store, t],
  );

  const handleGalleryConvert = useCallback(
    (patternId: string) => {
      const state = store.getState();
      const viewId = singleLinkedViewId(state.doc, state.ephemeral.selection.nodes);
      if (!viewId) return;
      const kind = classifyConversion(state.doc, viewId, patternId);
      if (kind === "freeform") {
        reportError(t("diagram.gallery.convertFreeform"));
        return;
      }
      if (kind === "same-family") {
        // One-command conversion: same dataset, new projection. No dialog.
        store.setState(withSnapshot(switchViewPatternAction(viewId, patternId, { t }), coalescer));
        recordRecentPattern(patternId);
        setGalleryOpen(false);
        reportError(null);
        return;
      }
      setGalleryOpen(false);
      setMappingPreview({ sourceViewId: viewId, targetPatternId: patternId });
    },
    [coalescer, recordRecentPattern, reportError, store, t],
  );

  const handleMappingConfirm = useCallback(
    (result: CrossConversionResult) => {
      store.setState(withSnapshot(replaceDoc(result.doc), coalescer));
      if (mappingPreview) recordRecentPattern(mappingPreview.targetPatternId);
      setMappingPreview(null);
      reportError(result.warnings.length > 0 ? result.warnings.join(" / ") : null);
    },
    [coalescer, mappingPreview, recordRecentPattern, reportError, store],
  );

  // --- Phase 3: OS clipboard paste + copy-as-format actions ----------------

  /** Selected table's matrix, else the first matrix dataset in the doc. */
  const activeMatrix = useCallback((): MatrixDataset | null => {
    const state = store.getState();
    for (const id of state.ephemeral.selection.nodes) {
      const node = state.doc.nodes.find((n) => n.id === id);
      const matrix = matrixForTableNode(node, state.doc.datasets);
      if (matrix) return matrix;
    }
    return (state.doc.datasets ?? []).find((ds) => ds.kind === "matrix") as MatrixDataset ?? null;
  }, [store]);

  /** Insert a matrix as a new table view at the last pointer position. */
  const insertMatrixAtPointer = useCallback(
    (matrix: MatrixDataset) => {
      if (matrixExceedsLimits(matrix)) {
        reportError(t("diagram.clipboard.tooLarge"));
        return;
      }
      store.setState(
        withSnapshot(
          insertPatternAtAction(TABLE_PATTERN_ID, lastPointerRef.current, {
            datasetSeed: matrix,
            t,
          }),
          gestureCoalescers.paste,
        ),
      );
      reportError(null);
    },
    [gestureCoalescers, reportError, store, t],
  );

  /**
   * Cmd/Ctrl+V with no internal clipboard entry: read the OS clipboard in
   * priority order (HTML table → TSV → Markdown table → plain text). With an
   * active table cell selection the parsed grid pastes into that table;
   * otherwise a new table is inserted at the pointer. One paste = one undo
   * entry (the paste gesture coalescer).
   */
  const handleOsClipboardPaste = useCallback(async () => {
    const candidate = await readClipboardCandidate();
    if (!candidate) {
      reportError(t("diagram.clipboard.unavailable"));
      return;
    }
    const state = store.getState();
    const ts = state.ephemeral.tableSelection;

    let grid: string[][];
    let parsed: MatrixDataset | null = null;
    try {
      if (candidate.codecId === "html-table") {
        parsed = htmlTableToMatrix(candidate.text);
        grid = expandMatrixToGrid(parsed);
      } else if (candidate.codecId === "markdown-table") {
        grid = parseMarkdownTable(candidate.text);
      } else if (candidate.codecId === "tsv") {
        grid = parseTsv(candidate.text);
      } else {
        grid = [[candidate.text]];
      }
    } catch (err) {
      reportError(
        t("diagram.dialog.ie.parseFailed", { message: (err as Error).message ?? "unknown" }),
      );
      return;
    }

    if (ts) {
      const node = state.doc.nodes.find((n) => n.id === ts.nodeId);
      const matrix = matrixForTableNode(node, state.doc.datasets);
      if (matrix) {
        store.setState(
          withSnapshot(
            updateMatrix(matrix.id, (m) => pasteTextGridAt(m, ts.focus, grid)),
            gestureCoalescers.paste,
          ),
        );
        reportError(null);
        return;
      }
    }

    if (parsed) {
      insertMatrixAtPointer(parsed);
      return;
    }
    const header = candidate.codecId === "markdown-table";
    insertMatrixAtPointer(matrixFromTextGrid(grid, { header }));
  }, [gestureCoalescers, insertMatrixAtPointer, reportError, store, t]);

  const handleCopyPng = useCallback(async () => {
    try {
      const doc = store.getState().doc;
      // The live-svg parameter is deprecated — exports derive from the model.
      const result = await exportPng(null as unknown as SVGSVGElement, doc);
      await clipboardWriteImagePng(await blobToUint8Array(result.blob));
      reportError(null);
    } catch (err) {
      reportError(t("diagram.clipboard.copyFailed", { message: (err as Error).message ?? "unknown" }));
    }
  }, [reportError, store, t]);

  const handleCopySvg = useCallback(async () => {
    try {
      const doc = store.getState().doc;
      const result = exportSvg(null as unknown as SVGSVGElement, doc);
      await clipboardWriteText(await result.blob.text());
      reportError(null);
    } catch (err) {
      reportError(t("diagram.clipboard.copyFailed", { message: (err as Error).message ?? "unknown" }));
    }
  }, [reportError, store, t]);

  const handleCopyTableHtml = useCallback(async () => {
    const matrix = activeMatrix();
    if (!matrix) return;
    try {
      const html = serializeMatrixToHtml(matrix);
      const tsv = expandMatrixToGrid(matrix)
        .map((row) => row.join("\t"))
        .join("\n");
      await clipboardWriteHtml(html, tsv);
      reportError(null);
    } catch (err) {
      reportError(t("diagram.clipboard.copyFailed", { message: (err as Error).message ?? "unknown" }));
    }
  }, [activeMatrix, reportError, t]);

  const handleCopyTableMarkdown = useCallback(async () => {
    const matrix = activeMatrix();
    if (!matrix) return;
    try {
      const { text } = serializeMatrixToMarkdown(matrix);
      await clipboardWriteText(text);
      reportError(null);
    } catch (err) {
      reportError(t("diagram.clipboard.copyFailed", { message: (err as Error).message ?? "unknown" }));
    }
  }, [activeMatrix, reportError, t]);

  // --- Phase 4: Insert/Update in report ------------------------------------
  // Renders SVG + 2x PNG under attachments/diagrams/<docId>/ and splices a
  // managed maru-diagram:v1 block into the target Markdown document via the
  // app-provided revision-checked save callback.

  const [reportBusy, setReportBusy] = useState(false);
  const [reportChooserOpen, setReportChooserOpen] = useState(false);
  const [reportLinkState, setReportLinkState] = useState<"unknown" | "insert" | "update">(
    "unknown",
  );

  // Lazily check (on File-tab open / target change) whether the active
  // Markdown document already links this diagram + scope, so the ribbon can
  // label the action Update vs Insert. Unknown -> "Insert/Update".
  const activeDocumentPath = activeDocument?.path ?? null;
  const activeDocumentRevision = activeDocument?.revision ?? null;
  const activeDocumentIsMarkdown = activeDocument?.fileKind === "md";
  useEffect(() => {
    if (!activeDocumentIsMarkdown) setReportLinkState("unknown");
  }, [activeDocumentIsMarkdown]);
  useEffect(() => {
    if (
      panels.ribbon !== "file" ||
      !workPath ||
      !activeName ||
      !activeDocumentPath ||
      !activeDocumentIsMarkdown
    ) {
      return;
    }
    let cancelled = false;
    const source = `diagrams/${activeName}.cmd.json`;
    void readDocument(workPath, activeDocumentPath)
      .then((payload) => {
        if (cancelled) return;
        setReportLinkState(
          findManagedBlock(payload.content, { source, scope: reportScope })
            ? "update"
            : "insert",
        );
      })
      .catch(() => {
        if (!cancelled) setReportLinkState("unknown");
      });
    return () => {
      cancelled = true;
    };
  }, [
    panels.ribbon,
    workPath,
    activeName,
    activeDocumentPath,
    activeDocumentRevision,
    activeDocumentIsMarkdown,
    reportScope,
  ]);

  const runInsertInReport = useCallback(
    async (targetPath: string | null) => {
      if (!workPath || !onSaveDocument) {
        reportError(t("diagram.status.noWorkspace"));
        return;
      }
      setReportBusy(true);
      try {
        const outcome = await insertDiagramIntoReport(
          {
            diagramName: activeName,
            dirty,
            doc: store.getState().doc,
            scope: reportScope,
            target: targetPath ? { path: targetPath } : null,
          },
          defaultReportInsertDeps(workPath, onSaveDocument),
        );
        switch (outcome.status) {
          case "needs-save":
            reportError(t("diagram.report.needsSave"));
            break;
          case "needs-target":
            setReportChooserOpen(true);
            break;
          case "conflict":
            reportError(t("diagram.report.conflict", { message: outcome.message }));
            break;
          case "error":
            reportError(t("diagram.report.failed", { message: outcome.message }));
            break;
          case "inserted":
            reportError(t("diagram.report.inserted", { path: outcome.targetPath }));
            setReportLinkState("update");
            break;
          case "updated":
            reportError(t("diagram.report.updated", { path: outcome.targetPath }));
            setReportLinkState("update");
            break;
        }
      } finally {
        setReportBusy(false);
      }
    },
    [activeName, dirty, onSaveDocument, reportError, reportScope, store, t, workPath],
  );

  const handleInsertInReport = useCallback(() => {
    const direct =
      activeDocument && activeDocument.fileKind === "md" ? activeDocument.path : null;
    void runInsertInReport(direct);
  }, [activeDocument, runInsertInReport]);

  const handleImportDataset = useCallback(
    (dataset: ReportDataset) => {
      if (dataset.kind !== "matrix") return;
      insertMatrixAtPointer(dataset as MatrixDataset);
      setIoDialog(null);
    },
    [insertMatrixAtPointer],
  );

  const handleImportDoc = useCallback(
    (next: Parameters<typeof replaceDoc>[0]) => {
      store.setState(replaceDoc(next));
      setActiveName(null);
      setLastSavedBody(null);
      void persistLastDocument(null);
      setIoDialog(null);
      reportError(null);
    },
    [persistLastDocument, reportError, setActiveName, setLastSavedBody, store],
  );

  const refreshList = useCallback(async () => {
    if (!workPath) return;
    try {
      const list = await listDiagrams(workPath);
      setFiles(list);
    } catch (err) {
      reportError(t("diagram.error.load", { message: (err as Error).message ?? "unknown" }));
    }
  }, [reportError, t, workPath]);

  useEffect(() => {
    if (workPath && listOpen) void refreshList();
  }, [listOpen, refreshList, workPath]);

  const insertAtCenter = useCallback(
    (kind: NodeKind, opts: MkNodeOpts = {}) => {
      const el = viewportRef.current;
      const rect = el?.getBoundingClientRect();
      const cx = rect ? rect.width / 2 : 400;
      const cy = rect ? rect.height / 2 : 300;
      const canvasX = (cx - viewport.px) / viewport.zoom;
      const canvasY = (cy - viewport.py) / viewport.zoom;
      const offset = (insertOffsetRef.current % 5) * 16;
      insertOffsetRef.current += 1;
      const nodeOpts =
        kind === "text" && opts.title === undefined
          ? { ...opts, title: t("diagram.toolbar.addText") }
          : opts;
      // Tables get a linked matrix dataset + pattern view (Phase 1b), not
      // legacy meta.rows/cols counts.
      if (kind === "table") {
        store.setState(
          withSnapshot(addTableNode(canvasX + offset, canvasY + offset, 3, 3), coalescer),
        );
        return;
      }
      store.setState(
        withSnapshot(addNode(kind, canvasX + offset, canvasY + offset, nodeOpts), coalescer),
      );
    },
    [coalescer, store, t, viewport.px, viewport.py, viewport.zoom],
  );

  const handleZoom = useCallback(
    (factor: number) => {
      const el = viewportRef.current;
      const rect = el?.getBoundingClientRect();
      const cx = rect ? rect.width / 2 : 400;
      const cy = rect ? rect.height / 2 : 300;
      const canvasX = (cx - viewport.px) / viewport.zoom;
      const canvasY = (cy - viewport.py) / viewport.zoom;
      const zoom = Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, viewport.zoom * factor));
      const px = cx - canvasX * zoom;
      const py = cy - canvasY * zoom;
      store.setState(setViewport({ zoom, px, py }));
    },
    [store, viewport.px, viewport.py, viewport.zoom],
  );

  const handleFitView = useCallback(() => {
    const el = viewportRef.current;
    const rect = el?.getBoundingClientRect();
    const next = fitView({
      nodes: store.getState().doc.nodes,
      viewportW: rect?.width ?? 800,
      viewportH: rect?.height ?? 600,
    });
    store.setState(setViewport(next));
  }, [store]);

  const persistSave = useCallback(
    async (name: string) => {
      if (!workPath) {
        reportError(t("diagram.status.noWorkspace"));
        return;
      }
      setSaving(true);
      reportError(null);
      try {
        // One-time v7 backup: the active document was loaded from a pre-v8
        // body and this is the first v8 save over it. A backup failure must
        // not silently lose data, so we warn via the error channel but still
        // allow the save (and do not retry within this session).
        const session = getDiagramSession(sessionKey);
        if (session.migratedFromLegacy && !session.legacyBackupAttempted) {
          setDiagramSession({ legacyBackupAttempted: true }, sessionKey);
          try {
            await diagramBackupDocument(workPath, name);
          } catch (backupErr) {
            console.warn("diagram v7 backup failed", backupErr);
            reportError(
              t("diagram.error.backup", { message: (backupErr as Error).message ?? "unknown" }),
            );
          }
        }
        const current = store.getState().doc;
        const written = await writeDiagram(workPath, name, current);
        store.setState((s) => ({ ...s, doc: written }));
        setActiveName(name);
        setLastSavedBody(serializeDoc(written));
        setDiagramSession({ migratedFromLegacy: false }, sessionKey);
        // A successful manual save satisfies the pending auto-snapshot.
        snapshotSchedRef.current?.markClean();
        await persistLastDocument(name);
      } catch (err) {
        reportError(t("diagram.error.save", { message: (err as Error).message ?? "unknown" }));
      } finally {
        setSaving(false);
      }
    },
    [persistLastDocument, reportError, sessionKey, setActiveName, setLastSavedBody, store, t, workPath],
  );

  const handleSave = useCallback(() => {
    if (!workPath) {
      reportError(t("diagram.status.noWorkspace"));
      return;
    }
    if (activeName) {
      void persistSave(activeName);
    } else {
      setSaveDialogOpen(true);
    }
  }, [activeName, persistSave, reportError, t, workPath]);

  const handleConfirmSaveAs = useCallback(
    (name: string) => {
      setSaveDialogOpen(false);
      void persistSave(name);
    },
    [persistSave],
  );

  const handleNew = useCallback(() => {
    const fresh = createEmptyDoc(createDiagramId());
    store.setState(replaceDoc(fresh));
    setActiveName(null);
    setLastSavedBody(null);
    setDiagramSession({ migratedFromLegacy: false, legacyBackupAttempted: false }, sessionKey);
    void persistLastDocument(null);
    reportError(null);
  }, [persistLastDocument, reportError, sessionKey, setActiveName, setLastSavedBody, store]);

  const handleOpen = useCallback(
    async (name: string) => {
      if (!workPath) return;
      try {
        const { doc, migratedFromLegacy } = await readDiagramDetailed(workPath, name);
        store.setState(replaceDoc(doc));
        setActiveName(name);
        setLastSavedBody(serializeDoc(doc));
        setDiagramSession({ migratedFromLegacy, legacyBackupAttempted: false }, sessionKey);
        setListOpen(false);
        await persistLastDocument(name);
        reportError(null);
      } catch (err) {
        if (err instanceof UnsupportedDiagramVersionError) {
          reportError(
            t("diagram.error.unsupportedVersion", {
              version: err.version,
              supported: err.supported,
            }),
          );
        } else {
          reportError(t("diagram.error.load", { message: (err as Error).message ?? "unknown" }));
        }
      }
    },
    [persistLastDocument, reportError, sessionKey, setActiveName, setLastSavedBody, store, t, workPath],
  );

  const handleDeleteFile = useCallback(
    async (name: string) => {
      if (!workPath) return;
      try {
        await deleteDiagram(workPath, name);
        await refreshList();
        if (activeName === name) handleNew();
      } catch (err) {
        reportError(t("diagram.error.load", { message: (err as Error).message ?? "unknown" }));
      }
    },
    [activeName, handleNew, refreshList, reportError, t, workPath],
  );

  const handleImage = useCallback(
    (event: ChangeEvent<HTMLInputElement>) => {
      const file = event.target.files?.[0];
      event.target.value = "";
      if (!file) return;
      if (file.size > MAX_IMAGE_BYTES) {
        reportError(t("diagram.error.imageTooLarge", { size: (file.size / 1024 / 1024).toFixed(1) }));
        return;
      }
      const reader = new FileReader();
      reader.onerror = () => reportError(t("diagram.error.imageUnreadable"));
      reader.onload = () => {
        const dataUrl = reader.result;
        if (typeof dataUrl !== "string") return;
        const img = new Image();
        img.onload = () => {
          const maxW = 240;
          const ratio = img.height / Math.max(1, img.width);
          insertAtCenter("image", {
            w: maxW,
            h: Math.round(maxW * ratio),
            meta: { src: dataUrl, name: file.name },
          });
        };
        img.onerror = () => insertAtCenter("image", { meta: { src: dataUrl, name: file.name } });
        img.src = dataUrl;
      };
      reader.readAsDataURL(file);
    },
    [insertAtCenter, reportError, t],
  );

  const persistSnapSize = useCallback((size: number) => {
    try {
      window.localStorage.setItem(SNAP_STORAGE_KEY, String(size));
    } catch {
      /* ignore */
    }
  }, []);

  // Inline editing — double-click on a node or F2 with a single selection
  // opens the overlay editor; a fresh coalescer per gesture keeps one edit =
  // one undo entry (the commit itself is a single updateNode mutation).
  const openInlineEditor = useCallback(
    (nodeId: NodeId) => {
      const node = store.getState().doc.nodes.find((n) => n.id === nodeId);
      if (!node || node.locked) return;
      // Title is the primary target; fall back to body when there is no title.
      const field: InlineEditField = !node.title && node.body ? "body" : "title";
      inlineEditCoalescerRef.current = defaultCoalescer();
      setInlineEdit({ nodeId, field });
    },
    [store],
  );

  const commitInlineEdit = useCallback(
    (nodeId: NodeId, field: InlineEditField, value: string) => {
      const patch = field === "title" ? { title: value } : { body: value };
      store.setState(
        withSnapshot(updateNode(nodeId, patch), inlineEditCoalescerRef.current, {
          coalesce: true,
        }),
      );
      setInlineEdit(null);
    },
    [store],
  );

  // --- Table cell editing -------------------------------------------------
  // One editing gesture = one store mutation (a fresh coalescer per editor
  // open keeps rapid open/edit/close cycles from collapsing into each other).
  const openCellEditor = useCallback(
    (nodeId: NodeId, addr: TableCellAddress, initial?: string) => {
      const state = store.getState();
      const node = state.doc.nodes.find((n) => n.id === nodeId);
      if (!node || node.locked) return;
      const matrix = matrixForTableNode(node, state.doc.datasets);
      if (!matrix || !cellAtAddr(matrix, addr)) return;
      cellEditCoalescerRef.current = defaultCoalescer();
      setCellEdit({ nodeId, addr, initial });
    },
    [store],
  );

  const commitCellEdit = useCallback(
    (value: string, reason: "enter" | "tab" | "shift-tab" | "blur") => {
      const edit = cellEdit;
      if (!edit) return;
      const state = store.getState();
      const node = state.doc.nodes.find((n) => n.id === edit.nodeId);
      const matrix = node ? matrixForTableNode(node, state.doc.datasets) : null;
      if (node && matrix) {
        const cell = cellAtAddr(matrix, edit.addr);
        if (cell) {
          store.setState(
            withSnapshot(setCellText(matrix.id, cell.id, value), cellEditCoalescerRef.current, {
              coalesce: true,
            }),
          );
        }
        // Spreadsheet navigation: Enter moves down, Tab right, Shift+Tab left.
        const ts = state.ephemeral.tableSelection;
        if (ts && ts.nodeId === edit.nodeId && reason !== "blur") {
          const [dr, dc] =
            reason === "enter" ? [1, 0] : reason === "tab" ? [0, 1] : [0, -1];
          store.setState(setTableSelection(moveFocus(matrix, ts, dr, dc, false)));
        }
      }
      setCellEdit(null);
    },
    [cellEdit, store],
  );

  // Keyboard shortcuts scoped to the diagram pane.
  useEffect(() => {
    const handler = (event: KeyboardEvent) => {
      // Korean IME: never treat composition keystrokes as shortcuts.
      if (event.isComposing) return;
      const target = event.target as HTMLElement | null;
      const inField = isInEditable(target);

      if (matchesShortcut(event, { key: "s", mod: true })) {
        event.preventDefault();
        handleSave();
        return;
      }
      if (matchesShortcut(event, { key: "z", mod: true, shift: false })) {
        event.preventDefault();
        store.setState(undoAction());
        return;
      }
      if (matchesShortcut(event, { key: "z", mod: true, shift: true })) {
        event.preventDefault();
        store.setState(redoAction());
        return;
      }
      if (matchesShortcut(event, { key: "y", mod: true })) {
        event.preventDefault();
        store.setState(redoAction());
        return;
      }
      if (matchesShortcut(event, { key: "f", mod: true, shift: false })) {
        event.preventDefault();
        setFindOpen(true);
        return;
      }
      if (!inField && event.key === "/" && !event.metaKey && !event.ctrlKey) {
        event.preventDefault();
        setFindOpen(true);
        return;
      }
      if (matchesShortcut(event, { key: "a", mod: true })) {
        event.preventDefault();
        store.setState(selectAllNodes());
        return;
      }
      if (matchesShortcut(event, { key: "d", mod: true })) {
        event.preventDefault();
        store.setState(withSnapshot(duplicateSelection(), coalescer));
        return;
      }
      // Copy/paste: cell ranges win while a table has an active cell
      // selection (handled by the table block below); otherwise whole nodes.
      if (matchesShortcut(event, { key: "c", mod: true })) {
        if (!inField && !store.getState().ephemeral.tableSelection) {
          if (store.getState().ephemeral.selection.nodes.size > 0) {
            event.preventDefault();
            store.setState(copyNodesToClipboard());
            return;
          }
        }
      }
      if (matchesShortcut(event, { key: "v", mod: true })) {
        if (!inField) {
          const clip = store.getState().ephemeral.clipboard;
          if (!clip) {
            // No internal clipboard entry — fall through to the OS clipboard
            // (HTML table → TSV → Markdown table → plain text).
            event.preventDefault();
            void handleOsClipboardPaste();
            return;
          }
          if (!store.getState().ephemeral.tableSelection && clip.kind === "nodes") {
            event.preventDefault();
            store.setState(withSnapshot(pasteClipboard(), gestureCoalescers.paste));
            return;
          }
        }
      }
      // Table cell keyboard flow (F2/Tab/Enter/arrows/Delete/printable char)
      // — takes precedence over node-level nudge/delete/inline-edit while a
      // table has an active cell selection.
      if (!inField && !cellEdit) {
        const tableAction = nextTableKeyAction(event, store.getState());
        if (tableAction) {
          event.preventDefault();
          switch (tableAction.kind) {
            case "select":
              store.setState(setTableSelection(tableAction.selection));
              break;
            case "clearRange":
              store.setState(
                withSnapshot(
                  clearCellsText(tableAction.datasetId, tableAction.cellIds),
                  gestureCoalescers.typing,
                  { coalesce: true },
                ),
              );
              break;
            case "edit": {
              const ts = store.getState().ephemeral.tableSelection;
              if (ts) openCellEditor(ts.nodeId, tableAction.addr, tableAction.initial);
              break;
            }
            case "copy":
              store.setState(copyCellsToClipboard(tableAction.texts));
              break;
            case "paste":
              store.setState(withSnapshot(pasteClipboard(), gestureCoalescers.paste));
              break;
          }
          return;
        }
      }
      if (!inField && event.key === "F2") {
        event.preventDefault();
        const selected = [...store.getState().ephemeral.selection.nodes];
        if (selected.length === 1 && selected[0]) {
          openInlineEditor(selected[0]);
        } else {
          titleInputRef.current?.focus();
          titleInputRef.current?.select();
        }
        return;
      }
      if (!inField && event.key === "Escape") {
        if (store.getState().ephemeral.ui.focusMode) {
          event.preventDefault();
          store.setState(toggleFocusMode(false));
          return;
        }
        if (findOpen) {
          event.preventDefault();
          setFindOpen(false);
          return;
        }
        if (store.getState().ephemeral.tableSelection) {
          event.preventDefault();
          store.setState(setTableSelection(null));
          return;
        }
      }
      if (!inField && !event.metaKey && !event.ctrlKey) {
        const step = event.shiftKey ? 10 : 1;
        if (event.key === "ArrowLeft") {
          event.preventDefault();
          store.setState(withSnapshot(nudgeSelection(-step, 0), coalescer, { coalesce: true }));
          return;
        }
        if (event.key === "ArrowRight") {
          event.preventDefault();
          store.setState(withSnapshot(nudgeSelection(step, 0), coalescer, { coalesce: true }));
          return;
        }
        if (event.key === "ArrowUp") {
          event.preventDefault();
          store.setState(withSnapshot(nudgeSelection(0, -step), coalescer, { coalesce: true }));
          return;
        }
        if (event.key === "ArrowDown") {
          event.preventDefault();
          store.setState(withSnapshot(nudgeSelection(0, step), coalescer, { coalesce: true }));
          return;
        }
      }
      if (!inField && (event.key === "Delete" || event.key === "Backspace")) {
        if (hasSelection) {
          event.preventDefault();
          const state = store.getState();
          const nodeIds = [...state.ephemeral.selection.nodes];
          const edgeIds = [...state.ephemeral.selection.edges];
          // Detach prompt (Phase 2b): deleting a strict subset of a view's
          // generated members asks to detach them from the projection first.
          const analysis = analyzeViewDrag(state.doc, nodeIds);
          if (analysis.subsets.length > 0) {
            if (!window.confirm(t("diagram.detach.confirm"))) return;
            for (const subset of analysis.subsets) {
              store.setState(
                withSnapshot(
                  detachViewMembersSnippetAction(subset.viewId, subset.memberIds),
                  coalescer,
                ),
              );
            }
          }
          if (nodeIds.length > 0) {
            store.setState(withSnapshot(removeNodes(nodeIds), coalescer));
          }
          if (edgeIds.length > 0) {
            store.setState(withSnapshot(removeEdges(edgeIds), coalescer));
          }
        }
      }
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [cellEdit, coalescer, findOpen, gestureCoalescers, handleOsClipboardPaste, handleSave, hasSelection, openCellEditor, openInlineEditor, store, t]);

  const statusLabel = saving
    ? t("diagram.status.saving")
    : dirty
      ? t("diagram.status.dirty")
      : activeName
        ? t("diagram.status.saved")
        : "";

  const toggleLeftPanel = useCallback(
    () => setPanels((p) => ({ ...p, left: !p.left })),
    [],
  );
  const toggleRightPanel = useCallback(
    () => setPanels((p) => ({ ...p, right: !p.right })),
    [],
  );

  const startPanelResize = useCallback(
    (side: "left" | "right") => (event: ReactPointerEvent<HTMLDivElement>) => {
      if (event.button !== 0) return;
      event.preventDefault();
      const target = event.currentTarget;
      const startX = event.clientX;
      const startLeft = panels.leftWidth;
      const startRight = panels.rightWidth;
      target.setPointerCapture(event.pointerId);
      target.classList.add("is-dragging");

      const onMove = (e: PointerEvent) => {
        const dx = e.clientX - startX;
        setPanels((prev) => {
          if (side === "left") {
            const next = clampWidth(startLeft + dx);
            return next === prev.leftWidth ? prev : { ...prev, leftWidth: next };
          }
          const next = clampWidth(startRight - dx);
          return next === prev.rightWidth ? prev : { ...prev, rightWidth: next };
        });
      };
      const onUp = (e: PointerEvent) => {
        target.releasePointerCapture(e.pointerId);
        target.classList.remove("is-dragging");
        window.removeEventListener("pointermove", onMove);
        window.removeEventListener("pointerup", onUp);
        window.removeEventListener("pointercancel", onUp);
      };
      window.addEventListener("pointermove", onMove);
      window.addEventListener("pointerup", onUp);
      window.addEventListener("pointercancel", onUp);
    },
    [panels.leftWidth, panels.rightWidth],
  );

  const resetPanelWidth = useCallback(
    (side: "left" | "right") => () => {
      setPanels((p) =>
        side === "left"
          ? { ...p, leftWidth: PANEL_DEFAULT_WIDTH }
          : { ...p, rightWidth: PANEL_DEFAULT_WIDTH },
      );
    },
    [],
  );

  const initialSaveName = (docTitle || "").trim() || `diagram-${new Date().toISOString().slice(0, 10)}`;

  const inlineEditNode = inlineEdit
    ? (doc.nodes.find((n) => n.id === inlineEdit.nodeId) ?? null)
    : null;

  // Cell editor positioning: node-local cell rect → screen space.
  const cellEditInfo = (() => {
    if (!cellEdit) return null;
    const node = doc.nodes.find((n) => n.id === cellEdit.nodeId);
    const matrix = node ? matrixForTableNode(node, doc.datasets) : null;
    if (!node || !matrix) return null;
    const cell = cellAtAddr(matrix, cellEdit.addr);
    if (!cell) return null;
    const r = matrix.rows.findIndex((row) => row.id === cell.rowId);
    const c = matrix.columns.findIndex((col) => col.id === cell.colId);
    if (r < 0 || c < 0) return null;
    const layout = computeTableLayout(matrix, node.w, node.h);
    const rect = cellRect(matrix, layout, cell, r, c);
    return {
      node,
      matrix,
      cell,
      rect: {
        x: (node.x + rect.x) * viewport.zoom + viewport.px,
        y: (node.y + rect.y) * viewport.zoom + viewport.py,
        w: rect.w * viewport.zoom,
        h: rect.h * viewport.zoom,
      },
    };
  })();

  return (
    <div
      className={`maru-diagram${theme === "dark" ? " is-dark" : ""}${focusMode ? " is-focus-mode" : ""}`}
      data-testid="diagram-mode"
      role="region"
      aria-label={t("mode.diagram")}
    >
      {focusMode ? (
        <button
          type="button"
          className="maru-diagram-focus-exit"
          onClick={() => store.setState(toggleFocusMode(false))}
          title={t("diagram.focusMode.exit")}
        >
          {t("diagram.focusMode.exit")}
        </button>
      ) : null}
      <header className="maru-diagram-header">
        <div className="maru-diagram-title">
          <Network size={20} strokeWidth={1.9} aria-hidden="true" />
          <input
            ref={titleInputRef}
            className="maru-diagram-title-input"
            value={docTitle}
            placeholder={t("diagram.title.placeholder")}
            onChange={(e) =>
              store.setState(
                withSnapshot(setDocTitle(e.target.value), titleCoalescerRef.current, {
                  coalesce: true,
                }),
              )
            }
            aria-label={t("diagram.title.placeholder")}
          />
          <button
            type="button"
            className="maru-diagram-focus-btn"
            onClick={() => store.setState(toggleFocusMode())}
            title={t("diagram.focusMode.toggle")}
            aria-label={t("diagram.focusMode.toggle")}
            aria-pressed={focusMode}
          >
            <Eye size={14} />
          </button>
          {statusLabel ? (
            <span className={`maru-diagram-status maru-diagram-status-${dirty ? "dirty" : "saved"}`}>
              {statusLabel}
            </span>
          ) : null}
        </div>
        <div className="maru-diagram-meta">
          <span className="maru-diagram-meta-label">{t("diagram.scaffold.workspace")}</span>
          <code>{workPath ?? "—"}</code>
        </div>
      </header>
      <Ribbon
        active={panels.ribbon}
        onTabChange={(ribbon) => setPanels((p) => ({ ...p, ribbon }))}
        fileProps={{
          onNew: handleNew,
          onOpen: () => setListOpen((o) => !o),
          onSave: handleSave,
          onExport: () => setIoDialog("export"),
          onTemplates: () => openGallery("apply"),
          onHistory: () => setHistoryOpen(true),
          onImport: () => setIoDialog("import"),
          onCopyPng: () => void handleCopyPng(),
          onCopySvg: () => void handleCopySvg(),
          onCopyTableHtml: () => void handleCopyTableHtml(),
          onCopyTableMarkdown: () => void handleCopyTableMarkdown(),
          onInsertInReport: handleInsertInReport,
          insertInReportLabelKey:
            reportLinkState === "update"
              ? "diagram.ribbon.updateInReport"
              : reportLinkState === "insert"
                ? "diagram.ribbon.insertInReport"
                : "diagram.ribbon.insertUpdateInReport",
          insertInReportBusy: reportBusy,
          saving,
          canSave: Boolean(workPath),
        }}
        insertProps={{
          onInsert: (kind) => insertAtCenter(kind),
          onImageFile: handleImage,
          onInsertPattern: () => openGallery("apply"),
        }}
        viewProps={{
          zoomPercent: Math.round(viewport.zoom * 100),
          onZoomIn: () => handleZoom(ZOOM_STEP),
          onZoomOut: () => handleZoom(1 / ZOOM_STEP),
          onFitView: handleFitView,
          leftPaneOpen: panels.left,
          rightPaneOpen: panels.right,
          onToggleLeft: toggleLeftPanel,
          onToggleRight: toggleRightPanel,
          onSnapSizePersist: persistSnapSize,
        }}
        toolsProps={{
          onFind: () => setFindOpen(true),
          onHistory: () => setHistoryOpen(true),
          onSpecialChars: () => setSpecialOpen(true),
          onToggleFocus: () => store.setState(toggleFocusMode()),
          onConvertView: () => openGallery("convert"),
        }}
      />
      <div className="maru-diagram-workspace">
        {panels.left ? (
          <>
            <div style={{ width: panels.leftWidth, flexShrink: 0 }}>
              <LeftPanel />
            </div>
            <div
              className="maru-diagram-panel-resizer"
              role="separator"
              aria-orientation="vertical"
              aria-label={t("diagram.panel.left.hide")}
              onPointerDown={startPanelResize("left")}
              onDoubleClick={resetPanelWidth("left")}
            />
          </>
        ) : null}
        <div className="maru-diagram-viewport" ref={viewportRef}>
          <FindBar open={findOpen} onClose={() => setFindOpen(false)} />
          <CanvasSurface
            onMemoOpen={(nodeId) => setMemoOpen(nodeId)}
            onNodeDoubleClick={openInlineEditor}
            onBlankDoubleClick={() => openGallery("apply")}
            onPointerCanvasMove={(point) => {
              lastPointerRef.current = point;
            }}
            onCellEditRequest={(nodeId, addr) => openCellEditor(nodeId, addr)}
          />
          {inlineEdit && inlineEditNode ? (
            <InlineTextEditor
              node={inlineEditNode}
              field={inlineEdit.field}
              rect={{
                x: inlineEditNode.x * viewport.zoom + viewport.px,
                y: inlineEditNode.y * viewport.zoom + viewport.py,
                w: inlineEditNode.w * viewport.zoom,
                h: inlineEditNode.h * viewport.zoom,
              }}
              zoom={viewport.zoom}
              onCommit={(value) => commitInlineEdit(inlineEdit.nodeId, inlineEdit.field, value)}
              onCancel={() => setInlineEdit(null)}
            />
          ) : null}
          {cellEdit && cellEditInfo ? (
            <InlineTextEditor
              node={cellEditInfo.node}
              field="title"
              rect={cellEditInfo.rect}
              zoom={viewport.zoom}
              initialValue={cellEdit.initial ?? cellEditInfo.cell.text}
              ariaLabel={t("diagram.inlineEdit.cell.aria")}
              fontSize={11 * viewport.zoom}
              textAlign={cellEditInfo.cell.style?.align ?? "left"}
              onCommitReason={commitCellEdit}
              onCancel={() => setCellEdit(null)}
            />
          ) : null}
          {listOpen ? (
            <aside className="maru-diagram-list" aria-label={t("diagram.list.heading")}>
              <div className="maru-diagram-list-head">
                <h2>{t("diagram.list.heading")}</h2>
                <button type="button" onClick={() => setListOpen(false)}>
                  {t("diagram.list.close")}
                </button>
              </div>
              {files.length === 0 ? (
                <p className="maru-diagram-list-empty">{t("diagram.list.empty")}</p>
              ) : (
                <ul>
                  {files.map((file) => (
                    <li key={file.name}>
                      <button type="button" onClick={() => void handleOpen(file.name)}>
                        <span className="maru-diagram-list-name">{file.docTitle || file.name}</span>
                        <span className="maru-diagram-list-meta">
                          {new Date(file.modifiedAt).toLocaleString()}
                        </span>
                      </button>
                      <button
                        type="button"
                        className="maru-diagram-list-delete"
                        onClick={() => void handleDeleteFile(file.name)}
                        title={t("diagram.toolbar.delete")}
                        aria-label={t("diagram.toolbar.delete")}
                      >
                        ×
                      </button>
                    </li>
                  ))}
                </ul>
              )}
            </aside>
          ) : null}
        </div>
        {panels.right ? (
          <>
            <div
              className="maru-diagram-panel-resizer"
              role="separator"
              aria-orientation="vertical"
              aria-label={t("diagram.panel.right.hide")}
              onPointerDown={startPanelResize("right")}
              onDoubleClick={resetPanelWidth("right")}
            />
            <div style={{ width: panels.rightWidth, flexShrink: 0 }}>
              <RightPanel />
            </div>
          </>
        ) : null}
      </div>
      <SaveAsDialog
        open={saveDialogOpen}
        initialName={activeName ?? initialSaveName}
        workspace={workPath}
        onConfirm={handleConfirmSaveAs}
        onCancel={() => setSaveDialogOpen(false)}
      />
      <ReportTargetDialog
        open={reportChooserOpen}
        documents={recentDocuments}
        onChoose={(path) => {
          setReportChooserOpen(false);
          void runInsertInReport(path);
        }}
        onClose={() => setReportChooserOpen(false)}
      />
      <PatternGalleryDialog
        open={galleryOpen}
        dirty={dirty}
        workspace={workPath}
        convertViewId={convertViewId}
        initialMode={galleryMode}
        presetDraft={presetDraft}
        favorites={patternPrefs.favorites}
        recents={patternPrefs.recents}
        onToggleFavorite={toggleFavoritePattern}
        onNewDocument={handleGalleryNewDocument}
        onInsertAtPointer={handleGalleryInsert}
        onConvert={handleGalleryConvert}
        onNotice={(message) => reportError(message)}
        onClose={() => setGalleryOpen(false)}
      />
      {mappingPreview ? (
        <MappingPreviewDialog
          key={`${mappingPreview.sourceViewId}:${mappingPreview.targetPatternId}`}
          open
          doc={doc}
          sourceViewId={mappingPreview.sourceViewId}
          targetPatternId={mappingPreview.targetPatternId}
          onConfirm={handleMappingConfirm}
          onCancel={() => setMappingPreview(null)}
        />
      ) : null}
      <ImportExportDialog
        open={ioDialog !== null}
        mode={ioDialog ?? "export"}
        doc={store.getState().doc}
        workspace={workPath}
        dirty={dirty}
        onImportDoc={handleImportDoc}
        onImportDataset={handleImportDataset}
        onClose={() => setIoDialog(null)}
      />
      <VersionHistoryDialog
        open={historyOpen}
        doc={store.getState().doc}
        workspace={workPath}
        onRestore={(next) => {
          store.setState(replaceDoc(next));
          setHistoryOpen(false);
          reportError(null);
        }}
        onError={(message) => reportError(t("diagram.error.load", { message }))}
        onClose={() => setHistoryOpen(false)}
      />
      <MemoDialog
        open={memoOpen !== null}
        initial={(memoOpen ? (store.getState().doc.nodes.find((n) => n.id === memoOpen)?.meta?.memo as string | undefined) : "") ?? ""}
        nodeTitle={
          memoOpen ? store.getState().doc.nodes.find((n) => n.id === memoOpen)?.title ?? "" : ""
        }
        onSave={(memo) => {
          if (memoOpen) {
            store.setState(withSnapshot(setNodeMeta(memoOpen, { memo: memo || null }), coalescer));
          }
          setMemoOpen(null);
        }}
        onDelete={() => {
          if (memoOpen) {
            store.setState(withSnapshot(setNodeMeta(memoOpen, { memo: null }), coalescer));
          }
          setMemoOpen(null);
        }}
        onClose={() => setMemoOpen(null)}
      />
      <SpecialCharsPicker
        open={specialOpen}
        onInsert={(char) => {
          const sel = [...store.getState().ephemeral.selection.nodes];
          if (sel.length === 0) return;
          for (const id of sel) {
            const node = store.getState().doc.nodes.find((n) => n.id === id);
            if (!node) continue;
            store.setState(
              withSnapshot(
                (state) => ({
                  ...state,
                  doc: {
                    ...state.doc,
                    nodes: state.doc.nodes.map((n) =>
                      n.id === id && !n.locked ? { ...n, title: (n.title ?? "") + char } : n,
                    ),
                  },
                }),
                coalescer,
              ),
            );
          }
        }}
        onClose={() => setSpecialOpen(false)}
      />
    </div>
  );
}

export default DiagramMode;
