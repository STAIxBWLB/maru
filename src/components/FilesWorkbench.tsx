import {
  ArrowLeft,
  ArrowRight,
  ArrowUp,
  ChevronDown,
  ChevronRight,
  Clipboard,
  Copy,
  ExternalLink,
  File,
  FilePlus2,
  FileText,
  Folder,
  FolderOpen,
  FolderPlus,
  ListFilter,
  MoreHorizontal,
  PanelLeftClose,
  PanelLeftOpen,
  PanelRightClose,
  PanelRightOpen,
  RefreshCcw,
  Scissors,
  Search,
  Star,
  Trash2,
} from "lucide-react";
import type React from "react";
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import {
  binaryViewerClassify,
  binaryViewerOpenExternal,
  binaryViewerPrepareAsset,
  createWorkspaceDirectory,
  duplicateWorkspaceEntries,
  pasteWorkspaceEntries,
  readDocument,
  renameWorkspaceEntry,
  trashWorkspaceEntries,
  type BinaryViewerClassification,
} from "../lib/api";
import {
  buildFilesDirectoryTree,
  collapseNestedPaths,
  filesBreadcrumbs,
  isDirectoryNode,
  isFileNode,
  listFilesDirectoryContents,
  normalizeRelPath,
  parentFolderRelPath,
  workspaceNodeToFileEntry,
  type FilesDirectoryTreeNode,
} from "../lib/filesWorkbench";
import { formatBytes, usesAssetProtocol } from "../lib/binaryViewer";
import { renderMarkdown } from "../lib/markdown";
import type {
  FavoriteItem,
  FilesListAttribute,
  FilesSortKey,
  WorkspaceFileFilter,
} from "../lib/settings";
import type {
  FileStoreOperation,
  WorkspaceEntryNode,
  WorkspaceFileEntry,
  WorkspaceMutationOutcome,
  WorkspaceVisibility,
} from "../lib/types";
import {
  applyWorkspaceFilesPaneFilters,
  collectWorkspaceFileExtensionCounts,
  hasActiveWorkspaceFilesPaneFilters,
  type WorkspaceFilesPaneFilters,
} from "../lib/workspaceFileTree";
import { useTranslation } from "../lib/i18n";
import { BinaryViewerPane } from "./BinaryViewerPane";
import { FavoritesSection, type FavoriteTarget } from "./FavoritesSection";
import { HtmlPreviewFrame } from "./HtmlVisualEditor";

const LOCATION_KEY = "maru:files-location:v1";
const CLIPBOARD_KEY = "maru:files-clipboard:v1";

interface FilesClipboardState {
  workspacePath: string;
  operation: FileStoreOperation;
  paths: string[];
}

interface FilesWorkbenchProps {
  entries: WorkspaceEntryNode[];
  selectedPaths: string[];
  query: string;
  loading: boolean;
  refreshing: boolean;
  workspacePath: string | null;
  workspaceVisibility: WorkspaceVisibility;
  publicWorkspaceAvailable: boolean;
  activeWorkspaceLabel: string | null;
  filter: WorkspaceFileFilter;
  sortKey: FilesSortKey;
  filesListAttributes: FilesListAttribute[];
  paneFilters: WorkspaceFilesPaneFilters;
  queuedSourcePaths: string[];
  collapsedFolders: string[];
  treeOpen: boolean;
  treeWidth: number;
  previewOpen: boolean;
  previewWidth: number;
  favorites: FavoriteItem[];
  canCreate: boolean;
  canRenameMove: boolean;
  canDelete: boolean;
  openDocumentPaths: string[];
  dirtyDocumentPaths: string[];
  pendingRevealTargetPath?: string | null;
  onRevealHandled?: () => void;
  onWorkspaceVisibilityChange: (visibility: WorkspaceVisibility) => void;
  onAddPublicWorkspace: () => void;
  onQueryChange: (query: string) => void;
  onFilterChange: (filter: WorkspaceFileFilter) => void;
  onSortKeyChange: (key: FilesSortKey) => void;
  onFilesListAttributesChange: (attributes: FilesListAttribute[]) => void;
  onPaneFiltersChange: (filters: WorkspaceFilesPaneFilters) => void;
  onCollapsedFoldersChange: (paths: string[]) => void;
  onSelectionChange: (paths: string[]) => void;
  onOpenDocument: (entry: WorkspaceFileEntry) => void;
  onQueuePaths: (paths: string[]) => void;
  onRevealInFinder: (path: string) => void;
  onRefresh: () => void;
  onFilesystemMutated: (
    outcomes: WorkspaceMutationOutcome[],
    effect: "refresh" | "move" | "trash",
  ) => void;
  onLayoutChange: (patch: {
    filesTreeOpen?: boolean;
    filesTreeWidth?: number;
    filesPreviewOpen?: boolean;
    filesPreviewWidth?: number;
  }) => void;
  onOpenFavorite: (favorite: FavoriteItem) => void;
  onRemoveFavorite: (favorite: FavoriteItem) => void;
  onToggleFavorite: (target: FavoriteTarget) => void;
  isFavoriteMissing: (favorite: FavoriteItem) => boolean;
  isFavorite: (kind: FavoriteItem["kind"], relPath: string) => boolean;
  onApplySkillToTarget?: (targetPath: string, targetKind: "file" | "directory") => void;
  onAttachToTerminal?: (relPath: string, absPath: string) => void;
  onError: (message: string) => void;
}

