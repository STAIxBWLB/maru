import { AlertTriangle, CheckCircle2, GitCompare, Loader2 } from "lucide-react";
import { useTranslation } from "../../lib/i18n";
import {
  INBOX_CLASSIFICATIONS,
  statusAfterInboxMetadataEdit,
  type InboxItemDecision,
  type InboxItemDecisionStatus,
  type InboxReviewArtifact,
  type InboxReviewClassification,
} from "../../lib/inboxReview";
import type { MissionRecord } from "../../lib/types";

export interface InboxReviewBundle {
  runId: string;
  mission: MissionRecord;
  rawOutput: string;
  review: InboxReviewArtifact;
  decisions: InboxItemDecision[];
}

export interface InboxApplyResult {
  runId: string;
  accepted: number;
  rejected: number;
  deferred: number;
  appliedAt: string;
}

// Editable per-item statuses for route/reject/defer confirmation.
const DECISION_STATUSES: InboxItemDecisionStatus[] = ["accepted", "edited", "rejected", "deferred"];

export function InboxReviewPanel({
  bundle,
  applyBusy,
  applied,
  canApply,
  applyResult,
  onApply,
  onDismissApplyResult,
  onUpdateDecision,
  onUpdateDecisions,
}: {
  bundle: InboxReviewBundle;
  applyBusy: boolean;
  applied: boolean;
  canApply: boolean;
  applyResult: InboxApplyResult | null;
  onApply: () => void;
  onDismissApplyResult: () => void;
  onUpdateDecision: (id: string, patch: Partial<InboxItemDecision>) => void;
  onUpdateDecisions: (ids: string[], patch: Partial<InboxItemDecision>) => void;
}) {
  const { t } = useTranslation();
  const pendingRequired = bundle.decisions.filter(
    (decision) => decision.requiresConfirmation && decision.status === "pending",
  ).length;
  const acceptedCount = bundle.decisions.filter(
    (decision) => decision.status === "accepted" || decision.status === "edited",
  ).length;
  const rejectedCount = bundle.decisions.filter((decision) => decision.status === "rejected").length;
  const deferredCount = bundle.decisions.filter((decision) => decision.status === "deferred").length;
  const allIds = bundle.decisions.map((decision) => decision.id);
  const applyDescription =
    applyResult && applyResult.accepted === 0 && applyResult.rejected === 0 && applyResult.deferred > 0
      ? t("inbox.review.applyDeferredOnlyDescription", {
          deferred: applyResult.deferred,
          time: formatTime(applyResult.appliedAt),
        })
      : applyResult
        ? t("inbox.review.applyDoneDescription", {
            accepted: applyResult.accepted,
            rejected: applyResult.rejected,
            deferred: applyResult.deferred,
            time: formatTime(applyResult.appliedAt),
          })
        : null;

  return (
    <section className="inbox-review-card">
      <header>
        <div>
          <span>{t("inbox.review.heading")}</span>
          <h3>{bundle.review.summary || t("inbox.review.noReview")}</h3>
        </div>
        <GitCompare size={16} />
      </header>

      <div className="inbox-review-summary">
        <span>{t("inbox.review.items", { count: bundle.decisions.length })}</span>
        <span>{t("inbox.review.pending", { count: pendingRequired })}</span>
      </div>

      {applyResult ? (
        <div className="inbox-apply-result" role="status">
          <CheckCircle2 size={16} />
          <div>
            <strong>{t("inbox.review.applyDoneTitle")}</strong>
            <span>{applyDescription}</span>
          </div>
          <button
            type="button"
            className="icon-button"
            onClick={onDismissApplyResult}
            aria-label={t("inbox.review.dismissApplyResult")}
          >
            ×
          </button>
        </div>
      ) : null}

      <div className="inbox-review-decisions">
        <div className="inbox-decision-bulk-actions" role="group" aria-label={t("inbox.review.bulkActions")}>
          <button type="button" onClick={() => onUpdateDecisions(allIds, { status: "accepted" })}>
            {t("inbox.review.acceptAll")}
          </button>
          <button type="button" onClick={() => onUpdateDecisions(allIds, { status: "rejected" })}>
            {t("inbox.review.rejectAll")}
          </button>
          <button type="button" onClick={() => onUpdateDecisions(allIds, { status: "deferred" })}>
            {t("inbox.review.deferAll")}
          </button>
        </div>

        {pendingRequired > 0 ? (
          <div className="inbox-review-callout" role="status">
            <AlertTriangle size={14} />
            <span>{t("inbox.review.confirmationCallout", { count: pendingRequired })}</span>
          </div>
        ) : null}

        {bundle.decisions.length === 0 ? (
          <div className="inbox-review-empty">
            <AlertTriangle size={15} />
            <span>{t("inbox.review.noItems")}</span>
          </div>
        ) : null}

        {bundle.decisions.map((item) => (
          <article
            className={`inbox-decision-row ${item.status}`}
            data-status={item.status}
            data-required={item.requiresConfirmation ? "true" : "false"}
            key={item.id}
          >
            <div className="inbox-decision-main">
              <div className="inbox-decision-title">
                {item.channel ? <span className="source-chip">{item.channel}</span> : null}
                <strong>{item.title}</strong>
                {item.requiresConfirmation ? (
                  <span className="inbox-decision-required" title={t("inbox.review.requiredLabel")}>
                    *
                  </span>
                ) : null}
              </div>
              {item.summaryPreview ? <p className="inbox-decision-summary">{item.summaryPreview}</p> : null}
              <div className="inbox-decision-meta">
                <span className={`inbox-classification-badge ${item.classification}`}>
                  {t(`inbox.classification.${item.classification}`)}
                </span>
                <span
                  className="inbox-decision-confidence"
                  data-low={item.confidence === "low" ? "true" : "false"}
                >
                  {t(`inbox.confidence.${item.confidence}`)}
                </span>
                {item.note ? <small>{item.note}</small> : null}
              </div>
            </div>

            <div className="inbox-decision-route">
              <label className="inbox-decision-field">
                <span>{t("inbox.review.classificationLabel")}</span>
                <select
                  className="inbox-classification-select"
                  value={item.classification}
                  aria-label={t("inbox.review.classificationFor", { title: item.title })}
                  onChange={(event) =>
                    onUpdateDecision(item.id, {
                      classification: event.target.value as InboxReviewClassification,
                      status: statusAfterInboxMetadataEdit(item.status),
                    })
                  }
                >
                  {INBOX_CLASSIFICATIONS.map((value) => (
                    <option key={value} value={value}>
                      {t(`inbox.classification.${value}`)}
                    </option>
                  ))}
                </select>
              </label>
              <label className="inbox-decision-field">
                <span>{t("inbox.review.projectLabel")}</span>
                <input
                  className="inbox-decision-project"
                  value={item.project ?? ""}
                  placeholder={t("inbox.review.projectPlaceholder")}
                  onChange={(event) =>
                    onUpdateDecision(item.id, {
                      project: event.target.value || null,
                      status: statusAfterInboxMetadataEdit(item.status),
                    })
                  }
                />
              </label>
              <label className="inbox-decision-field">
                <span>{t("inbox.review.destinationLabel")}</span>
                <input
                  className="inbox-decision-destination"
                  value={item.destination ?? ""}
                  placeholder={t("inbox.review.destinationPlaceholder")}
                  onChange={(event) =>
                    onUpdateDecision(item.id, {
                      destination: event.target.value || null,
                      status: statusAfterInboxMetadataEdit(item.status),
                    })
                  }
                />
              </label>
            </div>

            <div className="inbox-decision-actions" role="group" aria-label={t("inbox.review.itemActions")}>
              {DECISION_STATUSES.map((status) => (
                <button
                  key={status}
                  type="button"
                  className={item.status === status ? "active" : ""}
                  aria-pressed={item.status === status}
                  onClick={() => onUpdateDecision(item.id, { status })}
                >
                  {t(`inbox.review.status.${status}`)}
                </button>
              ))}
            </div>
          </article>
        ))}
      </div>

      <div className="inbox-review-actions" data-applied={applied ? "true" : "false"}>
        <span>
          {pendingRequired > 0
            ? t("inbox.review.applyBlocked", { count: pendingRequired })
            : applied
              ? t("inbox.review.applyDoneTitle")
              : t("inbox.review.applyReadyDetailed", {
                  accepted: acceptedCount,
                  rejected: rejectedCount,
                  deferred: deferredCount,
                })}
        </span>
        <button
          type="button"
          className="primary-button"
          disabled={!canApply}
          aria-disabled={!canApply}
          data-state={applyBusy ? "applying" : applied ? "applied" : canApply ? "ready" : "pending"}
          onClick={onApply}
        >
          {applyBusy ? <Loader2 size={14} className="spin" /> : <CheckCircle2 size={14} />}
          {applyBusy ? t("inbox.review.applying") : applied ? t("inbox.review.applied") : t("inbox.review.apply")}
        </button>
      </div>
    </section>
  );
}

function formatTime(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return date.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
}
