import { Loader2, Play } from "lucide-react";
import { useTranslation } from "../../lib/i18n";
import { SOURCE_LABEL_KEY, type InboxSourceChannel } from "../../lib/inboxSources";
import type { InboxSourceRun } from "../../lib/types";
import { formatShortDate } from "../inbox/processedFormat";

interface SourceHeaderCardProps {
  channel: string;
  run: InboxSourceRun | null;
  running: boolean;
  processedCount: number;
  actionBusy: boolean;
  compact?: boolean;
  onProcessNow: (channel: string) => void;
  onSelect?: (channel: string) => void;
}

export function SourceHeaderCard({
  channel,
  run,
  running,
  processedCount,
  actionBusy,
  compact = false,
  onProcessNow,
  onSelect,
}: SourceHeaderCardProps) {
  const { t } = useTranslation();
  const labelKey = SOURCE_LABEL_KEY[channel as InboxSourceChannel];
  const label = labelKey ? t(labelKey) : channel;
  const digest = run?.digest ?? null;

  const info = (
    <>
      <div className="source-card-title">
        <strong>{label}</strong>
        {running ? <span className="source-card-live">{t("comms.source.processing")}</span> : null}
      </div>
      <div className="source-card-meta">
        {run?.lastRunAt ? (
          <span>
            {t("comms.source.lastProcessed", { time: formatShortDate(run.lastRunAt) })}
            {run.lastRunKind ? ` · ${run.lastRunKind}` : ""}
          </span>
        ) : (
          <span className="source-card-muted">{t("comms.source.neverProcessed")}</span>
        )}
        {run?.account ? <span>{t("comms.source.account", { account: run.account })}</span> : null}
      </div>
      <div className="source-card-counts">
        {run?.itemsFetched != null ? (
          <span>{t("comms.source.itemsFetched", { count: run.itemsFetched })}</span>
        ) : null}
        {run?.itemsNew != null ? (
          <span>{t("comms.source.itemsNew", { count: run.itemsNew })}</span>
        ) : null}
        {processedCount > 0 ? (
          <span>{t("comms.source.processedCount", { count: processedCount })}</span>
        ) : null}
        {digest ? (
          <span>
            {t("comms.source.digestCounts", {
              total: digest.itemsTotal ?? 0,
              high: digest.itemsHigh ?? 0,
              med: digest.itemsMed ?? 0,
              low: digest.itemsLow ?? 0,
            })}
          </span>
        ) : null}
        {digest?.threads != null ? (
          <span>{t("comms.source.threads", { count: digest.threads })}</span>
        ) : null}
        {digest?.generatedAt ? (
          <span>{t("comms.source.generatedAt", { time: formatShortDate(digest.generatedAt) })}</span>
        ) : null}
      </div>
    </>
  );

  return (
    <article className={compact ? "source-card compact" : "source-card"}>
      {compact && onSelect ? (
        <button type="button" className="source-card-open" onClick={() => onSelect(channel)}>
          {info}
        </button>
      ) : (
        <div className="source-card-body">{info}</div>
      )}
      <div className="source-card-actions">
        <button
          type="button"
          className="button button-primary button-sm"
          disabled={actionBusy || running}
          onClick={() => onProcessNow(channel)}
        >
          {running ? <Loader2 size={14} className="spin" /> : <Play size={14} />}
          <span>{running ? t("comms.source.processing") : t("comms.source.processNow")}</span>
        </button>
      </div>
    </article>
  );
}
