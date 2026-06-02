import {
  AlertTriangle,
  CalendarClock,
  CheckCircle2,
  ClipboardCheck,
  GitCompare,
  Loader2,
  Pencil,
  RefreshCcw,
  ShieldAlert,
  Square,
} from "lucide-react";
import { useState } from "react";
import { useTranslation } from "../../lib/i18n";
import { appendTasksLog, readDocument } from "../../lib/api";
import {
  agentApplySkillProposal,
  agentParseSkillProposal,
  agentReadRunEvents,
  skillsDispatchBackground,
  SKILL_PROPOSAL_APPLY_APPROVAL_KIND,
  type SkillDispatchRuntime,
  type SkillProposal,
  type SkillRecord,
} from "../../lib/skills";
import {
  extractProviderOutput,
  extractSkillProposal,
  rebuildSkillProposal,
  selectedProposalFileCount,
} from "../../lib/skillProposal";
import {
  createTaskReviewChecks,
  deriveTaskRunSteps,
  emptyTaskReviewArtifact,
  parseTaskReviewArtifact,
  selectedTaskFollowupCount,
  taskReviewCanApply,
  taskReviewChecksComplete,
  type TaskFollowupCandidate,
  type TaskProposalFileDraft,
  type TaskReviewArtifact,
  type TaskReviewCheck,
  type TaskReviewCheckKind,
  type TaskReviewCheckStatus,
} from "../../lib/taskReview";
import { logLinePhase, logLineSeverity, parseMeetingsLogLine } from "../../lib/meetingsLog";
import type { MissionRecord } from "../../lib/types";

interface TaskReviewBundle {
  runId: string;
  mission: MissionRecord;
  rawOutput: string;
  proposal: SkillProposal | null;
  review: TaskReviewArtifact;
  files: TaskProposalFileDraft[];
  checks: TaskReviewCheck[];
  followups: TaskFollowupCandidate[];
}

interface TaskApplyResult {
  runId: string;
  files: number;
  followups: number;
  appliedAt: string;
}

