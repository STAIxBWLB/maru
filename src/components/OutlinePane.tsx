import {
  BookOpen,
  CircleX,
  ClipboardCheck,
  Copy,
  File,
  FileArchive,
  FileAudio,
  FileCode2,
  FileImage,
  FolderPlus,
  Grid2X2,
  FilePlus2,
  FileSpreadsheet,
  FileText,
  FileType,
  FileVideo,
  Files,
  Folder,
  Hash,
  Info,
  Layers,
  List,
  MoveRight,
  Plus,
  Presentation,
  Save,
  Send,
  StickyNote,
  Trash2,
  X,
} from "lucide-react";
import type React from "react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  chooseDirectories,
  chooseFiles,
  chooseSaveFile,
  chooseWorkspaceDirectory,
  deleteMemo,
  listMemos,
  readMemo,
  saveMemo,
  saveMemoAs,
} from "../lib/api";
import { frontmatterScalar } from "../lib/document";
import {
  clearExplorerDragPayload,
  clearFileQueueDragPayload,
  dropOperationFromEvent,
  hasExplorerDragPayload,
  readExplorerDragPayload,
  type ExplorerDragPayload,
  writeFileQueueDragPayload,
} from "../lib/fileDrag";
import { extractOutline } from "../lib/markdown";
import { useTranslation } from "../lib/i18n";
import { useContextMenuKeyboard } from "../lib/useContextMenuKeyboard";
import type {
  AnchorAppMode,
  DocumentViewDefinition,
  ExplorerPaneMode,
  RightPaneTab,
} from "../lib/settings";
import type { BuiltInDocumentView, DocumentFilter } from "../lib/documentIndex";
import type {
  DocumentPayload,
  FileQueueItem,
  FileQueueSourceInfo,
  MemoEntry,
  MemoFormat,
  VaultEntry,
  WorkspaceFileEntry,
} from "../lib/types";
import {
  collectWorkspaceFileExtensionCounts,
  type WorkspaceFilesPaneFilters,
} from "../lib/workspaceFileTree";
import { NeighborhoodPane } from "./NeighborhoodPane";
import { SharedOutboxPane } from "./SharedOutboxPane";
import { Sidebar } from "./Sidebar";

interface OutlinePaneProps {
  document: DocumentPayload | null;
  draftContent: string;
  entries: VaultEntry[];
  readOnly: boolean;
  workspacePath: string | null;
  /** Editor line currently scrolled to the top (source mode); highlights the
   *  matching outline heading. Null when tracking is inactive. */
  activeLine?: number | null;
  onJumpToLine: (line: number) => void;
  onClose: () => void;
  onError: (message: string | null) => void;
  onRefreshWorkspace: () => void;
  onUpdateField: (
    key: string,
    value: string | string[] | number | boolean | null,
  ) => Promise<void>;
  onSelectEntry: (entry: VaultEntry) => void;
  onMissingWikilink?: (target: string) => void;
  onOpenGraph?: (focusNodeId?: string) => void;
  /** Managed vault note — swaps the free-form type input for the schema form
   *  (description 카운터·type/domain select·topics 칩, spec §3 F1). */
  isManagedVaultNote?: boolean;
  fileQueue: FileQueueItem[];
  canApplyFileQueue: boolean;
  onUpdateFileQueueItem: (
    id: string,
    patch: Partial<Pick<FileQueueItem, "targetDir" | "operation">>,
  ) => void;
  selectedFileQueueItemIds: string[];
  onSelectFileQueueItem: (id: string, additive: boolean) => void;
  onQueueExternalFiles: (paths: string[]) => Promise<void>;
  onQueueFileSources: (sources: FileQueueSourceInfo[], targetDir: string) => void;
  onApplyFileQueue: () => Promise<unknown>;
  onClearFileQueue: () => void;
  onClearSelectedFileQueueItems: () => void;
  workspaceFileEntries: WorkspaceFileEntry[];
  selectedWorkspaceFileEntries: WorkspaceFileEntry[];
  filesPaneFilters: WorkspaceFilesPaneFilters;
  onFilesPaneFiltersChange: (filters: WorkspaceFilesPaneFilters) => void;
  explorerPaneMode: ExplorerPaneMode;
  onRevealFileInFinder: (targetPath: string) => void;
  activeTab: RightPaneTab;
  onTabChange: (tab: RightPaneTab) => void;
  paneRef?: React.RefObject<HTMLElement | null>;
  skillsNode?: React.ReactNode;
  guidelineNode?: React.ReactNode;
  evidenceNode?: React.ReactNode;
  /** Workspace root for share-outbox commands (PKM doc workspace or inbox). */
  shareWorkspacePath: string | null;
  /** Whether the active document has unsaved edits (drives "save first"). */
  shareDocumentDirty: boolean;
  /** Shareable absolute file paths reported by the Inbox selection. */
  inboxShareablePaths: string[];
  appMode: AnchorAppMode;
  contentCount: number;
  typeCounts: Array<[string, number]>;
  documentViews: DocumentViewDefinition[];
  viewCounts: Record<BuiltInDocumentView, number>;
  customViewCounts: Record<string, number>;
  recentEntries: VaultEntry[];
  selectedPath: string | null;
  documentFilter: DocumentFilter;
  onDocumentFilter: (filter: DocumentFilter) => void;
  onDocumentViewsChange: (views: DocumentViewDefinition[]) => void;
  onNewDocument: (docType?: string) => void;
  canCreateDocument: boolean;
  onSelectRecent: (entry: VaultEntry) => void;
  onOpenCommandPalette: () => void;
}

const STANDARD_TYPES = [
  "meeting",
  "project",
  "reference",
  "task",
  "person",
  "inbox",
  "document",
];
const STANDARD_STATUSES = [
  "active",
  "draft",
  "review",
  "done",
  "archived",
  "진행중",
  "검토",
  "완료",
];

const MARKDOWN_EXTENSIONS = new Set(["md", "markdown", "mdx"]);
const TEXT_EXTENSIONS = new Set(["txt", "text", "rtf", "csv", "tsv", "log"]);
const CODE_EXTENSIONS = new Set([
  "c",
  "cpp",
  "cs",
  "css",
  "go",
  "html",
  "java",
  "js",
  "json",
  "jsx",
  "kt",
  "lua",
  "php",
  "py",
  "rb",
  "rs",
  "scss",
  "sh",
  "swift",
  "toml",
  "ts",
  "tsx",
  "vue",
  "xml",
  "yaml",
  "yml",
]);
const IMAGE_EXTENSIONS = new Set(["avif", "gif", "heic", "jpeg", "jpg", "png", "svg", "webp"]);
const ARCHIVE_EXTENSIONS = new Set(["7z", "bz2", "dmg", "gz", "pkg", "rar", "tar", "tgz", "xz", "zip"]);
const SPREADSHEET_EXTENSIONS = new Set(["numbers", "ods", "tsv", "xls", "xlsm", "xlsx"]);
const PRESENTATION_EXTENSIONS = new Set(["key", "odp", "ppt", "pptx"]);
const AUDIO_EXTENSIONS = new Set(["aac", "aiff", "flac", "m4a", "mp3", "ogg", "wav"]);
const VIDEO_EXTENSIONS = new Set(["avi", "m4v", "mkv", "mov", "mp4", "webm", "wmv"]);

