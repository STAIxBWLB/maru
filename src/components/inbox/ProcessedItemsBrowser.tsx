import { AlertTriangle, FileText, RefreshCcw, Search } from "lucide-react";
import { useMemo, useState } from "react";
import type React from "react";
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
  emptyTitle = "No processed items",
  emptyDescription = "Done, failed, and duplicate items from inbox/items will appear here.",
  searchPlaceholder = "Search processed items",
  onStatusFilter,
  onQuery,
  onRefresh,
  onSelect,
  onRevealPath,
  onContextMenu,
}: ProcessedItemsBrowserProps) {
  const [tab, setTab] = useState<ProcessedDetailTab>("summary");
  const visibleItems = useMemo(
    () => (channelFilter ? items.filter((item) => item.channel === channelFilter) : items),
    [items, channelFilter],
  );
  return (
    <>
      <div className="processed-toolbar">
        <div className="processed-status-chips" role="toolbar" aria-label="Processed status">
          {(["all", "done", "failed", "duplicate"] as Array<InboxProcessedStatus | "all">).map((status) => (
            <button
              type="button"
              key={status}
              className={statusFilter === status ? "inbox-filter-chip active" : "inbox-filter-chip"}
              onClick={() => onStatusFilter(status)}
            >
              {statusLabel(status)}
            </button>
          ))}
        </div>
        <label className="processed-search">
          <Search size={13} />
          <input
            value={query}
            onChange={(event) => onQuery(event.target.value)}
            placeholder={searchPlaceholder}
            spellCheck={false}
          />
        </label>
        <button
          type="button"
          className="icon-button"
          onClick={onRefresh}
          title="Refresh processed items"
          aria-label="Refresh processed items"
        >
          <RefreshCcw size={14} />
        </button>
      </div>
      <div className="processed-layout">
        <div className="processed-list">
          {loading ? <div className="inbox-empty">Loading processed items...</div> : null}
          {error ? <div className="inbox-error gmail-error">{error}</div> : null}
          {!loading && !error && visibleItems.length === 0 ? (
            <div className="inbox-empty">
              <FileText size={22} />
              <strong>{emptyTitle}</strong>
              <span>{emptyDescription}</span>
            </div>
          ) : null}
          {visibleItems.map((item) => (
            <button
              type="button"
              key={`${item.status}:${item.id}`}
              className={
                detail?.item.itemDir === item.itemDir
                  ? `processed-row active ${item.status}`
                  : `processed-row ${item.status}`
              }
              onClick={() => void onSelect(item)}
              onContextMenu={onContextMenu ? (event) => onContextMenu(event, item) : undefined}
            >
              <div className="processed-row-title">
                <span className={`status-chip ${item.status}`}>{statusLabel(item.status)}</span>
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
