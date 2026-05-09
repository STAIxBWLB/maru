import { Brain, Check, HelpCircle, Inbox, Loader2, Mail, Play, RefreshCcw, Settings, X } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import type React from "react";
import { type GmailMessageState, shortFrom } from "../lib/gmail";
import {
  categoryLabel,
  filterItemsBySource,
  uniqueSources,
  type InboxDecision,
  type InboxItemState,
} from "../lib/inbox";
import { useTranslation } from "../lib/i18n";
import type { InboxEntry } from "../lib/types";
import { BulkActionBar } from "./BulkActionBar";

interface InboxPaneProps {
  items: InboxItemState[];
  entries: InboxEntry[];
  loading: boolean;
  gmailMessages: GmailMessageState[];
  gmailLoading: boolean;
  gmailError: string | null;
  sourceFilter: string | null;
  onSourceFilter: (source: string | null) => void;
  onRefresh: () => void;
  onOpenSettings: () => void;
  focusRequest?: number;
  actionBusy?: boolean;
  onClassify: (id: string) => void;
  onDecide: (id: string, decision: InboxDecision) => void | Promise<void>;
  onDecideGmail: (id: string, decision: InboxDecision) => void | Promise<void>;
  onBulkAccept: (keys: string[]) => void | Promise<void>;
  onBulkReject: (keys: string[]) => void | Promise<void>;
  onBulkMoveFiles: (keys: string[]) => void | Promise<void>;
  onProcessEntries: (keys: string[]) => void | Promise<void>;
  onProcessChannel: (channel: string) => void | Promise<void>;
}

type InboxRow =
  | { key: string; kind: "entry"; entry: InboxEntry }
  | { key: string; kind: "file"; entry: InboxItemState }
  | { key: string; kind: "gmail"; entry: GmailMessageState };

