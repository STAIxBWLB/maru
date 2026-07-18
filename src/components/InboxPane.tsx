import {
  Brain,
  Check,
  ChevronDown,
  FilePlus2,
  FolderOpen,
  HelpCircle,
  Inbox,
  Loader2,
  Play,
  RefreshCcw,
  Settings,
  Upload,
  X,
} from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import type React from "react";
import { chooseFiles } from "../lib/api";
import { isInboxRowShareable } from "../lib/shareOutbox";
import {
  clearExplorerDragPayload,
  hasExplorerDragPayload,
  readExplorerDragPayload,
} from "../lib/fileDrag";
import {
  categoryLabel,
  countInboxEntryChannels,
  countInboxSources,
  filterEntriesByChannel,
  filterItemsBySource,
  groupEntriesByChannel,
  groupFilesBySource,
  inboxContextActionKeys,
  inboxTrashTargetsForRows,
  mergeInboxSourceKeys,
  shouldHandleInboxDeleteShortcut,
  uniqueEntryChannels,
  uniqueSources,
  type InboxDecision,
  type InboxItemState,
  type InboxTrashableRow,
} from "../lib/inbox";
import { useTranslation } from "../lib/i18n";
import { allSourceSelectValue } from "../lib/inboxSources";
import { useContextMenuKeyboard } from "../lib/useContextMenuKeyboard";
import type {
  InboxEntry,
  InboxFileDropConfig,
  InboxProcessedItem,
  InboxProcessedItemDetail,
  InboxProcessedStatus,
  InboxTrashTarget,
  MissionRecord,
} from "../lib/types";
import { BulkActionBar } from "./BulkActionBar";
import { InboxProcessComposer } from "./inbox/InboxProcessComposer";
import { ProcessedItemsBrowser } from "./inbox/ProcessedItemsBrowser";
import { InboxRunsPanel } from "./inbox/InboxRunsPanel";
import { formatBytes } from "./inbox/processedFormat";

interface InboxPaneProps {
  items: InboxItemState[];
  entries: InboxEntry[];
  loading: boolean;
  processedItems: InboxProcessedItem[];
  processedLoading: boolean;
  processedError: string | null;
  processedStatusFilter: InboxProcessedStatus | "all";
  processedQuery: string;
  processedDetail: InboxProcessedItemDetail | null;
  processingMissions: MissionRecord[];
  processingLogLines: Record<string, string[]>;
  sourceFilter: string | null;
  onSourceFilter: (source: string | null) => void;
  sourceFolderKeys?: string[];
  fileDropTarget: InboxFileDropConfig;
  onRefresh: () => void;
  onOpenSettings: () => void;
  onOpenInboxFolder?: () => void;
  onOpenSourceFolder?: (sourceKey: string) => void;
  focusRequest?: number;
  actionBusy?: boolean;
  onClassify: (id: string) => void;
  onDecide: (id: string, decision: InboxDecision) => void | Promise<void>;
  onBulkAccept: (keys: string[]) => void | Promise<void>;
  onBulkReject: (keys: string[]) => void | Promise<void>;
  onBulkMoveFiles: (keys: string[]) => void | Promise<void>;
  onProcessEntries: (keys: string[], context?: string) => void | Promise<void>;
  onStageFiles: (paths: string[]) => void | Promise<void>;
  onProcessedStatusFilter: (status: InboxProcessedStatus | "all") => void;
  onProcessedQuery: (query: string) => void;
  onRefreshProcessed: () => void;
  onSelectProcessedItem: (item: InboxProcessedItem) => void | Promise<void>;
  onRevealPath: (path: string) => void;
  onTrashItems: (targets: InboxTrashTarget[]) => void | Promise<void>;
  onStopProcessingMission: (id: string) => void | Promise<void>;
  workPath: string | null;
  onConfirmApproval: (input: {
    kind: string;
    summary: string;
    target?: string | null;
    payloadPreview?: string | null;
  }) => Promise<string | null>;
  onProcessApplied: () => void;
  onProcessError: (message: string | null) => void;
  /** Reports the absolute paths of shareable selected rows (drop files /
   *  dropFile entries) for the Shared Outbox tab. */
  onShareSelectionChange?: (paths: string[]) => void;
}

type InboxRow =
  | { key: string; kind: "entry"; entry: InboxEntry }
  | { key: string; kind: "file"; entry: InboxItemState };

type InboxContextMenuState = {
  x: number;
  y: number;
  title: string;
  path: string;
  targets: InboxTrashTarget[];
};

