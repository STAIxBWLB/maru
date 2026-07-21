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
import { isInEditable, matchesShortcut } from "../../lib/diagram/shortcuts";
import { fitView } from "../../lib/diagram/geometry";
import { readMaruSettings, saveMaruSettings } from "../../lib/maruDir";
import type { MkNodeOpts } from "../../lib/diagram/nodeKinds";
import {
  deleteDiagram,
  listDiagrams,
  readDiagram,
  serializeDoc,
  type DiagramFile,
  writeDiagram,
} from "../../lib/diagram/persistence";
import type { TemplateDefinition } from "../../lib/diagram/templates";
import {
  createAutoSnapshotScheduler,
  saveSnapshotForDoc,
  type AutoSnapshotScheduler,
} from "../../lib/diagram/versionHistory";
import {
  createDiagramId,
  createEmptyDoc,
  type DiagramDoc,
  type NodeId,
  type NodeKind,
  type RibbonTab,
} from "../../lib/diagram/types";
import { useTranslation } from "../../lib/i18n";
import {
  DiagramStoreProvider,
  getDiagramSession,
  setDiagramSession,
  useDiagram,
  useDiagramCoalescer,
  useDiagramStore,
} from "./DiagramStoreContext";
import { CanvasSurface } from "./canvas/CanvasSurface";
import { InlineTextEditor, type InlineEditField } from "./canvas/InlineTextEditor";
import { LeftPanel } from "./panels/LeftPanel";
import { RightPanel } from "./panels/RightPanel";
import { Ribbon } from "./ribbon/Ribbon";
import { ExportDialog } from "./modals/ExportDialog";
import { ImportMermaidDialog } from "./modals/ImportMermaidDialog";
import { MemoDialog } from "./modals/MemoDialog";
import { SaveAsDialog } from "./modals/SaveAsDialog";
import { SpecialCharsPicker } from "./modals/SpecialCharsPicker";
import { TemplatePickerDialog } from "./modals/TemplatePickerDialog";
import { VersionHistoryDialog } from "./modals/VersionHistoryDialog";
import { FindBar } from "./canvas/FindBar";
import "./diagram.css";