export function OutlinePane({
  document,
  draftContent,
  entries,
  readOnly,
  workspacePath,
  activeLine = null,
  onJumpToLine,
  onClose,
  onError,
  onRefreshWorkspace,
  onUpdateField,
  onSelectEntry,
  onMissingWikilink,
  onOpenGraph,
  isManagedVaultNote,
  fileQueue,
  canApplyFileQueue,
  onUpdateFileQueueItem,
  selectedFileQueueItemIds,
  onSelectFileQueueItem,
  onQueueExternalFiles,
  onQueueFileSources,
  onApplyFileQueue,
  onClearFileQueue,
  onClearSelectedFileQueueItems,
  workspaceFileEntries,
  selectedWorkspaceFileEntries,
  filesPaneFilters,
  onFilesPaneFiltersChange,
  explorerPaneMode,
  onRevealFileInFinder,
  activeTab,
  onTabChange,
  paneRef,
  skillsNode,
  guidelineNode,
  evidenceNode,
  shareWorkspacePath,
  shareDocumentDirty,
  inboxShareablePaths,
  appMode,
  contentCount,
  typeCounts,
  documentViews,
  viewCounts,
  customViewCounts,
  recentEntries,
  selectedPath,
  documentFilter,
  onDocumentFilter,
  onDocumentViewsChange,
  onNewDocument,
  canCreateDocument,
  onSelectRecent,
  onOpenCommandPalette,
}: OutlinePaneProps) {
  const { t } = useTranslation();
  const isPkm = appMode === "pkm";
  // Shared Outbox is reachable in PKM (Docs) and Inbox only; other modes keep
  // the workspace tab. Fall back to the first valid tab when the persisted
  // tab is not available in the current mode.
  const visibleTabs: readonly RightPaneTab[] = isPkm
    ? ["workspace", "outline", "files", "memo", "shareOutbox", "skills", "guideline", "evidence", "info"]
    : appMode === "inbox"
      ? ["workspace", "shareOutbox"]
      : ["workspace"];
  const tab: RightPaneTab = visibleTabs.includes(activeTab) ? activeTab : visibleTabs[0];
  const headings = useMemo(() => extractOutline(draftContent), [draftContent]);
  // The active heading is the last one at or above the editor's top line.
  const activeHeadingIndex = useMemo(() => {
    if (activeLine == null || headings.length === 0) return -1;
    let idx = -1;
    for (let i = 0; i < headings.length; i++) {
      if (headings[i].line <= activeLine) idx = i;
      else break;
    }
    return idx;
  }, [headings, activeLine]);
  const activeItemRef = useRef<HTMLButtonElement | null>(null);
  useEffect(() => {
    if (activeHeadingIndex >= 0) {
      activeItemRef.current?.scrollIntoView({ block: "nearest" });
    }
  }, [activeHeadingIndex]);
  const meta = document?.meta ?? {};
  const fmType = frontmatterScalar(meta, "type");
  const fmStatus = frontmatterScalar(meta, "status");
  const fmProject = frontmatterScalar(meta, "project");
  const fmCreated = frontmatterScalar(meta, "created_at") ?? frontmatterScalar(meta, "created");
  const fmUpdated = frontmatterScalar(meta, "updated_at") ?? frontmatterScalar(meta, "modified");
  const fmTags = (meta as Record<string, unknown>)["tags"];
  const tagList: string[] = Array.isArray(fmTags)
    ? (fmTags as unknown[]).filter((tag): tag is string => typeof tag === "string")
    : [];
  // Managed vault schema fields (spec §3 F1).
  const fmDescription = frontmatterScalar(meta, "description") ?? "";
  const fmDomain = frontmatterScalar(meta, "domain");
  const fmTopics = (meta as Record<string, unknown>)["topics"];
  const topicsList: string[] = Array.isArray(fmTopics)
    ? (fmTopics as unknown[]).filter((item): item is string => typeof item === "string")
    : [];
  // MOC-first suggestions for the topics chips.
  const mocStems = useMemo(
    () =>
      entries
        .filter((entry) => frontmatterScalar(entry.frontmatter, "type") === "moc")
        .map((entry) => (entry.relPath.split("/").pop() ?? "").replace(/\.md$/i, ""))
        .filter(Boolean)
        .sort(),
    [entries],
  );

  // Distinct types observed in this workspace, used to seed type-input suggestions.
  const observedTypes = useMemo(() => {
    const set = new Set<string>(STANDARD_TYPES);
    for (const entry of entries) {
      const type = frontmatterScalar(entry.frontmatter, "type");
      if (type) set.add(type);
    }
    return Array.from(set).sort();
  }, [entries]);
  const queueExplorerPayload = useCallback(
    (payload: ExplorerDragPayload) => {
      onQueueFileSources(
        payload.items.map((item) => ({
          path: item.path,
          sourceRelPath: item.relPath,
          fileName: item.fileName,
          sourceKind: item.sourceKind,
        })),
        payload.workspacePath,
      );
    },
    [onQueueFileSources],
  );

  return (
    <aside className="outline-pane" ref={paneRef}>
      <div className="outline-header">
        <h3>{t("rightPane.title")}</h3>
        <button
          type="button"
          className="icon-button"
          onClick={onClose}
          title={t("outline.close")}
          aria-label={t("outline.close")}
        >
          <X size={14} />
        </button>
      </div>
      <div className="right-pane-workspace">
        <div className="right-pane-tabs" role="tablist" aria-label={t("rightPane.tabs")}>
          {visibleTabs.map((id) => (
            <button
              key={id}
              type="button"
              role="tab"
              aria-selected={tab === id}
              className={tab === id ? "active" : ""}
              onClick={() => onTabChange(id)}
              onDragOver={
                id === "files"
                  ? (event) => {
                      if (!hasExplorerDragPayload(event.dataTransfer)) return;
                      event.preventDefault();
                      event.dataTransfer.dropEffect = dropOperationFromEvent(event);
                    }
                  : undefined
              }
              onDrop={
                id === "files"
                  ? (event) => {
                      const payload = readExplorerDragPayload(event.dataTransfer);
                      if (!payload) return;
                      event.preventDefault();
                      clearExplorerDragPayload();
                      onTabChange("files");
                      queueExplorerPayload(payload);
                    }
                  : undefined
              }
              title={t(`rightPane.tab.${id}`)}
              aria-label={t(`rightPane.tab.${id}`)}
            >
              {id === "workspace" ? (
                <Layers size={20} />
              ) : id === "outline" ? (
                <List size={20} />
              ) : id === "files" ? (
                <Files size={20} />
              ) : id === "memo" ? (
                <StickyNote size={20} />
              ) : id === "shareOutbox" ? (
                <Send size={20} />
              ) : id === "skills" ? (
                <FileCode2 size={20} />
              ) : id === "guideline" ? (
                <BookOpen size={20} />
              ) : id === "evidence" ? (
                <ClipboardCheck size={20} />
              ) : (
                <Info size={20} />
              )}
            </button>
          ))}
        </div>

        <div className="right-pane-content">
          {tab === "workspace" ? (
            <Sidebar
              contentCount={contentCount}
              typeCounts={typeCounts}
              documentViews={documentViews}
              viewCounts={viewCounts}
              customViewCounts={customViewCounts}
              recentEntries={recentEntries}
              selectedPath={selectedPath}
              documentFilter={documentFilter}
              onDocumentFilter={onDocumentFilter}
              onDocumentViewsChange={onDocumentViewsChange}
              onNewDocument={onNewDocument}
              canCreateDocument={canCreateDocument}
              onSelectRecent={onSelectRecent}
              onOpenCommandPalette={onOpenCommandPalette}
            />
          ) : null}

          {tab === "outline" ? (
            <>
              {document ? (
                headings.length > 0 ? (
                  <div className="outline-list">
                    {headings.map((heading, i) => (
                      <button
                        key={`${heading.line}-${i}`}
                        ref={i === activeHeadingIndex ? activeItemRef : undefined}
                        type="button"
                        className={
                          i === activeHeadingIndex
                            ? "outline-item active"
                            : "outline-item"
                        }
                        data-level={heading.level}
                        aria-current={i === activeHeadingIndex ? "true" : undefined}
                        onClick={() => onJumpToLine(heading.line)}
                        title={heading.text}
                      >
                        {heading.text}
                      </button>
                    ))}
                  </div>
                ) : (
                  <div className="outline-empty" title={t("outline.empty")}>
                    <Hash size={20} className="outline-empty-icon" />
                    <div>{t("outline.empty")}</div>
                  </div>
                )
              ) : (
                <div className="outline-empty">{t("outline.empty.noDocument")}</div>
              )}

              {document ? (
                <NeighborhoodPane
                  document={document}
                  draftContent={draftContent}
                  entries={entries}
                  onSelectEntry={onSelectEntry}
                  onMissingTarget={onMissingWikilink}
                  onOpenGraph={onOpenGraph}
                />
              ) : null}
            </>
          ) : null}

          {tab === "files" ? (
            <>
              <FilesPaneFilterPanel
                entries={workspaceFileEntries}
                filters={filesPaneFilters}
                onChange={onFilesPaneFiltersChange}
                queueSize={fileQueue.length}
                t={t}
              />
              <FilesQueuePane
                queue={fileQueue}
                canApplyFileQueue={canApplyFileQueue}
                selectedIds={selectedFileQueueItemIds}
                onError={onError}
                onUpdateItem={onUpdateFileQueueItem}
                onSelectItem={onSelectFileQueueItem}
                onQueueExternalFiles={onQueueExternalFiles}
                onQueueFileSources={onQueueFileSources}
                onApply={onApplyFileQueue}
                onClear={onClearFileQueue}
                onClearSelected={onClearSelectedFileQueueItems}
                t={t}
              />
            </>
          ) : null}

          {tab === "memo" ? (
            <MemoPane
              workspacePath={workspacePath}
              onError={onError}
              onRefreshWorkspace={onRefreshWorkspace}
              t={t}
            />
          ) : null}

          {tab === "shareOutbox" ? (
            <SharedOutboxPane
              workspacePath={shareWorkspacePath}
              activeDocument={
                document
                  ? { path: document.path, title: document.title, dirty: shareDocumentDirty }
                  : null
              }
              selectedFileEntries={selectedWorkspaceFileEntries}
              inboxShareablePaths={inboxShareablePaths}
              onError={onError}
              onRevealFileInFinder={onRevealFileInFinder}
            />
          ) : null}

          {tab === "skills" ? skillsNode ?? null : null}

          {tab === "guideline" ? guidelineNode ?? null : null}

          {tab === "evidence" ? evidenceNode ?? null : null}

          {tab === "info" &&
          explorerPaneMode === "files" &&
          selectedWorkspaceFileEntries.length > 0 ? (
            <FilesInfoPane
              entries={selectedWorkspaceFileEntries}
              onRevealInFinder={onRevealFileInFinder}
              t={t}
            />
          ) : null}

          {tab === "info" && explorerPaneMode !== "files" && document ? (
            <section className="inspector">
              <div className="inspector-header">
                <h3>{t("inspector.title")}</h3>
              </div>

              {isManagedVaultNote ? (
                <>
                  <InspectorRow label="description">
                    <DescriptionInput
                      value={fmDescription}
                      readOnly={readOnly}
                      onCommit={(next) => onUpdateField("description", next || null)}
                    />
                  </InspectorRow>
                  <InspectorRow label="type">
                    <select
                      className="inspector-select"
                      value={fmType ?? ""}
                      disabled={readOnly}
                      onChange={(event) =>
                        void onUpdateField("type", event.target.value || null)
                      }
                    >
                      <option value="">{t("inspector.empty")}</option>
                      {VAULT_NOTE_TYPES.map((noteType) => (
                        <option key={noteType} value={noteType}>
                          {noteType}
                        </option>
                      ))}
                    </select>
                  </InspectorRow>
                  <InspectorRow label="domain">
                    <select
                      className="inspector-select"
                      value={fmDomain ?? ""}
                      disabled={readOnly}
                      onChange={(event) =>
                        void onUpdateField("domain", event.target.value || null)
                      }
                    >
                      <option value="">{t("inspector.empty")}</option>
                      {VAULT_NOTE_DOMAINS.map((domain) => (
                        <option key={domain} value={domain}>
                          {domain}
                        </option>
                      ))}
                    </select>
                  </InspectorRow>
                  <InspectorRow label="topics">
                    <TopicsInput
                      value={topicsList}
                      suggestions={mocStems}
                      readOnly={readOnly}
                      onCommit={(next) =>
                        onUpdateField("topics", next.length === 0 ? null : next)
                      }
                    />
                  </InspectorRow>
                </>
              ) : (
                <InspectorRow label="type">
                  <ComboInput
                    value={fmType ?? ""}
                    suggestions={observedTypes}
                    onCommit={(next) => onUpdateField("type", next || null)}
                    placeholder={t("inspector.empty")}
                    datalistId="anchor-type-list"
                    readOnly={readOnly}
                  />
                </InspectorRow>
              )}

              <InspectorRow label="status">
                <ComboInput
                  value={fmStatus ?? ""}
                  suggestions={STANDARD_STATUSES}
                  onCommit={(next) => onUpdateField("status", next || null)}
                  placeholder={t("inspector.empty")}
                  datalistId="anchor-status-list"
                  readOnly={readOnly}
                />
              </InspectorRow>

              <InspectorRow label="project">
                <ComboInput
                  value={fmProject ?? ""}
                  suggestions={[]}
                  onCommit={(next) => onUpdateField("project", next || null)}
                  placeholder="[[프로젝트]]"
                  readOnly={readOnly}
                />
              </InspectorRow>

              <InspectorRow label="tags">
                <TagsInput
                  value={tagList}
                  onCommit={(next) => onUpdateField("tags", next.length === 0 ? null : next)}
                  readOnly={readOnly}
                />
              </InspectorRow>

              {fmCreated ? (
                <InspectorRow label={t("outline.meta.created")} muted>
                  <span className="inspector-readonly" title={fmCreated}>
                    {fmCreated.slice(0, 16).replace("T", " ")}
                  </span>
                </InspectorRow>
              ) : null}
              {fmUpdated ? (
                <InspectorRow label={t("outline.meta.updated")} muted>
                  <span className="inspector-readonly" title={fmUpdated}>
                    {fmUpdated.slice(0, 16).replace("T", " ")}
                  </span>
                </InspectorRow>
              ) : null}
              <InspectorRow label="path" muted>
                <span className="inspector-readonly" title={document.relPath}>
                  {document.relPath}
                </span>
              </InspectorRow>
            </section>
          ) : tab === "info" &&
            (explorerPaneMode !== "files" || selectedWorkspaceFileEntries.length === 0) ? (
            <div className="outline-empty">
              {explorerPaneMode === "files"
                ? t("rightPane.files.info.empty")
                : t("outline.empty.noDocument")}
            </div>
          ) : null}
        </div>
      </div>
    </aside>
  );
}

