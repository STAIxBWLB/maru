import { listen } from "@tauri-apps/api/event";
import {
  AlertTriangle,
  Archive,
  ArrowRight,
  CheckSquare,
  Copy,
  FilePlus2,
  FolderInput,
  Lightbulb,
  List,
  RefreshCw,
  RotateCcw,
  Save,
  Search,
  Square,
  Trash2,
  X,
} from "lucide-react";
import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
} from "react";
import {
  applyScratchpadTempCleanup,
  chooseSaveFile,
  createScratchpadIdea,
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
  transitionScratchpadIdea,
  trashScratchpadDocument,
} from "../lib/api";
import {
  filterScratchpadEntries,
  groupScratchpadEntries,
  isRevisionConflict,
  clearScratchpadDraft,
  newMemoRelativePath,
  readScratchpadDraft,
  renderScratchpadMarkdown,
  scratchpadCopyPath,
  scratchpadEntryKey,
  scratchpadPathForFormat,
  writeScratchpadDraft,
  type ScratchpadDraft,
} from "../lib/scratchpad";
import type {
  IdeationStage,
  MemoFormat,
  ScratchpadChangedEvent,
  ScratchpadDocument,
  ScratchpadEntry,
  ScratchpadWatcherErrorEvent,
  TempCleanupCandidate,
} from "../lib/types";

type Translate = (key: string, vars?: Record<string, string | number>) => string;
type SaveState = "idle" | "saving" | "saved" | "error";

interface ScratchpadPaneProps {
  workPath: string | null;
  onError: (message: string | null) => void;
  onRefreshWorkspace: () => void;
  t: Translate;
}

const IDEATION_STAGE_TRANSITIONS: Record<IdeationStage, IdeationStage[]> = {
  seed: ["developing", "archive"],
  developing: ["proposal", "archive"],
  proposal: ["archive"],
  archive: ["seed"],
};

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
  if (collection === "ideation") {
    return id === "ungrouped"
      ? t("rightPane.scratchpad.group.ungrouped")
      : t(`rightPane.scratchpad.stage.${id}`);
  }
  if (collection === "memos") return t("rightPane.scratchpad.group.personal");
  return id;
}

let watcherTransition: Promise<void> = Promise.resolve();

function queueWatcherTransition(task: () => Promise<void>): Promise<void> {
  const next = watcherTransition.catch(() => undefined).then(task);
  watcherTransition = next;
  return next;
}