export function FilesWorkbench(props: FilesWorkbenchProps) {
  const { t, locale } = useTranslation();
  const {
    entries,
    selectedPaths,
    query,
    loading,
    refreshing,
    workspacePath,
    workspaceVisibility,
    publicWorkspaceAvailable,
    activeWorkspaceLabel,
    filter,
    sortKey,
    filesListAttributes,
    paneFilters,
    queuedSourcePaths,
    collapsedFolders,
    treeOpen,
    treeWidth,
    previewOpen,
    previewWidth,
    favorites,
    canCreate,
    canRenameMove,
    canDelete,
    openDocumentPaths,
    dirtyDocumentPaths,
    pendingRevealTargetPath,
    onRevealHandled,
    onWorkspaceVisibilityChange,
    onAddPublicWorkspace,
    onQueryChange,
    onFilterChange,
    onSortKeyChange,
    onFilesListAttributesChange,
    onPaneFiltersChange,
    onCollapsedFoldersChange,
    onSelectionChange,
    onOpenDocument,
    onQueuePaths,
    onRevealInFinder,
    onRefresh,
    onFilesystemMutated,
    onLayoutChange,
    onOpenFavorite,
    onRemoveFavorite,
    onToggleFavorite,
    isFavoriteMissing,
    isFavorite,
    onApplySkillToTarget,
    onAttachToTerminal,
    onError,
  } = props;

  const rootLabel = activeWorkspaceLabel || t("files.workspaceRoot");
  const [currentFolder, setCurrentFolder] = useState("");
  const [backStack, setBackStack] = useState<string[]>([]);
  const [forwardStack, setForwardStack] = useState<string[]>([]);
  const [clipboard, setClipboard] = useState<FilesClipboardState | null>(() =>
    readSessionJson<FilesClipboardState>(CLIPBOARD_KEY),
  );
  const [creatingFolder, setCreatingFolder] = useState(false);
  const [newFolderName, setNewFolderName] = useState("");
  const [renamingPath, setRenamingPath] = useState<string | null>(null);
  const [renameValue, setRenameValue] = useState("");
  const [filtersOpen, setFiltersOpen] = useState(false);
  const [contextMenu, setContextMenu] = useState<{
    x: number;
    y: number;
    path: string;
  } | null>(null);
  const [busy, setBusy] = useState(false);
  const selectionRef = useRef(selectedPaths);
  const rangeAnchorRef = useRef<string | null>(null);
  const listRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    selectionRef.current = selectedPaths;
  }, [selectedPaths]);

  useEffect(() => {
    if (!workspacePath) {
      setCurrentFolder("");
      return;
    }
    const locations = readSessionJson<Record<string, string>>(LOCATION_KEY) ?? {};
    setCurrentFolder(normalizeRelPath(locations[workspacePath] ?? ""));
    setBackStack([]);
    setForwardStack([]);
  }, [workspacePath]);

  useEffect(() => {
    if (!workspacePath) return;
    const locations = readSessionJson<Record<string, string>>(LOCATION_KEY) ?? {};
    locations[workspacePath] = currentFolder;
    writeSessionJson(LOCATION_KEY, locations);
  }, [currentFolder, workspacePath]);

  const directoryPaths = useMemo(
    () => new Set(["", ...entries.filter(isDirectoryNode).map((entry) => entry.relPath)]),
    [entries],
  );

  useEffect(() => {
    if (currentFolder && !directoryPaths.has(currentFolder)) {
      setCurrentFolder("");
      setBackStack([]);
      setForwardStack([]);
      onSelectionChange([]);
    }
  }, [currentFolder, directoryPaths, onSelectionChange]);

  const fileEntries = useMemo(
    () =>
      entries
        .map(workspaceNodeToFileEntry)
        .filter((entry): entry is WorkspaceFileEntry => Boolean(entry)),
    [entries],
  );
  const effectivePaneFilters = useMemo(
    () => ({ ...paneFilters, queuedPaths: queuedSourcePaths }),
    [paneFilters, queuedSourcePaths],
  );
  const allowedFilePaths = useMemo(
    () =>
      new Set(
        applyWorkspaceFilesPaneFilters(fileEntries, effectivePaneFilters).map(
          (entry) => entry.path,
        ),
      ),
    [effectivePaneFilters, fileEntries],
  );
  const contents = useMemo(
    () =>
      listFilesDirectoryContents(entries, currentFolder, query, filter, sortKey).filter(
        (entry) => isDirectoryNode(entry) || allowedFilePaths.has(entry.path),
      ),
    [allowedFilePaths, currentFolder, entries, filter, query, sortKey],
  );
  const tree = useMemo(
    () => buildFilesDirectoryTree(entries, rootLabel),
    [entries, rootLabel],
  );
  const breadcrumbs = useMemo(
    () => filesBreadcrumbs(currentFolder, rootLabel),
    [currentFolder, rootLabel],
  );
  const selectedEntries = useMemo(() => {
    const byPath = new Map(entries.map((entry) => [entry.path, entry]));
    return selectedPaths
      .map((path) => byPath.get(path))
      .filter((entry): entry is WorkspaceEntryNode => Boolean(entry));
  }, [entries, selectedPaths]);
  const primaryEntry = selectedEntries.at(-1) ?? null;
  const openSet = useMemo(() => new Set(openDocumentPaths), [openDocumentPaths]);
  const dirtySet = useMemo(() => new Set(dirtyDocumentPaths), [dirtyDocumentPaths]);
  const extensionCounts = useMemo(
    () => collectWorkspaceFileExtensionCounts(fileEntries).slice(0, 14),
    [fileEntries],
  );

  const selectPaths = useCallback(
    (paths: string[]) => {
      selectionRef.current = paths;
      onSelectionChange(paths);
    },
    [onSelectionChange],
  );

  const navigateTo = useCallback(
    (relPath: string, push = true) => {
      const next = normalizeRelPath(relPath);
      if (next === currentFolder) return;
      if (push) {
        setBackStack((current) => [...current, currentFolder]);
        setForwardStack([]);
      }
      setCurrentFolder(next);
      setRenamingPath(null);
      selectPaths([]);
    },
    [currentFolder, selectPaths],
  );

  const navigateBack = () => {
    const target = backStack.at(-1);
    if (target === undefined) return;
    setBackStack((current) => current.slice(0, -1));
    setForwardStack((current) => [currentFolder, ...current]);
    setCurrentFolder(target);
    selectPaths([]);
  };

  const navigateForward = () => {
    const target = forwardStack[0];
    if (target === undefined) return;
    setForwardStack((current) => current.slice(1));
    setBackStack((current) => [...current, currentFolder]);
    setCurrentFolder(target);
    selectPaths([]);
  };

  const activateEntry = useCallback(
    (entry: WorkspaceEntryNode) => {
      if (isDirectoryNode(entry)) {
        navigateTo(entry.relPath);
        return;
      }
      const fileEntry = workspaceNodeToFileEntry(entry);
      if (!fileEntry || !workspacePath) return;
      if (/\.(md|markdown|html|htm)$/i.test(entry.name)) {
        onOpenDocument(fileEntry);
      } else {
        void binaryViewerOpenExternal(workspacePath, entry.path).catch((error) =>
          onError(error instanceof Error ? error.message : String(error)),
        );
      }
    },
    [navigateTo, onError, onOpenDocument, workspacePath],
  );

  const handleRowSelection = (
    entry: WorkspaceEntryNode,
    event: React.MouseEvent | React.KeyboardEvent,
  ) => {
    const visiblePaths = contents.map((item) => item.path);
    const current = selectionRef.current;
    let next: string[];
    if (event.shiftKey && rangeAnchorRef.current) {
      const start = visiblePaths.indexOf(rangeAnchorRef.current);
      const end = visiblePaths.indexOf(entry.path);
      if (start >= 0 && end >= 0) {
        const [from, to] = start < end ? [start, end] : [end, start];
        const range = visiblePaths.slice(from, to + 1);
        next = event.metaKey || event.ctrlKey
          ? Array.from(new Set([...current, ...range]))
          : range;
      } else {
        next = [entry.path];
      }
    } else if (event.metaKey || event.ctrlKey) {
      next = current.includes(entry.path)
        ? current.filter((path) => path !== entry.path)
        : [...current, entry.path];
      rangeAnchorRef.current = entry.path;
    } else {
      next = [entry.path];
      rangeAnchorRef.current = entry.path;
    }
    selectPaths(next);
  };

  const runMutation = useCallback(
    async (
      task: () => Promise<WorkspaceMutationOutcome[]>,
      effect: "refresh" | "move" | "trash" = "refresh",
    ) => {
      if (!workspacePath || busy) return;
      setBusy(true);
      try {
        const outcomes = await task();
        const failed = outcomes.filter((outcome) => outcome.status === "error");
        if (failed.length > 0) {
          onError(failed.map((outcome) => outcome.error || outcome.name).join("\n"));
        }
        onFilesystemMutated(outcomes, effect);
        selectPaths(
          outcomes
            .filter((outcome) => outcome.status === "done" && outcome.targetPath)
            .map((outcome) => outcome.targetPath as string),
        );
      } catch (error) {
        onError(error instanceof Error ? error.message : String(error));
      } finally {
        setBusy(false);
      }
    },
    [busy, onError, onFilesystemMutated, selectPaths, workspacePath],
  );

  const createFolder = async () => {
    const name = newFolderName.trim();
    if (!workspacePath || !name) return;
    setBusy(true);
    try {
      const parentPath = absoluteFolderPath(workspacePath, currentFolder);
      const outcome = await createWorkspaceDirectory(workspacePath, parentPath, name);
      onFilesystemMutated([outcome], "refresh");
      setCreatingFolder(false);
      setNewFolderName("");
      if (outcome.targetPath) selectPaths([outcome.targetPath]);
    } catch (error) {
      onError(error instanceof Error ? error.message : String(error));
    } finally {
      setBusy(false);
    }
  };

  const beginRename = () => {
    if (selectedEntries.length !== 1 || !canRenameMove) return;
    setRenamingPath(selectedEntries[0].path);
    setRenameValue(selectedEntries[0].name);
  };

  const commitRename = async () => {
    const source = renamingPath;
    const name = renameValue.trim();
    if (!workspacePath || !source || !name) return;
    setBusy(true);
    try {
      const outcome = await renameWorkspaceEntry(workspacePath, source, name);
      onFilesystemMutated([outcome], "move");
      setRenamingPath(null);
      if (outcome.targetPath) selectPaths([outcome.targetPath]);
    } catch (error) {
      onError(error instanceof Error ? error.message : String(error));
    } finally {
      setBusy(false);
    }
  };

  const setInternalClipboard = (operation: FileStoreOperation) => {
    if (!workspacePath || selectedPaths.length === 0) return;
    const next = { workspacePath, operation, paths: collapseNestedPaths(selectedPaths) };
    setClipboard(next);
    writeSessionJson(CLIPBOARD_KEY, next);
  };

  const pasteClipboard = () => {
    if (!workspacePath || clipboard?.workspacePath !== workspacePath) return;
    void runMutation(async () => {
      const outcomes = await pasteWorkspaceEntries(
        workspacePath,
        clipboard.paths,
        absoluteFolderPath(workspacePath, currentFolder),
        clipboard.operation,
      );
      if (clipboard.operation === "move" && outcomes.every((item) => item.status === "done")) {
        setClipboard(null);
        writeSessionJson(CLIPBOARD_KEY, null);
      }
      return outcomes;
    }, clipboard.operation === "move" ? "move" : "refresh");
  };

  const duplicateSelection = () => {
    if (!workspacePath || selectedPaths.length === 0 || !canCreate) return;
    void runMutation(() =>
      duplicateWorkspaceEntries(workspacePath, collapseNestedPaths(selectedPaths)),
    );
  };

  const trashSelection = () => {
    if (!workspacePath || selectedEntries.length === 0 || !canDelete) return;
    const dirty = selectedEntries.filter((entry) =>
      Array.from(dirtySet).some(
        (path) => path === entry.path || path.startsWith(`${entry.path}/`),
      ),
    );
    if (dirty.length > 0) {
      onError(t("files.operations.dirtyBlocked", { count: dirty.length }));
      return;
    }
    const risky =
      selectedEntries.length > 1 ||
      selectedEntries.some(
        (entry) =>
          isDirectoryNode(entry) ||
          Array.from(openSet).some(
            (path) => path === entry.path || path.startsWith(`${entry.path}/`),
          ),
      );
    if (
      risky &&
      !window.confirm(
        t("files.operations.trashConfirm", {
          count: selectedEntries.length,
          name: selectedEntries[0]?.name ?? "",
        }),
      )
    ) {
      return;
    }
    void runMutation(
      () =>
        trashWorkspaceEntries(
          workspacePath,
          collapseNestedPaths(selectedEntries.map((entry) => entry.path)),
        ),
      "trash",
    );
  };

  const handleKeyDown = (event: React.KeyboardEvent<HTMLDivElement>) => {
    const modifier = event.metaKey || event.ctrlKey;
    if (modifier && event.key.toLowerCase() === "a") {
      event.preventDefault();
      selectPaths(contents.map((entry) => entry.path));
      return;
    }
    if (modifier && event.key.toLowerCase() === "c") {
      event.preventDefault();
      setInternalClipboard("copy");
      return;
    }
    if (modifier && event.key.toLowerCase() === "x") {
      event.preventDefault();
      setInternalClipboard("move");
      return;
    }
    if (modifier && event.key.toLowerCase() === "v") {
      event.preventDefault();
      pasteClipboard();
      return;
    }
    if (modifier && event.key.toLowerCase() === "d") {
      event.preventDefault();
      duplicateSelection();
      return;
    }
    if (event.key === "F2") {
      event.preventDefault();
      beginRename();
      return;
    }
    if (
      event.key === "Delete" ||
      (event.key === "Backspace" && event.metaKey)
    ) {
      event.preventDefault();
      trashSelection();
      return;
    }
    if (event.key === "Enter" && primaryEntry && !renamingPath) {
      event.preventDefault();
      activateEntry(primaryEntry);
      return;
    }
    if (!["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key)) return;
    event.preventDefault();
    if (contents.length === 0) return;
    const currentIndex = primaryEntry
      ? contents.findIndex((entry) => entry.path === primaryEntry.path)
      : -1;
    const nextIndex =
      event.key === "Home"
        ? 0
        : event.key === "End"
          ? contents.length - 1
          : event.key === "ArrowDown"
            ? Math.min(contents.length - 1, currentIndex + 1)
            : Math.max(0, currentIndex <= 0 ? 0 : currentIndex - 1);
    const next = contents[nextIndex];
    if (next) selectPaths([next.path]);
  };

  useEffect(() => {
    if (!pendingRevealTargetPath || !workspacePath) return;
    const target = entries.find(
      (entry) =>
        entry.path === pendingRevealTargetPath || entry.relPath === pendingRevealTargetPath,
    );
    if (!target) return;
    const parent = isDirectoryNode(target) ? target.relPath : target.parentRelPath;
    setCurrentFolder(parent);
    selectPaths([target.path]);
    window.requestAnimationFrame(() => {
      listRef.current
        ?.querySelector<HTMLElement>(`[data-files-path="${CSS.escape(target.path)}"]`)
        ?.focus();
      onRevealHandled?.();
    });
  }, [
    entries,
    onRevealHandled,
    pendingRevealTargetPath,
    selectPaths,
    workspacePath,
  ]);

  const startResize = (
    side: "tree" | "preview",
    event: React.PointerEvent<HTMLDivElement>,
  ) => {
    event.preventDefault();
    const handle = event.currentTarget;
    const pointerId = event.pointerId;
    const startX = event.clientX;
    const startWidth = side === "tree" ? treeWidth : previewWidth;
    handle.setPointerCapture(pointerId);
    const onMove = (move: PointerEvent) => {
      if (move.pointerId !== pointerId) return;
      const delta = move.clientX - startX;
      const width =
        side === "tree"
          ? Math.min(420, Math.max(220, startWidth + delta))
          : Math.min(720, Math.max(320, startWidth - delta));
      onLayoutChange(
        side === "tree" ? { filesTreeWidth: width } : { filesPreviewWidth: width },
      );
    };
    const onEnd = (end: PointerEvent) => {
      if (end.pointerId !== pointerId) return;
      handle.removeEventListener("pointermove", onMove);
      handle.removeEventListener("pointerup", onEnd);
      handle.removeEventListener("pointercancel", onEnd);
      if (handle.hasPointerCapture(pointerId)) handle.releasePointerCapture(pointerId);
    };
    handle.addEventListener("pointermove", onMove);
    handle.addEventListener("pointerup", onEnd);
    handle.addEventListener("pointercancel", onEnd);
  };

  const workbenchStyle = {
    "--files-tree-width": treeOpen ? `${treeWidth}px` : "0px",
    "--files-preview-width": previewOpen ? `${previewWidth}px` : "0px",
  } as React.CSSProperties & Record<`--${string}`, string>;
  const metadataColumns = filesListAttributes.filter(
    (attribute): attribute is Exclude<FilesListAttribute, "parent"> =>
      attribute !== "parent",
  );
  const listColumnsStyle = {
    "--files-list-columns": `minmax(220px, 1fr) ${metadataColumns
      .map((attribute) =>
        attribute === "modified" ? "minmax(130px, 0.42fr)" : "minmax(78px, 0.24fr)",
      )
      .join(" ")}`,
  } as React.CSSProperties & Record<`--${string}`, string>;

  return (
    <main
      className={`files-workbench${treeOpen ? " tree-open" : ""}${
        previewOpen ? " preview-open" : ""
      }`}
      style={workbenchStyle}
    >
      {treeOpen ? (
        <aside className="files-tree-pane" aria-label={t("files.tree.title")}>
          <div className="files-workspace-tabs" role="tablist" aria-label={t("workspace.tabs.label")}>
            <button
              type="button"
              role="tab"
              aria-selected={workspaceVisibility === "private"}
              className={workspaceVisibility === "private" ? "active" : ""}
              onClick={() => onWorkspaceVisibilityChange("private")}
            >
              {t("workspace.visibility.private")}
            </button>
            {publicWorkspaceAvailable ? (
              <button
                type="button"
                role="tab"
                aria-selected={workspaceVisibility === "public"}
                className={workspaceVisibility === "public" ? "active" : ""}
                onClick={() => onWorkspaceVisibilityChange("public")}
              >
                {t("workspace.visibility.public")}
              </button>
            ) : (
              <button type="button" onClick={onAddPublicWorkspace}>
                {t("workspace.addPublic.short")}
              </button>
            )}
          </div>
          <FavoritesSection
            favorites={favorites}
            onOpen={onOpenFavorite}
            onRemove={onRemoveFavorite}
            isMissing={isFavoriteMissing}
          />
          <div className="files-tree-header">
            <span>{t("files.tree.title")}</span>
            <button
              type="button"
              onClick={() => onLayoutChange({ filesTreeOpen: false })}
              title={t("files.tree.hide")}
              aria-label={t("files.tree.hide")}
            >
              <PanelLeftClose size={14} />
            </button>
          </div>
          <div className="files-tree-scroll" role="tree" aria-label={t("files.tree.title")}>
            <DirectoryTreeRow
              node={tree}
              depth={0}
              currentFolder={currentFolder}
              collapsed={new Set(collapsedFolders)}
              onNavigate={navigateTo}
              onToggle={(relPath) =>
                onCollapsedFoldersChange(
                  collapsedFolders.includes(relPath)
                    ? collapsedFolders.filter((path) => path !== relPath)
                    : [...collapsedFolders, relPath],
                )
              }
              onDrop={(relPath, event) => {
                if (!workspacePath) return;
                const payload = parseDragPayload(
                  event.dataTransfer.getData("application/x-maru-files"),
                );
                if (!payload || payload.workspacePath !== workspacePath) return;
                const operation: FileStoreOperation = event.altKey ? "copy" : "move";
                if (
                  (operation === "copy" && !canCreate) ||
                  (operation === "move" && !canRenameMove)
                ) {
                  return;
                }
                void runMutation(
                  () =>
                    pasteWorkspaceEntries(
                      workspacePath,
                      payload.paths,
                      absoluteFolderPath(workspacePath, relPath),
                      operation,
                    ),
                  operation === "move" ? "move" : "refresh",
                );
              }}
            />
          </div>
        </aside>
      ) : null}

      {treeOpen ? (
        <div
          className="files-pane-resizer files-tree-resizer"
          role="separator"
          aria-orientation="vertical"
          aria-valuemin={220}
          aria-valuemax={420}
          aria-valuenow={treeWidth}
          tabIndex={0}
          onPointerDown={(event) => startResize("tree", event)}
        />
      ) : null}

      <section className="files-collection-pane">
        <header className="files-toolbar">
          <div className="files-nav-actions">
            {!treeOpen ? (
              <button
                type="button"
                onClick={() => onLayoutChange({ filesTreeOpen: true })}
                title={t("files.tree.show")}
                aria-label={t("files.tree.show")}
              >
                <PanelLeftOpen size={15} />
              </button>
            ) : null}
            <button type="button" disabled={backStack.length === 0} onClick={navigateBack}>
              <ArrowLeft size={15} />
            </button>
            <button type="button" disabled={forwardStack.length === 0} onClick={navigateForward}>
              <ArrowRight size={15} />
            </button>
            <button
              type="button"
              disabled={!currentFolder}
              onClick={() => navigateTo(parentFolderRelPath(currentFolder))}
            >
              <ArrowUp size={15} />
            </button>
          </div>
          <nav className="files-breadcrumbs" aria-label={t("files.breadcrumbs")}>
            {breadcrumbs.map((crumb, index) => (
              <span key={crumb.relPath || "__root__"}>
                {index > 0 ? <ChevronRight size={12} aria-hidden /> : null}
                <button type="button" onClick={() => navigateTo(crumb.relPath)}>
                  {crumb.label}
                </button>
              </span>
            ))}
          </nav>
          <div className="files-toolbar-actions">
            <button
              type="button"
              onClick={() => {
                setCreatingFolder(true);
                setNewFolderName("");
              }}
              disabled={!workspacePath || !canCreate || busy}
              title={t("files.operations.newFolder")}
            >
              <FolderPlus size={15} />
            </button>
            <button
              type="button"
              className={filtersOpen ? "active" : ""}
              onClick={() => setFiltersOpen((value) => !value)}
              title={t("rightPane.files.filters.title")}
            >
              <ListFilter size={15} />
            </button>
            <button type="button" onClick={onRefresh} disabled={refreshing}>
              <RefreshCcw size={15} className={refreshing ? "spin" : ""} />
            </button>
            {!previewOpen ? (
              <button
                type="button"
                onClick={() => onLayoutChange({ filesPreviewOpen: true })}
                title={t("files.preview.show")}
              >
                <PanelRightOpen size={15} />
              </button>
            ) : null}
          </div>
        </header>

        <div className="files-search-row">
          <label>
            <Search size={14} />
            <input
              value={query}
              onChange={(event) => onQueryChange(event.target.value)}
              placeholder={t("files.searchPlaceholder")}
            />
          </label>
          <select
            aria-label={t("files.filter.label")}
            value={filter}
            onChange={(event) => onFilterChange(event.target.value as WorkspaceFileFilter)}
          >
            <option value="all">{t("files.filter.all")}</option>
            <option value="tracked">{t("files.filter.tracked")}</option>
            <option value="binary">{t("files.filter.binary")}</option>
          </select>
          <select
            aria-label={t("files.sort.label")}
            value={sortKey}
            onChange={(event) => onSortKeyChange(event.target.value as FilesSortKey)}
          >
            <option value="name">{t("files.sort.name")}</option>
            <option value="modifiedDesc">{t("files.sort.modifiedDesc")}</option>
            <option value="modifiedAsc">{t("files.sort.modifiedAsc")}</option>
          </select>
        </div>

        {filtersOpen ? (
          <FilesFilters
            filters={effectivePaneFilters}
            extensionCounts={extensionCounts}
            queueCount={queuedSourcePaths.length}
            attributes={filesListAttributes}
            onChange={(next) =>
              onPaneFiltersChange({ ...next, queuedPaths: paneFilters.queuedPaths })
            }
            onAttributesChange={onFilesListAttributesChange}
          />
        ) : null}

        <div className="files-action-strip" role="toolbar" aria-label={t("files.operations.actions")}>
          <button
            type="button"
            onClick={beginRename}
            disabled={selectedEntries.length !== 1 || !canRenameMove || busy}
          >
            <FileText size={13} />
            {t("files.operations.rename")}
          </button>
          <button
            type="button"
            onClick={duplicateSelection}
            disabled={selectedEntries.length === 0 || !canCreate || busy}
          >
            <Copy size={13} />
            {t("files.operations.duplicate")}
          </button>
          <button
            type="button"
            onClick={() => setInternalClipboard("move")}
            disabled={selectedEntries.length === 0 || !canRenameMove}
          >
            <Scissors size={13} />
            {t("files.operations.cut")}
          </button>
          <button
            type="button"
            onClick={() => setInternalClipboard("copy")}
            disabled={selectedEntries.length === 0}
          >
            <Clipboard size={13} />
            {t("files.operations.copy")}
          </button>
          <button
            type="button"
            onClick={pasteClipboard}
            disabled={
              !workspacePath ||
              clipboard?.workspacePath !== workspacePath ||
              clipboard.paths.length === 0 ||
              (clipboard.operation === "copy" ? !canCreate : !canRenameMove) ||
              busy
            }
          >
            <FilePlus2 size={13} />
            {t("files.operations.paste")}
          </button>
          <button
            type="button"
            onClick={() => onQueuePaths(selectedPaths)}
            disabled={selectedPaths.length === 0}
          >
            <MoreHorizontal size={13} />
            {t("files.queueSelected")}
          </button>
          <span />
          <button
            type="button"
            className="danger"
            onClick={trashSelection}
            disabled={selectedEntries.length === 0 || !canDelete || busy}
          >
            <Trash2 size={13} />
            {t("files.operations.trash")}
          </button>
        </div>

        <div className="files-list-header" style={listColumnsStyle} aria-hidden>
          <span>{t("files.columns.name")}</span>
          {metadataColumns.map((attribute) => (
            <span key={attribute}>{t(`files.attributes.${attribute}`)}</span>
          ))}
        </div>

        <div
          className="files-list"
          ref={listRef}
          role="grid"
          aria-label={t("files.contents")}
          aria-multiselectable="true"
          tabIndex={0}
          onKeyDown={handleKeyDown}
          onClick={() => setContextMenu(null)}
        >
          {creatingFolder ? (
            <div className="files-list-row files-inline-edit" role="row">
              <Folder size={17} />
              <input
                autoFocus
                value={newFolderName}
                placeholder={t("files.operations.newFolderPlaceholder")}
                onChange={(event) => setNewFolderName(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === "Enter") void createFolder();
                  if (event.key === "Escape") setCreatingFolder(false);
                }}
                onBlur={() => {
                  if (!newFolderName.trim()) setCreatingFolder(false);
                }}
              />
            </div>
          ) : null}
          {loading && entries.length === 0 ? (
            <FilesListSkeleton label={t("files.loading")} />
          ) : contents.length === 0 ? (
            <div className="files-empty-state">
              <FolderOpen size={28} />
              <strong>{t("files.empty.title")}</strong>
              <span>{t("files.empty.description")}</span>
            </div>
          ) : (
            contents.map((entry) => {
              const selected = selectedPaths.includes(entry.path);
              const directory = isDirectoryNode(entry);
              const queued = queuedSourcePaths.includes(entry.path);
              return (
                <div
                  key={entry.path}
                  className={`files-list-row${selected ? " selected" : ""}${
                    entry.kind === "symlink" ? " symlink" : ""
                  }`}
                  style={listColumnsStyle}
                  role="row"
                  aria-selected={selected}
                  data-files-path={entry.path}
                  tabIndex={selected ? 0 : -1}
                  draggable={canCreate || canRenameMove}
                  onClick={(event) => handleRowSelection(entry, event)}
                  onDoubleClick={() => activateEntry(entry)}
                  onContextMenu={(event) => {
                    event.preventDefault();
                    if (!selectionRef.current.includes(entry.path)) selectPaths([entry.path]);
                    setContextMenu({ x: event.clientX, y: event.clientY, path: entry.path });
                  }}
                  onDragStart={(event) => {
                    const paths = selectionRef.current.includes(entry.path)
                      ? selectionRef.current
                      : [entry.path];
                    const dragPaths = collapseNestedPaths(paths);
                    selectionRef.current = dragPaths;
                    onSelectionChange(dragPaths);
                    event.dataTransfer.effectAllowed = "copyMove";
                    event.dataTransfer.setData(
                      "application/x-maru-files",
                      JSON.stringify({ workspacePath, paths: dragPaths }),
                    );
                  }}
                  onDragOver={(event) => {
                    if (!directory) return;
                    event.preventDefault();
                    event.dataTransfer.dropEffect = event.altKey ? "copy" : "move";
                  }}
                  onDrop={(event) => {
                    if (!directory || !workspacePath) return;
                    event.preventDefault();
                    const payload = parseDragPayload(
                      event.dataTransfer.getData("application/x-maru-files"),
                    );
                    if (!payload || payload.workspacePath !== workspacePath) return;
                    const operation: FileStoreOperation = event.altKey ? "copy" : "move";
                    if (
                      (operation === "copy" && !canCreate) ||
                      (operation === "move" && !canRenameMove)
                    ) {
                      return;
                    }
                    void runMutation(
                      () =>
                        pasteWorkspaceEntries(
                          workspacePath,
                          payload.paths,
                          entry.path,
                          operation,
                        ),
                      operation === "move" ? "move" : "refresh",
                    );
                  }}
                >
                  <span className="files-name-cell" role="gridcell">
                    {directory ? <Folder size={17} /> : <File size={17} />}
                    {renamingPath === entry.path ? (
                      <input
                        autoFocus
                        value={renameValue}
                        onChange={(event) => setRenameValue(event.target.value)}
                        onClick={(event) => event.stopPropagation()}
                        onKeyDown={(event) => {
                          event.stopPropagation();
                          if (event.key === "Enter") void commitRename();
                          if (event.key === "Escape") setRenamingPath(null);
                        }}
                        onBlur={() => setRenamingPath(null)}
                      />
                    ) : (
                      <span>
                        <strong>{entry.name}</strong>
                        {query || filesListAttributes.includes("parent") ? (
                          <small>{entry.parentRelPath || rootLabel}</small>
                        ) : null}
                      </span>
                    )}
                    {entry.kind === "symlink" ? (
                      <span className="files-badge">{t("files.symlink")}</span>
                    ) : null}
                    {queued ? <span className="files-badge">{t("files.row.queued")}</span> : null}
                  </span>
                  {metadataColumns.map((attribute) => {
                    let value: string;
                    if (attribute === "kind") {
                      value = directory ? t("files.kind.folder") : entry.fileKind;
                    } else if (attribute === "modified") {
                      value = entry.updatedAt
                        ? new Date(entry.updatedAt).toLocaleString(locale)
                        : "-";
                    } else if (attribute === "size") {
                      value = directory ? "-" : formatBytes(entry.sizeBytes);
                    } else if (attribute === "git") {
                      value = entry.gitTracked ? t("files.filter.tracked") : "-";
                    } else {
                      value = entry.binary ? t("files.filter.binary") : "-";
                    }
                    return (
                      <span key={attribute} role="gridcell">
                        {value}
                      </span>
                    );
                  })}
                </div>
              );
            })
          )}
        </div>
        <footer className="files-statusbar">
          <span>
            {t("files.status.items", {
              count: contents.length,
              selected: selectedEntries.length,
            })}
          </span>
          {clipboard?.workspacePath === workspacePath ? (
            <span>
              {t(
                clipboard.operation === "move"
                  ? "files.operations.cutReady"
                  : "files.operations.copyReady",
                { count: clipboard.paths.length },
              )}
            </span>
          ) : null}
        </footer>
      </section>

      {previewOpen ? (
        <div
          className="files-pane-resizer files-preview-resizer"
          role="separator"
          aria-orientation="vertical"
          aria-valuemin={320}
          aria-valuemax={720}
          aria-valuenow={previewWidth}
          tabIndex={0}
          onPointerDown={(event) => startResize("preview", event)}
        />
      ) : null}

      {previewOpen ? (
        <aside className="files-preview-pane" aria-label={t("files.preview.title")}>
          <header>
            <span>{t("files.preview.title")}</span>
            <button
              type="button"
              onClick={() => onLayoutChange({ filesPreviewOpen: false })}
              title={t("files.preview.hide")}
              aria-label={t("files.preview.hide")}
            >
              <PanelRightClose size={14} />
            </button>
          </header>
          <FilesPreview
            workspacePath={workspacePath}
            entries={entries}
            selectedEntries={selectedEntries}
            onReveal={onRevealInFinder}
            onError={onError}
          />
        </aside>
      ) : null}

      {contextMenu ? (
        <div
          className="files-context-menu"
          role="menu"
          style={{ left: contextMenu.x, top: contextMenu.y }}
        >
          <button type="button" role="menuitem" onClick={() => primaryEntry && activateEntry(primaryEntry)}>
            <ExternalLink size={13} />
            {t("files.operations.open")}
          </button>
          <button type="button" role="menuitem" onClick={beginRename} disabled={!canRenameMove}>
            <FileText size={13} />
            {t("files.operations.rename")}
          </button>
          <button type="button" role="menuitem" onClick={duplicateSelection} disabled={!canCreate}>
            <Copy size={13} />
            {t("files.operations.duplicate")}
          </button>
          <button
            type="button"
            role="menuitem"
            onClick={() => setInternalClipboard("move")}
            disabled={!canRenameMove}
          >
            <Scissors size={13} />
            {t("files.operations.cut")}
          </button>
          <button type="button" role="menuitem" onClick={() => setInternalClipboard("copy")}>
            <Clipboard size={13} />
            {t("files.operations.copy")}
          </button>
          <button
            type="button"
            role="menuitem"
            onClick={() => primaryEntry && onRevealInFinder(primaryEntry.path)}
          >
            <FolderOpen size={13} />
            {t("binaryViewer.revealInFinder")}
          </button>
          {primaryEntry ? (
            <button
              type="button"
              role="menuitem"
              onClick={() =>
                onToggleFavorite({
                  kind: isDirectoryNode(primaryEntry) ? "directory" : "file",
                  relPath: primaryEntry.relPath,
                  label: primaryEntry.name,
                })
              }
            >
              <Star size={13} />
              {isFavorite(
                isDirectoryNode(primaryEntry) ? "directory" : "file",
                primaryEntry.relPath,
              )
                ? t("favorites.remove")
                : t("favorites.add")}
            </button>
          ) : null}
          {primaryEntry && onApplySkillToTarget ? (
            <button
              type="button"
              role="menuitem"
              onClick={() =>
                onApplySkillToTarget(
                  primaryEntry.path,
                  isDirectoryNode(primaryEntry) ? "directory" : "file",
                )
              }
            >
              <MoreHorizontal size={13} />
              {t("files.context.applySkill")}
            </button>
          ) : null}
          {primaryEntry && onAttachToTerminal ? (
            <button
              type="button"
              role="menuitem"
              onClick={() => onAttachToTerminal(primaryEntry.relPath, primaryEntry.path)}
            >
              <MoreHorizontal size={13} />
              {t("files.context.attachTerminal")}
            </button>
          ) : null}
          <button
            type="button"
            role="menuitem"
            className="danger"
            onClick={trashSelection}
            disabled={!canDelete}
          >
            <Trash2 size={13} />
            {t("files.operations.trash")}
          </button>
        </div>
      ) : null}
    </main>
  );
}