interface TasksRunsPanelProps {
  workPath: string;
  skills: SkillRecord[];
  runtimeCommands: Partial<Record<SkillDispatchRuntime, string | null>>;
  permissionMode?: string | null;
  appendAuditLog: boolean;
  missions: MissionRecord[];
  logLines: Record<string, string[]>;
  onMissionStarted: (invocationId: string) => void;
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

export function TasksRunsPanel({
  workPath,
  skills,
  runtimeCommands,
  permissionMode,
  appendAuditLog,
  missions,
  logLines,
  onMissionStarted,
  onStopMission,
  onRefreshMissions,
  onConfirmApproval,
  onApplied,
  onError,
}: TasksRunsPanelProps) {
  const { t } = useTranslation();
  const [bundle, setBundle] = useState<TaskReviewBundle | null>(null);
  const [reviewLoading, setReviewLoading] = useState(false);
  const [applyBusy, setApplyBusy] = useState(false);
  const [applyResult, setApplyResult] = useState<TaskApplyResult | null>(null);
  const [appliedRunIds, setAppliedRunIds] = useState<Set<string>>(() => new Set());
  const [expandedLogs, setExpandedLogs] = useState<Set<string>>(() => new Set());

  const checksComplete = bundle ? taskReviewChecksComplete(bundle.checks) : false;
  const appliedCurrentRun = Boolean(bundle && appliedRunIds.has(bundle.runId));
  const canApply = bundle
    ? !appliedCurrentRun &&
      taskReviewCanApply({
        proposal: bundle.proposal,
        files: bundle.files,
        followups: bundle.followups,
        checksComplete,
        applyBusy,
      })
    : false;

  const loadReviewResult = async (mission: MissionRecord) => {
    setReviewLoading(true);
    onError(null);
    try {
      const events = await agentReadRunEvents(workPath, mission.id);
      const raw = extractProviderOutput(events, logLines[mission.id] ?? []);
      const proposal = extractSkillProposal(events) ?? (await parseProposalFallback(raw));
      const review =
        parseTaskReviewArtifact(raw) ??
        emptyTaskReviewArtifact(proposal?.summary ?? t("tasks.review.noReview"));
      const files = await Promise.all(
        (proposal?.files ?? []).map(async (file, index) => ({
          id: `${mission.id}-${index}`,
          selected: file.operation !== "delete",
          path: file.path,
          operation: file.operation,
          beforeContent: await readProposalBeforeContent(workPath, file),
          afterContent: file.content ?? "",
          expectedHash: file.expectedHash ?? null,
          diff: file.diff ?? null,
        })),
      );
      setBundle({
        runId: mission.id,
        mission,
        rawOutput: raw,
        proposal,
        review,
        files,
        checks: createTaskReviewChecks(review),
        followups: review.followups,
      });
      setApplyResult(null);
    } catch (err) {
      onError(err instanceof Error ? err.message : String(err));
    } finally {
      setReviewLoading(false);
    }
  };

  const applyReview = async () => {
    if (!bundle || !canApply) return;
    const selectedFiles = selectedProposalFileCount(bundle.files);
    const proposal = bundle.proposal && selectedFiles > 0 ? rebuildSkillProposal(bundle.proposal, bundle.files) : null;
    const selectedFollowupItems = bundle.followups.filter((item) => item.selected);
    const approvalId = await onConfirmApproval({
      kind: SKILL_PROPOSAL_APPLY_APPROVAL_KIND,
      summary: t("tasks.review.applySummaryDetailed", {
        files: proposal?.files.length ?? 0,
        followups: selectedFollowupItems.length,
      }),
      target: [
        ...(proposal?.files.map((file) => file.path) ?? []),
        ...selectedFollowupItems.map((item) => `${item.skill}: ${item.title}`),
      ].filter(Boolean).join("\n"),
      payloadPreview: [
        proposal?.summary ?? bundle.review.summary,
        ...bundle.checks.map((check) => `${check.kind}: ${check.label} -> ${check.normalized} (${check.status})`),
        ...selectedFollowupItems.map((item) => `followup: ${item.skill} - ${item.title}`),
      ].filter(Boolean).join("\n"),
    });
    if (!approvalId) return;
    setApplyBusy(true);
    onError(null);
    try {
      if (proposal) {
        await agentApplySkillProposal({ cwd: workPath, proposal, approvalId, runId: bundle.runId });
      }
      if (selectedFollowupItems.length > 0) {
        await dispatchSelectedTaskFollowups({
          workPath,
          skills,
          runtimeCommands,
          permissionMode,
          bundle,
          onMissionStarted,
        });
      }
      setApplyResult({
        runId: bundle.runId,
        files: proposal?.files.length ?? 0,
        followups: selectedFollowupItems.length,
        appliedAt: new Date().toISOString(),
      });
      setAppliedRunIds((current) => new Set([...current, bundle.runId]));
      onApplied();
      onRefreshMissions();
      onError(t("tasks.review.applySuccess"));
      if (appendAuditLog) {
        const target = proposal?.files[0]?.path ?? selectedFollowupItems[0]?.title ?? bundle.runId;
        await appendTasksLog(
          workPath,
          `- ${new Date().toISOString()} [apply] ${JSON.stringify({
            runId: bundle.runId,
            skill: "task-management",
            target,
            files: proposal?.files.length ?? 0,
            followups: selectedFollowupItems.length,
          })}`,
        ).catch(() => {});
      }
    } catch (err) {
      onError(err instanceof Error ? err.message : String(err));
    } finally {
      setApplyBusy(false);
    }
  };

  const updateCheck = (id: string, patch: Partial<TaskReviewCheck>) =>
    setBundle((current) =>
      current
        ? { ...current, checks: current.checks.map((check) => (check.id === id ? { ...check, ...patch } : check)) }
        : current,
    );
  const updateChecks = (ids: string[], patch: Partial<TaskReviewCheck>) => {
    const idSet = new Set(ids);
    setBundle((current) =>
      current
        ? { ...current, checks: current.checks.map((check) => (idSet.has(check.id) ? { ...check, ...patch } : check)) }
        : current,
    );
  };
  const updateFile = (id: string, patch: Partial<TaskProposalFileDraft>) =>
    setBundle((current) =>
      current
        ? { ...current, files: current.files.map((file) => (file.id === id ? { ...file, ...patch } : file)) }
        : current,
    );
  const toggleFollowup = (id: string) =>
    setBundle((current) =>
      current
        ? {
            ...current,
            followups: current.followups.map((item) =>
              item.id === id ? { ...item, selected: !item.selected } : item,
            ),
          }
        : current,
    );

  return (
    <section className="tasks-runs-panel">
      <header className="tasks-runs-head">
        <div>
          <strong>{t("tasks.progress.title")}</strong>
          <span>{t("tasks.progress.count", { count: missions.length })}</span>
        </div>
        <button
          type="button"
          className="icon-button"
          onClick={onRefreshMissions}
          title={t("tasks.actions.refresh")}
          aria-label={t("tasks.actions.refresh")}
        >
          <RefreshCcw size={14} />
        </button>
      </header>

      <div className="tasks-run-list">
        {missions.length === 0 ? (
          <div className="tasks-run-empty">
            <ClipboardCheck size={16} />
            <strong>{t("tasks.progress.empty")}</strong>
            <span>{t("tasks.progress.emptyCta")}</span>
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
          const stepsComplete = activeBundle ? taskReviewChecksComplete(activeBundle.checks) : false;
          const steps = deriveTaskRunSteps({
            missionStatus: mission.status,
            logLines: lines,
            reviewLoaded: Boolean(activeBundle),
            checksComplete: stepsComplete,
            applied: appliedRunIds.has(mission.id),
          });
          const statusClass = isFailed ? "failed" : isActive ? "review-ready" : mission.status;
          const expanded = expandedLogs.has(mission.id);
          const parsedLines = lines.map(parseMeetingsLogLine);
          const latestParsed = parsedLines.at(-1);
          return (
            <article
              className={`tasks-run-card ${statusClass}`}
              data-active={isActive ? "true" : "false"}
              key={mission.id}
            >
              <div className="tasks-run-card-head">
                <div>
                  <strong>{taskMissionTitle(mission, t)}</strong>
                  <span>
                    {mission.status} · {formatTime(mission.startedAt)}
                  </span>
                </div>
                {canStop ? (
                  <button
                    type="button"
                    className="button button-ghost button-sm"
                    onClick={() => onStopMission(mission.id)}
                  >
                    <Square size={12} />
                    <span>{t("tasks.progress.stop")}</span>
                  </button>
                ) : null}
              </div>
              <div className="tasks-run-meta">
                <span>{taskMissionRuntime(mission)}</span>
                <span>{taskMissionSource(mission, t)}</span>
              </div>
              <ol className="tasks-run-steps" aria-label={t("tasks.progress.steps")}>
                {steps.map((step) => (
                  <li className={`tasks-run-step ${step.status}`} key={step.id}>
                    <span className="tasks-run-step-dot" aria-hidden="true" />
                    <span>{t(`tasks.step.${step.id}`)}</span>
                  </li>
                ))}
              </ol>
              <div className="tasks-run-log-summary">
                <span data-severity={latestParsed ? logLineSeverity(latestParsed) : "info"}>
                  {latestParsed?.raw ?? t("tasks.progress.noLog")}
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
                  {expanded ? t("tasks.progress.hideLog") : t("tasks.progress.showLog")}
                </button>
              </div>
              {expanded && parsedLines.length > 0 ? (
                <ul className="tasks-run-log" aria-label={t("tasks.progress.logLines")}>
                  {parsedLines.slice(-60).map((parsed, index) => {
                    const phase = logLinePhase(parsed);
                    return (
                      <li
                        key={`${mission.id}-log-${index}`}
                        data-severity={logLineSeverity(parsed)}
                        data-phase={phase ?? undefined}
                      >
                        {phase ? <span className="tasks-run-log-phase">{phase}</span> : null}
                        <span className="tasks-run-log-text">{parsed.raw}</span>
                      </li>
                    );
                  })}
                </ul>
              ) : null}
              <div className="tasks-run-card-actions">
                <span>
                  {appliedRunIds.has(mission.id)
                    ? t("tasks.step.applyDone")
                    : isFailed
                      ? t("tasks.progress.failedStatus")
                      : t("tasks.progress.status", { status: mission.status })}
                </span>
                {canReview ? (
                  <button
                    type="button"
                    className="secondary-button"
                    disabled={reviewLoading}
                    onClick={() => void loadReviewResult(mission)}
                  >
                    {reviewLoading && isActive ? <Loader2 size={14} className="spin" /> : <Pencil size={14} />}
                    {t("tasks.review.result")}
                  </button>
                ) : null}
              </div>
            </article>
          );
        })}
      </div>

      {bundle ? (
        <TaskReviewPanel
          bundle={bundle}
          applyBusy={applyBusy}
          applied={appliedCurrentRun}
          canApply={canApply}
          applyResult={applyResult?.runId === bundle.runId ? applyResult : null}
          onApply={() => void applyReview()}
          onDismissApplyResult={() => setApplyResult(null)}
          onUpdateFile={updateFile}
          onUpdateCheck={updateCheck}
          onUpdateChecks={updateChecks}
          onToggleFollowup={toggleFollowup}
        />
      ) : null}
    </section>
  );
}