function FilesQueuePane({
  queue,
  canApplyFileQueue,
  selectedIds,
  onError,
  onUpdateItem,
  onSelectItem,
  onQueueExternalFiles,
  onQueueFileSources,
  onApply,
  onClear,
  onClearSelected,
  t,
}: {
  queue: FileQueueItem[];
  canApplyFileQueue: boolean;
  selectedIds: string[];
  onError: (message: string | null) => void;
  onUpdateItem: (
    id: string,
    patch: Partial<Pick<FileQueueItem, "targetDir" | "operation">>,
  ) => void;
  onSelectItem: (id: string, additive: boolean) => void;
  onQueueExternalFiles: (paths: string[]) => Promise<void>;
  onQueueFileSources: (sources: FileQueueSourceInfo[], targetDir: string) => void;
  onApply: () => Promise<unknown>;
  onClear: () => void;
  onClearSelected: () => void;
  t: (key: string, vars?: Record<string, string | number>) => string;
}) {
  const [working, setWorking] = useState(false);
  const [viewMode, setViewMode] = useState<"list" | "icons">("icons");
  const [contextMenu, setContextMenu] = useState<{ x: number; y: number } | null>(null);
  const contextMenuRef = useRef<HTMLDivElement>(null);
  const handleContextMenuKeyDown = useContextMenuKeyboard(
    contextMenuRef,
    !!contextMenu,
    () => setContextMenu(null),
  );
  const [dragOverShelf, setDragOverShelf] = useState(false);
  const selectedSet = useMemo(() => new Set(selectedIds), [selectedIds]);

  useEffect(() => {
    let dispose: (() => void) | null = null;
    void import("@tauri-apps/api/webview")
      .then(({ getCurrentWebview }) =>
        getCurrentWebview().onDragDropEvent((event) => {
          if (event.payload.type === "drop") void onQueueExternalFiles(event.payload.paths);
        }),
      )
      .then((off) => {
        dispose = off;
      })
      .catch(() => {});
    return () => dispose?.();
  }, [onQueueExternalFiles]);

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

  const pickFiles = async () => {
    await onQueueExternalFiles(await chooseFiles(t("rightPane.files.pick")));
  };

  const pickFolders = async () => {
    await onQueueExternalFiles(await chooseDirectories(t("rightPane.files.pickFolder")));
  };
  const queueExplorerPayload = (payload: ExplorerDragPayload) => {
    onQueueFileSources(
      payload.items.map((item) => ({
        path: item.path,
        sourceRelPath: item.relPath,
        fileName: item.fileName,
        sourceKind: item.sourceKind,
      })),
      payload.workspacePath,
    );
  };
  const handleShelfDragOver = (event: React.DragEvent) => {
    if (!hasExplorerDragPayload(event.dataTransfer)) return;
    event.preventDefault();
    event.dataTransfer.dropEffect = dropOperationFromEvent(event);
    setDragOverShelf(true);
  };
  const handleShelfDrop = (event: React.DragEvent) => {
    const payload = readExplorerDragPayload(event.dataTransfer);
    setDragOverShelf(false);
    if (!payload) return;
    event.preventDefault();
    clearExplorerDragPayload();
    queueExplorerPayload(payload);
  };

  const chooseDestination = async (item: FileQueueItem) => {
    const target = await chooseWorkspaceDirectory(t("rightPane.files.chooseDestination"));
    if (target) onUpdateItem(item.id, { targetDir: target });
  };

  const apply = async () => {
    setWorking(true);
    onError(null);
    try {
      await onApply();
    } catch (err) {
      onError(err instanceof Error ? err.message : String(err));
    } finally {
      setWorking(false);
    }
  };

  const queuedCount = queue.filter((item) => item.status === "queued").length;
  const cannotApply =
    queuedCount === 0 ||
    working ||
    !canApplyFileQueue;
  const dragIdsForQueueItem = (item: FileQueueItem): string[] => {
    if (item.status !== "queued") return [];
    if (!selectedSet.has(item.id)) return [item.id];
    const selectedQueuedIds = queue
      .filter((candidate) => candidate.status === "queued" && selectedSet.has(candidate.id))
      .map((candidate) => candidate.id);
    return selectedQueuedIds.length > 0 ? selectedQueuedIds : [item.id];
  };
  const clearSelectedLabel = t("rightPane.files.clearSelected", { count: selectedIds.length });
  const clearAllLabel = t("rightPane.files.clearAll");

  return (
    <section className="right-tool-pane">
      <div className="right-tool-actions file-shelf-toolbar">
        <button
          type="button"
          onClick={pickFiles}
          title={t("rightPane.files.pick")}
          aria-label={t("rightPane.files.pick")}
        >
          <FilePlus2 size={13} />
          <span>{t("rightPane.files.pick")}</span>
        </button>
        <button
          type="button"
          onClick={pickFolders}
          title={t("rightPane.files.pickFolder")}
          aria-label={t("rightPane.files.pickFolder")}
        >
          <FolderPlus size={13} />
          <span>{t("rightPane.files.pickFolder")}</span>
        </button>
        <div className="queue-view-toggle" role="group" aria-label={t("rightPane.files.viewMode")}>
          <button
            type="button"
            className={viewMode === "list" ? "active" : ""}
            onClick={() => setViewMode("list")}
            title={t("rightPane.files.viewList")}
            aria-label={t("rightPane.files.viewList")}
          >
            <List size={13} />
          </button>
          <button
            type="button"
            className={viewMode === "icons" ? "active" : ""}
            onClick={() => setViewMode("icons")}
            title={t("rightPane.files.viewIcons")}
            aria-label={t("rightPane.files.viewIcons")}
          >
            <Grid2X2 size={13} />
          </button>
        </div>
      </div>
      <div
        className={[
          "file-drop-zone",
          queue.length === 0 ? "empty" : "",
          dragOverShelf ? "drag-over" : "",
        ]
          .filter(Boolean)
          .join(" ")}
        title={t("rightPane.files.dropTitle")}
        onDragOver={handleShelfDragOver}
        onDragLeave={() => setDragOverShelf(false)}
        onDrop={handleShelfDrop}
        onContextMenu={(event) => {
          event.preventDefault();
          setContextMenu({ x: event.clientX, y: event.clientY });
        }}
      >
        <Files size={18} />
        <strong>{t("rightPane.files.dropTitle")}</strong>
        <span>{t("rightPane.files.dropDescription")}</span>
      </div>
      <div
        className={[
          "right-list",
          viewMode === "icons" ? "file-shelf-icons" : "",
          dragOverShelf ? "drag-over" : "",
        ]
          .filter(Boolean)
          .join(" ")}
        onDragOver={handleShelfDragOver}
        onDragLeave={() => setDragOverShelf(false)}
        onDrop={handleShelfDrop}
      >
        {queue.length === 0 ? (
          <div className="outline-empty">{t("rightPane.files.emptyQueue")}</div>
        ) : null}
        {queue.map((item) => (
          <div
            role="button"
            tabIndex={0}
            className={`right-list-item queue ${item.status}${selectedSet.has(item.id) ? " selected" : ""}`}
            key={item.id}
            title={fileQueueTitleFor(item, t)}
            aria-selected={selectedSet.has(item.id)}
            draggable={item.status === "queued"}
            onClick={(event) => onSelectItem(item.id, event.metaKey || event.ctrlKey || event.shiftKey)}
            onKeyDown={(event) => {
              if (event.key !== "Enter" && event.key !== " ") return;
              event.preventDefault();
              onSelectItem(item.id, event.metaKey || event.ctrlKey || event.shiftKey);
            }}
            onDragStart={(event) => {
              const dragIds = dragIdsForQueueItem(item);
              if (dragIds.length === 0) {
                event.preventDefault();
                return;
              }
              if (!selectedSet.has(item.id)) onSelectItem(item.id, false);
              writeFileQueueDragPayload(event, dragIds);
            }}
            onDragEnd={clearFileQueueDragPayload}
          >
            <div className="queue-copy">
              <span
                className="queue-file-icon"
                data-kind={fileQueueKindFor(item)}
                title={fileQueueTitleFor(item, t)}
                aria-hidden="true"
              >
                {fileQueueIconFor(item)}
              </span>
              <strong>
                <span>{item.fileName}</span>
              </strong>
              <span className="queue-source-path">{item.sourceRelPath}</span>
              <span className="queue-target-path" title={item.targetDir}>{t("rightPane.files.destination")}: {item.targetDir}</span>
              {item.message ? <em>{item.message}</em> : null}
            </div>
            <div className="queue-controls" onClick={(event) => event.stopPropagation()}>
              <button
                type="button"
                className={item.operation === "copy" ? "active" : ""}
                onClick={() => onUpdateItem(item.id, { operation: "copy" })}
                disabled={item.status !== "queued"}
                title={t("rightPane.files.copy")}
                aria-label={t("rightPane.files.copy")}
              >
                <Copy size={12} />
              </button>
              <button
                type="button"
                className={item.operation === "move" ? "active" : ""}
                onClick={() => onUpdateItem(item.id, { operation: "move" })}
                disabled={item.status !== "queued"}
                title={t("rightPane.files.move")}
                aria-label={t("rightPane.files.move")}
              >
                <MoveRight size={12} />
              </button>
              <button
                type="button"
                onClick={() => void chooseDestination(item)}
                disabled={item.status !== "queued"}
                title={t("rightPane.files.chooseDestination")}
                aria-label={t("rightPane.files.chooseDestination")}
              >
                <Files size={12} />
              </button>
            </div>
          </div>
        ))}
      </div>
      <div className="right-tool-actions bottom">
        <button
          type="button"
          disabled={cannotApply}
          onClick={() => void apply()}
          title={t("rightPane.files.applyQueue")}
          aria-label={t("rightPane.files.applyQueue")}
        >
          <Save size={13} />
          <span>{t("rightPane.files.applyQueue")}</span>
        </button>
        <button
          type="button"
          disabled={selectedIds.length === 0 || working}
          onClick={onClearSelected}
          title={clearSelectedLabel}
          aria-label={clearSelectedLabel}
        >
          <X size={13} />
          <span>{clearSelectedLabel}</span>
        </button>
        <button
          type="button"
          disabled={queue.length === 0 || working}
          onClick={onClear}
          title={clearAllLabel}
          aria-label={clearAllLabel}
        >
          <CircleX size={13} />
          <span>{clearAllLabel}</span>
        </button>
      </div>
      {contextMenu ? (
        <div
          ref={contextMenuRef}
          className="context-menu"
          role="menu"
          tabIndex={-1}
          style={{ left: contextMenu.x, top: contextMenu.y }}
          onPointerDown={(event) => event.stopPropagation()}
          onKeyDown={handleContextMenuKeyDown}
        >
          <button type="button" role="menuitem" onClick={() => { setContextMenu(null); void pickFiles(); }}>
            {t("rightPane.files.pick")}
          </button>
          <button type="button" role="menuitem" onClick={() => { setContextMenu(null); void pickFolders(); }}>
            {t("rightPane.files.pickFolder")}
          </button>
          <div className="context-menu-separator" role="separator" />
          <button
            type="button"
            role="menuitem"
            disabled={selectedIds.length === 0}
            onClick={() => {
              setContextMenu(null);
              onClearSelected();
            }}
          >
            {clearSelectedLabel}
          </button>
          <button
            type="button"
            role="menuitem"
            disabled={queue.length === 0}
            onClick={() => {
              setContextMenu(null);
              onClear();
            }}
          >
            {clearAllLabel}
          </button>
        </div>
      ) : null}
    </section>
  );
}