function DirectoryTreeRow({
  node,
  depth,
  currentFolder,
  collapsed,
  onNavigate,
  onToggle,
  onDrop,
}: {
  node: FilesDirectoryTreeNode;
  depth: number;
  currentFolder: string;
  collapsed: Set<string>;
  onNavigate: (relPath: string) => void;
  onToggle: (relPath: string) => void;
  onDrop: (relPath: string, event: React.DragEvent<HTMLDivElement>) => void;
}) {
  const isCollapsed = node.relPath ? collapsed.has(node.relPath) : false;
  const hasChildren = node.children.length > 0;
  return (
    <div role="none">
      <div
        className={`files-tree-row${currentFolder === node.relPath ? " selected" : ""}`}
        role="treeitem"
        aria-level={depth + 1}
        aria-selected={currentFolder === node.relPath}
        aria-expanded={hasChildren ? !isCollapsed : undefined}
        style={{ paddingLeft: `${8 + depth * 14}px` }}
        onDragOver={(event) => {
          if (!event.dataTransfer.types.includes("application/x-maru-files")) return;
          event.preventDefault();
          event.dataTransfer.dropEffect = event.altKey ? "copy" : "move";
        }}
        onDrop={(event) => {
          event.preventDefault();
          onDrop(node.relPath, event);
        }}
      >
        <button
          type="button"
          className="files-tree-chevron"
          disabled={!hasChildren}
          onClick={() => onToggle(node.relPath)}
          tabIndex={-1}
        >
          {hasChildren ? (
            isCollapsed ? <ChevronRight size={12} /> : <ChevronDown size={12} />
          ) : (
            <span />
          )}
        </button>
        <button type="button" className="files-tree-target" onClick={() => onNavigate(node.relPath)}>
          <Folder size={14} />
          <span>{node.name}</span>
        </button>
      </div>
      {!isCollapsed && hasChildren ? (
        <div role="group">
          {node.children.map((child) => (
            <DirectoryTreeRow
              key={child.relPath}
              node={child}
              depth={depth + 1}
              currentFolder={currentFolder}
              collapsed={collapsed}
              onNavigate={onNavigate}
              onToggle={onToggle}
              onDrop={onDrop}
            />
          ))}
        </div>
      ) : null}
    </div>
  );
}

