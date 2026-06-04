import { ClipboardCheck, Loader2, Pencil, RefreshCcw, Square } from "lucide-react";
import { Fragment, useEffect, useRef, useState } from "react";
import { useTranslation } from "../../lib/i18n";
import { applyInboxDecisions } from "../../lib/api";
import { agentReadRunEvents } from "../../lib/skills";
import { extractProviderOutput } from "../../lib/skillProposal";
import {
  buildInboxApplyDecisions,
  createInboxItemDecisions,
  deriveInboxRunSteps,
  emptyInboxReviewArtifact,
  inboxReviewCanApply,
  inboxReviewDecisionsComplete,
  parseInboxReviewArtifact,
  type InboxItemDecision,
} from "../../lib/inboxReview";
import { logLinePhase, logLineSeverity, parseMeetingsLogLine } from "../../lib/meetingsLog";
import type { MissionRecord } from "../../lib/types";
import { InboxReviewPanel, type InboxApplyResult, type InboxReviewBundle } from "./InboxReviewPanel";

// Rust `apply_inbox_decisions` accepts this kind (or `inbox.bulk`).
const INBOX_ROUTE_APPROVAL_KIND = "inbox.route";

interface InboxRunsPanelProps {
  workPath: string | null;
  missions: MissionRecord[];
  logLines: Record<string, string[]>;
  onStopMission: (id: string) => void;
  onRefreshMissions: () => void;
  onConfirmApproval: (input: {
    kind: string;
    summary: string;
    target?: string | null;
    payloadPreview?: string | null;
  }) => Promise<string | null>;
  onApplied: () => void;
  onError: (message: string | null) => void;
}