function TaskReviewPanel({
  bundle,
  applyBusy,
  applied,
  canApply,
  applyResult,
  onApply,
  onDismissApplyResult,
  onUpdateFile,
  onUpdateCheck,
  onUpdateChecks,
  onToggleFollowup,
}: {
  bundle: TaskReviewBundle;
  applyBusy: boolean;
  applied: boolean;
  canApply: boolean;
  applyResult: TaskApplyResult | null;
  onApply: () => void;
  onDismissApplyResult: () => void;
  onUpdateFile: (id: string, patch: Partial<TaskProposalFileDraft>) => void;
  onUpdateCheck: (id: string, patch: Partial<TaskReviewCheck>) => void;
  onUpdateChecks: (ids: string[], patch: Partial<TaskReviewCheck>) => void;
  onToggleFollowup: (id: string) => void;
}) {
  const { t } = useTranslation();
  const pendingRequired = bundle.checks.filter((check) => check.required && check.status === "pending").length;
  const selectedFiles = selectedProposalFileCount(bundle.files);
  const selectedFollowups = selectedTaskFollowupCount(bundle.followups);
  const isSync = taskMissionOrigin(bundle.mission) === "taskManagementSync";
  const checkGroups = (
    [
      ["field", bundle.checks.filter((check) => check.kind === "field")],
      ["schedule", bundle.checks.filter((check) => check.kind === "schedule")],
      ["conflict", bundle.checks.filter((check) => check.kind === "conflict")],
      ["uncertainty", bundle.checks.filter((check) => check.kind === "uncertainty")],
    ] as Array<[TaskReviewCheckKind, TaskReviewCheck[]]>
  ).filter(([, checks]) => checks.length > 0);

  return (
    <section className="tasks-review-card">
      <header>
        <div>
          <span>{t("tasks.review.heading")}</span>
          <h3>{bundle.review.summary || bundle.proposal?.summary || t("tasks.review.noReview")}</h3>
        </div>
        <GitCompare size={16} />
      </header>

      {isSync ? <p className="tasks-review-sync-note">{t("tasks.review.syncNote")}</p> : null}

      <div className="tasks-review-summary">
        <span>{t("tasks.review.files", { count: bundle.files.length })}</span>
        <span>{t("tasks.review.pending", { count: pendingRequired })}</span>
      </div>

      {applyResult ? (
        <div className="tasks-apply-result" role="status">
          <CheckCircle2 size={16} />
          <div>
            <strong>{t("tasks.review.applyDoneTitle")}</strong>
            <span>
              {t("tasks.review.applyDoneDescription", {
                files: applyResult.files,
                followups: applyResult.followups,
                time: formatTime(applyResult.appliedAt),
              })}
            </span>
          </div>
          <button
            type="button"
            className="icon-button"
            onClick={onDismissApplyResult}
            aria-label={t("tasks.review.dismissApplyResult")}
          >
            ×
          </button>
        </div>
      ) : null}

      <div className="tasks-proposal-files">
        {bundle.files.length === 0 ? (
          <div className="tasks-review-empty compact">
            <AlertTriangle size={15} />
            <span>{t("tasks.review.noProposal")}</span>
          </div>
        ) : null}
        {bundle.files.map((file) => (
          <article className="tasks-proposal-file" data-operation={file.operation} key={file.id}>
            <header>
              <label>
                <input
                  type="checkbox"
                  checked={file.selected}
                  onChange={(event) => onUpdateFile(file.id, { selected: event.target.checked })}
                />
                <span>{t("tasks.review.applyFile")}</span>
              </label>
              <span className="tasks-operation-badge" data-operation={file.operation}>
                {file.operation}
              </span>
            </header>
            <label className="field">
              <span>{t("tasks.review.targetPath")}</span>
              <input value={file.path} onChange={(event) => onUpdateFile(file.id, { path: event.target.value })} />
            </label>
            <div className="tasks-before-after">
              <label>
                <span>{t("tasks.review.before")}</span>
                <pre>{file.beforeContent || t("tasks.review.newFile")}</pre>
              </label>
              <label>
                <span>{t("tasks.review.after")}</span>
                <textarea
                  value={file.afterContent}
                  onChange={(event) => onUpdateFile(file.id, { afterContent: event.target.value })}
                />
              </label>
            </div>
          </article>
        ))}
      </div>

      <div className="tasks-confirmation-panel">
        <div className="tasks-confirmation-heading">
          <h3>{t("tasks.review.confirmTitle")}</h3>
          {bundle.checks.length > 0 ? (
            <div className="tasks-check-bulk-actions" role="group" aria-label={t("tasks.review.bulkActions")}>
              <button
                type="button"
                onClick={() => onUpdateChecks(bundle.checks.map((c) => c.id), { status: "accepted" })}
              >
                {t("tasks.review.acceptAll")}
              </button>
              <button
                type="button"
                onClick={() => onUpdateChecks(bundle.checks.map((c) => c.id), { status: "rejected" })}
              >
                {t("tasks.review.excludeAll")}
              </button>
            </div>
          ) : null}
        </div>
        {bundle.checks.length === 0 ? (
          <div className="tasks-review-empty compact">
            <CheckCircle2 size={15} />
            <span>{t("tasks.review.noChecks")}</span>
          </div>
        ) : null}
        {checkGroups.map(([kind, checks]) => (
          <section className="tasks-check-group" key={kind}>
            <header>
              <div className="tasks-check-group-title">
                <strong>
                  <TaskCheckKindIcon kind={kind} />
                  {t(`tasks.review.kind.${kind}`)}
                </strong>
                <span>
                  {t("tasks.review.pending", {
                    count: checks.filter((check) => check.required && check.status === "pending").length,
                  })}
                </span>
              </div>
              <div className="tasks-check-bulk-actions compact" role="group" aria-label={t("tasks.review.bulkActions")}>
                <button type="button" onClick={() => onUpdateChecks(checks.map((c) => c.id), { status: "accepted" })}>
                  {t("tasks.review.acceptGroup")}
                </button>
                <button type="button" onClick={() => onUpdateChecks(checks.map((c) => c.id), { status: "rejected" })}>
                  {t("tasks.review.excludeGroup")}
                </button>
              </div>
            </header>
            {checks.map((check) => (
              <article
                className={`tasks-check-row ${check.status}`}
                data-status={check.status}
                data-required={check.required ? "true" : "false"}
                key={check.id}
              >
                <div>
                  <span>
                    {t(`tasks.review.kind.${check.kind}`)}
                    {check.required ? (
                      <span className="tasks-check-required" title={t("tasks.review.requiredLabel")}>
                        *
                      </span>
                    ) : null}
                  </span>
                  <strong>{check.label}</strong>
                  {check.note ? <small>{check.note}</small> : null}
                </div>
                <input
                  value={check.normalized}
                  aria-label={t("tasks.review.normalizedFor", { label: check.label })}
                  onChange={(event) => onUpdateCheck(check.id, { normalized: event.target.value, status: "edited" })}
                />
                <div className="tasks-check-actions" role="group" aria-label={t("tasks.review.checkActions")}>
                  {(["accepted", "edited", "rejected"] as TaskReviewCheckStatus[]).map((status) => (
                    <button
                      key={status}
                      type="button"
                      className={check.status === status ? "active" : ""}
                      aria-pressed={check.status === status}
                      onClick={() => onUpdateCheck(check.id, { status })}
                    >
                      {t(`tasks.review.status.${status}`)}
                    </button>
                  ))}
                </div>
              </article>
            ))}
          </section>
        ))}
      </div>

      <div className="tasks-followups">
        <h3>{t("tasks.review.followups")}</h3>
        {bundle.followups.length === 0 ? (
          <div className="tasks-review-empty compact">{t("tasks.review.noFollowups")}</div>
        ) : null}
        {bundle.followups.map((item) => (
          <label className="tasks-followup-row" key={item.id}>
            <input type="checkbox" checked={item.selected} onChange={() => onToggleFollowup(item.id)} />
            <div>
              <strong>{item.skill}</strong>
              <span>{item.title}</span>
              {item.reason ? <small>{item.reason}</small> : null}
            </div>
          </label>
        ))}
      </div>

      <div className="tasks-review-actions" data-applied={applied ? "true" : "false"}>
        <span>
          {pendingRequired > 0
            ? t("tasks.review.applyBlocked", { count: pendingRequired })
            : applied
              ? t("tasks.review.applyDoneTitle")
              : t("tasks.review.applyReadyDetailed", { files: selectedFiles, followups: selectedFollowups })}
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
          {applyBusy ? t("tasks.review.applying") : applied ? t("tasks.review.applied") : t("tasks.review.apply")}
        </button>
      </div>
    </section>
  );
}