function FilesPreview({
  workspacePath,
  entries,
  selectedEntries,
  onReveal,
  onError,
}: {
  workspacePath: string | null;
  entries: WorkspaceEntryNode[];
  selectedEntries: WorkspaceEntryNode[];
  onReveal: (path: string) => void;
  onError: (message: string) => void;
}) {
  const { t } = useTranslation();
  const [preview, setPreview] = useState<
    | { status: "idle" | "loading" | "error"; message?: string }
    | {
        status: "document";
        kind: "markdown" | "html";
        content: string;
        entry: WorkspaceEntryNode;
      }
    | {
        status: "binary";
        entry: WorkspaceFileEntry;
        classification: BinaryViewerClassification;
      }
  >({ status: "idle" });
  const requestRef = useRef(0);
  const primary = selectedEntries.at(-1) ?? null;

  useEffect(() => {
    const request = ++requestRef.current;
    if (!workspacePath || selectedEntries.length !== 1 || !primary || isDirectoryNode(primary)) {
      setPreview({ status: "idle" });
      return;
    }
    const fileEntry = workspaceNodeToFileEntry(primary);
    if (!fileEntry) {
      setPreview({ status: "error", message: t("files.preview.unavailable") });
      return;
    }
    setPreview({ status: "loading" });
    void (async () => {
      try {
        if (/\.(md|markdown|html|htm)$/i.test(primary.name)) {
          const document = await readDocument(workspacePath, primary.path);
          if (request !== requestRef.current) return;
          setPreview({
            status: "document",
            kind: /\.(html|htm)$/i.test(primary.name) ? "html" : "markdown",
            content: document.content,
            entry: primary,
          });
          return;
        }
        const classification = await binaryViewerClassify(workspacePath, primary.path);
        const assetPath = usesAssetProtocol(classification.category)
          ? await binaryViewerPrepareAsset(workspacePath, primary.path)
          : primary.path;
        if (request !== requestRef.current) return;
        setPreview({
          status: "binary",
          entry: {
            ...fileEntry,
            path: assetPath,
            extension: classification.extension ?? fileEntry.extension,
            fileKind: classification.extension ?? fileEntry.fileKind,
            sizeBytes: classification.sizeBytes || fileEntry.sizeBytes,
          },
          classification,
        });
      } catch (error) {
        if (request !== requestRef.current) return;
        setPreview({
          status: "error",
          message: error instanceof Error ? error.message : String(error),
        });
      }
    })();
  }, [primary, selectedEntries.length, t, workspacePath]);

  if (selectedEntries.length === 0) {
    return (
      <div className="files-preview-empty">
        <File size={30} />
        <strong>{t("files.preview.emptyTitle")}</strong>
        <span>{t("files.preview.emptyDescription")}</span>
      </div>
    );
  }
  if (selectedEntries.length > 1) {
    const fileCount = selectedEntries.filter(isFileNode).length;
    const folderCount = selectedEntries.filter(isDirectoryNode).length;
    const totalSize = selectedEntries.reduce((sum, entry) => sum + entry.sizeBytes, 0);
    return (
      <div className="files-preview-summary">
        <strong>{t("files.preview.selected", { count: selectedEntries.length })}</strong>
        <dl>
          <dt>{t("files.preview.files")}</dt>
          <dd>{fileCount}</dd>
          <dt>{t("files.preview.folders")}</dt>
          <dd>{folderCount}</dd>
          <dt>{t("binaryViewer.size")}</dt>
          <dd>{formatBytes(totalSize)}</dd>
        </dl>
      </div>
    );
  }
  if (primary && isDirectoryNode(primary)) {
    const prefix = `${primary.relPath}/`;
    const descendants = entries.filter((entry) => entry.relPath.startsWith(prefix));
    return (
      <div className="files-preview-summary">
        <Folder size={34} />
        <strong>{primary.name}</strong>
        <small>{primary.relPath}</small>
        <dl>
          <dt>{t("files.preview.items")}</dt>
          <dd>{descendants.length}</dd>
          <dt>{t("binaryViewer.modified")}</dt>
          <dd>{primary.updatedAt ? new Date(primary.updatedAt).toLocaleString() : "-"}</dd>
        </dl>
        <button type="button" onClick={() => onReveal(primary.path)}>
          <FolderOpen size={14} />
          {t("binaryViewer.revealInFinder")}
        </button>
      </div>
    );
  }
  if (preview.status === "loading") {
    return <FilesPreviewSkeleton label={t("binaryViewer.loading")} />;
  }
  if (preview.status === "error") {
    return (
      <div className="files-preview-error" role="status">
        <strong>{t("binaryViewer.loadError", { message: preview.message || "" })}</strong>
        {primary ? (
          <button type="button" onClick={() => onReveal(primary.path)}>
            <FolderOpen size={14} />
            {t("binaryViewer.revealInFinder")}
          </button>
        ) : null}
      </div>
    );
  }
  if (preview.status === "document") {
    return (
      <div className="files-document-preview">
        <header>
          <div>
            <strong>{preview.entry.name}</strong>
            <small>{preview.entry.relPath}</small>
          </div>
          <button type="button" onClick={() => onReveal(preview.entry.path)}>
            <FolderOpen size={14} />
          </button>
        </header>
        {preview.kind === "html" && workspacePath ? (
          <HtmlPreviewFrame
            value={preview.content}
            vaultPath={workspacePath}
            documentPath={preview.entry.path}
            title={preview.entry.name}
          />
        ) : (
          <article
            className="preview-surface"
            dangerouslySetInnerHTML={{ __html: renderMarkdown(preview.content) }}
          />
        )}
      </div>
    );
  }
  if (preview.status === "binary" && workspacePath) {
    return (
      <BinaryViewerPane
        entry={preview.entry}
        workspacePath={workspacePath}
        classification={preview.classification}
        onError={onError}
      />
    );
  }
  return null;
}

