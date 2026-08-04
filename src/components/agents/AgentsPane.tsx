// Agents mode: one place to see every AI job Maru can run, what it is doing
// now, which backend it uses, and when it next fires.
//
// It owns no run tracking of its own. Missions arrive as props (App already
// listens to ai://mission_update for every background skill dispatch) and are
// grouped by `metadata.agentId`; the live log tail, the run history and the
// stop button are the same components the Inbox and Skills surfaces use.

import { Bot, Plus, RefreshCcw, RotateCcw, Square, Trash2 } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { listen } from "@tauri-apps/api/event";
import type { ApprovalInput } from "../../approval/ApprovalDialog";
import {
  agentCanRunStandalone,
  agentLabel,
  buildAgentBoard,
  deleteAgent,
  listAgents,
  resetAgent,
  resolveAgentRuntime,
  runAgent,
  upsertAgent,
  type AgentRecord,
  type AgentRow,
  type AgentRunStatus,
  type RecommendedSchedule,
} from "../../lib/agents";
import {
  addSchedule,
  isTauri,
  listSchedules,
  removeSchedule,
  runScheduleNow,
  setScheduleEnabled,
} from "../../lib/api";
import { formatRelativeDate } from "../../lib/document";
import { formatScheduleTime } from "../../lib/drafts";
import { useTranslation } from "../../lib/i18n";
import type { AiSettings } from "../../lib/settings";
import type { SkillDispatchRuntime, SkillRecord } from "../../lib/skills";
import type { MissionRecord, SchedulerSchedule } from "../../lib/types";
import { ProcessingMissionsPanel } from "../inbox/ProcessingMissionsPanel";
import { SkillRunsPanel } from "../skills/SkillRunsPanel";
import { Button, IconButton } from "../ui/Button";
import { DialogSurface, DialogSurfaceTitle } from "../ui/DialogSurface";
import { EmptyState, ModeHeader, SegmentedControl, StatusBanner } from "../ui/ModeChrome";
import { AgentChatTab } from "./AgentChatTab";
import { AgentEditor } from "./AgentEditor";

type AgentFilter = "all" | "running" | "scheduled" | "mine";
type DetailTab = "status" | "chat" | "runs" | "config";

const SCHEDULE_ADD_APPROVAL_KIND = "scheduler.add";

