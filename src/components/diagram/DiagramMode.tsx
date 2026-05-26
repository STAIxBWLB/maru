import {
  Image as ImageIcon,
  Magnet,
  Maximize2,
  Network,
  Redo2,
  Save,
  Trash2,
  Undo2,
  ZoomIn,
  ZoomOut,
} from "lucide-react";
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
  removeEdges,
  removeNodes,
  replaceDoc,
  setDocTitle,
  setSelection,
  setSnapSize,
  setViewport,
  toggleSmartGuides,
  toggleSnap,
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
import { createEmptyDoc, type NodeKind } from "../../lib/diagram/types";
import { useTranslation } from "../../lib/i18n";
import {
  DiagramStoreProvider,
  useDiagram,
  useDiagramStore,
} from "./DiagramStoreContext";
import { CanvasSurface } from "./canvas/CanvasSurface";
import "./diagram.css";

export interface DiagramModeProps {
  workPath: string | null;
  onError?: (message: string | null) => void;
}

const ZOOM_STEP = 1.25;
const MIN_ZOOM = 0.2;
const MAX_ZOOM = 3;
const SNAP_STORAGE_KEY = "anchor:diagram:snap-size";
const MAX_IMAGE_BYTES = 2 * 1024 * 1024;

type ToolbarKind = NodeKind;

interface ToolbarGroup {
  label: string;
  kinds: ToolbarKind[];
}

const TOOLBAR_GROUPS: ToolbarGroup[] = [
  {
    label: "diagram.toolbar.group.basic",
    kinds: ["simple", "text", "numbered", "section", "titled-box", "split-box"],
  },
  {
    label: "diagram.toolbar.group.shape",
    kinds: ["diamond", "oval", "hexagon", "cylinder", "callout"],
  },
  {
    label: "diagram.toolbar.group.misc",
    kinds: ["table"],
  },
];