function TaskCheckKindIcon({ kind }: { kind: TaskReviewCheckKind }) {
  switch (kind) {
    case "field":
      return <Pencil size={13} aria-hidden="true" />;
    case "schedule":
      return <CalendarClock size={13} aria-hidden="true" />;
    case "conflict":
      return <AlertTriangle size={13} aria-hidden="true" />;
    case "uncertainty":
      return <ShieldAlert size={13} aria-hidden="true" />;
    default:
      return null;
  }
}

async function parseProposalFallback(raw: string): Promise<SkillProposal | null> {
  if (!raw.trim()) return null;
  try {
    return await agentParseSkillProposal(raw);
  } catch {
    return null;
  }
}

async function readProposalBeforeContent(
  workPath: string,
  file: SkillProposal["files"][number],
): Promise<string> {
  if (file.operation === "create") return "";
  try {
    const document = await readDocument(workPath, file.path);
    return document.content;
  } catch {
    return "";
  }
}

async function dispatchSelectedTaskFollowups({
  workPath,
  skills,
  runtimeCommands,
  permissionMode,
  bundle,
  onMissionStarted,
}: {
  workPath: string;
  skills: SkillRecord[];
  runtimeCommands: Partial<Record<SkillDispatchRuntime, string | null>>;
  permissionMode?: string | null;
  bundle: TaskReviewBundle;
  onMissionStarted: (invocationId: string) => void;
}) {
  const selected = bundle.followups.filter((item) => item.selected);
  const appliedPaths = bundle.files.filter((file) => file.selected).map((file) => file.path);
  const runtime = normalizeRuntime(taskMissionRuntimeValue(bundle.mission)) ?? "claude";
  for (const followup of selected) {
    const skill = findSkill(skills, followup.skill);
    if (!skill) continue;
    const invocationId = await skillsDispatchBackground({
      skillId: skill.id,
      runtime,
      cwd: workPath,
      prompt: [
        "The user approved this selected task follow-up. Execute the approved follow-up now.",
        "",
        followup.prompt,
        "",
        "Approved execution contract:",
        "- This is not proposal-only mode; proceed to the actual approved action.",
        "- For knowledge-note reads, writes, patches, moves, deletes, tags, and searches, use MCP Obsidian only.",
        "- Do not use filesystem write/edit/shell commands for knowledge notes.",
        "- Emit progress logs and a final completion summary with changed note paths.",
        appliedPaths.length > 0 ? `Task note path(s):\n${appliedPaths.join("\n")}` : null,
      ].filter(Boolean).join("\n"),
      context: appliedPaths.map((path) => ({ path, kind: "document" })),
      commandOverride: runtimeCommands[runtime] ?? null,
      permissionMode: permissionMode ?? null,
      metadata: {
        origin: taskFollowupOrigin(followup.skill),
        runtime,
        reviewFlow: true,
        approvedExecution: true,
        parentRunId: bundle.runId,
        parentRuntime: runtime,
        workspacePath: workPath,
        skillName: followup.skill,
      },
    });
    onMissionStarted(invocationId);
  }
}

