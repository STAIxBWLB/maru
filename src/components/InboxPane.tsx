import { Brain, Check, Inbox, Loader2, RefreshCcw, X } from "lucide-react";
import { categoryLabel, type InboxDecision, type InboxItemState } from "../lib/inbox";
import { useTranslation } from "../lib/i18n";

interface InboxPaneProps {
  items: InboxItemState[];
  loading: boolean;
  onRefresh: () => void;
  onClassify: (id: string) => void;
  onDecide: (id: string, decision: InboxDecision) => void;
}

export function InboxPane({ items, loading, onRefresh, onClassify, onDecide }: InboxPaneProps) {
  const { t, locale } = useTranslation();
  const pending = items.filter((entry) => entry.decision === "pending").length;

  return (
    <main className="inbox-pane">
      <header className="inbox-header">
        <div>
          <h2>{t("inbox.title")}</h2>
          <p>{t("inbox.subtitle", { pending: pending.toLocaleString(locale) })}</p>
        </div>
        <button
          type="button"
          className="icon-button"
          onClick={onRefresh}
          title={t("inbox.refresh")}
          aria-label={t("inbox.refresh")}
        >
          <RefreshCcw size={15} />
        </button>
      </header>

      <div className="inbox-list">
        {loading ? <div className="inbox-empty">{t("inbox.loading")}</div> : null}
        {!loading && items.length === 0 ? (
          <div className="inbox-empty">
            <Inbox size={24} />
            <strong>{t("inbox.empty.title")}</strong>
            <span>{t("inbox.empty.description")}</span>
          </div>
        ) : null}
        {items.map((entry) => (
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
                {entry.classifying ? <Loader2 size={14} className="spin" /> : <Brain size={14} />}
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
    </main>
  );
}

function formatBytes(value: number): string {
  if (value < 1024) return `${value} B`;
  if (value < 1024 * 1024) return `${(value / 1024).toFixed(1)} KB`;
  return `${(value / 1024 / 1024).toFixed(1)} MB`;
}
