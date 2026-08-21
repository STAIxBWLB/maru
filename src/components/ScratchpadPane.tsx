import { listen } from "@tauri-apps/api/event";
import {
  AlertTriangle,
  CheckSquare,
  ChevronDown,
  ChevronRight,
  Copy,
  FilePlus2,
  Folder,
  FolderInput,
  Layers,
  Lightbulb,
  List,
  PanelLeftClose,
  PanelLeftOpen,
  RefreshCw,
  RotateCcw,
  Save,
  Search,
  Square,
  Trash2,
  X,
} from "lucide-react";
import {
  lazy,
  Suspense,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type KeyboardEvent as ReactKeyboardEvent,
} from "react";
import {
  applyScratchpadTempCleanup,
  chooseSaveFile,
  isTauri,
  listScratchpad,
  migrateLegacyMemos,
  planScratchpadTempCleanup,
  readScratchpadDocument,
  renameScratchpadDocument,
  saveMemoAs,
  saveScratchpadDocument,
  startScratchpadWatcher,
  stopScratchpadWatcher,
  trashScratchpadDocument,
} from "../lib/api";
import {
  groupScratchpadEntries,
  isRevisionConflict,
  clearScratchpadDraft,
  newMemoRelativePath,
  readScratchpadDraft,
  renderScratchpadMarkdown,
  scratchpadCopyPath,
  scratchpadEntryKey,
  scratchpadPathForFormat,
  sortScratchpadEntries,
  writeScratchpadDraft,
  type ScratchpadDraft,
} from "../lib/scratchpad";
import { setError } from "../lib/errorStore";
import {
  SCRATCHPAD_LIST_HEIGHT,
  SCRATCHPAD_LIST_WIDTH,
  SCRATCHPAD_TREE_WIDTH,
  type SortKey,
} from "../lib/settings";
import {
  buildScratchpadFolderTree,
  filterScratchpadFolderEntries,
  parseScratchpadFolderId,
  scratchpadFolderAncestors,
  type ScratchpadFolderNode,
} from "../lib/scratchpadTree";
import { DocumentModeSurface, type EditorViewMode } from "./DocumentModeSurface";
import { ModeHeader } from "./ui/ModeChrome";
import { PaneResizeHandle } from "./ui/PaneResizeHandle";
import { SortModeToggle } from "./ui/SortModeToggle";
import type {
  MemoFormat,
  ScratchpadChangedEvent,
  ScratchpadDocument,
  ScratchpadEntry,
  ScratchpadWatcherErrorEvent,
  TempCleanupCandidate,
} from "../lib/types";

type Translate = (key: string, vars?: Record<string, string | number>) => string;
type SaveState = "idle" | "saving" | "saved" | "error";

const SCRATCHPAD_LOCATION_KEY = "maru:scratchpad-location:v1";

const LazyRichMarkdownEditor = lazy(() =>
  import("./RichMarkdownEditor").then((module) => ({ default: module.RichMarkdownEditor })),
);

interface ScratchpadPaneProps {
  workPath: string | null;
  sortKey: SortKey;
  listHeight: number;
  listWidth: number;
  treeOpen: boolean;
  treeWidth: number;
  expandedFolders: string[];
  editorViewMode: EditorViewMode;
  refreshRequestEpoch: number;
  onRefreshWorkspace: () => void;
  onSortKeyChange: (key: SortKey) => void;
  onListHeightChange: (height: number) => void;
  onListWidthChange: (width: number) => void;
  onTreeOpenChange: (open: boolean) => void;
  onTreeWidthChange: (width: number) => void;
  onExpandedFoldersChange: (folders: string[]) => void;
  onEditorViewModeChange: (mode: EditorViewMode) => void;
  t: Translate;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function formatUpdated(value?: string | null): string {
  if (!value) return "";
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) return value;
  return new Intl.DateTimeFormat(undefined, {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  }).format(date);
}

function collectionLabel(collection: ScratchpadEntry["collection"], t: Translate): string {
  return t(`rightPane.scratchpad.collection.${collection}`);
}

function groupLabel(collection: ScratchpadEntry["collection"], id: string, t: Translate): string {
  if (collection === "memos") return t("rightPane.scratchpad.group.personal");
  return id;
}

function ScratchpadTreeRow({
  node,
  depth,
  currentFolder,
  expanded,
  onNavigate,
  onToggle,
  t,
}: {
  node: ScratchpadFolderNode;
  depth: number;
  currentFolder: string;
  expanded: Set<string>;
  onNavigate: (folderId: string) => void;
  onToggle: (folderId: string) => void;
  t: Translate;
}) {
  const hasChildren = node.children.length > 0;
  const isExpanded = expanded.has(node.id);
  const label =
    depth === 0 && node.collection
      ? t(`rightPane.scratchpad.collection.${node.collection}`)
      : node.name;
  return (
    <div>
      <div
        className={`scratchpad-tree-row${currentFolder === node.id ? " selected" : ""}`}
        role="treeitem"
        aria-level={depth + 1}
        aria-selected={currentFolder === node.id}
        aria-expanded={hasChildren ? isExpanded : undefined}
        style={{ paddingLeft: `${8 + depth * 14}px` }}
      >
        <button
          type="button"
          className="scratchpad-tree-chevron"
          onClick={() => onToggle(node.id)}
          disabled={!hasChildren}
          tabIndex={-1}
          aria-label={isExpanded ? t("list.tree.collapse") : t("list.tree.expand")}
        >
          {hasChildren ? (
            isExpanded ? <ChevronDown size={12} /> : <ChevronRight size={12} />
          ) : (
            <span />
          )}
        </button>
        <button
          type="button"
          className="scratchpad-tree-target"
          onClick={() => onNavigate(node.id)}
        >
          <Folder size={14} />
          <span>{label}</span>
          <small>{node.fileCount}</small>
          {node.staleCount > 0 ? (
            <em title={t("rightPane.scratchpad.cleanupEligible")}>{node.staleCount}</em>
          ) : null}
        </button>
      </div>
      {hasChildren && isExpanded ? (
        <div role="group">
          {node.children.map((child) => (
            <ScratchpadTreeRow
              key={child.id}
              node={child}
              depth={depth + 1}
              currentFolder={currentFolder}
              expanded={expanded}
              onNavigate={onNavigate}
              onToggle={onToggle}
              t={t}
            />
          ))}
        </div>
      ) : null}
    </div>
  );
}