function taskFollowupOrigin(skill: string): string {
  if (skill === "vault-connect") return "taskManagementVaultConnect";
  if (skill === "meeting-notes") return "taskManagementMeetingNotes";
  return "taskManagementVaultExtract";
}

function findSkill(skills: SkillRecord[], name: string): SkillRecord | null {
  return (
    skills.find((skill) => skill.name === name) ??
    skills.find((skill) => skill.id === name || skill.id.endsWith(`:${name}`)) ??
    null
  );
}

function taskMissionMetadata(mission: MissionRecord): Record<string, unknown> | null {
  const metadata = mission.metadata;
  return metadata && typeof metadata === "object" && !Array.isArray(metadata)
    ? (metadata as Record<string, unknown>)
    : null;
}

function taskMissionOrigin(mission: MissionRecord): string | null {
  const origin = taskMissionMetadata(mission)?.origin;
  return typeof origin === "string" ? origin : null;
}

function taskMissionTitle(mission: MissionRecord, t: (key: string) => string): string {
  const origin = taskMissionOrigin(mission);
  if (origin === "taskManagementSync") return t("tasks.runs.syncTitle");
  if (origin === "taskManagementSchedule") return t("tasks.runs.scheduleTitle");
  return t("tasks.runs.taskTitle");
}

function taskMissionSource(mission: MissionRecord, t: (key: string) => string): string {
  const origin = taskMissionOrigin(mission);
  if (origin === "taskManagementSync") return t("tasks.runs.sourceSync");
  if (origin === "taskManagementSchedule") return t("tasks.runs.sourceSchedule");
  return origin ?? mission.id;
}

function taskMissionRuntimeValue(mission: MissionRecord): string | null {
  const metadata = taskMissionMetadata(mission);
  if (!metadata) return null;
  const runtime = metadata.runtime ?? metadata.parentRuntime;
  return typeof runtime === "string" && runtime.trim() ? runtime : null;
}

function taskMissionRuntime(mission: MissionRecord): string {
  const runtime = taskMissionRuntimeValue(mission);
  if (runtime === "codex") return "Codex";
  if (runtime === "claude") return "Claude";
  return runtime ?? "Runtime";
}

function normalizeRuntime(value: string | null): SkillDispatchRuntime | null {
  return value === "claude" || value === "codex" ? value : null;
}

function formatTime(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return date.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
}
