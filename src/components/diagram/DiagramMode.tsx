import { Network } from "lucide-react";
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ChangeEvent,
} from "react";

import {
  addNode,
  defaultCoalescer,
  redo as redoAction,
  replaceDoc,
  setDocTitle,
  setSnapSize,
  setViewport,
  undo as undoAction,
  withSnapshot,
} from "../../lib/diagram/actions";
import { fitView } from "../../lib/diagram/geometry";
import type { MkNodeOpts } from "../../lib/diagram/nodeKinds";
import {
  deleteDiagram,
  listDiagrams,
  readDiagram,
  type DiagramFile,
  writeDiagram,
} from "../../lib/diagram/persistence";
import {
  createEmptyDoc,
  type NodeKind,
  type RibbonTab,
} from "../../lib/diagram/types";
import { useTranslation } from "../../lib/i18n";
import {
  DiagramStoreProvider,
  useDiagram,
  useDiagramStore,
} from "./DiagramStoreContext";
import { CanvasSurface } from "./canvas/CanvasSurface";
import { LeftPanel } from "./panels/LeftPanel";
import { RightPanel } from "./panels/RightPanel";
import { Ribbon } from "./ribbon/Ribbon";
import { SaveAsDialog } from "./modals/SaveAsDialog";
import "./diagram.css";

export interface DiagramModeProps {
  workPath: string | null;
  onError?: (message: string | null) => void;
}

const ZOOM_STEP = 1.25;
const MIN_ZOOM = 0.2;
const MAX_ZOOM = 3;
const SNAP_STORAGE_KEY = "anchor:diagram:snap-size";
const PANEL_STORAGE_KEY = "anchor:diagram:panels-v1";
const MAX_IMAGE_BYTES = 2 * 1024 * 1024;

interface PersistedPanelState {
  left: boolean;
  right: boolean;
  ribbon: RibbonTab;
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
      };
    }
  } catch {
    /* ignore */
  }
  return { left: true, right: true, ribbon: "edit" };
}

function writePanelState(state: PersistedPanelState): void {
  try {
    window.localStorage.setItem(PANEL_STORAGE_KEY, JSON.stringify(state));
  } catch {
    /* ignore */
  }
}

export function DiagramMode({ workPath, onError }: DiagramModeProps) {
  return (
    <DiagramStoreProvider>
      <DiagramShell workPath={workPath} onError={onError} />
    </DiagramStoreProvider>
  );
}