export function InboxPane({
  items,
  entries,
  loading,
  processedItems,
  processedLoading,
  processedError,
  processedStatusFilter,
  processedQuery,
  processedDetail,
  processingMissions,
  processingLogLines,
  sourceFilter,
  onSourceFilter,
  sourceFolderKeys = [],
  fileDropTarget,
  onRefresh,
  onOpenSettings,
  onOpenInboxFolder,
  onOpenSourceFolder,
  focusRequest = 0,
  actionBusy = false,
  onClassify,
  onDecide,
  onBulkAccept,
  onBulkReject,
  onBulkMoveFiles,
  onProcessEntries,
  onStageFiles,
  onProcessedStatusFilter,
  onProcessedQuery,
  onRefreshProcessed,
  onSelectProcessedItem,
  onRevealPath,
  onTrashItems,
  onStopProcessingMission,
  workPath,
  onConfirmApproval,
  onProcessApplied,
  onProcessError,
  onShareSelectionChange,
}: InboxPaneProps) {
  const { t, locale } = useTranslation();
  const paneRef = useRef<HTMLElement | null>(null);
  const [focusedKey, setFocusedKey] = useState<string | null>(null);
  const [selectedKeys, setSelectedKeys] = useState<Set<string>>(new Set());
  const [lastSelectedKey, setLastSelectedKey] = useState<string | null>(null);
  const [cheatsheetOpen, setCheatsheetOpen] = useState(false);
  const [dragOverDrop, setDragOverDrop] = useState(false);
  const [contextMenu, setContextMenu] = useState<InboxContextMenuState | null>(null);
  const [processComposer, setProcessComposer] = useState<{ keys: string[] } | null>(null);
  const contextMenuRef = useRef<HTMLDivElement>(null);
  const handleContextMenuKeyDown = useContextMenuKeyboard(
    contextMenuRef,
    !!contextMenu,
    () => setContextMenu(null),
  );
  const fileSources = useMemo(() => uniqueSources(items), [items]);
  const entrySources = useMemo(() => uniqueEntryChannels(entries), [entries]);
  const sources = useMemo(
    () => mergeInboxSourceKeys(sourceFolderKeys, entrySources, fileSources),
    [sourceFolderKeys, entrySources, fileSources],
  );
  const fileSourceCounts = useMemo(() => countInboxSources(items), [items]);
  const entrySourceCounts = useMemo(() => countInboxEntryChannels(entries), [entries]);
  const visibleEntries = useMemo(
    () => filterEntriesByChannel(entries, sourceFilter),
    [entries, sourceFilter],
  );
  const visibleItems = useMemo(
    () => filterItemsBySource(items, sourceFilter),
    [items, sourceFilter],
  );
  const entryGroups = useMemo(() => groupEntriesByChannel(visibleEntries), [visibleEntries]);
  const fileGroups = useMemo(() => groupFilesBySource(visibleItems), [visibleItems]);
  const pending = visibleItems.filter((entry) => entry.decision === "pending").length;
  const entryPending = visibleEntries.filter((entry) => entry.status !== "done").length;
  const totalSourceCount = entries.length + items.length;
  const countForSource = (source: string) =>
    (entrySourceCounts.get(source) ?? 0) + (fileSourceCounts.get(source) ?? 0);
  const selectedSourceCount =
    sourceFilter === null ? totalSourceCount : countForSource(sourceFilter);
  const allSourceValue = useMemo(() => allSourceSelectValue(sources), [sources]);
  const sourceSelectValue = sourceFilter ?? allSourceValue;
  const selectedFolderTitle =
    sourceFilter === null
      ? t("inbox.openFolder")
      : t("inbox.openSourceFolder", { source: sourceFilter });
  const selectedFolderDisabled =
    sourceFilter === null ? !onOpenInboxFolder : !onOpenSourceFolder;
  const rows = useMemo<InboxRow[]>(
    () => [
      ...entryGroups.flatMap((group) =>
        group.entries.map((entry) => ({
          key: `entry:${entry.id}`,
          kind: "entry" as const,
          entry,
        })),
      ),
      ...fileGroups.flatMap((group) =>
        group.items.map((entry) => ({
          key: `file:${entry.item.id}`,
          kind: "file" as const,
          entry,
        })),
      ),
    ],
    [entryGroups, fileGroups],
  );
  const selected = useMemo(
    () => rows.filter((row) => selectedKeys.has(row.key)),
    [rows, selectedKeys],
  );
  // Absolute paths of selected rows that map to concrete shareable files
  // (drop files / dropFile entries; pendingItem dirs are excluded).
  const shareablePaths = useMemo(
    () =>
      selected
        .filter((row) =>
          isInboxRowShareable({
            kind: row.kind,
            entryKind: row.kind === "entry" ? row.entry.kind : undefined,
          }),
        )
        .map((row) => pathForRow(row)),
    [selected],
  );
  useEffect(() => {
    onShareSelectionChange?.(shareablePaths);
  }, [shareablePaths, onShareSelectionChange]);
  const selectedDecisionKeys = useMemo(
    () => selected.filter((row) => row.kind !== "entry").map((row) => row.key),
    [selected],
  );
  const selectedFileCount = selected.filter((row) => row.kind === "file").length;
  const selectedEntryCount = selected.filter((row) => row.kind === "entry").length;
  const selectedDecisionCount = selectedDecisionKeys.length;
  const trashableRows = useMemo<InboxTrashableRow[]>(
    () => rows.map((row) => ({ key: row.key, trashTarget: trashTargetForRow(row) })),
    [rows],
  );

  useEffect(() => {
    const valid = new Set(rows.map((row) => row.key));
    setSelectedKeys((current) => new Set([...current].filter((key) => valid.has(key))));
    if (focusedKey && !valid.has(focusedKey)) setFocusedKey(rows[0]?.key ?? null);
  }, [focusedKey, rows]);

  useEffect(() => {
    if (sourceFilter !== null && !sources.includes(sourceFilter)) onSourceFilter(null);
  }, [onSourceFilter, sourceFilter, sources]);

  useEffect(() => {
    if (focusRequest <= 0) return;
    const next = firstPendingKey(rows) ?? rows[0]?.key ?? null;
    setFocusedKey(next);
    paneRef.current?.focus({ preventScroll: true });
  }, [focusRequest, rows]);

  useEffect(() => {
    let dispose: (() => void) | null = null;
    void import("@tauri-apps/api/webview")
      .then(({ getCurrentWebview }) =>
        getCurrentWebview().onDragDropEvent((event) => {
          if (event.payload.type === "drop") {
            void onStageFiles(event.payload.paths);
            setDragOverDrop(false);
          } else if (event.payload.type === "over") {
            setDragOverDrop(true);
          } else {
            setDragOverDrop(false);
          }
        }),
      )
      .then((off) => {
        dispose = off;
      })
      .catch(() => {});
    return () => dispose?.();
  }, [onStageFiles]);

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

  const actOnKeys = async (keys: string[], decision: InboxDecision) => {
    const decisionKeys = keys.filter((key) => !key.startsWith("entry:"));
    if (decisionKeys.length > 1) {
      if (decision === "accepted") await onBulkAccept(decisionKeys);
      else await onBulkReject(decisionKeys);
      return;
    }
    const key = decisionKeys[0];
    if (!key) return;
    if (key.startsWith("file:")) await onDecide(key.slice("file:".length), decision);
  };

  const processActionKeys = () => {
    const selectedEntryKeys = [...selectedKeys].filter((key) => key.startsWith("entry:"));
    if (selectedEntryKeys.length > 0) return selectedEntryKeys;
    if (focusedKey?.startsWith("entry:")) return [focusedKey];
    const fallback = rows.find((row) => row.kind === "entry")?.key;
    return fallback ? [fallback] : [];
  };

  // Distinct channels of the staged entry keys, for the composer's
  // `inbox-process <channels>` preview line.
  const channelsForKeys = (keys: string[]): string[] => {
    const ids = new Set(
      keys.filter((key) => key.startsWith("entry:")).map((key) => key.slice("entry:".length)),
    );
    const channels = entries
      .filter((entry) => ids.has(entry.id))
      .map((entry) => entry.channel)
      .filter(Boolean);
    return [...new Set(channels)].sort();
  };

  // All Process triggers route through here so the user can add free-text
  // context before the run is dispatched.
  const openProcessComposer = (keys: string[]) => {
    if (keys.length === 0) return;
    setProcessComposer({ keys });
  };

  const actionKeys = () => {
    const keys = selectedKeys.size > 0 ? [...selectedKeys] : focusedKey ? [focusedKey] : [];
    if (keys.length > 0) return keys;
    const fallback = firstPendingKey(rows) ?? rows[0]?.key;
    return fallback ? [fallback] : [];
  };

  const trashActionKeys = () => {
    if (selectedKeys.size > 0) return [...selectedKeys];
    return focusedKey ? [focusedKey] : [];
  };

  const trashRows = async (keys = trashActionKeys()) => {
    if (keys.length === 0) return;
    const targets = inboxTrashTargetsForRows(trashableRows, keys);
    if (targets.length === 0) {
      window.alert(t("inbox.delete.unsupported"));
      return;
    }
    await onTrashItems(targets);
    setSelectedKeys((current) => new Set([...current].filter((key) => !keys.includes(key))));
    if (focusedKey && keys.includes(focusedKey)) setFocusedKey(null);
  };

  const moveFocus = (delta: number) => {
    if (rows.length === 0) return;
    const current = focusedKey ? rows.findIndex((row) => row.key === focusedKey) : -1;
    const next = Math.max(0, Math.min(rows.length - 1, current + delta));
    setFocusedKey(rows[next].key);
  };

  const toggleSelection = (key: string, range = false) => {
    if (range && lastSelectedKey) {
      const from = rows.findIndex((row) => row.key === lastSelectedKey);
      const to = rows.findIndex((row) => row.key === key);
      if (from >= 0 && to >= 0) {
        const [start, end] = from < to ? [from, to] : [to, from];
        setSelectedKeys((current) => {
          const next = new Set(current);
          rows.slice(start, end + 1).forEach((row) => next.add(row.key));
          return next;
        });
        setFocusedKey(key);
        return;
      }
    }
    setSelectedKeys((current) => {
      const next = new Set(current);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
    setLastSelectedKey(key);
    setFocusedKey(key);
  };

  const handleRowClick = (event: React.MouseEvent, key: string) => {
    const target = event.target as HTMLElement | null;
    if (target?.closest("button,input,a,select,textarea")) return;
    if (event.shiftKey) toggleSelection(key, true);
    else if (event.metaKey || event.ctrlKey) toggleSelection(key);
    else setFocusedKey(key);
  };

  const openRowContextMenu = (event: React.MouseEvent, row: InboxRow) => {
    event.preventDefault();
    event.stopPropagation();
    const keys = inboxContextActionKeys(selectedKeys, row.key);
    if (!selectedKeys.has(row.key)) {
      setSelectedKeys(new Set([row.key]));
      setLastSelectedKey(row.key);
    }
    setFocusedKey(row.key);
    const targets = inboxTrashTargetsForRows(trashableRows, keys);
    setContextMenu({
      x: event.clientX,
      y: event.clientY,
      title:
        keys.length > 1
          ? t("inbox.menu.selectionTitle", { count: keys.length })
          : titleForRow(row),
      path: pathForRow(row),
      targets,
    });
  };

  const openProcessedContextMenu = (event: React.MouseEvent, item: InboxProcessedItem) => {
    event.preventDefault();
    event.stopPropagation();
    setContextMenu({
      x: event.clientX,
      y: event.clientY,
      title: item.title || item.id,
      path: item.itemDir,
      targets: [{ id: item.id, kind: "processedItem", path: item.itemDir }],
    });
  };

  const copyContextPath = () => {
    if (!contextMenu?.path) return;
    void navigator.clipboard?.writeText(contextMenu.path).catch(() => {});
    setContextMenu(null);
  };

  const trashContextTargets = async () => {
    const targets = contextMenu?.targets ?? [];
    setContextMenu(null);
    if (targets.length === 0) {
      window.alert(t("inbox.delete.unsupported"));
      return;
    }
    await onTrashItems(targets);
    const targetPaths = new Set(targets.map((target) => target.path));
    setSelectedKeys((current) =>
      new Set(
        [...current].filter((key) => {
          const target = inboxTrashTargetsForRows(trashableRows, [key])[0];
          return target ? !targetPaths.has(target.path) : true;
        }),
      ),
    );
  };

  const pickDropFiles = async () => {
    const paths = await chooseFiles(t("inbox.drop.chooseTitle"));
    if (paths.length > 0) await onStageFiles(paths);
  };

  const stageExplorerPayload = (event: React.DragEvent) => {
    const payload = readExplorerDragPayload(event.dataTransfer);
    if (!payload) return false;
    event.preventDefault();
    clearExplorerDragPayload();
    void onStageFiles(payload.items.map((item) => item.path));
    setDragOverDrop(false);
    return true;
  };

  const handleDropZoneDragOver = (event: React.DragEvent) => {
    if (!hasExplorerDragPayload(event.dataTransfer)) return;
    event.preventDefault();
    event.dataTransfer.dropEffect = "copy";
    setDragOverDrop(true);
  };

  const fileDropLabel = `${fileDropTarget.channel} · ${fileDropTarget.drop_path}`;

  return (
    <main
      className="inbox-pane"
      ref={paneRef}
      tabIndex={-1}
      onKeyDown={(event) => {
        const tag = (event.target as HTMLElement | null)?.tagName.toLowerCase();
        const isContentEditable = Boolean((event.target as HTMLElement | null)?.isContentEditable);
        if (shouldHandleInboxDeleteShortcut({
          key: event.key,
          metaKey: event.metaKey,
          ctrlKey: event.ctrlKey,
          altKey: event.altKey,
          targetTag: tag,
          isContentEditable,
        })) {
          event.preventDefault();
          void trashRows();
          return;
        }
        if (event.metaKey || event.ctrlKey || event.altKey) return;
        if (tag === "input" || tag === "textarea" || isContentEditable) {
          return;
        }
        if (event.key === "ArrowDown") {
          event.preventDefault();
          moveFocus(1);
        } else if (event.key === "ArrowUp") {
          event.preventDefault();
          moveFocus(-1);
        } else if (event.key.toLowerCase() === "a") {
          event.preventDefault();
          void actOnKeys(actionKeys(), "accepted");
        } else if (event.key.toLowerCase() === "r") {
          event.preventDefault();
          void actOnKeys(actionKeys(), "rejected");
        } else if (event.key.toLowerCase() === "p") {
          event.preventDefault();
          openProcessComposer(processActionKeys());
        } else if (event.key === "?") {
          event.preventDefault();
          setCheatsheetOpen((value) => !value);
        }
      }}
    >
      <header className="inbox-header">
        <div>
          <h2>{t("inbox.title")}</h2>
          <p>
            {t("inbox.subtitle.combined", {
              files: pending.toLocaleString(locale),
            })}
            {entryPending > 0 ? ` · ${t("inbox.subtitle.processing", { count: entryPending.toLocaleString(locale) })}` : ""}
          </p>
        </div>
        <div className="inbox-header-actions">
          <button
            type="button"
            className="icon-button"
            onClick={() => onOpenInboxFolder?.()}
            disabled={!onOpenInboxFolder}
            title={t("inbox.openFolder")}
            aria-label={t("inbox.openFolder")}
          >
            <FolderOpen size={15} />
          </button>
          <button
            type="button"
            className="icon-button"
            onClick={() => setCheatsheetOpen((value) => !value)}
            title={t("inbox.keyboardHelp")}
            aria-label={t("inbox.keyboardHelp")}
          >
            <HelpCircle size={15} />
          </button>
          <button
            type="button"
            className="icon-button"
            onClick={onOpenSettings}
            title={t("inbox.settings.open")}
            aria-label={t("inbox.settings.open")}
          >
            <Settings size={15} />
          </button>
          <button
            type="button"
            className="icon-button"
            onClick={onRefresh}
            title={t("inbox.refresh")}
            aria-label={t("inbox.refresh")}
          >
            <RefreshCcw size={15} />
          </button>
        </div>
      </header>

      {cheatsheetOpen ? (
        <div className="inbox-cheatsheet">
          <span>{t("inbox.cheatsheet.focus")}</span>
          <span>{t("inbox.cheatsheet.accept")}</span>
          <span>{t("inbox.cheatsheet.reject")}</span>
          <span>{t("inbox.cheatsheet.process")}</span>
          <span>{t("inbox.cheatsheet.select")}</span>
        </div>
      ) : null}

      {sources.length > 0 ? (
        <div
          className="inbox-filter-row inbox-source-toolbar"
          role="toolbar"
          aria-label={t("inbox.filter.label")}
        >
          <label className="inbox-source-select-control">
            <span className="inbox-source-select-label">{t("inbox.filter.source")}</span>
            <span className="inbox-source-select-wrap">
              <select
                className="inbox-source-select"
                value={sourceSelectValue}
                onChange={(event) => {
                  const value = event.target.value;
                  onSourceFilter(value === allSourceValue ? null : value);
                }}
              >
                <option value={allSourceValue}>{t("inbox.filter.all")}</option>
                {sources.map((source) => (
                  <option value={source} key={source}>
                    {source}
                  </option>
                ))}
              </select>
              <ChevronDown
                size={14}
                className="inbox-source-select-chevron"
                aria-hidden="true"
              />
            </span>
          </label>
          <span className="inbox-source-count-badge">
            {selectedSourceCount.toLocaleString(locale)}
          </span>
          <button
            type="button"
            className="icon-button inbox-filter-folder-button"
            onClick={() => {
              if (sourceFilter === null) onOpenInboxFolder?.();
              else onOpenSourceFolder?.(sourceFilter);
            }}
            disabled={selectedFolderDisabled}
            title={selectedFolderTitle}
            aria-label={selectedFolderTitle}
          >
            <FolderOpen size={14} />
          </button>
        </div>
      ) : null}

      <div className="inbox-sections">
        <InboxSection
          title={t("inbox.section.configuredEntries")}
        >
            <div className="inbox-list">
              {visibleEntries.length === 0 ? (
                <div className="inbox-empty">
                  <Inbox size={24} />
                  <strong>{t("inbox.entries.empty.title")}</strong>
                  <span>{t("inbox.entries.empty.description")}</span>
                </div>
              ) : null}
              {entryGroups.map((group) => (
                <div className="inbox-source-group-block" key={`entry-group:${group.key}`}>
                  <InboxSourceGroupHeader
                    source={group.key}
                    count={group.entries.length.toLocaleString(locale)}
                    title={t("inbox.openSourceFolder", { source: group.key })}
                    onOpen={onOpenSourceFolder ? () => onOpenSourceFolder(group.key) : undefined}
                  />
                  {group.entries.map((entry) => {
                    const key = `entry:${entry.id}`;
                    const row: InboxRow = { key, kind: "entry", entry };
                    return (
                      <article
                        className={`inbox-item configured-inbox-item${focusedKey === key ? " focused" : ""}${selectedKeys.has(key) ? " selected" : ""}`}
                        key={entry.id}
                        data-inbox-row-key={key}
                        onClick={(event) => handleRowClick(event, key)}
                        onContextMenu={(event) => openRowContextMenu(event, row)}
                      >
                        <input
                          type="checkbox"
                          className="inbox-row-check"
                          checked={selectedKeys.has(key)}
                          onClick={(event) => {
                            event.stopPropagation();
                            toggleSelection(key, event.shiftKey);
                          }}
                          onChange={() => {}}
                          aria-label={t("inbox.row.select", { title: entry.title })}
                        />
                        <div className="inbox-item-main">
                          <div className="inbox-item-title">
                            <span className="source-chip">{entry.channel}</span>
                            <strong>{entry.title}</strong>
                          </div>
                          <p className="inbox-item-hint">
                            {entry.kind === "pendingItem" ? t("inbox.entryKind.pendingItem") : t("inbox.entryKind.dropFile")}
                            {entry.sourceKind ? ` · ${entry.sourceKind}` : ""}
                          </p>
                          <div className="inbox-item-meta">
                            <span>{entry.relPath}</span>
                            {entry.status ? <span>{entry.status}</span> : null}
                            {entry.kind === "dropFile" ? <span>{formatBytes(entry.sizeBytes)}</span> : null}
                          </div>
                          {entry.manifestPath ? (
                            <div className="inbox-item-meta">
                              <span>{entry.manifestPath}</span>
                            </div>
                          ) : null}
                        </div>
                        <div className="inbox-decision">
                          <button
                            type="button"
                            className="icon-button"
                            onClick={(event) => {
                              event.stopPropagation();
                              onRevealPath(pathForRow(row));
                            }}
                            title={t("inbox.menu.revealFinder")}
                            aria-label={t("inbox.menu.revealFinder")}
                          >
                            <FolderOpen size={14} />
                          </button>
                          <button
                            type="button"
                            className="button button-ghost button-sm"
                            disabled={actionBusy}
                            onClick={(event) => {
                              event.stopPropagation();
                              openProcessComposer([key]);
                            }}
                          >
                            <Play size={14} />
                            <span>{t("inbox.process")}</span>
                          </button>
                        </div>
                      </article>
                    );
                  })}
                </div>
              ))}
            </div>
        </InboxSection>

        <InboxSection title={t("inbox.section.processing")}>
          <InboxRunsPanel
            workPath={workPath}
            missions={processingMissions}
            logLines={processingLogLines}
            onStopMission={(id) => void onStopProcessingMission(id)}
            onRefreshMissions={onRefresh}
            onConfirmApproval={onConfirmApproval}
            onApplied={onProcessApplied}
            onError={onProcessError}
          />
        </InboxSection>

        <InboxSection title={t("inbox.section.processedItems")}>
          <ProcessedItemsBrowser
            items={processedItems}
            loading={processedLoading}
            error={processedError}
            statusFilter={processedStatusFilter}
            query={processedQuery}
            detail={processedDetail}
            onStatusFilter={onProcessedStatusFilter}
            onQuery={onProcessedQuery}
            onRefresh={onRefreshProcessed}
            onSelect={onSelectProcessedItem}
            onRevealPath={onRevealPath}
            onContextMenu={openProcessedContextMenu}
          />
        </InboxSection>

        <InboxSection
          title={t("inbox.section.files")}
        >
          <div className="inbox-list">
            <div
              className={[
                "inbox-file-drop-zone",
                dragOverDrop ? "drag-over" : "",
              ].filter(Boolean).join(" ")}
              onDragOver={handleDropZoneDragOver}
              onDragLeave={() => setDragOverDrop(false)}
              onDrop={(event) => {
                if (stageExplorerPayload(event)) return;
                setDragOverDrop(false);
              }}
            >
              <Upload size={20} />
              <strong>{t("inbox.drop.title")}</strong>
              <span>{fileDropLabel}</span>
              <button
                type="button"
                className="button button-ghost button-sm"
                onClick={() => void pickDropFiles()}
                disabled={actionBusy}
              >
                <FilePlus2 size={14} />
                <span>{t("inbox.drop.choose")}</span>
              </button>
            </div>
            {loading ? <div className="inbox-empty">{t("inbox.loading")}</div> : null}
            {!loading && visibleItems.length === 0 ? (
              <div className="inbox-empty" title={t("inbox.empty.title")}>
                <Inbox size={24} />
                <strong>{t("inbox.empty.title")}</strong>
                <span>{t("inbox.empty.dropHint")}</span>
              </div>
            ) : null}
            {fileGroups.map((group) => (
              <div className="inbox-source-group-block" key={`file-group:${group.key}`}>
                <InboxSourceGroupHeader
                  source={group.key}
                  count={group.items.length.toLocaleString(locale)}
                  title={t("inbox.openSourceFolder", { source: group.key })}
                  onOpen={onOpenSourceFolder ? () => onOpenSourceFolder(group.key) : undefined}
                />
                {group.items.map((entry) => {
                  const key = `file:${entry.item.id}`;
                  const row: InboxRow = { key, kind: "file", entry };
                  return (
                    <article
                      className={`inbox-item ${entry.decision}${focusedKey === key ? " focused" : ""}${selectedKeys.has(key) ? " selected" : ""}`}
                      key={entry.item.id}
                      data-inbox-row-key={key}
                      onClick={(event) => handleRowClick(event, key)}
                      onContextMenu={(event) => openRowContextMenu(event, row)}
                    >
                      <input
                        type="checkbox"
                        className="inbox-row-check"
                        checked={selectedKeys.has(key)}
                        onClick={(event) => {
                          event.stopPropagation();
                          toggleSelection(key, event.shiftKey);
                        }}
                        onChange={() => {}}
                        aria-label={t("inbox.row.select", { title: entry.item.title })}
                      />
                      <div className="inbox-item-main">
                        <div className="inbox-item-title">
                          <span className="source-chip">{entry.item.source}</span>
                          <strong>{entry.item.title}</strong>
                        </div>

                        {entry.classification ? (
                          <p>
                            <span className="category-chip">
                              {categoryLabel(entry.classification.category)}
                            </span>{" "}
                            {entry.classification.summary}
                          </p>
                        ) : (
                          <p className="inbox-item-hint">{t("inbox.notClassified")}</p>
                        )}

                        <div className="inbox-item-meta">
                          <span>{formatBytes(entry.item.sizeBytes)}</span>
                          {entry.item.receivedAt ? (
                            <time dateTime={entry.item.receivedAt}>{entry.item.receivedAt}</time>
                          ) : null}
                          {entry.classification?.suggestedFolder ? (
                            <span className="suggested-folder">
                              → {entry.classification.suggestedFolder}
                            </span>
                          ) : null}
                        </div>

                        {entry.classifyError ? (
                          <div className="inbox-error">{entry.classifyError}</div>
                        ) : null}
                      </div>

                      <div className="inbox-decision">
                        <button
                          type="button"
                          className="button button-ghost button-sm"
                          onClick={(event) => {
                            event.stopPropagation();
                            onClassify(entry.item.id);
                          }}
                          disabled={entry.classifying}
                          title={t("inbox.classify")}
                        >
                          {entry.classifying ? (
                            <Loader2 size={14} className="spin" />
                          ) : (
                            <Brain size={14} />
                          )}
                          <span>{t("inbox.classify")}</span>
                        </button>
                        <span className="decision-status">{t(`inbox.decision.${entry.decision}`)}</span>
                        <button
                          type="button"
                          className="icon-button"
                          onClick={(event) => {
                            event.stopPropagation();
                            void onDecide(entry.item.id, "accepted");
                          }}
                          title={t("inbox.accept")}
                          aria-label={t("inbox.accept")}
                        >
                          <Check size={14} />
                        </button>
                        <button
                          type="button"
                          className="icon-button"
                          onClick={(event) => {
                            event.stopPropagation();
                            void onDecide(entry.item.id, "rejected");
                          }}
                          title={t("inbox.reject")}
                          aria-label={t("inbox.reject")}
                        >
                          <X size={14} />
                        </button>
                        <button
                          type="button"
                          className="icon-button"
                          onClick={(event) => {
                            event.stopPropagation();
                            onRevealPath(entry.item.path);
                          }}
                          title={t("inbox.menu.revealFinder")}
                          aria-label={t("inbox.menu.revealFinder")}
                        >
                          <FolderOpen size={14} />
                        </button>
                      </div>
                    </article>
                  );
                })}
              </div>
            ))}
          </div>
        </InboxSection>

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
          <div className="context-menu-title" title={contextMenu.path}>
            {contextMenu.title}
          </div>
          <button
            type="button"
            role="menuitem"
            onClick={() => {
              const path = contextMenu.path;
              setContextMenu(null);
              onRevealPath(path);
            }}
          >
            <span>{t("inbox.menu.revealFinder")}</span>
          </button>
          <button type="button" role="menuitem" onClick={copyContextPath}>
            <span>{t("inbox.menu.copyPath")}</span>
          </button>
          <div className="context-menu-separator" role="separator" />
          <button
            type="button"
            role="menuitem"
            className="danger"
            disabled={contextMenu.targets.length === 0 || actionBusy}
            onClick={() => void trashContextTargets()}
          >
            <span>{t("inbox.menu.delete")}</span>
          </button>
        </div>
      ) : null}
      <BulkActionBar
        count={selectedKeys.size}
        fileCount={selectedFileCount}
        entryCount={selectedEntryCount}
        decisionCount={selectedDecisionCount}
        busy={actionBusy}
        onAccept={() => void onBulkAccept(selectedDecisionKeys)}
        onReject={() => void onBulkReject(selectedDecisionKeys)}
        onMoveFiles={() => void onBulkMoveFiles([...selectedKeys])}
        onProcess={() => openProcessComposer([...selectedKeys])}
        onCancel={() => setSelectedKeys(new Set())}
      />
      <InboxProcessComposer
        open={processComposer !== null}
        targetCount={
          processComposer
            ? processComposer.keys.filter((key) => key.startsWith("entry:")).length
            : 0
        }
        channels={processComposer ? channelsForKeys(processComposer.keys) : []}
        busy={actionBusy}
        onRun={(context) => {
          const keys = processComposer?.keys ?? [];
          setProcessComposer(null);
          void onProcessEntries(keys, context);
        }}
        onCancel={() => setProcessComposer(null)}
      />
    </main>
  );
}