function fileQueueIconFor(item: FileQueueItem): React.ReactNode {
  const kind = fileQueueKindFor(item);
  const size = 18;
  switch (kind) {
    case "directory":
      return <Folder size={size} />;
    case "markdown":
    case "text":
      return <FileText size={size} />;
    case "code":
      return <FileCode2 size={size} />;
    case "image":
      return <FileImage size={size} />;
    case "pdf":
      return <FileType size={size} />;
    case "archive":
      return <FileArchive size={size} />;
    case "spreadsheet":
      return <FileSpreadsheet size={size} />;
    case "presentation":
      return <Presentation size={size} />;
    case "audio":
      return <FileAudio size={size} />;
    case "video":
      return <FileVideo size={size} />;
    default:
      return <File size={size} />;
  }
}

function fileQueueKindFor(item: FileQueueItem): string {
  if (item.sourceKind === "directory") return "directory";
  const extension = fileQueueExtension(item);
  if (MARKDOWN_EXTENSIONS.has(extension)) return "markdown";
  if (TEXT_EXTENSIONS.has(extension)) return "text";
  if (CODE_EXTENSIONS.has(extension)) return "code";
  if (IMAGE_EXTENSIONS.has(extension)) return "image";
  if (extension === "pdf") return "pdf";
  if (ARCHIVE_EXTENSIONS.has(extension)) return "archive";
  if (SPREADSHEET_EXTENSIONS.has(extension)) return "spreadsheet";
  if (PRESENTATION_EXTENSIONS.has(extension)) return "presentation";
  if (AUDIO_EXTENSIONS.has(extension)) return "audio";
  if (VIDEO_EXTENSIONS.has(extension)) return "video";
  return "file";
}