export interface DiagramModeProps {
  workPath: string | null;
  onError?: (message: string | null) => void;
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

export function DiagramMode({ workPath, onError }: DiagramModeProps) {
  const storeKey = workPath ?? "__no-workspace__";
  return (
    <DiagramStoreProvider storeKey={storeKey}>
      <DiagramShell key={storeKey} workPath={workPath} onError={onError} />
    </DiagramStoreProvider>
  );
}

function DiagramShell({ workPath, onError }: DiagramModeProps) {
  const { t } = useTranslation();
  const store = useDiagramStore();
  const coalescer = useDiagramCoalescer();
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
  const [templateOpen, setTemplateOpen] = useState(false);
  const [exportOpen, setExportOpen] = useState(false);
  const [historyOpen, setHistoryOpen] = useState(false);
  const [memoOpen, setMemoOpen] = useState<string | null>(null);
  const [findOpen, setFindOpen] = useState(false);
  const [specialOpen, setSpecialOpen] = useState(false);
  const [importMermaidOpen, setImportMermaidOpen] = useState(false);
  const [inlineEdit, setInlineEdit] = useState<{ nodeId: NodeId; field: InlineEditField } | null>(null);
  const [theme, setTheme] = useState<"light" | "dark">(() => {
    if (typeof document === "undefined") return "light";
    return (document.documentElement.dataset.theme === "dark" ? "dark" : "light");
  });
  const focusMode = useDiagram((s) => s.ephemeral.ui.focusMode);
  const [panels, setPanels] = useState<PersistedPanelState>(() => readPanelState());
  const viewportRef = useRef<HTMLDivElement | null>(null);
  const titleInputRef = useRef<HTMLInputElement | null>(null);
  const insertOffsetRef = useRef(0);
  const titleCoalescerRef = useRef(defaultCoalescer());
  const inlineEditCoalescerRef = useRef(defaultCoalescer());

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
        const restored = await readDiagram(workPath, lastDocument);
        if (cancelled) return;
        store.setState(replaceDoc(restored));
        setActiveName(lastDocument);
        setLastSavedBody(serializeDoc(restored));
      } catch {
        /* Best-effort restore only: a missing/deleted last diagram should not block Diagram mode. */
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [sessionKey, setActiveName, setLastSavedBody, store, workPath]);

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
        const current = store.getState().doc;
        const written = await writeDiagram(workPath, name, current);
        store.setState((s) => ({ ...s, doc: written }));
        setActiveName(name);
        setLastSavedBody(serializeDoc(written));
        // A successful manual save satisfies the pending auto-snapshot.
        snapshotSchedRef.current?.markClean();
        await persistLastDocument(name);
      } catch (err) {
        reportError(t("diagram.error.save", { message: (err as Error).message ?? "unknown" }));
      } finally {
        setSaving(false);
      }
    },
    [persistLastDocument, reportError, setActiveName, setLastSavedBody, store, t, workPath],
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
    void persistLastDocument(null);
    reportError(null);
  }, [persistLastDocument, reportError, setActiveName, setLastSavedBody, store]);

  const handleOpen = useCallback(
    async (name: string) => {
      if (!workPath) return;
      try {
        const doc = await readDiagram(workPath, name);
        store.setState(replaceDoc(doc));
        setActiveName(name);
        setLastSavedBody(serializeDoc(doc));
        setListOpen(false);
        await persistLastDocument(name);
        reportError(null);
      } catch (err) {
        reportError(t("diagram.error.load", { message: (err as Error).message ?? "unknown" }));
      }
    },
    [persistLastDocument, reportError, setActiveName, setLastSavedBody, store, t, workPath],
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
      }
      if (!inField && !event.metaKey && !event.ctrlKey) {
        const step = event.shiftKey ? 10 : 1;
        if (event.key === "ArrowLeft") {
          event.preventDefault();
          store.setState(withSnapshot(nudgeSelection(-step, 0), coalescer));
          return;
        }
        if (event.key === "ArrowRight") {
          event.preventDefault();
          store.setState(withSnapshot(nudgeSelection(step, 0), coalescer));
          return;
        }
        if (event.key === "ArrowUp") {
          event.preventDefault();
          store.setState(withSnapshot(nudgeSelection(0, -step), coalescer));
          return;
        }
        if (event.key === "ArrowDown") {
          event.preventDefault();
          store.setState(withSnapshot(nudgeSelection(0, step), coalescer));
          return;
        }
      }
      if (!inField && (event.key === "Delete" || event.key === "Backspace")) {
        if (hasSelection) {
          event.preventDefault();
          const state = store.getState();
          const nodeIds = [...state.ephemeral.selection.nodes];
          const edgeIds = [...state.ephemeral.selection.edges];
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
  }, [coalescer, findOpen, handleSave, hasSelection, openInlineEditor, store]);

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
          onExport: () => setExportOpen(true),
          onTemplates: () => setTemplateOpen(true),
          onHistory: () => setHistoryOpen(true),
          onImportMermaid: () => setImportMermaidOpen(true),
          saving,
          canSave: Boolean(workPath),
        }}
        insertProps={{
          onInsert: (kind) => insertAtCenter(kind),
          onImageFile: handleImage,
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
      <TemplatePickerDialog
        open={templateOpen}
        dirty={dirty}
        onApply={(tpl: TemplateDefinition) => {
          const fresh = createEmptyDoc(createDiagramId());
          const bundle = tpl.build(400, 300, t);
          const next: DiagramDoc = {
            ...fresh,
            nodes: bundle.nodes,
            edges: bundle.edges,
            docTitle: t(tpl.labelKey),
          };
          store.setState(replaceDoc(next));
          setActiveName(null);
          setLastSavedBody(null);
          void persistLastDocument(null);
          setTemplateOpen(false);
        }}
        onCancel={() => setTemplateOpen(false)}
      />
      <ExportDialog
        open={exportOpen}
        doc={store.getState().doc}
        workspace={workPath}
        getSvg={() =>
          viewportRef.current?.querySelector<SVGSVGElement>(".maru-diagram-canvas") ?? null
        }
        onClose={() => setExportOpen(false)}
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
      <ImportMermaidDialog
        open={importMermaidOpen}
        onApply={(doc) => {
          store.setState(replaceDoc(doc));
          setActiveName(null);
          setLastSavedBody(null);
          void persistLastDocument(null);
          setImportMermaidOpen(false);
          reportError(null);
        }}
        onCancel={() => setImportMermaidOpen(false)}
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