export function InboxPane({
  items,
  entries,
  loading,
  gmailMessages,
  gmailLoading,
  gmailError,
  sourceFilter,
  onSourceFilter,
  onRefresh,
  onOpenSettings,
  focusRequest = 0,
  actionBusy = false,
  onClassify,
  onDecide,
  onDecideGmail,
  onBulkAccept,
  onBulkReject,
  onBulkMoveFiles,
  onProcessEntries,
  onProcessChannel,
}: InboxPaneProps) {
  const { t, locale } = useTranslation();
  const paneRef = useRef<HTMLElement | null>(null);
  const [focusedKey, setFocusedKey] = useState<string | null>(null);
  const [selectedKeys, setSelectedKeys] = useState<Set<string>>(new Set());
  const [lastSelectedKey, setLastSelectedKey] = useState<string | null>(null);
  const [cheatsheetOpen, setCheatsheetOpen] = useState(false);
  const sources = useMemo(() => uniqueSources(items), [items]);
  const visibleItems = useMemo(
    () => filterItemsBySource(items, sourceFilter),
    [items, sourceFilter],
  );
  const pending = visibleItems.filter((entry) => entry.decision === "pending").length;
  const entryPending = entries.filter((entry) => entry.status !== "done").length;
  const gmailPending = gmailMessages.filter((entry) => entry.decision === "pending").length;
  const entriesByChannel = useMemo(() => {
    const grouped = new Map<string, InboxEntry[]>();
    for (const entry of entries) {
      const group = grouped.get(entry.channel) ?? [];
      group.push(entry);
      grouped.set(entry.channel, group);
    }
    return [...grouped.entries()].sort(([a], [b]) => a.localeCompare(b));
  }, [entries]);
  const orderedEntries = useMemo(
    () => entriesByChannel.flatMap(([, channelEntries]) => channelEntries),
    [entriesByChannel],
  );
  const rows = useMemo<InboxRow[]>(
    () => [
      ...orderedEntries.map((entry) => ({ key: `entry:${entry.id}`, kind: "entry" as const, entry })),
      ...visibleItems.map((entry) => ({ key: `file:${entry.item.id}`, kind: "file" as const, entry })),
      ...gmailMessages.map((entry) => ({ key: `gmail:${entry.message.id}`, kind: "gmail" as const, entry })),
    ],
    [gmailMessages, orderedEntries, visibleItems],
  );
  const selected = useMemo(
    () => rows.filter((row) => selectedKeys.has(row.key)),
    [rows, selectedKeys],
  );
  const selectedFileCount = selected.filter((row) => row.kind === "file").length;
  const selectedEntryCount = selected.filter((row) => row.kind === "entry").length;

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
    else if (key.startsWith("gmail:")) await onDecideGmail(key.slice("gmail:".length), decision);
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

  return (
    <main
      className="inbox-pane"
      ref={paneRef}
      tabIndex={-1}
      onKeyDown={(event) => {
        if (event.metaKey || event.ctrlKey || event.altKey) return;
        const tag = (event.target as HTMLElement | null)?.tagName.toLowerCase();
        if (tag === "input" || tag === "textarea" || (event.target as HTMLElement | null)?.isContentEditable) {
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
              gmail: gmailPending.toLocaleString(locale),
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
            const count = items.filter((entry) => entry.item.source === source).length;
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
        {entriesByChannel.length > 0 ? (
          <section className="inbox-section">
            <h3 className="inbox-section-title">Configured Inbox</h3>
            <div className="inbox-list">
              {entriesByChannel.map(([channel, channelEntries]) => (
                <div className="inbox-channel-group" key={channel}>
                  <div className="inbox-channel-header">
                    <div>
                      <strong>{channel}</strong>
                      <span>{channelEntries.length.toLocaleString(locale)} items</span>
                    </div>
                    <button
                      type="button"
                      className="button button-ghost button-sm"
                      onClick={() => void onProcessChannel(channel)}
                      disabled={actionBusy}
                    >
                      <Play size={14} />
                      <span>Process</span>
                    </button>
                  </div>
                  {channelEntries.map((entry) => {
                    const key = `entry:${entry.id}`;
                    return (
                      <article
                        className={`inbox-item configured-inbox-item${focusedKey === key ? " focused" : ""}${selectedKeys.has(key) ? " selected" : ""}`}
                        key={entry.id}
                        data-inbox-row-key={key}
                        onClick={(event) => handleRowClick(event, key)}
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
              ))}
            </div>
          </section>
        ) : null}

        <section className="inbox-section">
          <h3 className="inbox-section-title">{t("inbox.section.files")}</h3>
          <div className="inbox-list">
            {loading ? <div className="inbox-empty">{t("inbox.loading")}</div> : null}
            {!loading && visibleItems.length === 0 ? (
              <div className="inbox-empty" title={t("inbox.empty.title")}>
                <Inbox size={24} />
                <strong>{t("inbox.empty.title")}</strong>
                <span>{t("inbox.empty.description")}</span>
              </div>
            ) : null}
            {visibleItems.map((entry) => {
              const key = `file:${entry.item.id}`;
              return (
              <article
                className={`inbox-item ${entry.decision}${focusedKey === key ? " focused" : ""}${selectedKeys.has(key) ? " selected" : ""}`}
                key={entry.item.id}
                data-inbox-row-key={key}
                onClick={(event) => handleRowClick(event, key)}
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
        </section>

        <section className="inbox-section">
          <h3 className="inbox-section-title">{t("inbox.section.gmail")}</h3>
          <div className="inbox-list">
            {gmailLoading ? <div className="inbox-empty">{t("inbox.gmail.loading")}</div> : null}
            {gmailError ? <div className="inbox-error gmail-error">{gmailError}</div> : null}
            {!gmailLoading && !gmailError && gmailMessages.length === 0 ? (
              <div className="inbox-empty" title={t("inbox.gmail.empty.title")}>
                <Mail size={24} />
                <strong>{t("inbox.gmail.empty.title")}</strong>
                <span>{t("inbox.gmail.empty.description")}</span>
              </div>
            ) : null}
            {gmailMessages.map((entry) => {
              const key = `gmail:${entry.message.id}`;
              return (
              <article
                className={`inbox-item gmail-item ${entry.decision}${focusedKey === key ? " focused" : ""}${selectedKeys.has(key) ? " selected" : ""}`}
                key={entry.message.id}
                data-inbox-row-key={key}
                onClick={(event) => handleRowClick(event, key)}
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
                  aria-label={`Select ${entry.message.subject || "Gmail message"}`}
                />
                <div className="inbox-item-main">
                  <div className="inbox-item-title">
                    <span className="source-chip gmail">gmail</span>
                    <strong>{entry.message.subject || t("inbox.gmail.noSubject")}</strong>
                  </div>
                  <p className="gmail-from">{shortFrom(entry.message.from)}</p>
                  <div className="inbox-item-meta">
                    {entry.message.date ? <time>{entry.message.date}</time> : null}
                  </div>
                </div>

                <div className="inbox-decision">
                  <span className="decision-status">{t(`inbox.decision.${entry.decision}`)}</span>
                  <button
                    type="button"
                    className="icon-button"
                    onClick={(event) => {
                      event.stopPropagation();
                      void onDecideGmail(entry.message.id, "accepted");
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
                      void onDecideGmail(entry.message.id, "rejected");
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
        </section>
      </div>
      <BulkActionBar
        count={selectedKeys.size}
        fileCount={selectedFileCount}
        entryCount={selectedEntryCount}
        busy={actionBusy}
        onAccept={() => void onBulkAccept([...selectedKeys])}
        onReject={() => void onBulkReject([...selectedKeys])}
        onMoveFiles={() => void onBulkMoveFiles([...selectedKeys])}
        onProcess={() => void onProcessEntries([...selectedKeys])}
        onCancel={() => setSelectedKeys(new Set())}
      />
    </main>
  );
}

function firstPendingKey(rows: InboxRow[]): string | null {
  const row = rows.find((entry) => {
    if (entry.kind === "entry") return entry.entry.status !== "done";
    if (entry.kind === "file") return entry.entry.decision === "pending";
    return entry.entry.decision === "pending";
  });
  return row?.key ?? null;
}

function formatBytes(value: number): string {
  if (value < 1024) return `${value} B`;
  if (value < 1024 * 1024) return `${(value / 1024).toFixed(1)} KB`;
  return `${(value / 1024 / 1024).toFixed(1)} MB`;
}
