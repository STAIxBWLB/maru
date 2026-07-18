import { AlertTriangle, FileText, FolderOpen, RefreshCcw, Search } from "lucide-react";
import { useMemo, useState } from "react";
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
  error: string | null;
  statusFilter: InboxProcessedStatus | "all";
  query: string;
  detail: InboxProcessedItemDetail | null;
  /** When set, only items whose `channel` matches are shown (client-side). */
  channelFilter?: string | null;
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
  error,
  statusFilter,
  query,
  detail,
  channelFilter = null,
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
  const visibleItems = useMemo(
    () => (channelFilter ? items.filter((item) => item.channel === channelFilter) : items),
    [items, channelFilter],
  );
  return (
    <>
      <div className="processed-toolbar">
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
          <RefreshCcw size={14} />
        </button>
      </div>
      <div className="processed-layout">
        <div className="processed-list">
          {loading ? <div className="inbox-empty">{t("inbox.processed.loading")}</div> : null}
          {error ? <div className="inbox-error gmail-error">{error}</div> : null}
          {!loading && !error && visibleItems.length === 0 ? (
            <div className="inbox-empty">
              <FileText size={22} />
              <strong>{resolvedEmptyTitle}</strong>
              <span>{resolvedEmptyDescription}</span>
            </div>
          ) : null}
          {visibleItems.map((item) => (
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