function InboxSection({
  title,
  children,
}: {
  title: string;
  children: React.ReactNode;
}) {
  return (
    <section className="inbox-section">
      <div className="inbox-section-header">
        <div className="inbox-section-title">
          <span>{title}</span>
        </div>
      </div>
      {children}
    </section>
  );
}

function InboxSourceGroupHeader({
  source,
  count,
  title,
  onOpen,
}: {
  source: string;
  count: string;
  title: string;
  onOpen?: () => void;
}) {
  return (
    <div className="inbox-source-group">
      <div className="inbox-source-group-label">
        <span>{source}</span>
        <span className="count">{count}</span>
      </div>
      <button
        type="button"
        className="icon-button"
        onClick={(event) => {
          event.stopPropagation();
          onOpen?.();
        }}
        disabled={!onOpen}
        title={title}
        aria-label={title}
      >
        <FolderOpen size={14} />
      </button>
    </div>
  );
}

function trashTargetForRow(row: InboxRow): InboxTrashTarget {
  if (row.kind === "entry") {
    return {
      id: row.entry.id,
      kind: row.entry.kind,
      path: row.entry.path,
    };
  }
  return {
    id: row.entry.item.id,
    kind: "dropFile",
    path: row.entry.item.path,
  };
}

function titleForRow(row: InboxRow): string {
  return row.kind === "entry" ? row.entry.title : row.entry.item.title;
}

function pathForRow(row: InboxRow): string {
  return row.kind === "entry" ? row.entry.path : row.entry.item.path;
}

function firstPendingKey(rows: InboxRow[]): string | null {
  const row = rows.find((entry) => {
    if (entry.kind === "entry") return entry.entry.status !== "done";
    if (entry.kind === "file") return entry.entry.decision === "pending";
    return false;
  });
  return row?.key ?? null;
}
