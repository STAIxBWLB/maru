import {
  BarChart3,
  CheckCircle2,
  ClipboardCheck,
  Download,
  FileSearch,
  Loader2,
  RefreshCcw,
  RotateCw,
  Square,
  Trash2,
} from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { chooseSaveFile } from "../../lib/api";
import { useTranslation } from "../../lib/i18n";
import {
  SKILL_PROPOSAL_APPLY_APPROVAL_KIND,
  agentApplySkillProposal,
  agentExportRedactedRunSummary,
  agentParseSkillProposal,
  agentReadRunEvents,
  agentReplayRunSummary,
  agentWriteRedactedRunSummary,
  skillsDispatchBackground,
  type RunReplaySummary,
  type SkillDispatchRuntime,
  type SkillProposal,
} from "../../lib/skills";
import {
  extractSkillRunRetryRequest,
  formatElapsed,
  formatSkillRunLogLine,
  proposalSummary,
  skillRunView,
} from "../../lib/skillRuns";
import { extractProviderOutput, extractSkillProposal } from "../../lib/meetingReview";
import type { MissionRecord } from "../../lib/types";

interface SkillRunsPanelProps {
  workPath: string | null;
  missions: MissionRecord[];
  logLines: Record<string, string[]>;
  runtimeCommands: Partial<Record<SkillDispatchRuntime, string | null>>;
  permissionMode?: string | null;
  onRefresh: () => void;
  onStopMission: (id: string) => void;
  onMissionStarted: (id: string) => void;
  onConfirmApproval: (input: {
    kind: string;
    summary: string;
    target?: string | null;
    payloadPreview?: string | null;
  }) => Promise<string | null>;
  onError: (message: string | null) => void;
}

