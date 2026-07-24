import { AlertTriangle, FileText, FolderOpen, RefreshCcw, Search } from "lucide-react";
import { useState } from "react";
import type React from "react";
import { useTranslation } from "../../lib/i18n";
import type {
  InboxProcessedItem,
  InboxProcessedItemDetail,
  InboxProcessedStatus,
} from "../../lib/types";
import { ProcessedDetailPanel, type ProcessedDetailTab } from "./ProcessedDetailPanel";
import { formatShortDate, statusLabel } from "./processedFormat";

interface ProcessedItemsBrowserProps {
  items: InboxProcessedItem[];
  loading: boolean;
  refreshing?: boolean;
  error: string | null;
  statusFilter: InboxProcessedStatus | "all";
  query: string;
  detail: InboxProcessedItemDetail | null;
  emptyTitle?: string;
  emptyDescription?: string;
  searchPlaceholder?: string;
  onStatusFilter: (status: InboxProcessedStatus | "all") => void;
  onQuery: (query: string) => void;
  onRefresh: () => void;
  onSelect: (item: InboxProcessedItem) => void | Promise<void>;
  onRevealPath: (path: string) => void;
  onContextMenu?: (event: React.MouseEvent, item: InboxProcessedItem) => void;
}

export function ProcessedItemsBrowser({
  items,
  loading,
  refreshing = false,
  error,
  statusFilter,
  query,
  detail,
  emptyTitle,
  emptyDescription,
  searchPlaceholder,
  onStatusFilter,
  onQuery,
  onRefresh,
  onSelect,
  onRevealPath,
  onContextMenu,
}: ProcessedItemsBrowserProps) {
  const { t } = useTranslation();
  const [tab, setTab] = useState<ProcessedDetailTab>("summary");
  const resolvedEmptyTitle = emptyTitle ?? t("inbox.processed.empty.title");
  const resolvedEmptyDescription = emptyDescription ?? t("inbox.processed.empty.description");
  const resolvedSearchPlaceholder = searchPlaceholder ?? t("inbox.processed.searchPlaceholder");
  const filtered = statusFilter !== "all" || query.trim().length > 0;
  const initialLoading = loading && items.length === 0;
  const staleError = error && items.length > 0;
  return (
    <>
      <div className="processed-toolbar" aria-busy={loading || refreshing}>
        <div className="processed-status-chips" role="toolbar" aria-label={t("inbox.processed.statusFilter")}>
          {(["all", "done", "failed", "duplicate"] as Array<InboxProcessedStatus | "all">).map((status) => (
            <button
              type="button"
              key={status}
              className={statusFilter === status ? "inbox-filter-chip active" : "inbox-filter-chip"}
              onClick={() => onStatusFilter(status)}
            >
              {processedStatusLabel(status, t)}
            </button>
          ))}
        </div>
        <label className="processed-search">
          <Search size={13} />
          <input
            value={query}
            onChange={(event) => onQuery(event.target.value)}
            placeholder={resolvedSearchPlaceholder}
            spellCheck={false}
          />
        </label>
        <button
          type="button"
          className="icon-button"
          onClick={onRefresh}
          title={t("inbox.processed.refresh")}
          aria-label={t("inbox.processed.refresh")}
        >
          <RefreshCcw size={14} className={refreshing ? "spin" : undefined} />
        </button>
      </div>
      {refreshing ? (
        <div className="processed-state-line" role="status">
          <RefreshCcw size={13} className="spin" aria-hidden="true" />
          {t("inbox.processed.refreshing")}
        </div>
      ) : null}
      {staleError ? (
        <div className="processed-state-line error" role="alert">
          <AlertTriangle size={13} aria-hidden="true" />
          {error}
        </div>
      ) : null}
      <div className={detail ? "processed-layout has-detail" : "processed-layout"}>
        <div className="processed-list">
          {initialLoading ? (
            <div className="inbox-empty">{t("inbox.processed.loading")}</div>
          ) : null}
          {error && items.length === 0 ? (
            <div className="inbox-error gmail-error">{error}</div>
          ) : null}
          {!initialLoading && !error && items.length === 0 ? (
            <div className="inbox-empty">
              <FileText size={22} />
              <strong>
                {filtered ? t("inbox.processed.filteredEmpty.title") : resolvedEmptyTitle}
              </strong>
              <span>
                {filtered
                  ? t("inbox.processed.filteredEmpty.description")
                  : resolvedEmptyDescription}
              </span>
            </div>
          ) : null}
          {items.map((item) => (
            <div className="processed-row-wrap" key={`${item.status}:${item.id}`}>
              <button
                type="button"
                className={
                  detail?.item.itemDir === item.itemDir
                    ? `processed-row active ${item.status}`
                    : `processed-row ${item.status}`
                }
                onClick={() => void onSelect(item)}
                onContextMenu={onContextMenu ? (event) => onContextMenu(event, item) : undefined}
              >
                <div className="processed-row-title">
                  <span className={`status-chip ${item.status}`}>{processedStatusLabel(item.status, t)}</span>
                  <strong>{item.title || item.id}</strong>
                </div>
                <div className="processed-row-meta">
                  <span>{item.channel}</span>
                  {item.project ? <span>{item.project}</span> : null}
                  {item.classification ? <span>{item.classification}</span> : null}
                  {item.receivedAt ? <time>{formatShortDate(item.receivedAt)}</time> : null}
                </div>
                {item.summaryPreview ? <p>{item.summaryPreview}</p> : null}
                {item.error ? (
                  <div className="processed-row-error">
                    <AlertTriangle size={13} />
                    <span>{item.error}</span>
                  </div>
                ) : null}
              </button>
              <button
                type="button"
                className="icon-button processed-row-reveal"
                onClick={(event) => {
                  event.stopPropagation();
                  onRevealPath(item.itemDir);
                }}
                title={t("inbox.menu.revealFinder")}
                aria-label={t("inbox.menu.revealFinder")}
              >
                <FolderOpen size={14} />
              </button>
            </div>
          ))}
        </div>
        {detail ? (
          <ProcessedDetailPanel
            detail={detail}
            tab={tab}
            onTab={setTab}
            onRevealPath={onRevealPath}
          />
        ) : null}
      </div>
    </>
  );
}

const TRANSLATED_STATUSES = new Set(["all", "done", "failed", "duplicate"]);

function processedStatusLabel(status: string, t: (key: string) => string): string {
  return TRANSLATED_STATUSES.has(status)
    ? t(`inbox.processed.status.${status}`)
    : statusLabel(status);
}