let watcherTransition: Promise<void> = Promise.resolve();

function queueWatcherTransition(task: () => Promise<void>): Promise<void> {
  const next = watcherTransition.catch(() => undefined).then(task);
  watcherTransition = next;
  return next;
}

export function ScratchpadPane({
  workPath,
  sortKey,
  listHeight,
  listWidth,
  treeOpen,
  treeWidth,
  expandedFolders,
  editorViewMode,
  refreshRequestEpoch,
  onRefreshWorkspace,
  onSortKeyChange,
  onListHeightChange,
  onListWidthChange,
  onTreeOpenChange,
  onTreeWidthChange,
  onExpandedFoldersChange,
  onEditorViewModeChange,
  t,
}: ScratchpadPaneProps) {
  const [entries, setEntries] = useState<ScratchpadEntry[]>([]);
  const [editor, setEditor] = useState<ScratchpadDocument | null>(null);
  const [content, setContent] = useState("");
  const [pathDraft, setPathDraft] = useState("");
  const [query, setQuery] = useState("");
  const [loading, setLoading] = useState(false);
  const [localError, setLocalError] = useState<string | null>(null);
  const [saveState, setSaveState] = useState<SaveState>("idle");
  const [conflict, setConflict] = useState(false);
  const [currentFolder, setCurrentFolder] = useState("");
  const [cleanupBusy, setCleanupBusy] = useState(false);
  const [cleanupCandidates, setCleanupCandidates] = useState<TempCleanupCandidate[] | null>(null);
  const [cleanupSelected, setCleanupSelected] = useState<Set<string>>(new Set());
  const [cleanupStatus, setCleanupStatus] = useState<string | null>(null);
  const [migrationBusy, setMigrationBusy] = useState(false);
  const [migrationStatus, setMigrationStatus] = useState<string | null>(null);
  const [recoveryDraft, setRecoveryDraft] = useState<ScratchpadDraft | null>(null);
  // Local during the drag, committed to settings on pointer release.
  const [draggedListHeight, setDraggedListHeight] = useState(listHeight);
  const [draggedListWidth, setDraggedListWidth] = useState(listWidth);
  const [draggedTreeWidth, setDraggedTreeWidth] = useState(treeWidth);
  useEffect(() => {
    setDraggedListHeight(listHeight);
  }, [listHeight]);
  useEffect(() => {
    setDraggedListWidth(listWidth);
  }, [listWidth]);
  useEffect(() => {
    setDraggedTreeWidth(treeWidth);
  }, [treeWidth]);

  const editorRef = useRef<ScratchpadDocument | null>(null);
  const contentRef = useRef("");
  const dirtyRef = useRef(false);
  const editSerialRef = useRef(0);
  const autoSaveTimerRef = useRef<ReturnType<typeof window.setTimeout> | null>(null);
  const saveInFlightRef = useRef<Promise<boolean> | null>(null);
  const refreshSerialRef = useRef(0);
  const watcherRefreshTimerRef = useRef<ReturnType<typeof window.setTimeout> | null>(null);
  const activeWorkPathRef = useRef(workPath);
  const activeWatcherGenerationRef = useRef<number | null>(null);
  const cleanupDialogRef = useRef<HTMLElement | null>(null);
  const reviewTempTriggerRef = useRef<HTMLButtonElement | null>(null);
  const refreshRequestEpochRef = useRef(refreshRequestEpoch);
  activeWorkPathRef.current = workPath;

  const clearAutoSaveTimer = useCallback(() => {
    if (!autoSaveTimerRef.current) return;
    window.clearTimeout(autoSaveTimerRef.current);
    autoSaveTimerRef.current = null;
  }, []);

  const loadEditor = useCallback((document: ScratchpadDocument | null) => {
    editorRef.current = document;
    contentRef.current = document?.content ?? "";
    dirtyRef.current = false;
    setEditor(document);
    setContent(document?.content ?? "");
    setPathDraft(document?.relativePath ?? "");
    setConflict(false);
    setSaveState(document ? "saved" : "idle");
    setRecoveryDraft(null);
  }, []);

  const refresh = useCallback(
    async (checkActive = false) => {
      if (!workPath) {
        setEntries([]);
        return;
      }
      // Overlapping refreshes may resolve out of order; only the newest one
      // may commit list or editor state, or a slow stale read would regress
      // the UI to older content.
      const refreshSerial = ++refreshSerialRef.current;
      setLoading(true);
      setLocalError(null);
      try {
        const nextEntries = await listScratchpad(workPath);
        if (refreshSerialRef.current !== refreshSerial) return;
        // Ideation and AI drafts are owned by the Ideation hub; Scratchpad keeps
        // only the memo and disposable-temp collections visible here.
        setEntries(
          nextEntries.filter(
            (entry) => entry.collection !== "drafts" && entry.collection !== "ideation",
          ),
        );
        const current = editorRef.current;
        if (!checkActive || !current || !current.revision) return;
        if (current.collection === "ideation" || current.collection === "drafts") {
          // A pane that was already open across a mode/config refresh must not
          // keep an editor for a collection it no longer owns.
          loadEditor(null);
          return;
        }
        const fresh = nextEntries.find(
          (entry) => scratchpadEntryKey(entry) === scratchpadEntryKey(current),
        );
        if (!fresh) {
          if (dirtyRef.current) setConflict(true);
          else loadEditor(null);
          return;
        }
        if (fresh.revision === current.revision) return;
        if (dirtyRef.current) {
          setConflict(true);
          return;
        }
        const serialBeforeRead = editSerialRef.current;
        const loaded = await readScratchpadDocument(
          workPath,
          fresh.collection,
          fresh.relativePath,
        );
        // The user may have switched files or typed while the read was
        // pending; replacing the buffer then would silently drop their edits.
        if (refreshSerialRef.current !== refreshSerial) return;
        const stillCurrent =
          activeWorkPathRef.current === workPath &&
          editorRef.current &&
          scratchpadEntryKey(editorRef.current) === scratchpadEntryKey(current);
        if (!stillCurrent) return;
        if (dirtyRef.current || editSerialRef.current !== serialBeforeRead) {
          setConflict(true);
          return;
        }
        loadEditor(loaded);
      } catch (error) {
        const message = errorMessage(error);
        setLocalError(message);
        setError(message);
      } finally {
        if (refreshSerialRef.current === refreshSerial) setLoading(false);
      }
    },
    [loadEditor, workPath],
  );

  const flushCurrent = useCallback(
    async (options?: { force?: boolean; copyPath?: string }): Promise<boolean> => {
      clearAutoSaveTimer();
      if (saveInFlightRef.current) {
        const priorSaved = await saveInFlightRef.current;
        if (!priorSaved) return false;
      }
      const current = editorRef.current;
      if (!workPath || !current) return true;
      const force = options?.force ?? false;
      const copyPath = options?.copyPath;
      if (!dirtyRef.current && !force && !copyPath) return true;
      if (!current.editable && !copyPath) return false;

      const serial = editSerialRef.current;
      const snapshot = contentRef.current;
      const targetPath = copyPath ?? current.relativePath;
      setSaveState("saving");
      setLocalError(null);
      setError(null);

      const savePromise = saveScratchpadDocument(
        workPath,
        current.collection,
        targetPath,
        current.format,
        snapshot,
        copyPath ? null : current.revision || null,
        force,
      )
        .then(async (saved) => {
          let clearRecovery = false;
          const stillCurrent =
            editorRef.current && scratchpadEntryKey(editorRef.current) === scratchpadEntryKey(current);
          if (copyPath) {
            loadEditor(saved);
            clearRecovery = true;
          } else if (stillCurrent) {
            editorRef.current = { ...saved, content: contentRef.current };
            setEditor(editorRef.current);
            if (editSerialRef.current === serial) {
              dirtyRef.current = false;
              setSaveState("saved");
              clearRecovery = true;
            } else {
              setSaveState("idle");
            }
          }
          setConflict(false);
          if (clearRecovery) {
            clearScratchpadDraft(workPath);
            setRecoveryDraft(null);
          }
          await refresh(false);
          return true;
        })
        .catch((error) => {
          const message = errorMessage(error);
          if (isRevisionConflict(error)) setConflict(true);
          setLocalError(message);
          setSaveState("error");
          setError(message);
          return false;
        });

      saveInFlightRef.current = savePromise;
      const saved = await savePromise;
      if (saveInFlightRef.current === savePromise) saveInFlightRef.current = null;
      if (saved && dirtyRef.current && !copyPath && !force) {
        return flushCurrent();
      }
      return saved;
    },
    [clearAutoSaveTimer, loadEditor, refresh, workPath],
  );

  useEffect(() => {
    clearAutoSaveTimer();
    loadEditor(null);
    setRecoveryDraft(workPath ? readScratchpadDraft(workPath) : null);
    void refresh(false);
  }, [clearAutoSaveTimer, loadEditor, refresh, workPath]);

  useEffect(() => {
    if (refreshRequestEpochRef.current === refreshRequestEpoch) return;
    refreshRequestEpochRef.current = refreshRequestEpoch;
    void refresh(true);
  }, [refresh, refreshRequestEpoch]);

  useEffect(() => {
    if (!workPath || !isTauri()) return;
    let disposed = false;
    let unlisten: (() => void) | null = null;
    let unlistenError: (() => void) | null = null;
    const setup = queueWatcherTransition(async () => {
      await stopScratchpadWatcher();
      if (disposed) return;
      unlisten = await listen<ScratchpadChangedEvent>("scratchpad://changed", (event) => {
        if (
          disposed ||
          event.payload.workPath !== workPath ||
          event.payload.generation !== activeWatcherGenerationRef.current
        ) return;
        if (watcherRefreshTimerRef.current) window.clearTimeout(watcherRefreshTimerRef.current);
        watcherRefreshTimerRef.current = window.setTimeout(() => {
          watcherRefreshTimerRef.current = null;
          void refresh(true);
        }, 160);
      });
      unlistenError = await listen<ScratchpadWatcherErrorEvent>("scratchpad://error", (event) => {
        if (
          disposed ||
          event.payload.workPath !== workPath ||
          event.payload.generation !== activeWatcherGenerationRef.current
        ) return;
        setLocalError(event.payload.message);
        setError(event.payload.message);
      });
      if (disposed) {
        unlisten();
        unlistenError();
        unlisten = null;
        unlistenError = null;
        return;
      }
      activeWatcherGenerationRef.current = await startScratchpadWatcher(workPath);
    });
    void setup.catch((error) => {
      if (!disposed) setLocalError(errorMessage(error));
    });
    return () => {
      disposed = true;
      activeWatcherGenerationRef.current = null;
      unlisten?.();
      unlistenError?.();
      if (watcherRefreshTimerRef.current) window.clearTimeout(watcherRefreshTimerRef.current);
      void queueWatcherTransition(async () => {
        await setup.catch(() => undefined);
        await stopScratchpadWatcher();
      });
    };
  }, [refresh, workPath]);

  useEffect(
    () => () => {
      clearAutoSaveTimer();
    },
    [clearAutoSaveTimer],
  );

  const persistDraft = useCallback(
    (document: ScratchpadDocument, nextContent: string) => {
      if (!workPath) return;
      try {
        // Store the live buffer once; the embedded document is metadata only.
        writeScratchpadDraft({
          workPath,
          document: { ...document, content: "" },
          content: nextContent,
          savedAt: new Date().toISOString(),
        });
      } catch {
        // Quota or unavailable storage must never block the backend autosave.
      }
    },
    [workPath],
  );

  const scheduleAutoSave = useCallback(() => {
    clearAutoSaveTimer();
    const scheduledWorkPath = workPath;
    autoSaveTimerRef.current = window.setTimeout(() => {
      autoSaveTimerRef.current = null;
      if (activeWorkPathRef.current !== scheduledWorkPath) return;
      void flushCurrent();
    }, 700);
  }, [clearAutoSaveTimer, flushCurrent, workPath]);

  const updateContent = (next: string) => {
    contentRef.current = next;
    dirtyRef.current = true;
    editSerialRef.current += 1;
    setContent(next);
    setSaveState("idle");
    setConflict(false);
    if (editorRef.current) persistDraft(editorRef.current, next);
    scheduleAutoSave();
  };

  const openEntry = async (entry: ScratchpadEntry) => {
    if (!workPath || scratchpadEntryKey(entry) === (editor ? scratchpadEntryKey(editor) : "")) return;
    if (!(await flushCurrent())) return;
    setLocalError(null);
    try {
      loadEditor(await readScratchpadDocument(workPath, entry.collection, entry.relativePath));
    } catch (error) {
      const message = errorMessage(error);
      setLocalError(message);
      setError(message);
    }
  };

  const newMemo = async () => {
    if (!(await flushCurrent())) return;
    const selectedFolder = parseScratchpadFolderId(currentFolder);
    const leaf = newMemoRelativePath();
    const relativePath =
      selectedFolder?.collection === "memos" && selectedFolder.relativePath
        ? `${selectedFolder.relativePath}/${leaf}`
        : leaf;
    loadEditor({
      collection: "memos",
      relativePath,
      name: leaf,
      source: "maru",
      format: "plain",
      updatedAt: null,
      sizeBytes: 0,
      preview: "",
      revision: "",
      stale: false,
      editable: true,
      content: "",
    });
  };

  const changeNewMemoFormat = (format: MemoFormat) => {
    const current = editorRef.current;
    if (!current || current.revision || current.collection !== "memos") return;
    const relativePath = scratchpadPathForFormat(current.relativePath, format);
    const next = {
      ...current,
      name: relativePath.split("/").pop() ?? relativePath,
      relativePath,
      format,
    };
    editorRef.current = next;
    dirtyRef.current = true;
    editSerialRef.current += 1;
    setEditor(next);
    setPathDraft(relativePath);
    persistDraft(next, contentRef.current);
    scheduleAutoSave();
  };

  const renameCurrent = async () => {
    const current = editorRef.current;
    if (!workPath || !current || !current.revision || pathDraft === current.relativePath) return;
    if (!(await flushCurrent())) return;
    try {
      const renamed = await renameScratchpadDocument(
        workPath,
        current.collection,
        current.relativePath,
        pathDraft,
        editorRef.current?.revision ?? current.revision,
      );
      loadEditor(renamed);
      await refresh(false);
      onRefreshWorkspace();
    } catch (error) {
      const message = errorMessage(error);
      if (isRevisionConflict(error)) setConflict(true);
      setLocalError(message);
      setError(message);
    }
  };

  const reloadCurrent = async () => {
    const current = editorRef.current;
    if (!workPath || !current || !current.revision) return;
    try {
      loadEditor(
        await readScratchpadDocument(workPath, current.collection, current.relativePath),
      );
      clearScratchpadDraft(workPath);
      await refresh(false);
    } catch (error) {
      setLocalError(errorMessage(error));
    }
  };

  const overwriteCurrent = async () => {
    const current = editorRef.current;
    if (!workPath || !current || !current.revision) return;
    try {
      const disk = await readScratchpadDocument(
        workPath,
        current.collection,
        current.relativePath,
      );
      editorRef.current = { ...current, revision: disk.revision, updatedAt: disk.updatedAt };
      setEditor(editorRef.current);
      dirtyRef.current = true;
      await flushCurrent({ force: true });
    } catch (error) {
      const message = errorMessage(error);
      setConflict(true);
      setLocalError(message);
      setError(message);
    }
  };

  const saveCopy = async () => {
    const current = editorRef.current;
    if (!current) return;
    await flushCurrent({ copyPath: scratchpadCopyPath(current.relativePath) });
  };

  const trashCurrent = async () => {
    const current = editorRef.current;
    if (!workPath || !current || !current.revision) return;
    if (!(await flushCurrent())) return;
    if (!window.confirm(t("rightPane.scratchpad.trashConfirm", { name: current.name }))) return;
    try {
      await trashScratchpadDocument(
        workPath,
        current.collection,
        current.relativePath,
        editorRef.current?.revision ?? current.revision,
      );
      loadEditor(null);
      await refresh(false);
      onRefreshWorkspace();
    } catch (error) {
      const message = errorMessage(error);
      if (isRevisionConflict(error)) setConflict(true);
      setLocalError(message);
      setError(message);
    }
  };

  const saveAs = async () => {
    const current = editorRef.current;
    if (!current || !workPath) return;
    const target = await chooseSaveFile(t("rightPane.scratchpad.saveAs"), current.name);
    if (!target) return;
    try {
      await saveMemoAs(workPath, target, contentRef.current);
      onRefreshWorkspace();
    } catch (error) {
      const message = errorMessage(error);
      setLocalError(message);
      setError(message);
    }
  };

  const restoreRecoveryDraft = () => {
    if (!recoveryDraft || recoveryDraft.workPath !== workPath) return;
    const recovered = { ...recoveryDraft.document, content: recoveryDraft.content };
    editorRef.current = recovered;
    contentRef.current = recoveryDraft.content;
    dirtyRef.current = true;
    editSerialRef.current += 1;
    setEditor(recovered);
    setContent(recoveryDraft.content);
    setPathDraft(recovered.relativePath);
    setSaveState("idle");
    setConflict(Boolean(recovered.revision));
    setRecoveryDraft(null);
    if (!recovered.revision) scheduleAutoSave();
  };

  const discardRecoveryDraft = () => {
    if (workPath) clearScratchpadDraft(workPath);
    setRecoveryDraft(null);
  };

  const migrateMemos = async () => {
    if (!workPath || migrationBusy) return;
    if (!window.confirm(t("rightPane.scratchpad.migrationConfirm"))) return;
    setMigrationBusy(true);
    setMigrationStatus(null);
    try {
      const result = await migrateLegacyMemos(workPath);
      setMigrationStatus(
        t("rightPane.scratchpad.migrationResult", {
          migrated: result.migrated.length,
          skipped: result.skipped.length,
        }),
      );
      await refresh(false);
      onRefreshWorkspace();
    } catch (error) {
      const message = errorMessage(error);
      setMigrationStatus(message);
      setError(message);
    } finally {
      setMigrationBusy(false);
    }
  };

  const reviewTempCleanup = async () => {
    if (!workPath || cleanupBusy) return;
    setCleanupBusy(true);
    setCleanupStatus(null);
    setLocalError(null);
    try {
      if (!(await flushCurrent())) return;
      const candidates = (await planScratchpadTempCleanup(workPath)).filter((entry) => entry.stale);
      const current = editorRef.current;
      const safeCandidates = candidates.filter(
        (entry) =>
          !(
            current?.collection === "temp" &&
            current.relativePath === entry.relativePath
          ),
      );
      setCleanupCandidates(safeCandidates);
      setCleanupSelected(new Set());
      if (safeCandidates.length === 0) setCleanupStatus(t("rightPane.scratchpad.cleanupEmpty"));
    } catch (error) {
      const message = errorMessage(error);
      setLocalError(message);
      setError(message);
    } finally {
      setCleanupBusy(false);
    }
  };

  const applyTempCleanup = async () => {
    if (!workPath || !cleanupCandidates || cleanupSelected.size === 0 || cleanupBusy) return;
    setCleanupBusy(true);
    try {
      const selected = cleanupCandidates.filter((entry) => cleanupSelected.has(entry.relativePath));
      const result = await applyScratchpadTempCleanup(
        workPath,
        selected.map(({ relativePath, revision }) => ({ relativePath, revision })),
      );
      setCleanupStatus(
        t("rightPane.scratchpad.cleanupResult", {
          trashed: result.trashed.length,
          skipped: result.skipped.length,
        }),
      );
      closeCleanupReview();
      await refresh(true);
    } catch (error) {
      const message = errorMessage(error);
      setLocalError(message);
      setError(message);
    } finally {
      setCleanupBusy(false);
    }
  };

  const closeCleanupReview = () => {
    setCleanupCandidates(null);
    setCleanupSelected(new Set());
    window.requestAnimationFrame(() => reviewTempTriggerRef.current?.focus());
  };

  const handleCleanupDialogKeyDown = (event: ReactKeyboardEvent<HTMLDivElement>) => {
    if (event.key === "Escape") {
      event.preventDefault();
      closeCleanupReview();
      return;
    }
    if (event.key !== "Tab" || !cleanupDialogRef.current) return;
    const focusable = Array.from(
      cleanupDialogRef.current.querySelectorAll<HTMLElement>(
        'button:not(:disabled), input:not(:disabled), [href], [tabindex]:not([tabindex="-1"])',
      ),
    ).filter((element) => !element.hasAttribute("hidden"));
    if (focusable.length === 0) {
      event.preventDefault();
      cleanupDialogRef.current.focus();
      return;
    }
    const first = focusable[0];
    const last = focusable[focusable.length - 1];
    if (event.shiftKey && (document.activeElement === first || document.activeElement === cleanupDialogRef.current)) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && (document.activeElement === last || document.activeElement === cleanupDialogRef.current)) {
      event.preventDefault();
      first.focus();
    }
  };

  useEffect(() => {
    const handleNewMemo = () => void newMemo();
    const handleReviewTemp = () => void reviewTempCleanup();
    window.addEventListener("maru:scratchpad:new-memo", handleNewMemo);
    window.addEventListener("maru:scratchpad:review-temp", handleReviewTemp);
    return () => {
      window.removeEventListener("maru:scratchpad:new-memo", handleNewMemo);
      window.removeEventListener("maru:scratchpad:review-temp", handleReviewTemp);
    };
  });

  useLayoutEffect(() => {
    if (!cleanupCandidates) return;
    cleanupDialogRef.current?.focus();
  }, [cleanupCandidates]);

  useEffect(() => {
    if (!workPath) {
      setCurrentFolder("");
      return;
    }
    try {
      const stored = JSON.parse(
        window.sessionStorage.getItem(SCRATCHPAD_LOCATION_KEY) ?? "{}",
      ) as Record<string, string>;
      setCurrentFolder(stored[workPath] ?? "");
    } catch {
      setCurrentFolder("");
    }
  }, [workPath]);

  useEffect(() => {
    if (!workPath) return;
    try {
      const stored = JSON.parse(
        window.sessionStorage.getItem(SCRATCHPAD_LOCATION_KEY) ?? "{}",
      ) as Record<string, string>;
      stored[workPath] = currentFolder;
      window.sessionStorage.setItem(SCRATCHPAD_LOCATION_KEY, JSON.stringify(stored));
    } catch {
      // Session storage is a convenience only; navigation must remain usable.
    }
  }, [currentFolder, workPath]);

  const folderTree = useMemo(() => buildScratchpadFolderTree(entries), [entries]);
  const folderIds = useMemo(() => {
    const ids = new Set<string>([""]);
    const visit = (node: ScratchpadFolderNode) => {
      ids.add(node.id);
      node.children.forEach(visit);
    };
    visit(folderTree);
    return ids;
  }, [folderTree]);
  useEffect(() => {
    if (!folderIds.has(currentFolder)) setCurrentFolder("");
  }, [currentFolder, folderIds]);

  const filteredEntries = useMemo(
    () => filterScratchpadFolderEntries(entries, currentFolder, query),
    [currentFolder, entries, query],
  );
  // "name" keeps the collection/stage grouping; a time sort flattens it so the
  // most recently touched scratch file wins regardless of which collection it
  // lives in.
  const flatSort = sortKey !== "name" || Boolean(currentFolder);
  const groupedEntries = useMemo(
    () => (flatSort ? [] : groupScratchpadEntries(filteredEntries)),
    [flatSort, filteredEntries],
  );
  const flatEntries = useMemo(
    () => (flatSort ? sortScratchpadEntries(filteredEntries, sortKey) : []),
    [flatSort, filteredEntries, sortKey],
  );
  const hasEntries = flatSort ? flatEntries.length > 0 : groupedEntries.length > 0;
  const previewHtml = useMemo(
    () => (editor?.format === "markdown" ? renderScratchpadMarkdown(content) : ""),
    [content, editor?.format],
  );
  const selectedKey = editor ? scratchpadEntryKey(editor) : "";
  const expandedSet = useMemo(() => new Set(expandedFolders), [expandedFolders]);
  const navigateFolder = useCallback(
    async (folderId: string) => {
      if (folderId === currentFolder) return;
      if (!(await flushCurrent())) return;
      setCurrentFolder(folderId);
      loadEditor(null);
      onExpandedFoldersChange(
        Array.from(new Set([...expandedFolders, ...scratchpadFolderAncestors(folderId)])),
      );
    },
    [currentFolder, expandedFolders, flushCurrent, loadEditor, onExpandedFoldersChange],
  );
  const toggleFolder = useCallback(
    (folderId: string) => {
      onExpandedFoldersChange(
        expandedSet.has(folderId)
          ? expandedFolders.filter(
              (item) => item !== folderId && !item.startsWith(`${folderId}/`),
            )
          : [...expandedFolders, folderId],
      );
    },
    [expandedFolders, expandedSet, onExpandedFoldersChange],
  );
  const renderEntryRow = (entry: ScratchpadEntry) => (
    <button
      key={scratchpadEntryKey(entry)}
      type="button"
      className={
        scratchpadEntryKey(entry) === selectedKey
          ? "scratchpad-list-item active"
          : "scratchpad-list-item"
      }
      onClick={() => void openEntry(entry)}
      title={`${entry.collection}/${entry.relativePath}`}
    >
      <span className="scratchpad-list-title">
        <strong>{entry.name}</strong>
        {entry.stale ? (
          <em>{t("rightPane.scratchpad.cleanupEligible")}</em>
        ) : null}
      </span>
      <span className="scratchpad-list-preview">
        {entry.preview || t("rightPane.memo.noPreview")}
      </span>
      <span className="scratchpad-list-meta">
        <span>{entry.relativePath}</span>
        <span>{formatUpdated(entry.updatedAt)}</span>
      </span>
    </button>
  );
  const autoSaveLabel =
    saveState === "saving"
      ? t("rightPane.memo.autoSaving")
      : saveState === "saved"
        ? t("rightPane.memo.autoSaved")
        : saveState === "error"
          ? t("rightPane.memo.autoSaveError")
          : t("rightPane.memo.autoSaveIdle");

  return (
    <section
      className={`scratchpad-pane scratchpad-workspace${treeOpen ? " tree-open" : ""}`}
      aria-label={t("rightPane.tab.memo")}
      style={
        {
          "--scratchpad-list-height": `${draggedListHeight}px`,
          "--scratchpad-list-width": `${draggedListWidth}px`,
          "--scratchpad-tree-width": treeOpen ? `${draggedTreeWidth}px` : "0px",
        } as CSSProperties
      }
    >
      <ModeHeader
        className="scratchpad-mode-header"
        title={t("rightPane.tab.memo")}
        subtitle={t("scratchpad.subtitle")}
        actions={
          <div className="right-tool-actions scratchpad-actions">
            {!treeOpen ? (
              <button
                type="button"
                onClick={() => onTreeOpenChange(true)}
                title={t("scratchpad.tree.show")}
                aria-label={t("scratchpad.tree.show")}
              >
                <PanelLeftOpen size={14} />
                <span>{t("scratchpad.tree.title")}</span>
              </button>
            ) : null}
            <button
              type="button"
              className="scratchpad-new-memo-action"
              onClick={() => void newMemo()}
              disabled={!workPath}
            >
              <FilePlus2 size={14} />
              <span>{t("rightPane.scratchpad.newMemo")}</span>
            </button>
            <button
              ref={reviewTempTriggerRef}
              type="button"
              onClick={() => void reviewTempCleanup()}
              disabled={!workPath || cleanupBusy}
            >
              <Trash2 size={14} />
              <span>{t("rightPane.scratchpad.reviewTemp")}</span>
            </button>
            <button
              type="button"
              className="scratchpad-refresh-action"
              onClick={() => void refresh(true)}
              disabled={!workPath || loading}
              title={t("rightPane.scratchpad.refresh")}
              aria-label={t("rightPane.scratchpad.refresh")}
            >
              <RefreshCw size={14} />
            </button>
          </div>
        }
      />

      <div className="scratchpad-workspace-body">
        {treeOpen ? (
          <aside className="scratchpad-tree-pane" aria-label={t("scratchpad.tree.title")}>
            <header className="scratchpad-tree-header">
              <span>{t("scratchpad.tree.title")}</span>
              <button
                type="button"
                onClick={() => onTreeOpenChange(false)}
                title={t("scratchpad.tree.hide")}
                aria-label={t("scratchpad.tree.hide")}
              >
                <PanelLeftClose size={14} />
              </button>
            </header>
            <div className="scratchpad-tree-scroll" role="tree" aria-label={t("scratchpad.tree.title")}>
              <div
                className={`scratchpad-tree-row scratchpad-tree-all${currentFolder === "" ? " selected" : ""}`}
                role="treeitem"
                aria-level={1}
                aria-selected={currentFolder === ""}
              >
                <span className="scratchpad-tree-chevron" />
                <button
                  type="button"
                  className="scratchpad-tree-target"
                  onClick={() => void navigateFolder("")}
                >
                  <Layers size={14} />
                  <span>{t("scratchpad.tree.all")}</span>
                  <small>{folderTree.fileCount}</small>
                  {folderTree.staleCount > 0 ? <em>{folderTree.staleCount}</em> : null}
                </button>
              </div>
              {folderTree.children.map((node) => (
                <ScratchpadTreeRow
                  key={node.id}
                  node={node}
                  depth={0}
                  currentFolder={currentFolder}
                  expanded={expandedSet}
                  onNavigate={(folderId) => void navigateFolder(folderId)}
                  onToggle={toggleFolder}
                  t={t}
                />
              ))}
            </div>
            <div className="scratchpad-maintenance">
              <button type="button" onClick={() => void migrateMemos()} disabled={!workPath || migrationBusy}>
                <FolderInput size={13} />
                <span>{t("rightPane.scratchpad.migrateMemos")}</span>
              </button>
              {migrationStatus ? <span role="status">{migrationStatus}</span> : null}
              {cleanupStatus ? <span role="status">{cleanupStatus}</span> : null}
            </div>
          </aside>
        ) : null}

        {treeOpen ? (
          <div className="scratchpad-resize scratchpad-tree-resize">
            <PaneResizeHandle
              label={t("scratchpad.tree.resize")}
              orientation="vertical"
              value={draggedTreeWidth}
              min={SCRATCHPAD_TREE_WIDTH.min}
              max={SCRATCHPAD_TREE_WIDTH.max}
              defaultValue={SCRATCHPAD_TREE_WIDTH.defaultValue}
              onChange={setDraggedTreeWidth}
              onCommit={onTreeWidthChange}
            />
          </div>
        ) : null}

        <aside className="scratchpad-navigator" aria-label={t("rightPane.scratchpad.list")}>
          <div className="scratchpad-navigator-heading">
            <span>{currentFolder ? currentFolder : t("scratchpad.tree.all")}</span>
            <small>{filteredEntries.length}</small>
          </div>
          <div className="scratchpad-navigator-tools">
            <label className="scratchpad-search">
              <Search size={14} />
              <input
                value={query}
                onChange={(event) => setQuery(event.target.value)}
                placeholder={t("rightPane.scratchpad.search")}
                aria-label={t("rightPane.scratchpad.search")}
              />
            </label>

            <SortModeToggle value={sortKey} onChange={onSortKeyChange} t={t} />

            {localError ? (
              <div className="scratchpad-inline-state error" role="alert">
                <AlertTriangle size={14} />
                <span>{localError}</span>
              </div>
            ) : null}
          </div>

          <div className="scratchpad-list">
            {loading && entries.length === 0 ? (
              <div className="scratchpad-skeleton" aria-label={t("rightPane.scratchpad.loading")}>
                <span />
                <span />
                <span />
              </div>
            ) : null}
            {!loading && !hasEntries ? (
              <div className="scratchpad-empty">
                <List size={18} />
                <strong>{query ? t("rightPane.scratchpad.noResults") : t("rightPane.scratchpad.empty")}</strong>
                <span>{t("rightPane.scratchpad.emptyHint")}</span>
              </div>
            ) : null}
            {flatSort
              ? flatEntries.map(renderEntryRow)
              : groupedEntries.map((section) => (
                  <section className="scratchpad-collection" key={section.collection}>
                    <header>
                      <strong>{collectionLabel(section.collection, t)}</strong>
                      <span>
                        {section.groups.reduce((count, group) => count + group.entries.length, 0)}
                      </span>
                    </header>
                    {section.groups.map((group) => (
                      <div className="scratchpad-group" key={group.id}>
                        <span className="scratchpad-group-label">
                          {groupLabel(section.collection, group.id, t)}
                        </span>
                        {group.entries.map(renderEntryRow)}
                      </div>
                    ))}
                  </section>
                ))}
          </div>

        </aside>

        <div className="scratchpad-resize scratchpad-resize-wide">
          <PaneResizeHandle
            label={t("scratchpad.resizeNavigator")}
            orientation="vertical"
            value={draggedListWidth}
            min={SCRATCHPAD_LIST_WIDTH.min}
            max={SCRATCHPAD_LIST_WIDTH.max}
            defaultValue={SCRATCHPAD_LIST_WIDTH.defaultValue}
            onChange={setDraggedListWidth}
            onCommit={onListWidthChange}
          />
        </div>

        <div className="scratchpad-resize scratchpad-resize-compact">
          <PaneResizeHandle
            label={t("rightPane.scratchpad.resizeList")}
            orientation="horizontal"
            value={draggedListHeight}
            min={SCRATCHPAD_LIST_HEIGHT.min}
            max={SCRATCHPAD_LIST_HEIGHT.max}
            defaultValue={SCRATCHPAD_LIST_HEIGHT.defaultValue}
            onChange={setDraggedListHeight}
            onCommit={onListHeightChange}
          />
        </div>

        <main className="scratchpad-editor-region">
          {recoveryDraft ? (
            <div className="scratchpad-recovery" role="status">
              <div>
                <AlertTriangle size={14} />
                <span>{t("rightPane.scratchpad.recoveryAvailable", { name: recoveryDraft.document.name })}</span>
              </div>
              <div className="right-tool-actions">
                <button type="button" onClick={restoreRecoveryDraft}>
                  {t("rightPane.scratchpad.restoreDraft")}
                </button>
                <button type="button" onClick={discardRecoveryDraft}>
                  {t("rightPane.scratchpad.discardDraft")}
                </button>
              </div>
            </div>
          ) : null}

          {editor ? (
            <div className="scratchpad-editor-shell">
          {conflict ? (
            <div className="scratchpad-conflict" role="alert">
              <div>
                <AlertTriangle size={14} />
                <strong>{t("rightPane.scratchpad.conflict")}</strong>
              </div>
              <span>{t("rightPane.scratchpad.conflictHint")}</span>
              <div className="right-tool-actions">
                <button type="button" onClick={() => void reloadCurrent()}>
                  <RotateCcw size={12} />
                  {t("rightPane.scratchpad.reload")}
                </button>
                <button type="button" onClick={() => void overwriteCurrent()}>
                  <Save size={12} />
                  {t("rightPane.scratchpad.overwrite")}
                </button>
                <button type="button" onClick={() => void saveCopy()}>
                  <Copy size={12} />
                  {t("rightPane.scratchpad.saveCopy")}
                </button>
              </div>
            </div>
          ) : null}

          <label className="scratchpad-path-field">
            <span>{t("rightPane.scratchpad.path")}</span>
            <div>
              <input
                value={pathDraft}
                onChange={(event) => setPathDraft(event.target.value)}
                disabled={!editor.revision || !editor.editable}
              />
              <button
                type="button"
                onClick={() => void renameCurrent()}
                disabled={!editor.revision || !editor.editable || pathDraft === editor.relativePath}
              >
                {t("rightPane.scratchpad.rename")}
              </button>
            </div>
          </label>

          <DocumentModeSurface
            t={t}
            kind={editor.format === "markdown" ? "markdown" : "plain"}
            mode={editor.format === "markdown" ? editorViewMode : "source"}
            onModeChange={(mode) => onEditorViewModeChange(mode as EditorViewMode)}
            toolbarAction={
              <div className="scratchpad-editor-mode-meta">
                {!editor.revision && editor.collection === "memos" ? (
                  <div className="right-tool-actions">
                    <button
                      type="button"
                      className={editor.format === "plain" ? "active" : ""}
                      onClick={() => changeNewMemoFormat("plain")}
                    >
                      {t("rightPane.scratchpad.plain")}
                    </button>
                    <button
                      type="button"
                      className={editor.format === "markdown" ? "active" : ""}
                      onClick={() => changeNewMemoFormat("markdown")}
                    >
                      {t("rightPane.scratchpad.markdown")}
                    </button>
                  </div>
                ) : null}
                <span title={editor.relativePath}>
                  {editor.source} · {formatSize(editor.sizeBytes)}
                  {!editor.editable ? ` · ${t("rightPane.scratchpad.readOnly")}` : ""}
                </span>
              </div>
            }
            richPanel={
              <Suspense fallback={<div className="editor-loading" role="status">…</div>}>
                <LazyRichMarkdownEditor
                  value={content}
                  onChange={updateContent}
                  readOnly={!editor.editable}
                />
              </Suspense>
            }
            sourcePanel={
              <div className="source-editor-wrap">
                <textarea
                  className="source-editor scratchpad-editor scratchpad-source-editor"
                  value={content}
                  onChange={(event) => updateContent(event.target.value)}
                  placeholder={t("rightPane.scratchpad.placeholder")}
                  readOnly={!editor.editable}
                  spellCheck={false}
                />
              </div>
            }
            previewPanel={
              <article
                className="preview-surface scratchpad-preview"
                dangerouslySetInnerHTML={{ __html: previewHtml }}
              />
            }
          />

          <div className="scratchpad-editor-footer">
            <span />
            <span
              className={`memo-autosave-status ${saveState}`}
              role="status"
              aria-live="polite"
            >
              {autoSaveLabel}
            </span>
          </div>

          <div className="right-tool-actions bottom scratchpad-bottom-actions">
            <button
              type="button"
              className="danger"
              disabled={!editor.revision}
              onClick={() => void trashCurrent()}
            >
              <Trash2 size={13} />
              <span>{t("rightPane.scratchpad.trash")}</span>
            </button>
            <button type="button" onClick={() => void saveAs()}>
              <Save size={13} />
              <span>{t("rightPane.scratchpad.saveAs")}</span>
            </button>
          </div>
            </div>
          ) : (
            <div className="scratchpad-editor-empty">
              <Lightbulb size={22} />
              <strong>{t("scratchpad.editorEmptyTitle")}</strong>
              <span>{t("rightPane.scratchpad.selectHint")}</span>
              <button type="button" onClick={() => void newMemo()} disabled={!workPath}>
                <FilePlus2 size={14} />
                {t("rightPane.scratchpad.newMemo")}
              </button>
            </div>
          )}
        </main>
      </div>

      {cleanupCandidates ? (
        <div
          className="scratchpad-cleanup-overlay"
          onKeyDown={handleCleanupDialogKeyDown}
        >
          <section
            ref={cleanupDialogRef}
            className="scratchpad-cleanup-dialog"
            role="dialog"
            aria-modal="true"
            aria-labelledby="scratchpad-cleanup-title"
            tabIndex={-1}
          >
            <header>
              <div>
                <strong id="scratchpad-cleanup-title">{t("rightPane.scratchpad.cleanupTitle")}</strong>
                <span>
                  {t("rightPane.scratchpad.cleanupReviewHint", { count: cleanupCandidates.length })}
                </span>
              </div>
              <button
                type="button"
                onClick={closeCleanupReview}
                aria-label={t("rightPane.scratchpad.close")}
              >
                <X size={14} />
              </button>
            </header>
            {cleanupCandidates.length === 0 ? (
              <div className="scratchpad-cleanup-empty">{t("rightPane.scratchpad.cleanupEmpty")}</div>
            ) : (
              <>
                <div className="scratchpad-cleanup-tools">
                  <button
                    type="button"
                    onClick={() =>
                      setCleanupSelected(new Set(cleanupCandidates.map((entry) => entry.relativePath)))
                    }
                  >
                    <CheckSquare size={13} />
                    {t("rightPane.scratchpad.selectAll")}
                  </button>
                  <button type="button" onClick={() => setCleanupSelected(new Set())}>
                    <Square size={13} />
                    {t("rightPane.scratchpad.clearSelection")}
                  </button>
                </div>
                <fieldset className="scratchpad-cleanup-list">
                  <legend>{t("rightPane.scratchpad.cleanupCandidates")}</legend>
                  {cleanupCandidates.map((entry) => {
                    const checked = cleanupSelected.has(entry.relativePath);
                    return (
                      <label key={entry.relativePath}>
                        <input
                          type="checkbox"
                          checked={checked}
                          onChange={() =>
                            setCleanupSelected((current) => {
                              const next = new Set(current);
                              if (next.has(entry.relativePath)) next.delete(entry.relativePath);
                              else next.add(entry.relativePath);
                              return next;
                            })
                          }
                        />
                        <span>
                          <strong>{entry.relativePath}</strong>
                          <small>
                            {formatSize(entry.sizeBytes)} · {formatUpdated(entry.updatedAt)}
                          </small>
                        </span>
                      </label>
                    );
                  })}
                </fieldset>
              </>
            )}
            <footer>
              <span>{t("rightPane.scratchpad.selectedCount", { count: cleanupSelected.size })}</span>
              <div>
                <button type="button" onClick={closeCleanupReview}>
                  {t("rightPane.scratchpad.cancel")}
                </button>
                <button
                  type="button"
                  className="danger"
                  disabled={cleanupSelected.size === 0 || cleanupBusy}
                  onClick={() => void applyTempCleanup()}
                >
                  {t("rightPane.scratchpad.moveSelectedToTrash")}
                </button>
              </div>
            </footer>
          </section>
        </div>
      ) : null}
    </section>
  );
}
