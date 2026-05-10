import { Check, X } from "lucide-react";
import type { CommsFeedRow, CommsProvider } from "../../lib/comms";
import type { InboxDecision } from "../../lib/inbox";
import { shortFrom } from "../../lib/gmail";
import { useTranslation } from "../../lib/i18n";

interface MessageListProps {
  rows: CommsFeedRow[];
  emptyTitle: string;
  emptyDescription: string;
  loading?: boolean;
  error?: string | null;
  loadingLabel?: string;
  onDecide: (provider: CommsProvider, id: string, decision: Exclude<InboxDecision, "pending">) => void;
}

export function MessageList({
  rows,
  emptyTitle,
  emptyDescription,
  loading = false,
  error = null,
  loadingLabel,
  onDecide,
}: MessageListProps) {
  const { t, locale } = useTranslation();
  return (
    <div className="inbox-list">
      {loading ? <div className="inbox-empty">{loadingLabel ?? t("comms.loading")}</div> : null}
      {error ? <div className="inbox-error gmail-error">{error}</div> : null}
      {!loading && !error && rows.length === 0 ? (
        <div className="inbox-empty">
          <strong>{emptyTitle}</strong>
          <span>{emptyDescription}</span>
        </div>
      ) : null}
      {rows.map((row) => {
        const title = row.title || fallbackTitle(row.provider, t);
        return (
          <article
            key={row.key}
            className={`inbox-item comms-item ${row.provider}-item ${row.decision}`}
            title={row.preview || title}
          >
            <div className="inbox-item-main">
              <div className="inbox-item-title">
                <span className={`source-chip ${row.provider}`}>{row.provider}</span>
                <strong>{title}</strong>
              </div>
              <p className="gmail-from">{shortFrom(row.sender)}</p>
              {row.preview ? <p className="comms-preview">{row.preview}</p> : null}
              <div className="inbox-item-meta">
                <span>{formatDate(row.date, locale)}</span>
              </div>
            </div>
            <div className="inbox-decision">
              <span className="decision-status">{t(`inbox.decision.${row.decision}`)}</span>
              <button
                type="button"
                className="icon-button accept"
                disabled={row.decision !== "pending"}
                title={t("inbox.accept")}
                aria-label={t("inbox.accept")}
                onClick={() => onDecide(row.provider, row.key.split(":").slice(1).join(":"), "accepted")}
              >
                <Check size={15} />
              </button>
              <button
                type="button"
                className="icon-button reject"
                disabled={row.decision !== "pending"}
                title={t("inbox.reject")}
                aria-label={t("inbox.reject")}
                onClick={() => onDecide(row.provider, row.key.split(":").slice(1).join(":"), "rejected")}
              >
                <X size={15} />
              </button>
            </div>
          </article>
        );
      })}
    </div>
  );
}

function fallbackTitle(provider: CommsProvider, t: (key: string) => string): string {
  return provider === "telegram"
    ? t("comms.telegram.unknownChat")
    : t("inbox.gmail.noSubject");
}

function formatDate(raw: string, locale: string): string {
  const date = new Date(raw);
  if (Number.isNaN(date.getTime())) return raw;
  return new Intl.DateTimeFormat(locale === "ko" ? "ko-KR" : "en-US", {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  }).format(date);
}