function DiagramShell({ workPath, onError }: DiagramModeProps) {
  const { t } = useTranslation();
  const store = useDiagramStore();
  const nodes = useDiagram((s) => s.doc.nodes);
  const edges = useDiagram((s) => s.doc.edges);
  const docTitle = useDiagram((s) => s.doc.docTitle);
  const selection = useDiagram((s) => s.ephemeral.selection);
  const viewport = useDiagram((s) => s.ephemeral.viewport);

  const [activeName, setActiveName] = useState<string | null>(null);
  const [lastSavedBody, setLastSavedBody] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [listOpen, setListOpen] = useState(false);
  const [files, setFiles] = useState<DiagramFile[]>([]);
  const [saveDialogOpen, setSaveDialogOpen] = useState(false);
  const [panels, setPanels] = useState<PersistedPanelState>(() => readPanelState());
  const viewportRef = useRef<HTMLDivElement | null>(null);
  const insertOffsetRef = useRef(0);

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

  const docBody = useMemo(
    () => JSON.stringify(store.getState().doc),
    [nodes, edges, docTitle],
  );
  const dirty = lastSavedBody !== null ? docBody !== lastSavedBody : nodes.length > 0;
  const hasSelection = selection.nodes.size + selection.edges.size > 0;

  const reportError = useCallback((message: string | null) => onError?.(message), [onError]);

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
      store.setState(
        withSnapshot(addNode(kind, canvasX + offset, canvasY + offset, opts), defaultCoalescer()),
      );
    },
    [store, viewport.px, viewport.py, viewport.zoom],
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
        setLastSavedBody(JSON.stringify(written));
      } catch (err) {
        reportError(t("diagram.error.save", { message: (err as Error).message ?? "unknown" }));
      } finally {
        setSaving(false);
      }
    },
    [reportError, store, t, workPath],
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
    const fresh = createEmptyDoc(crypto.randomUUID());
    store.setState(replaceDoc(fresh));
    setActiveName(null);
    setLastSavedBody(null);
    reportError(null);
  }, [reportError, store]);

  const handleOpen = useCallback(
    async (name: string) => {
      if (!workPath) return;
      try {
        const doc = await readDiagram(workPath, name);
        store.setState(replaceDoc(doc));
        setActiveName(name);
        setLastSavedBody(JSON.stringify(doc));
        setListOpen(false);
        reportError(null);
      } catch (err) {
        reportError(t("diagram.error.load", { message: (err as Error).message ?? "unknown" }));
      }
    },
    [reportError, store, t, workPath],
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
        reportError(`이미지가 너무 큽니다 (${(file.size / 1024 / 1024).toFixed(1)}MB > 2MB)`);
        return;
      }
      const reader = new FileReader();
      reader.onerror = () => reportError("이미지를 읽을 수 없습니다");
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
    [insertAtCenter, reportError],
  );

  const persistSnapSize = useCallback((size: number) => {
    try {
      window.localStorage.setItem(SNAP_STORAGE_KEY, String(size));
    } catch {
      /* ignore */
    }
  }, []);

  // Keyboard shortcuts scoped to the diagram pane.
  useEffect(() => {
    const handler = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement | null;
      const inField =
        target?.tagName === "INPUT" || target?.tagName === "TEXTAREA" || target?.isContentEditable;
      const mod = event.metaKey || event.ctrlKey;
      if (mod && event.key.toLowerCase() === "s") {
        event.preventDefault();
        handleSave();
        return;
      }
      if (mod && event.key.toLowerCase() === "z") {
        event.preventDefault();
        if (event.shiftKey) store.setState(redoAction());
        else store.setState(undoAction());
        return;
      }
      if (mod && event.key.toLowerCase() === "y") {
        event.preventDefault();
        store.setState(redoAction());
        return;
      }
      if (!inField && (event.key === "Delete" || event.key === "Backspace")) {
        if (hasSelection) {
          event.preventDefault();
          // Delegate to the action (re-importing here would create a cycle; use a local lambda).
          store.setState((state) => {
            const { nodes, edges } = state.ephemeral.selection;
            if (nodes.size === 0 && edges.size === 0) return state;
            const filteredNodes = state.doc.nodes.filter((n) => !nodes.has(n.id));
            const filteredEdges = state.doc.edges.filter(
              (e) => !edges.has(e.id) && !nodes.has(e.fromNode) && !nodes.has(e.toNode),
            );
            return {
              ...state,
              doc: { ...state.doc, nodes: filteredNodes, edges: filteredEdges },
              ephemeral: {
                ...state.ephemeral,
                selection: { nodes: new Set(), edges: new Set() },
              },
            };
          });
        }
      }
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [handleSave, hasSelection, store]);

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

  const initialSaveName = (docTitle || "").trim() || `diagram-${new Date().toISOString().slice(0, 10)}`;

  return (
    <div className="anchor-diagram" data-testid="diagram-mode" role="region" aria-label={t("mode.diagram")}>
      <header className="anchor-diagram-header">
        <div className="anchor-diagram-title">
          <Network size={20} strokeWidth={1.9} aria-hidden="true" />
          <input
            className="anchor-diagram-title-input"
            value={docTitle}
            placeholder={t("diagram.title.placeholder")}
            onChange={(e) => store.setState(setDocTitle(e.target.value))}
            aria-label={t("diagram.title.placeholder")}
          />
          {statusLabel ? (
            <span className={`anchor-diagram-status anchor-diagram-status-${dirty ? "dirty" : "saved"}`}>
              {statusLabel}
            </span>
          ) : null}
        </div>
        <div className="anchor-diagram-meta">
          <span className="anchor-diagram-meta-label">{t("diagram.scaffold.workspace")}</span>
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
      />
      <div className="anchor-diagram-workspace">
        {panels.left ? <LeftPanel /> : null}
        <div className="anchor-diagram-viewport" ref={viewportRef}>
          <CanvasSurface />
          {listOpen ? (
            <aside className="anchor-diagram-list" aria-label={t("diagram.list.heading")}>
              <div className="anchor-diagram-list-head">
                <h2>{t("diagram.list.heading")}</h2>
                <button type="button" onClick={() => setListOpen(false)}>
                  {t("diagram.list.close")}
                </button>
              </div>
              {files.length === 0 ? (
                <p className="anchor-diagram-list-empty">{t("diagram.list.empty")}</p>
              ) : (
                <ul>
                  {files.map((file) => (
                    <li key={file.name}>
                      <button type="button" onClick={() => void handleOpen(file.name)}>
                        <span className="anchor-diagram-list-name">{file.docTitle || file.name}</span>
                        <span className="anchor-diagram-list-meta">
                          {new Date(file.modifiedAt).toLocaleString()}
                        </span>
                      </button>
                      <button
                        type="button"
                        className="anchor-diagram-list-delete"
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
        {panels.right ? <RightPanel /> : null}
      </div>
      <SaveAsDialog
        open={saveDialogOpen}
        initialName={activeName ?? initialSaveName}
        workspace={workPath}
        onConfirm={handleConfirmSaveAs}
        onCancel={() => setSaveDialogOpen(false)}
      />
    </div>
  );
}

export default DiagramMode;