export function InboxRunsPanel({
  workPath,
  missions,
  logLines,
  onStopMission,
  onRefreshMissions,
  onConfirmApproval,
  onApplied,
  onError,
}: InboxRunsPanelProps) {
  const { t } = useTranslation();
  const [bundle, setBundle] = useState<InboxReviewBundle | null>(null);
  const [reviewLoading, setReviewLoading] = useState(false);
  const [applyBusy, setApplyBusy] = useState(false);
  const [applyResult, setApplyResult] = useState<InboxApplyResult | null>(null);
  const [appliedRunIds, setAppliedRunIds] = useState<Set<string>>(() => new Set());
  const [expandedLogs, setExpandedLogs] = useState<Set<string>>(() => new Set());
  const reviewPanelRef = useRef<HTMLDivElement | null>(null);
  const pendingReviewScrollRunId = useRef<string | null>(null);

  const decisionsComplete = bundle ? inboxReviewDecisionsComplete(bundle.decisions) : false;
  const appliedCurrentRun = Boolean(bundle && appliedRunIds.has(bundle.runId));
  const canApply = bundle
    ? !appliedCurrentRun &&
      inboxReviewCanApply({ decisions: bundle.decisions, decisionsComplete, applyBusy })
    : false;

  useEffect(() => {
    if (!bundle || pendingReviewScrollRunId.current !== bundle.runId) return;
    pendingReviewScrollRunId.current = null;
    window.requestAnimationFrame(() => {
      reviewPanelRef.current?.scrollIntoView({ behavior: "smooth", block: "nearest" });
    });
  }, [bundle]);

  const loadReviewResult = async (mission: MissionRecord) => {
    if (!workPath) return;
    setReviewLoading(true);
    onError(null);
    try {
      const events = await agentReadRunEvents(workPath, mission.id);
      const raw = extractProviderOutput(events, logLines[mission.id] ?? []);
      const review = parseInboxReviewArtifact(raw) ?? emptyInboxReviewArtifact(t("inbox.review.noReview"));
      pendingReviewScrollRunId.current = mission.id;
      setExpandedLogs((current) => {
        if (!current.has(mission.id)) return current;
        const next = new Set(current);
        next.delete(mission.id);
        return next;
      });
      setBundle({
        runId: mission.id,
        mission,
        rawOutput: raw,
        review,
        decisions: createInboxItemDecisions(review),
      });
      setApplyResult(null);
    } catch (err) {
      onError(err instanceof Error ? err.message : String(err));
    } finally {
      setReviewLoading(false);
    }
  };

  const applyReview = async () => {
    if (!bundle || !canApply || !workPath) return;
    const decisions = buildInboxApplyDecisions(bundle.decisions);
    const accepted = decisions.filter((decision) => decision.decision === "accept");
    const rejected = decisions.filter((decision) => decision.decision === "reject");
    const deferred = bundle.decisions.filter((decision) => decision.status === "deferred").length;
    if (decisions.length === 0) {
      setApplyResult({
        runId: bundle.runId,
        accepted: 0,
        rejected: 0,
        deferred,
        appliedAt: new Date().toISOString(),
      });
      setAppliedRunIds((current) => new Set([...current, bundle.runId]));
      onError(t("inbox.review.deferSuccess", { count: deferred }));
      return;
    }
    const approvalId = await onConfirmApproval({
      kind: INBOX_ROUTE_APPROVAL_KIND,
      summary: t("inbox.review.applySummaryDetailed", {
        accepted: accepted.length,
        rejected: rejected.length,
        deferred,
      }),
      target: decisions
        .map((decision) =>
          decision.decision === "accept" ? decision.destination ?? "inbox/items/done" : "rejected",
        )
        .join("\n"),
      payloadPreview: bundle.decisions
        .filter((decision) => decision.status !== "pending")
        .map(
          (decision) =>
            `${decision.classification} · ${decision.title} -> ${
              decision.status === "rejected"
                ? "reject"
                : decision.status === "deferred"
                  ? "defer"
                  : decision.destination ?? "done"
            } (${decision.status})`,
        )
        .join("\n"),
    });
    if (!approvalId) return;
    setApplyBusy(true);
    onError(null);
    try {
      await applyInboxDecisions(workPath, decisions, approvalId);
      setApplyResult({
        runId: bundle.runId,
        accepted: accepted.length,
        rejected: rejected.length,
        deferred,
        appliedAt: new Date().toISOString(),
      });
      setAppliedRunIds((current) => new Set([...current, bundle.runId]));
      onApplied();
      onRefreshMissions();
      onError(t("inbox.review.applySuccess"));
    } catch (err) {
      onError(err instanceof Error ? err.message : String(err));
    } finally {
      setApplyBusy(false);
    }
  };

  const updateDecision = (id: string, patch: Partial<InboxItemDecision>) =>
    setBundle((current) =>
      current
        ? {
            ...current,
            decisions: current.decisions.map((decision) =>
              decision.id === id ? { ...decision, ...patch } : decision,
            ),
          }
        : current,
    );
  const updateDecisions = (ids: string[], patch: Partial<InboxItemDecision>) => {
    const idSet = new Set(ids);
    setBundle((current) =>
      current
        ? {
            ...current,
            decisions: current.decisions.map((decision) =>
              idSet.has(decision.id) ? { ...decision, ...patch } : decision,
            ),
          }
        : current,
    );
  };

  return (
    <section className="inbox-runs-panel">
      <header className="inbox-runs-head">
        <div>
          <strong>{t("inbox.progress.title")}</strong>
          <span>{t("inbox.progress.count", { count: missions.length })}</span>
        </div>
        <button
          type="button"
          className="icon-button"
          onClick={onRefreshMissions}
          title={t("inbox.progress.refresh")}
          aria-label={t("inbox.progress.refresh")}
        >
          <RefreshCcw size={14} />
        </button>
      </header>

      <div className="inbox-run-list">
        {missions.length === 0 ? (
          <div className="inbox-run-empty">
            <ClipboardCheck size={16} />
            <strong>{t("inbox.progress.empty")}</strong>
            <span>{t("inbox.progress.emptyCta")}</span>
          </div>
        ) : null}
        {missions.map((mission) => {
          const lines = logLines[mission.id] ?? [];
          const canStop = mission.status === "running" || mission.status === "idle";
          const isFailed =
            mission.status === "failed" ||
            mission.status === "stopped" ||
            (mission.exitCode !== null && mission.exitCode !== 0);
          const isActive = bundle?.runId === mission.id;
          const canReview = !isFailed && (mission.status === "done" || isActive);
          const activeBundle = isActive ? bundle : null;
          const stepsComplete = activeBundle ? inboxReviewDecisionsComplete(activeBundle.decisions) : false;
          const steps = deriveInboxRunSteps({
            missionStatus: mission.status,
            logLines: lines,
            reviewLoaded: Boolean(activeBundle),
            decisionsComplete: stepsComplete,
            applied: appliedRunIds.has(mission.id),
          });
          const statusClass = isFailed ? "failed" : isActive ? "review-ready" : mission.status;
          const expanded = expandedLogs.has(mission.id);
          const parsedLines = lines.map(parseMeetingsLogLine);
          const latestParsed = parsedLines.at(-1);
          const contextNote = inboxMissionContext(mission);
          return (
            <Fragment key={mission.id}>
              <article
                className={`inbox-run-card ${statusClass}`}
                data-active={isActive ? "true" : "false"}
              >
                <div className="inbox-run-card-head">
                  <div>
                    <strong>{inboxMissionTitle(mission)}</strong>
                    <span>
                      {mission.status} · {formatTime(mission.startedAt)}
                    </span>
                    {contextNote ? (
                      <span className="inbox-run-context" title={contextNote}>
                        {contextNote}
                      </span>
                    ) : null}
                  </div>
                  {canStop ? (
                    <button
                      type="button"
                      className="button button-ghost button-sm"
                      onClick={() => onStopMission(mission.id)}
                    >
                      <Square size={12} />
                      <span>{t("inbox.progress.stop")}</span>
                    </button>
                  ) : null}
                </div>
                <ol className="inbox-run-steps" aria-label={t("inbox.progress.steps")}>
                  {steps.map((step) => (
                    <li className={`inbox-run-step ${step.status}`} key={step.id}>
                      <span className="inbox-run-step-dot" aria-hidden="true" />
                      <span>{t(`inbox.step.${step.id}`)}</span>
                    </li>
                  ))}
                </ol>
                <div className="inbox-run-log-summary">
                  <span data-severity={latestParsed ? logLineSeverity(latestParsed) : "info"}>
                    {latestParsed?.raw ?? t("inbox.progress.noLog")}
                  </span>
                  <button
                    type="button"
                    aria-expanded={expanded}
                    onClick={() =>
                      setExpandedLogs((current) => {
                        const next = new Set(current);
                        if (next.has(mission.id)) next.delete(mission.id);
                        else next.add(mission.id);
                        return next;
                      })
                    }
                  >
                    {expanded ? t("inbox.progress.hideLog") : t("inbox.progress.showLog")}
                  </button>
                </div>
                {expanded && parsedLines.length > 0 ? (
                  <ul className="inbox-run-log" aria-label={t("inbox.progress.logLines")}>
                    {parsedLines.slice(-60).map((parsed, index) => {
                      const phase = logLinePhase(parsed);
                      return (
                        <li
                          key={`${mission.id}-log-${index}`}
                          data-severity={logLineSeverity(parsed)}
                          data-phase={phase ?? undefined}
                        >
                          {phase ? <span className="inbox-run-log-phase">{phase}</span> : null}
                          <span className="inbox-run-log-text">{parsed.raw}</span>
                        </li>
                      );
                    })}
                  </ul>
                ) : null}
                <div className="inbox-run-card-actions">
                  <span>
                    {appliedRunIds.has(mission.id)
                      ? t("inbox.step.applyDone")
                      : isFailed
                        ? t("inbox.progress.failedStatus")
                        : t("inbox.progress.status", { status: mission.status })}
                  </span>
                  {canReview ? (
                    <button
                      type="button"
                      className="secondary-button"
                      disabled={reviewLoading}
                      onClick={() => void loadReviewResult(mission)}
                    >
                      {reviewLoading && isActive ? <Loader2 size={14} className="spin" /> : <Pencil size={14} />}
                      {isActive && steps.some((step) => step.id === "confirm" && step.status === "blocked")
                        ? t("inbox.review.resolveConfirmations")
                        : t("inbox.review.result")}
                    </button>
                  ) : null}
                </div>
              </article>
              {activeBundle ? (
                <div ref={reviewPanelRef} className="inbox-run-review-slot">
                  <InboxReviewPanel
                    bundle={activeBundle}
                    applyBusy={applyBusy}
                    applied={appliedRunIds.has(mission.id)}
                    canApply={canApply}
                    applyResult={applyResult?.runId === mission.id ? applyResult : null}
                    onApply={() => void applyReview()}
                    onDismissApplyResult={() => setApplyResult(null)}
                    onUpdateDecision={updateDecision}
                    onUpdateDecisions={updateDecisions}
                  />
                </div>
              ) : null}
            </Fragment>
          );
        })}
      </div>
    </section>
  );
}

function inboxMissionTitle(mission: MissionRecord): string {
  const metadata = mission.metadata;
  if (metadata && typeof metadata === "object" && !Array.isArray(metadata)) {
    const record = metadata as Record<string, unknown>;
    const channels = record.channels;
    if (Array.isArray(channels)) {
      const named = channels.filter((value): value is string => typeof value === "string" && value.length > 0);
      if (named.length > 0) return `inbox-process ${named.join(" ")}`;
    }
    if (typeof record.channel === "string" && record.channel) {
      return `inbox-process ${record.channel}`;
    }
  }
  return "inbox-process";
}

/** Free-text guidance the user attached to this run, if any. */
function inboxMissionContext(mission: MissionRecord): string | null {
  const metadata = mission.metadata;
  if (metadata && typeof metadata === "object" && !Array.isArray(metadata)) {
    const value = (metadata as Record<string, unknown>).processingContext;
    if (typeof value === "string" && value.trim().length > 0) return value.trim();
  }
  return null;
}

function formatTime(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return date.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
}
