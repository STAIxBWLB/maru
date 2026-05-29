import {
  Brain,
  Check,
  FilePlus2,
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
import {
  clearExplorerDragPayload,
  hasExplorerDragPayload,
  readExplorerDragPayload,
} from "../lib/fileDrag";
import {
  categoryLabel,
  countInboxSources,
  filterItemsBySource,
  inboxContextActionKeys,
  inboxTrashTargetsForRows,
  shouldHandleInboxDeleteShortcut,
  uniqueSources,
  type InboxDecision,
  type InboxItemState,
  type InboxTrashableRow,
} from "../lib/inbox";
import { useTranslation } from "../lib/i18n";
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
import { ProcessedItemsBrowser } from "./inbox/ProcessedItemsBrowser";
import { ProcessingMissionsPanel } from "./inbox/ProcessingMissionsPanel";
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
  fileDropTarget: InboxFileDropConfig;
  onRefresh: () => void;
  onOpenSettings: () => void;
  focusRequest?: number;
  actionBusy?: boolean;
  onClassify: (id: string) => void;
  onDecide: (id: string, decision: InboxDecision) => void | Promise<void>;
  onBulkAccept: (keys: string[]) => void | Promise<void>;
  onBulkReject: (keys: string[]) => void | Promise<void>;
  onBulkMoveFiles: (keys: string[]) => void | Promise<void>;
  onProcessEntries: (keys: string[]) => void | Promise<void>;
  onStageFiles: (paths: string[]) => void | Promise<void>;
  onProcessedStatusFilter: (status: InboxProcessedStatus | "all") => void;
  onProcessedQuery: (query: string) => void;
  onRefreshProcessed: () => void;
  onSelectProcessedItem: (item: InboxProcessedItem) => void | Promise<void>;
  onRevealPath: (path: string) => void;
  onTrashItems: (targets: InboxTrashTarget[]) => void | Promise<void>;
  onStopProcessingMission: (id: string) => void | Promise<void>;
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
  fileDropTarget,
  onRefresh,
  onOpenSettings,
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
}: InboxPaneProps) {
  const { t, locale } = useTranslation();
  const paneRef = useRef<HTMLElement | null>(null);
  const [focusedKey, setFocusedKey] = useState<string | null>(null);
  const [selectedKeys, setSelectedKeys] = useState<Set<string>>(new Set());
  const [lastSelectedKey, setLastSelectedKey] = useState<string | null>(null);
  const [cheatsheetOpen, setCheatsheetOpen] = useState(false);
  const [dragOverDrop, setDragOverDrop] = useState(false);
  const [contextMenu, setContextMenu] = useState<InboxContextMenuState | null>(null);
  const contextMenuRef = useRef<HTMLDivElement>(null);
  const handleContextMenuKeyDown = useContextMenuKeyboard(
    contextMenuRef,
    !!contextMenu,
    () => setContextMenu(null),
  );
  const sources = useMemo(() => uniqueSources(items), [items]);
  const sourceCounts = useMemo(() => countInboxSources(items), [items]);
  const visibleItems = useMemo(
    () => filterItemsBySource(items, sourceFilter),
    [items, sourceFilter],
  );
  const pending = visibleItems.filter((entry) => entry.decision === "pending").length;
  const entryPending = entries.filter((entry) => entry.status !== "done").length;
  const rows = useMemo<InboxRow[]>(
    () => [
      ...entries.map((entry) => ({ key: `entry:${entry.id}`, kind: "entry" as const, entry })),
      ...visibleItems.map((entry) => ({ key: `file:${entry.item.id}`, kind: "file" as const, entry })),
    ],
    [entries, visibleItems],
  );
  const selected = useMemo(
    () => rows.filter((row) => selectedKeys.has(row.key)),
    [rows, selectedKeys],
  );
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
    const paths = await chooseFiles("Choose files for Inbox");
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
          void onProcessEntries(processActionKeys());
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
            {entryPending > 0 ? ` · process ${entryPending.toLocaleString(locale)}` : ""}
          </p>
        </div>
        <div className="inbox-header-actions">
          <button
            type="button"
            className="icon-button"
            onClick={() => setCheatsheetOpen((value) => !value)}
            title="Keyboard help"
            aria-label="Keyboard help"
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
          <span>↑/↓ focus</span>
          <span>a accept</span>
          <span>r reject</span>
          <span>p process</span>
          <span>shift/cmd click select</span>
        </div>
      ) : null}

      {sources.length > 0 ? (
        <div className="inbox-filter-row" role="toolbar" aria-label={t("inbox.filter.label")}>
          <button
            type="button"
            className={sourceFilter === null ? "inbox-filter-chip active" : "inbox-filter-chip"}
            onClick={() => onSourceFilter(null)}
          >
            {t("inbox.filter.all")} <span className="count">{items.length}</span>
          </button>
          {sources.map((source) => {
            const count = sourceCounts.get(source) ?? 0;
            const active = sourceFilter === source;
            return (
              <button
                type="button"
                key={source}
                className={active ? "inbox-filter-chip active" : "inbox-filter-chip"}
                onClick={() => onSourceFilter(active ? null : source)}
              >
                {source} <span className="count">{count}</span>
              </button>
            );
          })}
        </div>
      ) : null}

      <div className="inbox-sections">
        <InboxSection
          title="CONFIGURED ENTRIES"
        >
            <div className="inbox-list">
              {entries.length === 0 ? (
                <div className="inbox-empty">
                  <Inbox size={24} />
                  <strong>No configured inbox items</strong>
                  <span>Configured drop files and pending manifests will appear here.</span>
                </div>
              ) : null}
              {entries.map((entry) => {
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
                          aria-label={`Select ${entry.title}`}
                        />
                        <div className="inbox-item-main">
                          <div className="inbox-item-title">
                            <span className="source-chip">{entry.channel}</span>
                            <strong>{entry.title}</strong>
                          </div>
                          <p className="inbox-item-hint">
                            {entry.kind === "pendingItem" ? "pending item" : "drop file"}
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
                            className="button button-ghost button-sm"
                            disabled={actionBusy}
                            onClick={(event) => {
                              event.stopPropagation();
                              void onProcessEntries([key]);
                            }}
                          >
                            <Play size={14} />
                            <span>Process</span>
                          </button>
                        </div>
                      </article>
                    );
                  })}
            </div>
        </InboxSection>

        <InboxSection title="PROCESSING">
          <ProcessingMissionsPanel
            missions={processingMissions}
            logLines={processingLogLines}
            onStop={onStopProcessingMission}
          />
        </InboxSection>

        <InboxSection title="PROCESSED ITEMS">
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
          title="FILES"
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
              <strong>Drop files for Inbox</strong>
              <span>{fileDropLabel}</span>
              <button
                type="button"
                className="button button-ghost button-sm"
                onClick={() => void pickDropFiles()}
                disabled={actionBusy}
              >
                <FilePlus2 size={14} />
                <span>Choose files</span>
              </button>
            </div>
            {loading ? <div className="inbox-empty">{t("inbox.loading")}</div> : null}
            {!loading && visibleItems.length === 0 ? (
              <div className="inbox-empty" title={t("inbox.empty.title")}>
                <Inbox size={24} />
                <strong>{t("inbox.empty.title")}</strong>
                <span>Drop or choose files above to stage them into the configured inbox.</span>
              </div>
            ) : null}
            {visibleItems.map((entry) => {
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
                  aria-label={`Select ${entry.item.title}`}
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
                </div>
              </article>
            );
            })}
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
        onProcess={() => void onProcessEntries([...selectedKeys])}
        onCancel={() => setSelectedKeys(new Set())}
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