interface AgentsPaneProps {
  workPath: string | null;
  skills: SkillRecord[];
  ai: AiSettings;
  missions: MissionRecord[];
  logLines: Record<string, string[]>;
  runtimeCommands: Partial<Record<SkillDispatchRuntime, string | null>>;
  /** Configured tasks root, so a task created from chat lands where TasksPane
   *  looks for it rather than in the default root. */
  tasksRoot: string | null;
  onRefreshMissions: () => void;
  onStopMission: (id: string) => void;
  onMissionStarted: (id: string) => void;
  onConfirmApproval: (input: ApprovalInput) => Promise<string | null>;
  /** App holds its own copy for the converted call sites; keep it in step. */
  onAgentsChanged: () => void;
  onError: (message: string | null) => void;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Frozen, not a factory called in JSX: `AgentEditor` resets its draft whenever
 * the `agent` prop's identity changes, so a fresh object per render wiped
 * whatever the user had typed every time a background mission logged a line.
 */
const BLANK_AGENT: AgentRecord = Object.freeze({
    id: "",
    labelKey: null,
    label: "",
    description: null,
    skillName: "",
    runtime: "inherit",
    permissionMode: "inherit",
    prompt: "",
    kind: "background",
    enabled: true,
  builtin: false,
  customized: false,
});

export function AgentsPane({
  workPath,
  skills,
  ai,
  missions,
  logLines,
  runtimeCommands,
  tasksRoot,
  onRefreshMissions,
  onStopMission,
  onMissionStarted,
  onConfirmApproval,
  onAgentsChanged,
  onError,
}: AgentsPaneProps) {
  const { t } = useTranslation();
  const [agents, setAgents] = useState<AgentRecord[]>([]);
  const [schedules, setSchedules] = useState<SchedulerSchedule[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [filter, setFilter] = useState<AgentFilter>("all");
  const [tab, setTab] = useState<DetailTab>("status");
  const [createOpen, setCreateOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [localError, setLocalError] = useState<string | null>(null);
  // Held in a ref so the listen effect below does not depend on a prop whose
  // identity changes every App render.
  const missionsRef = useRef(onRefreshMissions);
  useEffect(() => {
    missionsRef.current = onRefreshMissions;
  }, [onRefreshMissions]);

  const refresh = useCallback(async () => {
    try {
      const next = await listAgents();
      setAgents(next);
      setSchedules(workPath ? await listSchedules(workPath) : []);
      setLocalError(null);
      // Every converted AI feature reads App's copy, so an edit here has to
      // reach it or the Inbox would keep dispatching on the old backend.
      onAgentsChanged();
    } catch (error) {
      const message = errorMessage(error);
      setLocalError(message);
      onError(message);
    }
  }, [onAgentsChanged, onError, workPath]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  // A schedule fired or changed elsewhere (the ticker, another pane) must show
  // up here without a manual reload.
  useEffect(() => {
    // `listen` reaches into the Tauri runtime, which the browser dev and e2e
    // shells do not have; without this guard the pane throws on mount there.
    if (!isTauri()) return;
    let disposed = false;
    const offs: Array<() => void> = [];
    for (const event of ["scheduler://changed", "scheduler://fired", "scheduler://error"]) {
      void listen<{ message?: string }>(event, (payload) => {
        // A schedule that fails every morning must not look identical to one
        // that never fired. The retired scheduler section was the only surface
        // that showed these.
        if (event === "scheduler://error" && payload.payload?.message) {
          setLocalError(payload.payload.message);
        }
        void refresh();
        missionsRef.current();
      })
        .then((off) => {
          if (disposed) off();
          else offs.push(off);
        })
        .catch(() => undefined);
    }
    return () => {
      disposed = true;
      for (const off of offs) off();
    };
  }, [refresh]);

  const { rows, orphans } = useMemo(
    () => buildAgentBoard(agents, schedules, missions),
    [agents, missions, schedules],
  );

  const visibleRows = useMemo(() => {
    switch (filter) {
      case "running":
        return rows.filter((row) => row.status === "running" || row.status === "idle");
      case "scheduled":
        return rows.filter((row) => row.schedules.length > 0);
      case "mine":
        return rows.filter((row) => !row.agent.builtin);
      default:
        return rows;
    }
  }, [filter, rows]);

  // Scoped to `visibleRows`, not `rows`: searching all rows kept the detail
  // pane rendering an agent that the filter had just hidden, with a live
  // delete button on a row the user could no longer see.
  const selected = useMemo(
    () => visibleRows.find((row) => row.agent.id === selectedId) ?? visibleRows[0] ?? null,
    [selectedId, visibleRows],
  );

  const runningCount = rows.filter(
    (row) => row.status === "running" || row.status === "idle",
  ).length;
  const scheduledCount =
    rows.reduce((total, row) => total + row.schedules.length, 0) + orphans.length;

  const save = useCallback(
    async (agent: AgentRecord) => {
      setBusy(true);
      try {
        const saved = await upsertAgent(agent);
        setSelectedId(saved.id);
        await refresh();
        setCreateOpen(false);
        setLocalError(null);
      } catch (error) {
        const message = errorMessage(error);
        setLocalError(message);
        onError(message);
      } finally {
        setBusy(false);
      }
    },
    [onError, refresh],
  );

  const runNow = useCallback(
    async (row: AgentRow) => {
      if (!workPath) return;
      setBusy(true);
      try {
        // A schedule carries the prompt and cwd the user already approved, so
        // running through it keeps a scheduled agent's manual run identical to
        // its timed one.
        const invocationId = row.schedules[0]
          ? await runScheduleNow(workPath, row.schedules[0].id)
          : await runAgent(row.agent, { skills, ai, workPath });
        onMissionStarted(invocationId);
        onRefreshMissions();
        setTab("status");
        setLocalError(null);
      } catch (error) {
        const message = errorMessage(error);
        setLocalError(message);
        onError(message);
      } finally {
        setBusy(false);
      }
    },
    [ai, onError, onMissionStarted, onRefreshMissions, skills, workPath],
  );

  const attachSchedule = useCallback(
    async (row: AgentRow, when: RecommendedSchedule) => {
      if (!workPath) return;
      setBusy(true);
      try {
        const approvalId = await onConfirmApproval({
          kind: SCHEDULE_ADD_APPROVAL_KIND,
          summary: t("agents.schedule.approval", { name: agentLabel(row.agent, t) }),
          target: workPath,
          payloadPreview: `${formatScheduleTime(when.hour, when.minute)} · ${row.agent.skillName}`,
        });
        if (!approvalId) return;
        await addSchedule(
          workPath,
          {
            name: agentLabel(row.agent, t),
            skillId: row.agent.skillName,
            runtime: resolveAgentRuntime(row.agent, ai),
            prompt: row.agent.prompt,
            hour: when.hour,
            minute: when.minute,
            daysOfWeek: when.daysOfWeek,
            enabled: true,
            agentId: row.agent.id,
          },
          approvalId,
        );
        await refresh();
        setLocalError(null);
      } catch (error) {
        const message = errorMessage(error);
        setLocalError(message);
        onError(message);
      } finally {
        setBusy(false);
      }
    },
    [ai, onConfirmApproval, onError, refresh, t, workPath],
  );

  const runSchedule = useCallback(
    async (schedule: SchedulerSchedule) => {
      if (!workPath) return;
      setBusy(true);
      try {
        const invocationId = await runScheduleNow(workPath, schedule.id);
        onMissionStarted(invocationId);
        onRefreshMissions();
        setLocalError(null);
      } catch (error) {
        const message = errorMessage(error);
        setLocalError(message);
        onError(message);
      } finally {
        setBusy(false);
      }
    },
    [onError, onMissionStarted, onRefreshMissions, workPath],
  );

  const toggleSchedule = useCallback(
    async (schedule: SchedulerSchedule) => {
      if (!workPath) return;
      setBusy(true);
      try {
        await setScheduleEnabled(workPath, schedule.id, !schedule.enabled);
        await refresh();
        setLocalError(null);
      } catch (error) {
        const message = errorMessage(error);
        setLocalError(message);
        onError(message);
      } finally {
        setBusy(false);
      }
    },
    [onError, refresh, workPath],
  );

  const detachSchedule = useCallback(
    async (schedule: SchedulerSchedule) => {
      if (!workPath) return;
      // schedules.json has no undo, and a skill-matched schedule may be one the
      // user built in the old UI with a prompt this agent never owned.
      if (!window.confirm(t("drafts.automation.removeConfirm", { name: schedule.name }))) {
        return;
      }
      setBusy(true);
      try {
        await removeSchedule(workPath, schedule.id);
        await refresh();
      } catch (error) {
        const message = errorMessage(error);
        setLocalError(message);
        onError(message);
      } finally {
        setBusy(false);
      }
    },
    [onError, refresh, t, workPath],
  );

  const remove = useCallback(
    async (agent: AgentRecord) => {
      setBusy(true);
      try {
        await deleteAgent(agent.id);
        setSelectedId(null);
        await refresh();
      } catch (error) {
        const message = errorMessage(error);
        setLocalError(message);
        onError(message);
      } finally {
        setBusy(false);
      }
    },
    [onError, refresh],
  );

  const reset = useCallback(
    async (agent: AgentRecord) => {
      setBusy(true);
      try {
        await resetAgent(agent.id);
        await refresh();
      } catch (error) {
        const message = errorMessage(error);
        setLocalError(message);
        onError(message);
      } finally {
        setBusy(false);
      }
    },
    [onError, refresh],
  );

  return (
    <section className="agents-pane" aria-label={t("mode.agents")}>
      <ModeHeader
        eyebrow={t("agents.header.eyebrow")}
        title={t("agents.header.title")}
        subtitle={t("agents.header.counts", {
          running: runningCount,
          scheduled: scheduledCount,
          total: rows.length,
        })}
        actions={
          <>
            <Button variant="primary" size="sm" onClick={() => setCreateOpen(true)}>
              <Plus size={14} />
              <span>{t("agents.new")}</span>
            </Button>
            <IconButton
              label={t("agents.refresh")}
              onClick={() => {
                void refresh();
                onRefreshMissions();
              }}
            >
              <RefreshCcw size={15} />
            </IconButton>
          </>
        }
      />

      {localError ? (
        <StatusBanner tone="danger">
          <span>{localError}</span>
        </StatusBanner>
      ) : null}

      <div className="agents-body">
        <div className="agents-list-col">
          <SegmentedControl<AgentFilter>
            className="agents-filter"
            label={t("agents.filter.label")}
            value={filter}
            onChange={setFilter}
            options={[
              { value: "all", label: t("agents.filter.all") },
              { value: "running", label: t("agents.filter.running") },
              { value: "scheduled", label: t("agents.filter.scheduled") },
              { value: "mine", label: t("agents.filter.mine") },
            ]}
          />
          <div className="agents-list">
            {visibleRows.length === 0 ? (
              <EmptyState
                icon={<Bot size={18} />}
                title={t("agents.list.empty")}
                description={t("agents.list.emptyHint")}
              />
            ) : null}
            {visibleRows.map((row) => (
              <AgentListItem
                key={row.agent.id}
                row={row}
                active={selected?.agent.id === row.agent.id}
                onSelect={() => {
                  setSelectedId(row.agent.id);
                  setTab("status");
                }}
              />
            ))}
          </div>
          {orphans.length > 0 && filter !== "mine" ? (
            <div className="agents-orphans">
              <h4>{t("agents.orphans.title")}</h4>
              <p>{t("agents.orphans.hint")}</p>
              {orphans.map((schedule) => (
                <div key={schedule.id} className="agents-schedule-row">
                  <span>
                    {schedule.name}
                    {" · "}
                    {formatScheduleTime(schedule.hour, schedule.minute)}
                    {schedule.enabled ? "" : ` · ${t("agents.schedule.paused")}`}
                  </span>
                  <span className="agents-orphan-actions">
                    <Button
                      variant="ghost"
                      size="sm"
                      disabled={busy || !workPath}
                      onClick={() => void runSchedule(schedule)}
                    >
                      {t("agents.action.run")}
                    </Button>
                    <Button
                      variant="ghost"
                      size="sm"
                      disabled={busy || !workPath}
                      onClick={() => void toggleSchedule(schedule)}
                    >
                      {schedule.enabled
                        ? t("agents.orphans.pause")
                        : t("agents.orphans.resume")}
                    </Button>
                    <Button
                      variant="ghost"
                      size="sm"
                      disabled={busy || !workPath}
                      onClick={() => void detachSchedule(schedule)}
                    >
                      {t("agents.schedule.remove")}
                    </Button>
                  </span>
                </div>
              ))}
            </div>
          ) : null}
        </div>

        <div className="agents-detail-col">
          {selected ? (
            <AgentDetail
              row={selected}
              tab={tab}
              onTab={setTab}
              skills={skills}
              ai={ai}
              busy={busy}
              workPath={workPath}
              logLines={logLines}
              runtimeCommands={runtimeCommands}
              tasksRoot={tasksRoot}
              onRun={() => void runNow(selected)}
              onStop={() => {
                if (selected.activeMissionId) onStopMission(selected.activeMissionId);
              }}
              onAttachSchedule={(when) => void attachSchedule(selected, when)}
              onDetachSchedule={(schedule) => void detachSchedule(schedule)}
              onToggleSchedule={(schedule) => void toggleSchedule(schedule)}
              onSave={save}
              onDelete={() => void remove(selected.agent)}
              onReset={() => void reset(selected.agent)}
              onRefreshMissions={onRefreshMissions}
              onStopMissionById={onStopMission}
              onMissionStarted={onMissionStarted}
              onConfirmApproval={onConfirmApproval}
              onError={onError}
            />
          ) : (
            <EmptyState
              icon={<Bot size={20} />}
              title={t("agents.detail.none")}
              description={t("agents.detail.noneHint")}
            />
          )}
        </div>
      </div>

      <DialogSurface
        open={createOpen}
        onOpenChange={setCreateOpen}
        ariaLabel={t("agents.new")}
      >
        <DialogSurfaceTitle>{t("agents.new")}</DialogSurfaceTitle>
        <AgentEditor
          create
          agent={BLANK_AGENT}
          skills={skills}
          busy={busy}
          takenIds={agents.map((agent) => agent.id)}
          onSave={save}
          onCancel={() => setCreateOpen(false)}
        />
      </DialogSurface>
    </section>
  );
}

function statusDot(status: AgentRunStatus): string {
  switch (status) {
    case "running":
      return "●";
    case "idle":
      return "◐";
    case "failed":
    case "stopped":
      return "✕";
    case "done":
      return "✓";
    default:
      return "○";
  }
}

function AgentListItem({
  row,
  active,
  onSelect,
}: {
  row: AgentRow;
  active: boolean;
  onSelect: () => void;
}) {
  const { t, locale } = useTranslation();
  const { agent, status } = row;
  const schedule = row.schedules[0] ?? null;
  const runtimeLabel =
    agent.runtime === "inherit" ? t("agents.runtime.inherit") : agent.runtime;
  const scheduleLabel = schedule
    ? `${formatScheduleTime(schedule.hour, schedule.minute)} · ${
        schedule.daysOfWeek.length === 0
          ? t("agents.schedule.daily")
          : schedule.daysOfWeek.map((day) => t(`drafts.weekday.${day}`)).join(" ")
      }`
    : t("agents.schedule.manual");
  const extraSchedules = row.schedules.length - 1;
  const lastRun = row.missions[0]?.lastOutputAt ?? null;

  return (
    <button
      type="button"
      className={[
        "agents-list-item",
        active ? "active" : "",
        agent.enabled ? "" : "disabled",
      ]
        .filter(Boolean)
        .join(" ")}
      onClick={onSelect}
    >
      <span className="agents-list-title">
        <span className={`agents-status-dot status-${status}`} aria-hidden="true">
          {statusDot(status)}
        </span>
        <strong>{agentLabel(agent, t)}</strong>
        {agent.enabled ? null : <em>{t("agents.row.disabled")}</em>}
      </span>
      <code className="agents-list-skill">
        {agent.kind === "inline" ? t("agents.row.inline") : agent.skillName}
      </code>
      <span className="agents-list-meta">
        <span className="agents-runtime-badge">{runtimeLabel}</span>
        <span>{scheduleLabel}</span>
        {extraSchedules > 0 ? (
          <span>{t("agents.schedule.more", { count: extraSchedules })}</span>
        ) : null}
      </span>
      <span className="agents-list-run">
        {lastRun
          ? t(`agents.status.${status}`) + " · " + formatRelativeDate(lastRun, locale)
          : t("agents.status.never")}
      </span>
    </button>
  );
}

function AgentDetail({
  row,
  tab,
  onTab,
  skills,
  ai,
  busy,
  workPath,
  logLines,
  runtimeCommands,
  onRun,
  onStop,
  onAttachSchedule,
  onDetachSchedule,
  onToggleSchedule,
  tasksRoot,
  onSave,
  onDelete,
  onReset,
  onRefreshMissions,
  onStopMissionById,
  onMissionStarted,
  onConfirmApproval,
  onError,
}: {
  row: AgentRow;
  tab: DetailTab;
  onTab: (tab: DetailTab) => void;
  skills: SkillRecord[];
  ai: AiSettings;
  busy: boolean;
  workPath: string | null;
  logLines: Record<string, string[]>;
  runtimeCommands: Partial<Record<SkillDispatchRuntime, string | null>>;
  tasksRoot: string | null;
  onRun: () => void;
  onStop: () => void;
  onAttachSchedule: (when: RecommendedSchedule) => void;
  onDetachSchedule: (schedule: SchedulerSchedule) => void;
  onToggleSchedule: (schedule: SchedulerSchedule) => void;
  onSave: (agent: AgentRecord) => void | Promise<void>;
  onDelete: () => void;
  onReset: () => void;
  onRefreshMissions: () => void;
  onStopMissionById: (id: string) => void;
  onMissionStarted: (id: string) => void;
  onConfirmApproval: (input: ApprovalInput) => Promise<string | null>;
  onError: (message: string | null) => void;
}) {
  const { t, locale } = useTranslation();
  const { agent } = row;
  const label = agentLabel(agent, t);
  const inline = agent.kind === "inline";
  // A feature-bound agent has no prompt of its own; its owning surface builds
  // one per run, so "run now" here would dispatch nothing. A schedule supplies
  // one, which is why an attached schedule re-enables the button.
  const canRun =
    Boolean(workPath)
    && !inline
    && agent.enabled
    && (agentCanRunStandalone(agent) || row.schedules.length > 0);
  const liveMissions = row.missions.filter(
    (mission) => mission.status === "running" || mission.status === "idle",
  );

  return (
    <div className="agents-detail">
      <header className="agents-detail-header">
        <div>
          <h3>{label}</h3>
          <p className="agents-detail-meta">
            <code>{inline ? t("agents.row.inline") : agent.skillName}</code>
            <span>·</span>
            <span>{resolveAgentRuntime(agent, ai)}</span>
            <span>·</span>
            <span>{agent.enabled ? t("agents.row.enabled") : t("agents.row.disabled")}</span>
            {agent.customized ? (
              <>
                <span>·</span>
                <span>{t("agents.row.customized")}</span>
              </>
            ) : null}
          </p>
        </div>
        <div className="agents-detail-actions">
          {row.activeMissionId ? (
            <Button variant="secondary" size="sm" onClick={onStop}>
              <Square size={13} />
              <span>{t("agents.action.stop")}</span>
            </Button>
          ) : (
            <Button
              variant="primary"
              size="sm"
              disabled={!canRun || busy}
              title={canRun ? undefined : t("agents.action.runBlocked")}
              onClick={onRun}
            >
              {t("agents.action.run")}
            </Button>
          )}
          {agent.builtin ? (
            agent.customized ? (
              <Button variant="ghost" size="sm" disabled={busy} onClick={onReset}>
                <RotateCcw size={13} />
                <span>{t("agents.action.reset")}</span>
              </Button>
            ) : null
          ) : (
            <Button variant="danger" size="sm" disabled={busy} onClick={onDelete}>
              <Trash2 size={13} />
              <span>{t("agents.action.delete")}</span>
            </Button>
          )}
        </div>
      </header>

      {inline ? (
        <StatusBanner tone="info">
          <span>{t("agents.detail.inlineNote")}</span>
        </StatusBanner>
      ) : null}

      <SegmentedControl<DetailTab>
        className="agents-detail-tabs"
        label={t("agents.detail.tabs")}
        value={tab}
        onChange={onTab}
        options={[
          { value: "status", label: t("agents.tab.status") },
          { value: "chat", label: t("agents.tab.chat") },
          { value: "runs", label: t("agents.tab.runs") },
          { value: "config", label: t("agents.tab.config") },
        ]}
      />

      {tab === "status" ? (
        <div className="agents-detail-body">
          <ProcessingMissionsPanel
            missions={liveMissions}
            logLines={logLines}
            title={label}
            emptyLabel={t("agents.status.noLiveRun")}
            onStop={(id) => onStopMissionById(id)}
          />
          {inline ? null : (
            <div className="agents-next-run">
              <h4>{t("agents.schedule.title")}</h4>
              {row.schedules.map((schedule) => (
                <div key={schedule.id} className="agents-schedule-row">
                  <span>
                    {schedule.enabled
                      ? schedule.nextRunAt
                        ? formatRelativeDate(schedule.nextRunAt, locale)
                        : t("agents.schedule.unscheduled")
                      : t("agents.schedule.paused")}
                    {" · "}
                    {formatScheduleTime(schedule.hour, schedule.minute)}
                    {schedule.agentId ? null : ` · ${t("agents.schedule.inferred")}`}
                  </span>
                  <span className="agents-orphan-actions">
                    {/* The retired scheduler section had a per-schedule enable
                        checkbox; without one, pausing for a week meant delete. */}
                    <Button
                      variant="ghost"
                      size="sm"
                      disabled={busy}
                      onClick={() => onToggleSchedule(schedule)}
                    >
                      {schedule.enabled
                        ? t("agents.orphans.pause")
                        : t("agents.orphans.resume")}
                    </Button>
                    <Button
                      variant="ghost"
                      size="sm"
                      disabled={busy}
                      onClick={() => onDetachSchedule(schedule)}
                    >
                      {t("agents.schedule.remove")}
                    </Button>
                  </span>
                </div>
              ))}
              <ScheduleForm
                recommended={agent.recommendedSchedule ?? null}
                disabled={busy || !workPath || !agentCanRunStandalone(agent)}
                onAdd={onAttachSchedule}
              />
            </div>
          )}
        </div>
      ) : null}

      {tab === "chat" ? (
        <div className="agents-detail-body">
          <AgentChatTab
            key={`${workPath ?? "no-workspace"}:${agent.id}`}
            agent={agent}
            ai={ai}
            workPath={workPath}
            tasksRoot={tasksRoot}
            runtimeCommands={runtimeCommands}
            resolvedRuntime={resolveAgentRuntime(agent, ai) as SkillDispatchRuntime}
            permissionMode={
              agent.permissionMode === "inherit" ? ai.permissionMode : agent.permissionMode
            }
            onConfirmApproval={onConfirmApproval}
            onError={onError}
          />
        </div>
      ) : null}

      {tab === "runs" ? (
        <div className="agents-detail-body">
          <SkillRunsPanel
            workPath={workPath}
            missions={row.missions}
            logLines={logLines}
            runtimeCommands={runtimeCommands}
            permissionMode={agent.permissionMode === "inherit" ? ai.permissionMode : agent.permissionMode}
            onRefresh={onRefreshMissions}
            onStopMission={onStopMissionById}
            onMissionStarted={onMissionStarted}
            onConfirmApproval={onConfirmApproval}
            onError={onError}
          />
        </div>
      ) : null}

      {tab === "config" ? (
        <div className="agents-detail-body">
          <AgentEditor agent={agent} skills={skills} busy={busy} onSave={onSave} />
        </div>
      ) : null}
    </div>
  );
}

/**
 * Attach-a-schedule form. Pre-filled from the agent's recommendation when it
 * has one, but always editable — a user-created agent has no recommendation
 * and would otherwise have no way to be scheduled at all.
 */
function ScheduleForm({
  recommended,
  disabled,
  onAdd,
}: {
  recommended: RecommendedSchedule | null;
  disabled: boolean;
  onAdd: (when: RecommendedSchedule) => void;
}) {
  const { t } = useTranslation();
  const [hour, setHour] = useState(recommended?.hour ?? 9);
  const [minute, setMinute] = useState(recommended?.minute ?? 0);
  const [days, setDays] = useState<number[]>(recommended?.daysOfWeek ?? []);

  useEffect(() => {
    setHour(recommended?.hour ?? 9);
    setMinute(recommended?.minute ?? 0);
    setDays(recommended?.daysOfWeek ?? []);
  }, [recommended]);

  return (
    <div className="agents-schedule-form">
      {recommended ? (
        <p>
          {t("agents.schedule.recommended", {
            time: formatScheduleTime(recommended.hour, recommended.minute),
            days:
              recommended.daysOfWeek.length === 0
                ? t("agents.schedule.daily")
                : recommended.daysOfWeek.map((day) => t(`drafts.weekday.${day}`)).join(" "),
          })}
        </p>
      ) : null}
      <div className="agents-schedule-inputs">
        <label>
          <span>{t("agents.schedule.time")}</span>
          <input
            type="number"
            min={0}
            max={23}
            value={hour}
            onChange={(event) => setHour(Number(event.target.value))}
          />
          <input
            type="number"
            min={0}
            max={59}
            value={minute}
            onChange={(event) => setMinute(Number(event.target.value))}
          />
        </label>
        <div className="agents-schedule-days" role="group" aria-label={t("agents.schedule.days")}>
          {[0, 1, 2, 3, 4, 5, 6].map((day) => (
            <label key={day}>
              <input
                type="checkbox"
                checked={days.includes(day)}
                onChange={(event) =>
                  setDays((current) =>
                    event.target.checked
                      ? [...current, day].sort()
                      : current.filter((value) => value !== day),
                  )
                }
              />
              <span>{t(`drafts.weekday.${day}`)}</span>
            </label>
          ))}
        </div>
      </div>
      <Button
        variant="secondary"
        size="sm"
        disabled={disabled}
        title={disabled ? t("agents.schedule.blocked") : undefined}
        onClick={() => onAdd({ hour, minute, daysOfWeek: days })}
      >
        {t("agents.schedule.add")}
      </Button>
    </div>
  );
}