function fileQueueExtension(item: FileQueueItem): string {
  const name = (item.fileName || item.sourceRelPath || item.sourcePath).toLowerCase();
  const index = name.lastIndexOf(".");
  if (index <= 0 || index === name.length - 1) return "";
  return name.slice(index + 1);
}

function fileQueueTitleFor(
  item: FileQueueItem,
  t: (key: string, vars?: Record<string, string | number>) => string,
): string {
  const operation = item.operation === "move" ? t("rightPane.files.move") : t("rightPane.files.copy");
  return [
    item.fileName,
    item.sourcePath,
    `${t("rightPane.files.destination")}: ${item.targetDir}`,
    operation,
    item.status,
    item.message,
  ]
    .filter(Boolean)
    .join("\n");
}

function MemoPane({
  workspacePath,
  onError,
  onRefreshWorkspace,
  t,
}: {
  workspacePath: string | null;
  onError: (message: string | null) => void;
  onRefreshWorkspace: () => void;
  t: (key: string, vars?: Record<string, string | number>) => string;
}) {
  const [memos, setMemos] = useState<MemoEntry[]>([]);
  const [selectedPath, setSelectedPath] = useState<string | null>(null);
  const [name, setName] = useState("memo.txt");
  const [format, setFormat] = useState<MemoFormat>("plain");
  const [content, setContent] = useState("");
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [saveState, setSaveState] = useState<"idle" | "saving" | "saved" | "error">("idle");
  const autoSaveTimerRef = useRef<ReturnType<typeof window.setTimeout> | null>(null);
  const autoSaveSerialRef = useRef(0);
  const selectedPathRef = useRef<string | null>(null);
  const userEditedRef = useRef(false);
  const lastSavedSignatureRef = useRef("");

  const clearAutoSaveTimer = useCallback(() => {
    if (autoSaveTimerRef.current) {
      window.clearTimeout(autoSaveTimerRef.current);
      autoSaveTimerRef.current = null;
    }
  }, []);

  useEffect(() => {
    selectedPathRef.current = selectedPath;
  }, [selectedPath]);

  const refresh = useCallback(async () => {
    if (!workspacePath) {
      setMemos([]);
      return;
    }
    setLoading(true);
    try {
      setMemos(await listMemos(workspacePath));
    } catch (err) {
      onError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  }, [onError, workspacePath]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  useEffect(() => () => clearAutoSaveTimer(), [clearAutoSaveTimer]);

  useEffect(() => {
    const signature = `${name}\u0000${format}\u0000${content}`;
    if (!workspacePath || !userEditedRef.current) return;
    if (!selectedPath && !content.trim()) {
      setSaveState("idle");
      return;
    }
    if (lastSavedSignatureRef.current === signature) return;

    clearAutoSaveTimer();
    autoSaveTimerRef.current = window.setTimeout(() => {
      autoSaveTimerRef.current = null;
      const saveName = name;
      const saveFormat = format;
      const saveContent = content;
      const previousPath = selectedPathRef.current;
      const serial = ++autoSaveSerialRef.current;
      setSaving(true);
      setSaveState("saving");
      onError(null);
      void saveMemo(workspacePath, saveName, saveFormat, saveContent)
        .then(async (doc) => {
          if (serial !== autoSaveSerialRef.current) return;
          if (previousPath && previousPath !== doc.path) {
            await deleteMemo(workspacePath, previousPath);
          }
          setSelectedPath(doc.path);
          setName((current) => (current === saveName ? doc.name : current));
          setFormat((current) => (current === saveFormat ? doc.format : current));
          lastSavedSignatureRef.current = `${doc.name}\u0000${doc.format}\u0000${saveContent}`;
          userEditedRef.current = false;
          setSaveState("saved");
          await refresh();
        })
        .catch((err) => {
          if (serial !== autoSaveSerialRef.current) return;
          setSaveState("error");
          onError(err instanceof Error ? err.message : String(err));
        })
        .finally(() => {
          if (serial === autoSaveSerialRef.current) {
            setSaving(false);
          }
        });
    }, 700);

    return clearAutoSaveTimer;
  }, [clearAutoSaveTimer, content, format, name, onError, refresh, selectedPath, workspacePath]);

  const openMemo = async (memo: MemoEntry) => {
    if (!workspacePath) return;
    clearAutoSaveTimer();
    autoSaveSerialRef.current += 1;
    userEditedRef.current = false;
    setSaving(false);
    try {
      const doc = await readMemo(workspacePath, memo.path);
      setSelectedPath(doc.path);
      setName(doc.name);
      setFormat(doc.format);
      setContent(doc.content);
      lastSavedSignatureRef.current = `${doc.name}\u0000${doc.format}\u0000${doc.content}`;
      setSaveState("saved");
    } catch (err) {
      onError(err instanceof Error ? err.message : String(err));
    }
  };

  const newMemo = () => {
    const stamp = new Date().toISOString().slice(0, 16).replace(/[-:T]/g, "");
    clearAutoSaveTimer();
    autoSaveSerialRef.current += 1;
    userEditedRef.current = false;
    setSelectedPath(null);
    setName(`memo-${stamp}.txt`);
    setFormat("plain");
    setContent("");
    setSaving(false);
    setSaveState("idle");
    lastSavedSignatureRef.current = "";
  };

  const handleNameChange = (next: string) => {
    userEditedRef.current = true;
    setSaveState("idle");
    setName(next);
  };

  const handleFormatChange = (next: MemoFormat) => {
    userEditedRef.current = true;
    setSaveState("idle");
    setFormat(next);
  };

  const handleContentChange = (next: string) => {
    userEditedRef.current = true;
    setSaveState("idle");
    setContent(next);
  };

  const deleteCurrent = async () => {
    if (!workspacePath || !selectedPath) return;
    if (!window.confirm(t("rightPane.memo.deleteConfirm"))) return;
    clearAutoSaveTimer();
    autoSaveSerialRef.current += 1;
    setSaving(true);
    onError(null);
    try {
      await deleteMemo(workspacePath, selectedPath);
      await refresh();
      newMemo();
    } catch (err) {
      onError(err instanceof Error ? err.message : String(err));
    } finally {
      setSaving(false);
    }
  };

  const saveAs = async () => {
    setSaving(true);
    onError(null);
    try {
      const target = await chooseSaveFile(t("rightPane.memo.saveAs"), name);
      if (!target) return;
      await saveMemoAs(target, content);
      onRefreshWorkspace();
    } catch (err) {
      onError(err instanceof Error ? err.message : String(err));
    } finally {
      setSaving(false);
    }
  };

  const autoSaveLabel =
    saveState === "saving"
      ? t("rightPane.memo.autoSaving")
      : saveState === "saved"
        ? t("rightPane.memo.autoSaved")
        : saveState === "error"
          ? t("rightPane.memo.autoSaveError")
          : t("rightPane.memo.autoSaveIdle");

  return (
    <section className="right-tool-pane memo-pane">
      <div className="right-tool-actions">
        <button
          type="button"
          onClick={newMemo}
          title={t("rightPane.memo.new")}
          aria-label={t("rightPane.memo.new")}
        >
          <Plus size={13} />
          <span>{t("rightPane.memo.new")}</span>
        </button>
        <button
          type="button"
          onClick={() => void refresh()}
          title={t("rightPane.memo.refresh")}
          aria-label={t("rightPane.memo.refresh")}
        >
          <List size={13} />
          <span>{t("rightPane.memo.refresh")}</span>
        </button>
      </div>
      <div className="memo-list" aria-label={t("rightPane.memo.list")}>
        {loading ? <div className="outline-empty">{t("rightPane.memo.loading")}</div> : null}
        {!loading && memos.length === 0 ? (
          <div className="outline-empty">{t("rightPane.memo.empty")}</div>
        ) : null}
        {memos.map((memo) => (
          <button
            key={memo.path}
            type="button"
            className={memo.path === selectedPath ? "memo-list-item active" : "memo-list-item"}
            onClick={() => void openMemo(memo)}
            title={memo.path}
          >
            <strong>{memo.name}</strong>
            <span>{memo.preview || t("rightPane.memo.noPreview")}</span>
          </button>
        ))}
      </div>
      <label className="memo-name">
        <span>{t("rightPane.memo.name")}</span>
        <input value={name} onChange={(event) => handleNameChange(event.target.value)} />
      </label>
      <div className="right-tool-actions">
        <button type="button" className={format === "plain" ? "active" : ""} onClick={() => handleFormatChange("plain")}>
          Plain
        </button>
        <button type="button" className={format === "markdown" ? "active" : ""} onClick={() => handleFormatChange("markdown")}>
          Markdown
        </button>
      </div>
      <textarea
        className="memo-editor"
        value={content}
        onChange={(event) => handleContentChange(event.target.value)}
        placeholder={t("rightPane.memo.placeholder")}
      />
      <div className={`memo-autosave-status ${saveState}`}>{autoSaveLabel}</div>
      <div className="right-tool-actions bottom">
        <button
          type="button"
          className="danger"
          disabled={!workspacePath || !selectedPath || saving}
          onClick={() => void deleteCurrent()}
          title={t("rightPane.memo.delete")}
          aria-label={t("rightPane.memo.delete")}
        >
          <Trash2 size={13} />
          <span>{t("rightPane.memo.delete")}</span>
        </button>
        <button
          type="button"
          disabled={saving}
          onClick={() => void saveAs()}
          title={t("rightPane.memo.saveAs")}
          aria-label={t("rightPane.memo.saveAs")}
        >
          <Save size={13} />
          <span>{t("rightPane.memo.saveAs")}</span>
        </button>
      </div>
    </section>
  );
}

interface InspectorRowProps {
  label: string;
  muted?: boolean;
  children: React.ReactNode;
}

function InspectorRow({ label, muted, children }: InspectorRowProps) {
  return (
    <div className={muted ? "inspector-row muted" : "inspector-row"}>
      <dt>{label}</dt>
      <dd>{children}</dd>
    </div>
  );
}

interface ComboInputProps {
  value: string;
  suggestions: string[];
  onCommit: (next: string) => void | Promise<void>;
  placeholder?: string;
  datalistId?: string;
  readOnly?: boolean;
}

/** Free-text input with optional <datalist> suggestions. Commits on blur or
 *  Enter — but only fires onCommit when the value actually changed, so a
 *  blur from a no-op edit doesn't write the file back. */
function ComboInput({
  value,
  suggestions,
  onCommit,
  placeholder,
  datalistId,
  readOnly = false,
}: ComboInputProps) {
  const [draft, setDraft] = useState(value);
  const lastCommitted = useRef(value);

  useEffect(() => {
    setDraft(value);
    lastCommitted.current = value;
  }, [value]);

  function commit() {
    if (readOnly) return;
    const next = draft.trim();
    if (next === lastCommitted.current) return;
    lastCommitted.current = next;
    void onCommit(next);
  }

  return (
    <>
      <input
        className="inspector-input"
        list={datalistId}
        value={draft}
        onChange={(event) => setDraft(event.target.value)}
        onBlur={commit}
        disabled={readOnly}
        onKeyDown={(event) => {
          if (event.key === "Enter") {
            event.preventDefault();
            (event.currentTarget as HTMLInputElement).blur();
          } else if (event.key === "Escape") {
            event.preventDefault();
            setDraft(lastCommitted.current);
            (event.currentTarget as HTMLInputElement).blur();
          }
        }}
        placeholder={placeholder}
      />
      {datalistId && suggestions.length > 0 ? (
        <datalist id={datalistId}>
          {suggestions.map((option) => (
            <option key={option} value={option} />
          ))}
        </datalist>
      ) : null}
    </>
  );
}

// V2 schema contract — mirrors src-tauri/src/vault_guard.rs.
const VAULT_NOTE_TYPES = [
  "insight", "decision", "observation", "person",
  "project", "method", "moc", "reference",
] as const;
const VAULT_NOTE_DOMAINS = [
  "research", "projects", "teaching", "operations", "people", "ai-practice",
] as const;
const DESCRIPTION_MAX = 200;

interface DescriptionInputProps {
  value: string;
  readOnly?: boolean;
  onCommit: (next: string) => void | Promise<void>;
}

/** description textarea with the 200-char counter (spec §3 F1). Commits on
 *  blur through update_frontmatter_field like every inspector editor. */
function DescriptionInput({ value, readOnly = false, onCommit }: DescriptionInputProps) {
  const [draft, setDraft] = useState(value);
  useEffect(() => {
    setDraft(value);
  }, [value]);
  const count = [...draft].length;
  return (
    <div className="inspector-description">
      <textarea
        className="inspector-description-input"
        value={draft}
        rows={3}
        maxLength={DESCRIPTION_MAX * 2}
        disabled={readOnly}
        onChange={(event) => setDraft(event.target.value)}
        onBlur={() => {
          if (draft !== value) void onCommit(draft.trim());
        }}
      />
      <span
        className={
          count > DESCRIPTION_MAX
            ? "inspector-description-count over"
            : "inspector-description-count"
        }
      >
        {count}/{DESCRIPTION_MAX}
      </span>
    </div>
  );
}

interface TopicsInputProps {
  value: string[];
  suggestions: string[];
  readOnly?: boolean;
  onCommit: (next: string[]) => void | Promise<void>;
}

/** topics chips — values are `[[MOC]]` wikilinks; suggestions list MOC stems
 *  first (native datalist). Enter/comma adds, Backspace removes the last. */
function TopicsInput({ value, suggestions, readOnly = false, onCommit }: TopicsInputProps) {
  const [topics, setTopics] = useState<string[]>(value);
  const [draft, setDraft] = useState("");
  useEffect(() => {
    setTopics(value);
  }, [value]);

  function applyNext(next: string[]) {
    if (readOnly) return;
    setTopics(next);
    void onCommit(next);
  }

  function pushTopic() {
    const cleaned = draft.trim().replace(/^\[\[/, "").replace(/\]\]$/, "");
    if (!cleaned) return;
    const wikilink = `[[${cleaned}]]`;
    if (topics.includes(wikilink)) {
      setDraft("");
      return;
    }
    applyNext([...topics, wikilink]);
    setDraft("");
  }

  return (
    <div className="tag-chips">
      {topics.map((topic) => (
        <span key={topic} className="tag-chip">
          {topic.replace(/^\[\[/, "").replace(/\]\]$/, "")}
          <button
            type="button"
            className="tag-chip-x"
            aria-label={`remove ${topic}`}
            title={`remove ${topic}`}
            disabled={readOnly}
            onClick={() => applyNext(topics.filter((item) => item !== topic))}
          >
            <X size={10} />
          </button>
        </span>
      ))}
      <input
        className="tag-chip-input"
        value={draft}
        list="anchor-topics-moc-list"
        onChange={(event) => setDraft(event.target.value)}
        disabled={readOnly}
        onKeyDown={(event) => {
          if (event.key === "Enter" || event.key === ",") {
            event.preventDefault();
            pushTopic();
          } else if (event.key === "Backspace" && draft === "" && topics.length > 0) {
            event.preventDefault();
            applyNext(topics.slice(0, -1));
          }
        }}
        onBlur={pushTopic}
        placeholder={topics.length === 0 ? "[[moc]]" : "+"}
      />
      <datalist id="anchor-topics-moc-list">
        {suggestions.map((stem) => (
          <option key={stem} value={stem} />
        ))}
      </datalist>
    </div>
  );
}

interface TagsInputProps {
  value: string[];
  onCommit: (next: string[]) => void | Promise<void>;
  readOnly?: boolean;
}

/** Multi-chip tags editor. Type and press Enter or comma to add; Backspace
 *  in an empty input removes the last chip. Commits the full array on each
 *  mutation so InspectorPane can write it via update_frontmatter_field. */
function TagsInput({ value, onCommit, readOnly = false }: TagsInputProps) {
  const [tags, setTags] = useState<string[]>(value);
  const [draft, setDraft] = useState("");

  useEffect(() => {
    setTags(value);
  }, [value]);

  function applyNext(next: string[]) {
    if (readOnly) return;
    setTags(next);
    void onCommit(next);
  }

  function pushTag() {
    const cleaned = draft.trim().replace(/^#+/, "");
    if (!cleaned) return;
    if (tags.includes(cleaned)) {
      setDraft("");
      return;
    }
    applyNext([...tags, cleaned]);
    setDraft("");
  }

  return (
    <div className="tag-chips">
      {tags.map((tag) => (
        <span key={tag} className="tag-chip">
          #{tag}
          <button
            type="button"
            className="tag-chip-x"
            aria-label={`remove ${tag}`}
            title={`remove ${tag}`}
            disabled={readOnly}
            onClick={() => applyNext(tags.filter((t) => t !== tag))}
          >
            <X size={10} />
          </button>
        </span>
      ))}
      <input
        className="tag-chip-input"
        value={draft}
        onChange={(event) => setDraft(event.target.value)}
        disabled={readOnly}
        onKeyDown={(event) => {
          if (event.key === "Enter" || event.key === ",") {
            event.preventDefault();
            pushTag();
          } else if (event.key === "Backspace" && draft === "" && tags.length > 0) {
            event.preventDefault();
            applyNext(tags.slice(0, -1));
          }
        }}
        onBlur={pushTag}
        placeholder={tags.length === 0 ? "tag" : "+"}
      />
      {tags.length === 0 && draft === "" ? null : (
        <button
          type="button"
          className="tag-chip-add"
          onClick={pushTag}
          disabled={readOnly}
          title="add tag"
          aria-label="add tag"
          tabIndex={-1}
        >
          <Plus size={11} />
        </button>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Files filter panel (right pane → drives left Files list)
// ---------------------------------------------------------------------------

const MODIFIED_PRESETS: { value: number | null; key: string }[] = [
  { value: null, key: "rightPane.files.filters.modifiedAll" },
  { value: 1, key: "rightPane.files.filters.modified1" },
  { value: 7, key: "rightPane.files.filters.modified7" },
  { value: 30, key: "rightPane.files.filters.modified30" },
  { value: 90, key: "rightPane.files.filters.modified90" },
];

const SIZE_PRESETS: {
  value: WorkspaceFilesPaneFilters["sizeBucket"];
  key: string;
}[] = [
  { value: null, key: "rightPane.files.filters.sizeAll" },
  { value: "lt10k", key: "rightPane.files.filters.sizeLt10k" },
  { value: "lt1m", key: "rightPane.files.filters.sizeLt1m" },
  { value: "lt10m", key: "rightPane.files.filters.sizeLt10m" },
  { value: "gte10m", key: "rightPane.files.filters.sizeGte10m" },
];

function FilesPaneFilterPanel({
  entries,
  filters,
  onChange,
  queueSize,
  t,
}: {
  entries: WorkspaceFileEntry[];
  filters: WorkspaceFilesPaneFilters;
  onChange: (filters: WorkspaceFilesPaneFilters) => void;
  queueSize: number;
  t: (key: string, vars?: Record<string, string | number>) => string;
}) {
  const extensionCounts = useMemo(
    () => collectWorkspaceFileExtensionCounts(entries).slice(0, 12),
    [entries],
  );
  const selectedExtSet = useMemo(
    () => new Set(filters.extensions.map((ext) => ext.toLowerCase())),
    [filters.extensions],
  );
  const hasActive =
    filters.extensions.length > 0 ||
    filters.modifiedWithinDays !== null ||
    filters.sizeBucket !== null ||
    filters.queuedOnly;

  const toggleExtension = (ext: string) => {
    const lower = ext.toLowerCase();
    const next = selectedExtSet.has(lower)
      ? filters.extensions.filter((value) => value.toLowerCase() !== lower)
      : [...filters.extensions, lower];
    onChange({ ...filters, extensions: next });
  };

  const clearAll = () => {
    onChange({
      extensions: [],
      modifiedWithinDays: null,
      sizeBucket: null,
      queuedOnly: false,
      queuedPaths: filters.queuedPaths,
    });
  };

  return (
    <section className="files-pane-filters" aria-label={t("rightPane.files.filters.title")}>
      <header className="files-pane-filters-header">
        <span>{t("rightPane.files.filters.title")}</span>
        {hasActive ? (
          <button
            type="button"
            className="files-pane-filters-clear"
            onClick={clearAll}
            title={t("rightPane.files.filters.clear")}
          >
            <CircleX size={12} />
            <span>{t("rightPane.files.filters.clear")}</span>
          </button>
        ) : null}
      </header>

      {extensionCounts.length > 0 ? (
        <div className="files-pane-filters-group" role="group" aria-label={t("rightPane.files.filters.extensions")}>
          <span className="files-pane-filters-label">{t("rightPane.files.filters.extensions")}</span>
          <div className="files-pane-filters-chips">
            {extensionCounts.map(({ extension, count }) => {
              const active = selectedExtSet.has(extension.toLowerCase());
              return (
                <button
                  key={extension}
                  type="button"
                  className={active ? "chip active" : "chip"}
                  onClick={() => toggleExtension(extension)}
                  title={`${extension} (${count})`}
                >
                  <span>{extension}</span>
                  <span className="chip-count">{count}</span>
                </button>
              );
            })}
          </div>
        </div>
      ) : null}

      <div className="files-pane-filters-group" role="group" aria-label={t("rightPane.files.filters.modified")}>
        <span className="files-pane-filters-label">{t("rightPane.files.filters.modified")}</span>
        <div className="files-pane-filters-chips">
          {MODIFIED_PRESETS.map(({ value, key }) => (
            <button
              key={key}
              type="button"
              className={filters.modifiedWithinDays === value ? "chip active" : "chip"}
              onClick={() => onChange({ ...filters, modifiedWithinDays: value })}
            >
              {t(key)}
            </button>
          ))}
        </div>
      </div>

      <div className="files-pane-filters-group" role="group" aria-label={t("rightPane.files.filters.size")}>
        <span className="files-pane-filters-label">{t("rightPane.files.filters.size")}</span>
        <div className="files-pane-filters-chips">
          {SIZE_PRESETS.map(({ value, key }) => (
            <button
              key={key}
              type="button"
              className={filters.sizeBucket === value ? "chip active" : "chip"}
              onClick={() => onChange({ ...filters, sizeBucket: value })}
            >
              {t(key)}
            </button>
          ))}
        </div>
      </div>

      <label className="files-pane-filters-toggle">
        <input
          type="checkbox"
          checked={filters.queuedOnly}
          disabled={queueSize === 0 && !filters.queuedOnly}
          onChange={(event) => onChange({ ...filters, queuedOnly: event.target.checked })}
        />
        <span>
          {t("rightPane.files.filters.queuedOnly", { count: queueSize })}
        </span>
      </label>
    </section>
  );
}

// ---------------------------------------------------------------------------
// Files Info pane (right Info tab → reflects selected files in Files list)
// ---------------------------------------------------------------------------

function FilesInfoPane({
  entries,
  onRevealInFinder,
  t,
}: {
  entries: WorkspaceFileEntry[];
  onRevealInFinder: (targetPath: string) => void;
  t: (key: string, vars?: Record<string, string | number>) => string;
}) {
  if (entries.length === 1) {
    const entry = entries[0];
    const updated = entry.updatedAt
      ? formatAbsoluteTimestamp(entry.updatedAt)
      : t("inspector.empty");
    return (
      <section className="inspector files-info">
        <div className="inspector-header">
          <h3>{t("rightPane.files.info.title")}</h3>
        </div>
        <InspectorRow label={t("rightPane.files.info.name")} muted>
          <span className="inspector-readonly">{entry.name}</span>
        </InspectorRow>
        <InspectorRow label={t("rightPane.files.info.path")} muted>
          <span className="inspector-readonly" title={entry.path}>
            {entry.relPath}
          </span>
        </InspectorRow>
        <InspectorRow label={t("rightPane.files.info.size")} muted>
          <span className="inspector-readonly">{formatFileSize(entry.sizeBytes)}</span>
        </InspectorRow>
        <InspectorRow label={t("rightPane.files.info.modified")} muted>
          <span className="inspector-readonly">{updated}</span>
        </InspectorRow>
        <InspectorRow label={t("rightPane.files.info.kind")} muted>
          <span className="inspector-readonly">
            {entry.fileKind.toUpperCase()}
            {entry.binary ? ` · ${t("rightPane.files.info.binary")}` : ""}
            {entry.gitTracked ? ` · ${t("rightPane.files.info.tracked")}` : ""}
          </span>
        </InspectorRow>
        <div className="files-info-actions">
          <button
            type="button"
            className="files-info-action"
            onClick={() => onRevealInFinder(entry.path)}
          >
            {t("context.revealInFinder")}
          </button>
        </div>
      </section>
    );
  }
  const totalSize = entries.reduce((sum, entry) => sum + entry.sizeBytes, 0);
  const latestTs = entries.reduce<number>((max, entry) => {
    if (!entry.updatedAt) return max;
    const ts = Date.parse(entry.updatedAt);
    return Number.isFinite(ts) && ts > max ? ts : max;
  }, 0);
  const kinds = Array.from(new Set(entries.map((entry) => entry.fileKind))).slice(0, 8);
  return (
    <section className="inspector files-info">
      <div className="inspector-header">
        <h3>{t("rightPane.files.info.title")}</h3>
      </div>
      <InspectorRow label={t("rightPane.files.info.selected")} muted>
        <span className="inspector-readonly">
          {t("rightPane.files.info.selectedCount", { count: entries.length })}
        </span>
      </InspectorRow>
      <InspectorRow label={t("rightPane.files.info.totalSize")} muted>
        <span className="inspector-readonly">{formatFileSize(totalSize)}</span>
      </InspectorRow>
      {latestTs > 0 ? (
        <InspectorRow label={t("rightPane.files.info.modified")} muted>
          <span className="inspector-readonly">
            {formatAbsoluteTimestamp(new Date(latestTs).toISOString())}
          </span>
        </InspectorRow>
      ) : null}
      {kinds.length > 0 ? (
        <InspectorRow label={t("rightPane.files.info.kinds")} muted>
          <span className="inspector-readonly">
            {kinds.map((kind) => kind.toUpperCase()).join(", ")}
          </span>
        </InspectorRow>
      ) : null}
    </section>
  );
}

function formatFileSize(value: number): string {
  if (value < 1024) return `${value} B`;
  if (value < 1024 * 1024) return `${(value / 1024).toFixed(1)} KB`;
  if (value < 1024 * 1024 * 1024) return `${(value / (1024 * 1024)).toFixed(1)} MB`;
  return `${(value / (1024 * 1024 * 1024)).toFixed(2)} GB`;
}

function formatAbsoluteTimestamp(isoString: string): string {
  const ts = Date.parse(isoString);
  if (!Number.isFinite(ts)) return isoString;
  const date = new Date(ts);
  const pad = (n: number) => n.toString().padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
}