export function SkillRunsPanel({
  workPath,
  missions,
  logLines,
  runtimeCommands,
  permissionMode,
  onRefresh,
  onStopMission,
  onMissionStarted,
  onConfirmApproval,
  onError,
}: SkillRunsPanelProps) {
  const { t } = useTranslation();
  const storageKey = useMemo(
    () => `anchor:skill-runs:cleared:${workPath ?? "no-workspace"}`,
    [workPath],
  );
  const [clearedIds, setClearedIds] = useState<Set<string>>(() => readClearedRunIds(storageKey));
  const [expandedLogs, setExpandedLogs] = useState<Set<string>>(() => new Set());
  const [activeRunId, setActiveRunId] = useState<string | null>(null);
  const [reviewProposal, setReviewProposal] = useState<SkillProposal | null>(null);
  const [reviewLoading, setReviewLoading] = useState(false);
  const [applyBusy, setApplyBusy] = useState(false);
  const [retryBusyId, setRetryBusyId] = useState<string | null>(null);
  const [appliedIds, setAppliedIds] = useState<Set<string>>(() => new Set());
  const [summaries, setSummaries] = useState<Record<string, RunReplaySummary>>({});
  const [summaryBusyId, setSummaryBusyId] = useState<string | null>(null);
  const [exportBusyId, setExportBusyId] = useState<string | null>(null);
  const [exportNotices, setExportNotices] = useState<Record<string, string>>({});
  const reviewRequestSeq = useRef(0);

  useEffect(() => {
    setClearedIds(readClearedRunIds(storageKey));
  }, [storageKey]);

  const visibleMissions = useMemo(
    () => missions.filter((mission) => !clearedIds.has(mission.id)),
    [clearedIds, missions],
  );

  const clearRun = useCallback((id: string) => {
    setClearedIds((current) => {
      const next = new Set(current);
      next.add(id);
      writeClearedRunIds(storageKey, next);
      return next;
    });
    if (activeRunId === id) {
      reviewRequestSeq.current += 1;
      setActiveRunId(null);
      setReviewProposal(null);
      setReviewLoading(false);
    }
  }, [activeRunId, storageKey]);

  async function reviewRun(mission: MissionRecord) {
    const cwd = workspacePathFromMission(mission) ?? workPath;
    if (!cwd) return;
    const requestId = reviewRequestSeq.current + 1;
    reviewRequestSeq.current = requestId;
    setReviewLoading(true);
    setActiveRunId(mission.id);
    setReviewProposal(null);
    onError(null);
    try {
      const events = await agentReadRunEvents(cwd, mission.id);
      const raw = extractProviderOutput(events, logLines[mission.id] ?? []);
      const proposal = extractSkillProposal(events) ?? await agentParseSkillProposal(raw);
      if (reviewRequestSeq.current !== requestId) return;
      setReviewProposal(proposal);
    } catch (err) {
      if (reviewRequestSeq.current !== requestId) return;
      setReviewProposal(null);
      onError(err instanceof Error ? err.message : t("skillRuns.noProposal"));
    } finally {
      if (reviewRequestSeq.current === requestId) setReviewLoading(false);
    }
  }

  async function applyProposal(mission: MissionRecord) {
    const cwd = workspacePathFromMission(mission) ?? workPath;
    if (!cwd || !reviewProposal || activeRunId !== mission.id || appliedIds.has(mission.id) || applyBusy) return;
    const approvalId = await onConfirmApproval({
      kind: SKILL_PROPOSAL_APPLY_APPROVAL_KIND,
      summary: t("skillRuns.applySummary", {
        files: reviewProposal.files.length,
        commands: reviewProposal.commands.length,
      }),
      target: reviewProposal.files.map((file) => file.path).join("\n"),
      payloadPreview: proposalSummary(reviewProposal),
    });
    if (!approvalId) return;
    setApplyBusy(true);
    onError(null);
    try {
      await agentApplySkillProposal({
        cwd,
        proposal: reviewProposal,
        approvalId,
        runId: mission.id,
      });
      setAppliedIds((current) => new Set([...current, mission.id]));
      onRefresh();
    } catch (err) {
      onError(err instanceof Error ? err.message : String(err));
    } finally {
      setApplyBusy(false);
    }
  }

  async function retryRun(mission: MissionRecord) {
    const cwd = workspacePathFromMission(mission) ?? workPath;
    if (!cwd) return;
    setRetryBusyId(mission.id);
    onError(null);
    try {
      const events = await agentReadRunEvents(cwd, mission.id);
      const retry = extractSkillRunRetryRequest(events);
      if (!retry) {
        onError(t("skillRuns.retryUnavailable"));
        return;
      }
      const invocationId = await skillsDispatchBackground({
        skillId: retry.skillId,
        runtime: retry.runtime,
        prompt: retry.prompt,
        cwd: retry.cwd ?? cwd,
        context: retry.context,
        commandOverride: retry.commandOverride ?? runtimeCommands[retry.runtime] ?? null,
        permissionMode: retry.permissionMode ?? permissionMode ?? null,
        metadata: {
          origin: "skillRetry",
          skillName: skillNameFromMission(mission),
          runtime: retry.runtime,
          workspacePath: retry.cwd ?? cwd,
          inputPaths: retry.context.map((item) => item.path),
          parentRunId: mission.id,
        },
      });
      onMissionStarted(invocationId);
      onRefresh();
    } catch (err) {
      onError(err instanceof Error ? err.message : String(err));
    } finally {
      setRetryBusyId(null);
    }
  }

  async function loadSummary(mission: MissionRecord) {
    const cwd = workspacePathFromMission(mission) ?? workPath;
    if (!cwd) return;
    setSummaryBusyId(mission.id);
    onError(null);
    try {
      const summary = await agentReplayRunSummary(cwd, mission.id);
      setSummaries((current) => ({ ...current, [mission.id]: summary }));
    } catch (err) {
      onError(err instanceof Error ? err.message : String(err));
    } finally {
      setSummaryBusyId(null);
    }
  }

  async function exportSummary(mission: MissionRecord) {
    const cwd = workspacePathFromMission(mission) ?? workPath;
    if (!cwd) return;
    setExportBusyId(mission.id);
    onError(null);
    try {
      const target = await chooseSaveFile(
        t("skillRuns.export.title"),
        `${cwd}/.anchor/run-summaries/${mission.id}.json`,
      );
      if (target) {
        const written = await agentWriteRedactedRunSummary(cwd, mission.id, target);
        setExportNotices((current) => ({
          ...current,
          [mission.id]: t("skillRuns.export.done", { path: written }),
        }));
      } else {
        // No save target chosen (or browser dev) — fall back to the clipboard.
        const summary = await agentExportRedactedRunSummary(cwd, mission.id);
        await navigator.clipboard?.writeText(JSON.stringify(summary, null, 2));
        setExportNotices((current) => ({
          ...current,
          [mission.id]: t("skillRuns.export.copied"),
        }));
      }
    } catch (err) {
      onError(err instanceof Error ? err.message : String(err));
    } finally {
      setExportBusyId(null);
    }
  }

  return (
    <section className="skill-runs-panel">
      <header className="skill-runs-head">
        <div>
          <span>{t("skillRuns.kicker")}</span>
          <h3>{t("skillRuns.title")}</h3>
        </div>
        <button
          type="button"
          className="icon-button"
          onClick={onRefresh}
          aria-label={t("skillRuns.refresh")}
          title={t("skillRuns.refresh")}
        >
          <RefreshCcw size={13} />
        </button>
      </header>
      {visibleMissions.length === 0 ? (
        <div className="skill-runs-empty">
          <ClipboardCheck size={15} />
          <span>{t("skillRuns.empty")}</span>
        </div>
      ) : (
        <div className="skill-runs-list">
          {visibleMissions.map((mission) => {
            const view = skillRunView(mission, logLines[mission.id] ?? [], {
              reviewLoaded: activeRunId === mission.id && reviewProposal !== null,
              applied: appliedIds.has(mission.id),
            });
            const expanded = expandedLogs.has(mission.id);
            const formattedLines = (logLines[mission.id] ?? []).map(formatSkillRunLogLine);
            return (
              <article className={`skill-run-card ${view.phase}`} key={mission.id}>
                <div className="skill-run-card-head">
                  <div>
                    <strong>{view.skillName}</strong>
                    <span>
                      {view.runtime ? t(`skillRuns.runtime.${view.runtime}`) : t("skillRuns.runtime.unknown")}
                      {" · "}
                      {t(`skillRuns.phase.${view.phase}`)}
                      {" · "}
                      {formatElapsed(view.elapsedMs)}
                    </span>
                  </div>
                  <div className="skill-run-actions">
                    {view.canStop ? (
                      <button type="button" className="button button-ghost button-sm" onClick={() => onStopMission(mission.id)}>
                        <Square size={12} />
                        {t("skillRuns.stop")}
                      </button>
                    ) : view.status !== "running" && view.status !== "idle" ? (
                      <button type="button" className="button button-ghost button-sm" onClick={() => void retryRun(mission)} disabled={retryBusyId === mission.id}>
                        {retryBusyId === mission.id ? <Loader2 size={12} className="spin" /> : <RotateCw size={12} />}
                        {t("skillRuns.retry")}
                      </button>
                    ) : null}
                    <button type="button" className="icon-button" onClick={() => clearRun(mission.id)} aria-label={t("skillRuns.clear")} title={t("skillRuns.clear")}>
                      <Trash2 size={12} />
                    </button>
                  </div>
                </div>
                <div className="skill-run-logline" data-severity={view.latestSeverity}>
                  {view.latestLog || t("skillRuns.noLog")}
                </div>
                {expanded ? (
                  <pre className="skill-run-log">
                    {formattedLines.length > 0
                      ? formattedLines.slice(-40).map((line) => line.text).join("\n")
                      : t("skillRuns.noLog")}
                  </pre>
                ) : null}
                <div className="skill-run-footer">
                  <button
                    type="button"
                    className="link-button"
                    onClick={() =>
                      setExpandedLogs((current) => {
                        const next = new Set(current);
                        if (next.has(mission.id)) next.delete(mission.id);
                        else next.add(mission.id);
                        return next;
                      })
                    }
                  >
                    {expanded ? t("skillRuns.hideLog") : t("skillRuns.showLog")}
                  </button>
                  <button
                    type="button"
                    className="secondary-button"
                    disabled={reviewLoading}
                    onClick={() => void reviewRun(mission)}
                  >
                    {reviewLoading && activeRunId === mission.id ? <Loader2 size={13} className="spin" /> : <FileSearch size={13} />}
                    {t("skillRuns.review")}
                  </button>
                  {activeRunId === mission.id && reviewProposal ? (
                    <button
                      type="button"
                      className="primary-button"
                      disabled={applyBusy || appliedIds.has(mission.id)}
                      onClick={() => void applyProposal(mission)}
                    >
                      {applyBusy ? <Loader2 size={13} className="spin" /> : <CheckCircle2 size={13} />}
                      {appliedIds.has(mission.id) ? t("skillRuns.applied") : t("skillRuns.apply")}
                    </button>
                  ) : null}
                  <button
                    type="button"
                    className="link-button"
                    disabled={summaryBusyId === mission.id}
                    onClick={() => void loadSummary(mission)}
                  >
                    {summaryBusyId === mission.id ? <Loader2 size={12} className="spin" /> : <BarChart3 size={12} />}
                    {t("skillRuns.summary")}
                  </button>
                  <button
                    type="button"
                    className="link-button"
                    disabled={exportBusyId === mission.id}
                    onClick={() => void exportSummary(mission)}
                    title={t("skillRuns.export.title")}
                  >
                    {exportBusyId === mission.id ? <Loader2 size={12} className="spin" /> : <Download size={12} />}
                    {t("skillRuns.export.title")}
                  </button>
                </div>
                {activeRunId === mission.id && reviewProposal ? (
                  <div className="skill-run-proposal">
                    <strong>{t("skillRuns.proposalReady")}</strong>
                    <span>{proposalSummary(reviewProposal)}</span>
                  </div>
                ) : null}
                {summaries[mission.id] ? (
                  <div className="skill-run-summary">
                    {t("skillRuns.summary.counts", {
                      events: summaries[mission.id].eventCount,
                      proposals: summaries[mission.id].proposalCount,
                      claimed: summaries[mission.id].writeClaimedCount,
                      committed: summaries[mission.id].writeCommittedCount,
                      conflicts: summaries[mission.id].writeConflictCount,
                    })}
                  </div>
                ) : null}
                {exportNotices[mission.id] ? (
                  <div className="skill-run-summary">{exportNotices[mission.id]}</div>
                ) : null}
              </article>
            );
          })}
        </div>
      )}
    </section>
  );
}

function skillNameFromMission(mission: MissionRecord): string | null {
  const metadata = mission.metadata;
  if (!metadata || typeof metadata !== "object" || Array.isArray(metadata)) return null;
  const skillName = (metadata as Record<string, unknown>).skillName;
  return typeof skillName === "string" && skillName.trim() ? skillName : null;
}

function workspacePathFromMission(mission: MissionRecord): string | null {
  const metadata = mission.metadata;
  if (!metadata || typeof metadata !== "object" || Array.isArray(metadata)) return null;
  const workspacePath = (metadata as Record<string, unknown>).workspacePath;
  return typeof workspacePath === "string" && workspacePath.trim() ? workspacePath : null;
}

function readClearedRunIds(key: string): Set<string> {
  if (typeof window === "undefined") return new Set();
  try {
    const raw = window.localStorage.getItem(key);
    if (!raw) return new Set();
    const parsed = JSON.parse(raw);
    return new Set(Array.isArray(parsed) ? parsed.filter((id): id is string => typeof id === "string") : []);
  } catch {
    return new Set();
  }
}

function writeClearedRunIds(key: string, ids: Set<string>) {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(key, JSON.stringify([...ids].slice(-250)));
  } catch {
    // Best-effort UI state only.
  }
}