function FilesFilters({
  filters,
  extensionCounts,
  queueCount,
  attributes,
  onChange,
  onAttributesChange,
}: {
  filters: WorkspaceFilesPaneFilters;
  extensionCounts: { extension: string; count: number }[];
  queueCount: number;
  attributes: FilesListAttribute[];
  onChange: (filters: WorkspaceFilesPaneFilters) => void;
  onAttributesChange: (attributes: FilesListAttribute[]) => void;
}) {
  const { t } = useTranslation();
  const selectedExtensions = new Set(filters.extensions);
  const toggleAttribute = (attribute: FilesListAttribute) => {
    onAttributesChange(
      attributes.includes(attribute)
        ? attributes.filter((item) => item !== attribute)
        : [...attributes, attribute],
    );
  };
  return (
    <section className="files-filter-drawer">
      <div>
        <span>{t("rightPane.files.filters.extensions")}</span>
        <div className="files-filter-chips">
          {extensionCounts.map(({ extension, count }) => (
            <button
              type="button"
              key={extension}
              className={selectedExtensions.has(extension) ? "active" : ""}
              onClick={() =>
                onChange({
                  ...filters,
                  extensions: selectedExtensions.has(extension)
                    ? filters.extensions.filter((item) => item !== extension)
                    : [...filters.extensions, extension],
                })
              }
            >
              {extension} <small>{count}</small>
            </button>
          ))}
        </div>
      </div>
      <label>
        <span>{t("rightPane.files.filters.modified")}</span>
        <select
          value={filters.modifiedWithinDays ?? ""}
          onChange={(event) =>
            onChange({
              ...filters,
              modifiedWithinDays: event.target.value ? Number(event.target.value) : null,
            })
          }
        >
          <option value="">{t("rightPane.files.filters.modifiedAll")}</option>
          <option value="1">{t("rightPane.files.filters.modified1")}</option>
          <option value="7">{t("rightPane.files.filters.modified7")}</option>
          <option value="30">{t("rightPane.files.filters.modified30")}</option>
          <option value="90">{t("rightPane.files.filters.modified90")}</option>
        </select>
      </label>
      <label>
        <span>{t("rightPane.files.filters.size")}</span>
        <select
          value={filters.sizeBucket ?? ""}
          onChange={(event) =>
            onChange({
              ...filters,
              sizeBucket:
                (event.target.value as WorkspaceFilesPaneFilters["sizeBucket"]) || null,
            })
          }
        >
          <option value="">{t("rightPane.files.filters.sizeAll")}</option>
          <option value="lt10k">{t("rightPane.files.filters.sizeLt10k")}</option>
          <option value="lt1m">{t("rightPane.files.filters.sizeLt1m")}</option>
          <option value="lt10m">{t("rightPane.files.filters.sizeLt10m")}</option>
          <option value="gte10m">{t("rightPane.files.filters.sizeGte10m")}</option>
        </select>
      </label>
      <label className="files-filter-checkbox">
        <input
          type="checkbox"
          checked={filters.queuedOnly}
          disabled={queueCount === 0 && !filters.queuedOnly}
          onChange={(event) => onChange({ ...filters, queuedOnly: event.target.checked })}
        />
        {t("rightPane.files.filters.queuedOnly", { count: queueCount })}
      </label>
      <div>
        <span>{t("files.attributes.label")}</span>
        <div className="files-filter-chips">
          {(["parent", "kind", "modified", "size", "git", "binary"] as const).map(
            (attribute) => (
              <button
                type="button"
                key={attribute}
                className={attributes.includes(attribute) ? "active" : ""}
                onClick={() => toggleAttribute(attribute)}
              >
                {t(`files.attributes.${attribute}`)}
              </button>
            ),
          )}
        </div>
      </div>
      {hasActiveWorkspaceFilesPaneFilters(filters) ? (
        <button
          type="button"
          className="files-filter-clear"
          onClick={() =>
            onChange({
              extensions: [],
              modifiedWithinDays: null,
              sizeBucket: null,
              queuedOnly: false,
              queuedPaths: filters.queuedPaths,
            })
          }
        >
          {t("rightPane.files.filters.clear")}
        </button>
      ) : null}
    </section>
  );
}

