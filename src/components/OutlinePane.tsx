import {
  Copy,
  FolderPlus,
  Grid2X2,
  FilePlus2,
  Files,
  Hash,
  Info,
  List,
  MoveRight,
  Plus,
  Save,
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
import { extractOutline } from "../lib/markdown";
import { useTranslation } from "../lib/i18n";
import type {
  DocumentPayload,
  FileQueueItem,
  MemoEntry,
  MemoFormat,
  VaultEntry,
} from "../lib/types";
import { NeighborhoodPane } from "./NeighborhoodPane";

interface OutlinePaneProps {
  document: DocumentPayload | null;
  draftContent: string;
  entries: VaultEntry[];
  readOnly: boolean;
  workspacePath: string | null;
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
  fileQueue: FileQueueItem[];
  canApplyFileQueue: boolean;
  onUpdateFileQueueItem: (
    id: string,
    patch: Partial<Pick<FileQueueItem, "targetDir" | "operation">>,
  ) => void;
  selectedFileQueueItemIds: string[];
  onSelectFileQueueItem: (id: string, additive: boolean) => void;
  onQueueExternalFiles: (paths: string[]) => Promise<void>;
  onApplyFileQueue: () => Promise<void>;
  onClearFileQueue: () => void;
  onClearSelectedFileQueueItems: () => void;
  paneRef?: React.RefObject<HTMLElement | null>;
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

export function OutlinePane({
  document,
  draftContent,
  entries,
  readOnly,
  workspacePath,
  onJumpToLine,
  onClose,
  onError,
  onRefreshWorkspace,
  onUpdateField,
  onSelectEntry,
  onMissingWikilink,
  fileQueue,
  canApplyFileQueue,
  onUpdateFileQueueItem,
  selectedFileQueueItemIds,
  onSelectFileQueueItem,
  onQueueExternalFiles,
  onApplyFileQueue,
  onClearFileQueue,
  onClearSelectedFileQueueItems,
  paneRef,
}: OutlinePaneProps) {
  const { t } = useTranslation();
  const [tab, setTab] = useState<"outline" | "files" | "memo" | "info">("outline");
  const headings = useMemo(() => extractOutline(draftContent), [draftContent]);
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

  // Distinct types observed in this workspace, used to seed type-input suggestions.
  const observedTypes = useMemo(() => {
    const set = new Set<string>(STANDARD_TYPES);
    for (const entry of entries) {
      const type = frontmatterScalar(entry.frontmatter, "type");
      if (type) set.add(type);
    }
    return Array.from(set).sort();
  }, [entries]);

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
          {(["outline", "files", "memo", "info"] as const).map((id) => (
            <button
              key={id}
              type="button"
              role="tab"
              aria-selected={tab === id}
              className={tab === id ? "active" : ""}
              onClick={() => setTab(id)}
              title={t(`rightPane.tab.${id}`)}
              aria-label={t(`rightPane.tab.${id}`)}
            >
              {id === "outline" ? (
                <List size={20} />
              ) : id === "files" ? (
                <Files size={20} />
              ) : id === "memo" ? (
                <StickyNote size={20} />
              ) : (
                <Info size={20} />
              )}
            </button>
          ))}
        </div>

        <div className="right-pane-content">
          {tab === "outline" ? (
            <>
              {document ? (
                headings.length > 0 ? (
                  <div className="outline-list">
                    {headings.map((heading, i) => (
                      <button
                        key={`${heading.line}-${i}`}
                        type="button"
                        className="outline-item"
                        data-level={heading.level}
                        onClick={() => onJumpToLine(heading.line)}
                        title={heading.text}
                      >
                        {heading.text}
                      </button>
                    ))}
                  </div>
                ) : (
                  <div className="outline-empty">
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
                />
              ) : null}
            </>
          ) : null}

          {tab === "files" ? (
            <FilesQueuePane
              queue={fileQueue}
              canApplyFileQueue={canApplyFileQueue}
              selectedIds={selectedFileQueueItemIds}
              onError={onError}
              onUpdateItem={onUpdateFileQueueItem}
              onSelectItem={onSelectFileQueueItem}
              onQueueExternalFiles={onQueueExternalFiles}
              onApply={onApplyFileQueue}
              onClear={onClearFileQueue}
              onClearSelected={onClearSelectedFileQueueItems}
              t={t}
            />
          ) : null}

          {tab === "memo" ? (
            <MemoPane
              workspacePath={workspacePath}
              onError={onError}
              onRefreshWorkspace={onRefreshWorkspace}
              t={t}
            />
          ) : null}

          {tab === "info" && document ? (
            <section className="inspector">
              <div className="inspector-header">
                <h3>{t("inspector.title")}</h3>
              </div>

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
          ) : tab === "info" ? (
            <div className="outline-empty">{t("outline.empty.noDocument")}</div>
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
  onApply: () => Promise<void>;
  onClear: () => void;
  onClearSelected: () => void;
  t: (key: string, vars?: Record<string, string | number>) => string;
}) {
  const [working, setWorking] = useState(false);
  const [viewMode, setViewMode] = useState<"list" | "icons">("list");
  const [contextMenu, setContextMenu] = useState<{ x: number; y: number } | null>(null);
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

  return (
    <section className="right-tool-pane">
      <div className="right-tool-actions file-shelf-toolbar">
        <button type="button" onClick={pickFiles}>
          <FilePlus2 size={13} />
          <span>{t("rightPane.files.pick")}</span>
        </button>
        <button type="button" onClick={pickFolders}>
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
        className={queue.length === 0 ? "file-drop-zone empty" : "file-drop-zone"}
        onContextMenu={(event) => {
          event.preventDefault();
          setContextMenu({ x: event.clientX, y: event.clientY });
        }}
      >
        <Files size={18} />
        <strong>{t("rightPane.files.dropTitle")}</strong>
        <span>{t("rightPane.files.dropDescription")}</span>
      </div>
      <div className={viewMode === "icons" ? "right-list file-shelf-icons" : "right-list"}>
        {queue.length === 0 ? (
          <div className="outline-empty">{t("rightPane.files.emptyQueue")}</div>
        ) : null}
        {queue.map((item) => (
          <div
            role="button"
            tabIndex={0}
            className={`right-list-item queue ${item.status}${selectedSet.has(item.id) ? " selected" : ""}`}
            key={item.id}
            title={item.sourcePath}
            aria-selected={selectedSet.has(item.id)}
            draggable={selectedSet.has(item.id)}
            onClick={(event) => onSelectItem(item.id, event.metaKey || event.ctrlKey || event.shiftKey)}
            onKeyDown={(event) => {
              if (event.key !== "Enter" && event.key !== " ") return;
              event.preventDefault();
              onSelectItem(item.id, event.metaKey || event.ctrlKey || event.shiftKey);
            }}
            onDragStart={(event) => {
              if (!selectedSet.has(item.id)) onSelectItem(item.id, false);
              event.dataTransfer.effectAllowed = "copyMove";
              event.dataTransfer.setData("application/x-anchor-file-queue", item.id);
            }}
          >
            <div className="queue-copy">
              <strong>
                {item.sourceKind === "directory" ? <Files size={12} /> : <FilePlus2 size={12} />}
                <span>{item.fileName}</span>
              </strong>
              <span>{item.sourceRelPath}</span>
              <span title={item.targetDir}>{t("rightPane.files.destination")}: {item.targetDir}</span>
              {item.message ? <em>{item.message}</em> : null}
            </div>
            <div className="queue-controls" onClick={(event) => event.stopPropagation()}>
              <button
                type="button"
                className={item.operation === "copy" ? "active" : ""}
                onClick={() => onUpdateItem(item.id, { operation: "copy" })}
                disabled={item.status !== "queued"}
                title={t("rightPane.files.copy")}
              >
                <Copy size={12} />
              </button>
              <button
                type="button"
                className={item.operation === "move" ? "active" : ""}
                onClick={() => onUpdateItem(item.id, { operation: "move" })}
                disabled={item.status !== "queued"}
                title={t("rightPane.files.move")}
              >
                <MoveRight size={12} />
              </button>
              <button
                type="button"
                onClick={() => void chooseDestination(item)}
                disabled={item.status !== "queued"}
                title={t("rightPane.files.chooseDestination")}
              >
                <Files size={12} />
              </button>
            </div>
          </div>
        ))}
      </div>
      <div className="right-tool-actions bottom">
        <button type="button" disabled={cannotApply} onClick={() => void apply()}>
          <Save size={13} />
          <span>{t("rightPane.files.applyQueue")}</span>
        </button>
        <button type="button" disabled={queue.length === 0 || working} onClick={onClear}>
          <Trash2 size={13} />
          <span>{t("rightPane.files.clearQueue")}</span>
        </button>
      </div>
      {contextMenu ? (
        <div
          className="context-menu"
          style={{ left: contextMenu.x, top: contextMenu.y }}
          onPointerDown={(event) => event.stopPropagation()}
        >
          <button type="button" onClick={() => { setContextMenu(null); void pickFiles(); }}>
            {t("rightPane.files.pick")}
          </button>
          <button type="button" onClick={() => { setContextMenu(null); void pickFolders(); }}>
            {t("rightPane.files.pickFolder")}
          </button>
          <div className="context-menu-separator" />
          <button
            type="button"
            disabled={selectedIds.length === 0}
            onClick={() => {
              setContextMenu(null);
              onClearSelected();
            }}
          >
            {t("rightPane.files.clearSelected", { count: selectedIds.length })}
          </button>
          <button
            type="button"
            disabled={queue.length === 0}
            onClick={() => {
              setContextMenu(null);
              onClear();
            }}
          >
            {t("rightPane.files.clearQueue")}
          </button>
        </div>
      ) : null}
    </section>
  );
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
        <button type="button" onClick={newMemo}>
          <Plus size={13} />
          <span>{t("rightPane.memo.new")}</span>
        </button>
        <button type="button" onClick={() => void refresh()}>
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
        <button type="button" className="danger" disabled={!workspacePath || !selectedPath || saving} onClick={() => void deleteCurrent()}>
          <Trash2 size={13} />
          <span>{t("rightPane.memo.delete")}</span>
        </button>
        <button type="button" disabled={saving} onClick={() => void saveAs()}>
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