export function ScratchpadPane({
  workPath,
  onError,
  onRefreshWorkspace,
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
  const [viewMode, setViewMode] = useState<"source" | "preview">("source");
  const [cleanupBusy, setCleanupBusy] = useState(false);
  const [cleanupCandidates, setCleanupCandidates] = useState<TempCleanupCandidate[] | null>(null);
  const [cleanupSelected, setCleanupSelected] = useState<Set<string>>(new Set());
  const [cleanupStatus, setCleanupStatus] = useState<string | null>(null);
  const [migrationBusy, setMigrationBusy] = useState(false);
  const [migrationStatus, setMigrationStatus] = useState<string | null>(null);
  const [recoveryDraft, setRecoveryDraft] = useState<ScratchpadDraft | null>(null);

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
    setViewMode("source");
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
        setEntries(nextEntries);
        const current = editorRef.current;
        if (!checkActive || !current || !current.revision) return;
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
        onError(message);
      } finally {
        if (refreshSerialRef.current === refreshSerial) setLoading(false);
      }
    },
    [loadEditor, onError, workPath],
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
      onError(null);

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
          onError(message);
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
    [clearAutoSaveTimer, loadEditor, onError, refresh, workPath],
  );

  useEffect(() => {
    clearAutoSaveTimer();
    loadEditor(null);
    setRecoveryDraft(workPath ? readScratchpadDraft(workPath) : null);
    void refresh(false);
  }, [clearAutoSaveTimer, loadEditor, refresh, workPath]);

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
        onError(event.payload.message);
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
      onError(message);
    }
  };

  const newMemo = async () => {
    if (!(await flushCurrent())) return;
    const relativePath = newMemoRelativePath();
    loadEditor({
      collection: "memos",
      relativePath,
      name: relativePath,
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

  const newIdea = async () => {
    if (!workPath || !(await flushCurrent())) return;
    const title = window.prompt(t("rightPane.scratchpad.ideaPrompt"))?.trim();
    if (!title) return;
    setLocalError(null);
    try {
      const created = await createScratchpadIdea(workPath, title);
      loadEditor(created);
      await refresh(false);
    } catch (error) {
      const message = errorMessage(error);
      setLocalError(message);
      onError(message);
    }
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
      onError(message);
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
      onError(message);
    }
  };

  const saveCopy = async () => {
    const current = editorRef.current;
    if (!current) return;
    await flushCurrent({ copyPath: scratchpadCopyPath(current.relativePath) });
  };

  const transitionIdea = async (stage: IdeationStage) => {
    const current = editorRef.current;
    if (!workPath || !current || current.collection !== "ideation" || !current.revision) return;
    if (!(await flushCurrent())) return;
    try {
      const transitioned = await transitionScratchpadIdea(
        workPath,
        current.relativePath,
        stage,
        editorRef.current?.revision ?? current.revision,
      );
      loadEditor(transitioned);
      await refresh(false);
      onRefreshWorkspace();
    } catch (error) {
      const message = errorMessage(error);
      if (isRevisionConflict(error)) setConflict(true);
      setLocalError(message);
      onError(message);
    }
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
      onError(message);
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
      onError(message);
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
      onError(message);
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
      onError(message);
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
      onError(message);
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
    const handleNewIdea = () => void newIdea();
    const handleReviewTemp = () => void reviewTempCleanup();
    window.addEventListener("maru:scratchpad:new-memo", handleNewMemo);
    window.addEventListener("maru:scratchpad:new-idea", handleNewIdea);
    window.addEventListener("maru:scratchpad:review-temp", handleReviewTemp);
    return () => {
      window.removeEventListener("maru:scratchpad:new-memo", handleNewMemo);
      window.removeEventListener("maru:scratchpad:new-idea", handleNewIdea);
      window.removeEventListener("maru:scratchpad:review-temp", handleReviewTemp);
    };
  });

  useLayoutEffect(() => {
    if (!cleanupCandidates) return;
    cleanupDialogRef.current?.focus();
  }, [cleanupCandidates]);

  const filteredEntries = useMemo(
    () => filterScratchpadEntries(entries, query),
    [entries, query],
  );
  const groupedEntries = useMemo(
    () => groupScratchpadEntries(filteredEntries),
    [filteredEntries],
  );
  const previewHtml = useMemo(
    () => (editor?.format === "markdown" ? renderScratchpadMarkdown(content) : ""),
    [content, editor?.format],
  );
  const selectedKey = editor ? scratchpadEntryKey(editor) : "";
  const transitions = editor?.ideationStage
    ? IDEATION_STAGE_TRANSITIONS[editor.ideationStage]
    : [];

  const autoSaveLabel =
    saveState === "saving"
      ? t("rightPane.memo.autoSaving")
      : saveState === "saved"
        ? t("rightPane.memo.autoSaved")
        : saveState === "error"
          ? t("rightPane.memo.autoSaveError")
          : t("rightPane.memo.autoSaveIdle");

  return (
    <section className="right-tool-pane scratchpad-pane" aria-label={t("rightPane.tab.memo")}>
      <div className="scratchpad-heading">
        <div>
          <span>{t("rightPane.scratchpad.kicker")}</span>
          <h3>{t("rightPane.tab.memo")}</h3>
        </div>
        <button
          type="button"
          className="scratchpad-icon-button"
          onClick={() => void refresh(true)}
          title={t("rightPane.scratchpad.refresh")}
          aria-label={t("rightPane.scratchpad.refresh")}
        >
          <RefreshCw size={14} />
        </button>
      </div>

      <div className="right-tool-actions scratchpad-actions">
        <button type="button" onClick={() => void newMemo()} disabled={!workPath}>
          <FilePlus2 size={13} />
          <span>{t("rightPane.scratchpad.newMemo")}</span>
        </button>
        <button type="button" onClick={() => void newIdea()} disabled={!workPath}>
          <Lightbulb size={13} />
          <span>{t("rightPane.scratchpad.newIdea")}</span>
        </button>
        <button
          ref={reviewTempTriggerRef}
          type="button"
          onClick={() => void reviewTempCleanup()}
          disabled={!workPath || cleanupBusy}
        >
          <Trash2 size={13} />
          <span>{t("rightPane.scratchpad.reviewTemp")}</span>
        </button>
      </div>

      <label className="scratchpad-search">
        <Search size={13} />
        <input
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          placeholder={t("rightPane.scratchpad.search")}
          aria-label={t("rightPane.scratchpad.search")}
        />
      </label>

      {localError ? (
        <div className="scratchpad-inline-state error" role="alert">
          <AlertTriangle size={14} />
          <span>{localError}</span>
        </div>
      ) : null}

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

      <div className="scratchpad-maintenance">
        <button type="button" onClick={() => void migrateMemos()} disabled={!workPath || migrationBusy}>
          <FolderInput size={13} />
          <span>{t("rightPane.scratchpad.migrateMemos")}</span>
        </button>
        {migrationStatus ? <span role="status">{migrationStatus}</span> : null}
        {cleanupStatus ? <span role="status">{cleanupStatus}</span> : null}
      </div>

      <div className="scratchpad-list" aria-label={t("rightPane.scratchpad.list")}>
        {loading && entries.length === 0 ? (
          <div className="scratchpad-skeleton" aria-label={t("rightPane.scratchpad.loading")}>
            <span />
            <span />
            <span />
          </div>
        ) : null}
        {!loading && groupedEntries.length === 0 ? (
          <div className="scratchpad-empty">
            <List size={18} />
            <strong>{query ? t("rightPane.scratchpad.noResults") : t("rightPane.scratchpad.empty")}</strong>
            <span>{t("rightPane.scratchpad.emptyHint")}</span>
          </div>
        ) : null}
        {groupedEntries.map((section) => (
          <section className="scratchpad-collection" key={section.collection}>
            <header>
              <strong>{collectionLabel(section.collection, t)}</strong>
              <span>{section.groups.reduce((count, group) => count + group.entries.length, 0)}</span>
            </header>
            {section.groups.map((group) => (
              <div className="scratchpad-group" key={group.id}>
                <span className="scratchpad-group-label">{groupLabel(section.collection, group.id, t)}</span>
                {group.entries.map((entry) => (
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
                        <em>
                          {entry.collection === "ideation"
                            ? t("rightPane.scratchpad.reviewDue")
                            : t("rightPane.scratchpad.cleanupEligible")}
                        </em>
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
                ))}
              </div>
            ))}
          </section>
        ))}
      </div>

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

          <div className="scratchpad-editor-toolbar">
            <div className="right-tool-actions">
              <button
                type="button"
                className={viewMode === "source" ? "active" : ""}
                onClick={() => setViewMode("source")}
              >
                {t("rightPane.scratchpad.source")}
              </button>
              {editor.format === "markdown" ? (
                <button
                  type="button"
                  className={viewMode === "preview" ? "active" : ""}
                  onClick={() => setViewMode("preview")}
                >
                  {t("rightPane.scratchpad.preview")}
                </button>
              ) : null}
              {!editor.revision && editor.collection === "memos" ? (
                <>
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
                </>
              ) : null}
            </div>
            <span title={editor.relativePath}>
              {editor.source} · {formatSize(editor.sizeBytes)}
              {!editor.editable ? ` · ${t("rightPane.scratchpad.readOnly")}` : ""}
            </span>
          </div>

          {viewMode === "preview" && editor.format === "markdown" ? (
            <article
              className="scratchpad-preview markdown-preview"
              dangerouslySetInnerHTML={{ __html: previewHtml }}
            />
          ) : (
            <textarea
              className="scratchpad-editor"
              value={content}
              onChange={(event) => updateContent(event.target.value)}
              placeholder={t("rightPane.scratchpad.placeholder")}
              readOnly={!editor.editable}
            />
          )}

          <div className="scratchpad-editor-footer">
            {editor.collection === "ideation" && editor.ideationStage ? (
              <div className="scratchpad-stage-actions">
                <span>{t(`rightPane.scratchpad.stage.${editor.ideationStage}`)}</span>
                {transitions.map((stage) => (
                  <button key={stage} type="button" onClick={() => void transitionIdea(stage)}>
                    {stage === "archive" ? <Archive size={12} /> : <ArrowRight size={12} />}
                    {t(`rightPane.scratchpad.stage.${stage}`)}
                  </button>
                ))}
              </div>
            ) : (
              <span />
            )}
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
          <Lightbulb size={18} />
          <span>{t("rightPane.scratchpad.selectHint")}</span>
        </div>
      )}

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