function FilesListSkeleton({ label }: { label: string }) {
  return (
    <div className="files-skeleton" aria-label={label} role="status">
      {Array.from({ length: 7 }, (_, index) => (
        <span key={index} style={{ width: `${66 + (index % 3) * 9}%` }} />
      ))}
    </div>
  );
}

function FilesPreviewSkeleton({ label }: { label: string }) {
  return (
    <div className="files-preview-skeleton" role="status" aria-label={label}>
      <span />
      <span />
      <span />
    </div>
  );
}

function absoluteFolderPath(workspacePath: string, relPath: string): string {
  const normalized = normalizeRelPath(relPath);
  return normalized ? `${workspacePath.replace(/\/$/, "")}/${normalized}` : workspacePath;
}

function readSessionJson<T>(key: string): T | null {
  if (typeof window === "undefined") return null;
  try {
    const value = window.sessionStorage.getItem(key);
    return value ? (JSON.parse(value) as T) : null;
  } catch {
    return null;
  }
}

function writeSessionJson(key: string, value: unknown) {
  if (typeof window === "undefined") return;
  try {
    if (value === null) window.sessionStorage.removeItem(key);
    else window.sessionStorage.setItem(key, JSON.stringify(value));
  } catch {
    // Session persistence is best-effort.
  }
}

function parseDragPayload(
  value: string,
): { workspacePath: string; paths: string[] } | null {
  try {
    const parsed = JSON.parse(value) as { workspacePath?: unknown; paths?: unknown };
    if (
      typeof parsed.workspacePath !== "string" ||
      !Array.isArray(parsed.paths) ||
      !parsed.paths.every((path) => typeof path === "string")
    ) {
      return null;
    }
    return { workspacePath: parsed.workspacePath, paths: parsed.paths };
  } catch {
    return null;
  }
}