const KIND_TO_KEY: Record<NodeKind, string> = {
  simple: "diagram.toolbar.addSimple",
  text: "diagram.toolbar.addText",
  section: "diagram.toolbar.addSection",
  numbered: "diagram.toolbar.addNumbered",
  "titled-box": "diagram.toolbar.addTitledBox",
  "split-box": "diagram.toolbar.addSplitBox",
  diamond: "diagram.toolbar.addDiamond",
  oval: "diagram.toolbar.addOval",
  hexagon: "diagram.toolbar.addHexagon",
  cylinder: "diagram.toolbar.addCylinder",
  callout: "diagram.toolbar.addCallout",
  table: "diagram.toolbar.addTable",
  image: "diagram.toolbar.addImage",
};

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
  const history = useDiagram((s) => s.ephemeral.history);
  const viewport = useDiagram((s) => s.ephemeral.viewport);
  const snapOn = useDiagram((s) => s.ephemeral.ui.snapOn);
  const snapSize = useDiagram((s) => s.ephemeral.ui.snapSize);
  const smartGuideOn = useDiagram((s) => s.ephemeral.ui.smartGuideOn);

  const [activeName, setActiveName] = useState<string | null>(null);
  const [lastSavedBody, setLastSavedBody] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [listOpen, setListOpen] = useState(false);
  const [files, setFiles] = useState<DiagramFile[]>([]);
  const viewportRef = useRef<HTMLDivElement | null>(null);
  const insertOffsetRef = useRef(0);
  const imageInputRef = useRef<HTMLInputElement | null>(null);

  // Hydrate persisted snap-size once on mount.
  useEffect(() => {
    try {
      const raw = window.localStorage.getItem(SNAP_STORAGE_KEY);
      const value = raw ? parseInt(raw, 10) : NaN;
      if (Number.isFinite(value) && value > 0) {
        store.setState(setSnapSize(value));
      }
    } catch {
      /* ignore */
    }
  }, [store]);

  const docBody = useMemo(
    () => JSON.stringify(store.getState().doc),
    [nodes, edges, docTitle],
  );
  const dirty = lastSavedBody !== null ? docBody !== lastSavedBody : nodes.length > 0;
  const canUndo = history.past.length > 0;
  const canRedo = history.future.length > 0;
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
      const titleKey = KIND_TO_KEY[kind];
      const title = opts.title ?? (kind === "text" ? t(titleKey) : "");
      store.setState(
        withSnapshot(
          addNode(kind, canvasX + offset, canvasY + offset, { ...opts, title }),
          defaultCoalescer(),
        ),
      );
    },
    [store, t, viewport.px, viewport.py, viewport.zoom],
  );

  const handleDelete = useCallback(() => {
    const state = store.getState();
    const nodeIds = [...state.ephemeral.selection.nodes];
    const edgeIds = [...state.ephemeral.selection.edges];
    if (nodeIds.length === 0 && edgeIds.length === 0) return;
    if (nodeIds.length > 0) {
      store.setState(withSnapshot(removeNodes(nodeIds), defaultCoalescer()));
    }
    if (edgeIds.length > 0) {
      store.setState(withSnapshot(removeEdges(edgeIds), defaultCoalescer()));
    }
  }, [store]);

  const handleUndo = useCallback(() => store.setState(undoAction()), [store]);
  const handleRedo = useCallback(() => store.setState(redoAction()), [store]);

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

  const handleSave = useCallback(async () => {
    if (!workPath) {
      reportError(t("diagram.status.noWorkspace"));
      return;
    }
    let name = activeName;
    if (!name) {
      const proposed = docTitle.trim() || `diagram-${new Date().toISOString().slice(0, 10)}`;
      const answer = typeof window === "undefined" ? null : window.prompt(t("diagram.prompt.saveAs"), proposed);
      if (!answer) return;
      name = answer.trim();
      if (!name) return;
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
  }, [activeName, docTitle, reportError, store, t, workPath]);

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
        // Try to size to image's natural aspect.
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
        img.onerror = () => {
          insertAtCenter("image", { meta: { src: dataUrl, name: file.name } });
        };
        img.src = dataUrl;
      };
      reader.readAsDataURL(file);
    },
    [insertAtCenter, reportError],
  );

  // Keyboard shortcuts scoped to the diagram pane.
  useEffect(() => {
    const handler = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement | null;
      const inField = target?.tagName === "INPUT" || target?.tagName === "TEXTAREA" || target?.isContentEditable;
      const mod = event.metaKey || event.ctrlKey;
      if (mod && event.key.toLowerCase() === "s") {
        event.preventDefault();
        void handleSave();
        return;
      }
      if (mod && event.key.toLowerCase() === "z") {
        event.preventDefault();
        if (event.shiftKey) handleRedo();
        else handleUndo();
        return;
      }
      if (mod && event.key.toLowerCase() === "y") {
        event.preventDefault();
        handleRedo();
        return;
      }
      if (!inField && (event.key === "Delete" || event.key === "Backspace")) {
        if (hasSelection) {
          event.preventDefault();
          handleDelete();
        }
      }
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [handleDelete, handleRedo, handleSave, handleUndo, hasSelection]);

  const onSnapSizeChange = useCallback(
    (event: ChangeEvent<HTMLInputElement>) => {
      const next = parseInt(event.target.value, 10);
      if (!Number.isFinite(next)) return;
      store.setState(setSnapSize(next));
      try {
        window.localStorage.setItem(SNAP_STORAGE_KEY, String(next));
      } catch {
        /* ignore */
      }
    },
    [store],
  );

  const statusLabel = saving
    ? t("diagram.status.saving")
    : dirty
      ? t("diagram.status.dirty")
      : activeName
        ? t("diagram.status.saved")
        : "";

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
      <div className="anchor-diagram-toolbar" role="toolbar" aria-label={t("mode.diagram")}>
        {TOOLBAR_GROUPS.map((group) => (
          <span className="anchor-diagram-toolbar-group" key={group.label}>
            <span className="anchor-diagram-toolbar-group-label">{t(group.label)}</span>
            {group.kinds.map((kind) => (
              <button
                key={kind}
                type="button"
                onClick={() => insertAtCenter(kind)}
                title={t(KIND_TO_KEY[kind])}
              >
                {t(KIND_TO_KEY[kind])}
              </button>
            ))}
          </span>
        ))}
        <span className="anchor-diagram-toolbar-group">
          <button
            type="button"
            onClick={() => imageInputRef.current?.click()}
            title={t("diagram.toolbar.addImage")}
          >
            <ImageIcon size={14} /> {t("diagram.toolbar.addImage")}
          </button>
          <input
            ref={imageInputRef}
            type="file"
            accept="image/*"
            style={{ display: "none" }}
            onChange={handleImage}
          />
        </span>
        <span className="anchor-diagram-sep" />
        <button
          type="button"
          onClick={handleDelete}
          disabled={!hasSelection}
          title={t("diagram.toolbar.delete")}
        >
          <Trash2 size={14} /> {t("diagram.toolbar.delete")}
        </button>
        <button type="button" onClick={handleUndo} disabled={!canUndo} title={t("diagram.toolbar.undo")}>
          <Undo2 size={14} />
        </button>
        <button type="button" onClick={handleRedo} disabled={!canRedo} title={t("diagram.toolbar.redo")}>
          <Redo2 size={14} />
        </button>
        <span className="anchor-diagram-sep" />
        <button
          type="button"
          onClick={() => store.setState(toggleSnap())}
          className={snapOn ? "is-toggle-on" : ""}
          title={`Snap ${snapOn ? "ON" : "OFF"}`}
        >
          <Magnet size={14} />
        </button>
        <label className="anchor-diagram-snap-input" title={t("diagram.toolbar.snapSize")}>
          <span>{t("diagram.toolbar.snapSize")}</span>
          <input type="number" min={1} max={200} step={1} value={snapSize} onChange={onSnapSizeChange} />
        </label>
        <button
          type="button"
          onClick={() => store.setState(toggleSmartGuides())}
          className={smartGuideOn ? "is-toggle-on" : ""}
          title={`Smart guides ${smartGuideOn ? "ON" : "OFF"}`}
        >
          🎯
        </button>
        <span className="anchor-diagram-sep" />
        <button type="button" onClick={() => handleZoom(1 / ZOOM_STEP)} title={t("diagram.toolbar.zoomOut")}>
          <ZoomOut size={14} />
        </button>
        <span className="anchor-diagram-zoom-label">{Math.round(viewport.zoom * 100)}%</span>
        <button type="button" onClick={() => handleZoom(ZOOM_STEP)} title={t("diagram.toolbar.zoomIn")}>
          <ZoomIn size={14} />
        </button>
        <button type="button" onClick={handleFitView} title={t("diagram.toolbar.fitView")}>
          <Maximize2 size={14} /> {t("diagram.toolbar.fitView")}
        </button>
        <span className="anchor-diagram-spacer" />
        <button type="button" onClick={handleNew} title={t("diagram.toolbar.new")}>
          {t("diagram.toolbar.new")}
        </button>
        <button type="button" onClick={() => setListOpen((o) => !o)} title={t("diagram.toolbar.open")}>
          {t("diagram.toolbar.open")}
        </button>
        <button
          type="button"
          onClick={() => void handleSave()}
          disabled={saving || !workPath}
          title={t("diagram.toolbar.save")}
          className="anchor-diagram-toolbar-primary"
        >
          <Save size={14} /> {t("diagram.toolbar.save")}
        </button>
      </div>
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
                      <Trash2 size={14} />
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </aside>
        ) : null}
      </div>
    </div>
  );
}

export default DiagramMode;
