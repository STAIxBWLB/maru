import { Brain, Check, Inbox, Loader2, Mail, RefreshCcw, Settings, X } from "lucide-react";
import { useMemo } from "react";
import { type GmailMessageState, shortFrom } from "../lib/gmail";
import {
  categoryLabel,
  filterItemsBySource,
  uniqueSources,
  type InboxDecision,
  type InboxItemState,
} from "../lib/inbox";
import { useTranslation } from "../lib/i18n";

interface InboxPaneProps {
  items: InboxItemState[];
  loading: boolean;
  gmailMessages: GmailMessageState[];
  gmailLoading: boolean;
  gmailError: string | null;
  sourceFilter: string | null;
  onSourceFilter: (source: string | null) => void;
  onRefresh: () => void;
  onOpenSettings: () => void;
  onClassify: (id: string) => void;
  onDecide: (id: string, decision: InboxDecision) => void;
  onDecideGmail: (id: string, decision: InboxDecision) => void;
}

export function InboxPane({
  items,
  loading,
  gmailMessages,
  gmailLoading,
  gmailError,
  sourceFilter,
  onSourceFilter,
  onRefresh,
  onOpenSettings,
  onClassify,
  onDecide,
  onDecideGmail,
}: InboxPaneProps) {
  const { t, locale } = useTranslation();
  const sources = useMemo(() => uniqueSources(items), [items]);
  const visibleItems = useMemo(
    () => filterItemsBySource(items, sourceFilter),
    [items, sourceFilter],
  );
  const pending = visibleItems.filter((entry) => entry.decision === "pending").length;
  const gmailPending = gmailMessages.filter((entry) => entry.decision === "pending").length;

  return (
    <main className="inbox-pane">
      <header className="inbox-header">
        <div>
          <h2>{t("inbox.title")}</h2>
          <p>
            {t("inbox.subtitle.combined", {
              files: pending.toLocaleString(locale),
              gmail: gmailPending.toLocaleString(locale),
            })}
          </p>
        </div>
        <div className="inbox-header-actions">
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
            {visibleItems.map((entry) => (
              <article className={`inbox-item ${entry.decision}`} key={entry.item.id}>
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
                    onClick={() => onClassify(entry.item.id)}
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
                    onClick={() => onDecide(entry.item.id, "accepted")}
                    title={t("inbox.accept")}
                    aria-label={t("inbox.accept")}
                  >
                    <Check size={14} />
                  </button>
                  <button
                    type="button"
                    className="icon-button"
                    onClick={() => onDecide(entry.item.id, "rejected")}
                    title={t("inbox.reject")}
                    aria-label={t("inbox.reject")}
                  >
                    <X size={14} />
                  </button>
                </div>
              </article>
            ))}
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
            {gmailMessages.map((entry) => (
              <article
                className={`inbox-item gmail-item ${entry.decision}`}
                key={entry.message.id}
              >
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
                    onClick={() => onDecideGmail(entry.message.id, "accepted")}
                    title={t("inbox.accept")}
                    aria-label={t("inbox.accept")}
                  >
                    <Check size={14} />
                  </button>
                  <button
                    type="button"
                    className="icon-button"
                    onClick={() => onDecideGmail(entry.message.id, "rejected")}
                    title={t("inbox.reject")}
                    aria-label={t("inbox.reject")}
                  >
                    <X size={14} />
                  </button>
                </div>
              </article>
            ))}
          </div>
        </section>
      </div>
    </main>
  );
}

function formatBytes(value: number): string {
  if (value < 1024) return `${value} B`;
  if (value < 1024 * 1024) return `${(value / 1024).toFixed(1)} KB`;
  return `${(value / 1024 / 1024).toFixed(1)} MB`;
}
