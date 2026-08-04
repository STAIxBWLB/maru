// The agent layer: one named preset per AI dispatch, and the single runner
// every AI feature goes through.
//
// Before this module each feature repeated the same seven steps inline —
// resolve a skill by name, read `ai.defaultRuntime`, look up the command
// override, probe `skillsRuntimeStatus`, build a prompt, build the context
// list, dispatch with hand-written metadata. `runAgent` does the six
// mechanical ones; callers keep only the part that is actually theirs, the
// prompt and the context.
//
// The record itself lives in Rust (`src-tauri/src/agents.rs`) at
// `~/.maru/agents.json`; this file only mirrors the wire types.

import { invoke } from "@tauri-apps/api/core";
import { invokeE2EOverride } from "./e2eInvoke";
import type { AiPermissionMode, AiRuntime, AiSettings } from "./settings";
import {
  skillsDispatchBackground,
  skillsRuntimeStatus,
  type SkillContextItem,
  type SkillDispatchRuntime,
  type SkillRecord,
  type SkillRuntimeStatus,
} from "./skills";
import type { MissionRecord, SchedulerSchedule } from "./types";

declare global {
  interface Window {
    __TAURI_INTERNALS__?: unknown;
  }
}

const isTauri = () =>
  typeof window !== "undefined" && Boolean(window.__TAURI_INTERNALS__);

export type AgentRuntimeChoice = AiRuntime | "inherit";
export type AgentPermissionChoice = AiPermissionMode | "inherit";
/** "background" = tracked, stoppable mission. "inline" = request/response. */
export type AgentKind = "background" | "inline";

export const AGENT_RUNTIME_CHOICES: readonly AgentRuntimeChoice[] = [
  "inherit",
  "claude",
  "codex",
  "kimi",
  "kiro",
];

export interface RecommendedSchedule {
  hour: number;
  minute: number;
  /** 0 = Sunday .. 6 = Saturday; empty means daily. */
  daysOfWeek: number[];
}

export interface AgentRecord {
  id: string;
  /** i18n key — builtins only. */
  labelKey?: string | null;
  /** Literal label — user agents only. */
  label?: string | null;
  description?: string | null;
  /** Skill *name*, resolved to the composite registry id at run time. */
  skillName: string;
  runtime: AgentRuntimeChoice;
  permissionMode: AgentPermissionChoice;
  prompt: string;
  kind: AgentKind;
  enabled: boolean;
  builtin: boolean;
  customized: boolean;
  recommendedSchedule?: RecommendedSchedule | null;
}

// === Registry ===

/**
 * Ids of the builtin seeds the frontend binds features to. Rust owns the real
 * records; this list exists only so the browser dev shell and the e2e seam
 * resolve them at all — the same reason `MOCK_BUILTIN_SKILLS` exists in
 * skills.ts. An empty list there would make every converted feature fail with
 * `agent_not_found`.
 */
export const MOCK_BUILTIN_AGENTS: Array<
  Pick<AgentRecord, "id" | "labelKey" | "skillName" | "kind">
> = [
  { id: "inbox-triage", labelKey: "agents.builtin.inboxTriage", skillName: "inbox-process", kind: "background" },
  { id: "inbox-classify", labelKey: "agents.builtin.inboxClassify", skillName: "", kind: "inline" },
  { id: "meeting-notes", labelKey: "agents.builtin.meetingNotes", skillName: "meeting-notes", kind: "background" },
  { id: "task-extract", labelKey: "agents.builtin.taskExtract", skillName: "task-management", kind: "background" },
  { id: "ideation-draft", labelKey: "agents.builtin.ideationDraft", skillName: "ideation-drafts", kind: "background" },
  { id: "commit-message", labelKey: "agents.builtin.commitMessage", skillName: "", kind: "inline" },
  { id: "vault-hygiene", labelKey: "agents.builtin.vaultHygiene", skillName: "vault-lint", kind: "background" },
  { id: "vault-proposal", labelKey: "agents.builtin.vaultProposal", skillName: "vault-sync", kind: "background" },
  { id: "daily-digest", labelKey: "agents.builtin.dailyDigest", skillName: "draft-writer", kind: "background" },
  { id: "git-sync", labelKey: "agents.builtin.gitSync", skillName: "git-sync", kind: "background" },
];

function mockBuiltinAgents(): AgentRecord[] {
  return MOCK_BUILTIN_AGENTS.map((seed) => ({
    ...seed,
    label: null,
    description: null,
    runtime: "inherit",
    permissionMode: "inherit",
    prompt: "",
    enabled: true,
    builtin: true,
    customized: false,
  }));
}

export async function listAgents(): Promise<AgentRecord[]> {
  if (!isTauri()) {
    const override = await invokeE2EOverride<AgentRecord[]>("agents_list", {});
    if (override) return override;
    return mockBuiltinAgents();
  }
  return invoke<AgentRecord[]>("agents_list");
}

export async function upsertAgent(agent: AgentRecord): Promise<AgentRecord> {
  if (!isTauri()) {
    const override = await invokeE2EOverride<AgentRecord>("agents_upsert", { agent });
    if (override) return override;
    return agent;
  }
  return invoke<AgentRecord>("agents_upsert", { agent });
}

export async function deleteAgent(id: string): Promise<AgentRecord[]> {
  if (!isTauri()) {
    const override = await invokeE2EOverride<AgentRecord[]>("agents_delete", { id });
    if (override) return override;
    return [];
  }
  return invoke<AgentRecord[]>("agents_delete", { id });
}

export async function resetAgent(id: string): Promise<AgentRecord> {
  if (!isTauri()) {
    const override = await invokeE2EOverride<AgentRecord>("agents_reset", { id });
    if (override) return override;
    throw new Error(`agent_not_builtin: ${id}`);
  }
  return invoke<AgentRecord>("agents_reset", { id });
}

// === Resolution ===

/**
 * Skill lookup by *name* first, then by registry id. Registry ids are
 * `<sourceId>::<name>` and machine-local — the same skill installs from
 * `maru-builtin`, `stai-public` or an import on different machines — so an
 * agent stores the portable name and resolves it here.
 */
export function findSkill(skills: SkillRecord[], nameOrId: string): SkillRecord | null {
  const needle = nameOrId.trim().toLowerCase();
  if (!needle) return null;
  return (
    skills.find((skill) => skill.name.toLowerCase() === needle)
    ?? skills.find((skill) => skill.id.toLowerCase() === needle)
    ?? skills.find((skill) => skill.id.toLowerCase().endsWith(`:${needle}`))
    ?? null
  );
}

export function resolveAgentRuntime(agent: AgentRecord, ai: AiSettings): AiRuntime {
  return agent.runtime === "inherit" ? ai.defaultRuntime : agent.runtime;
}

export function resolveAgentPermissionMode(
  agent: AgentRecord,
  ai: AiSettings,
): AiPermissionMode {
  return agent.permissionMode === "inherit" ? ai.permissionMode : agent.permissionMode;
}

/** The preferred runtime first, then the rest — so a missing CLI degrades. */
export function agentRuntimeFallbackOrder(preferred: AiRuntime): AiRuntime[] {
  return [
    preferred,
    ...(["claude", "codex", "kimi", "kiro"] as AiRuntime[]).filter(
      (runtime) => runtime !== preferred,
    ),
  ];
}

/**
 * True when the agent carries everything a standalone run needs. A background
 * agent with an empty prompt is feature-bound: the surface that owns it builds
 * the prompt per run, so "지금 실행" from the pane would dispatch nothing.
 */
export function agentCanRunStandalone(agent: AgentRecord): boolean {
  return agent.kind === "background" && agent.prompt.trim().length > 0;
}

export function agentLabel(agent: AgentRecord, t: (key: string) => string): string {
  if (agent.labelKey) return t(agent.labelKey);
  const label = agent.label?.trim();
  return label && label.length > 0 ? label : agent.id;
}

/**
 * Kebab-case id derived from a user agent's name. Mirrors the Rust id rule
 * (`^[a-z0-9][a-z0-9-]{0,47}$`) so the editor can reject a bad name before the
 * round trip; returns "" when the name yields nothing valid.
 */
export function slugifyAgentId(name: string): string {
  const slug = name
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 48)
    .replace(/-+$/, "");
  return /^[a-z0-9]/.test(slug) ? slug : "";
}

/**
 * Human-readable text for the machine tokens `runAgent` throws. The converted
 * call sites all surface what they catch, but the user used to read a sentence
 * in their language where they would now read `agent_skill_missing: …`.
 */
export function agentErrorMessage(
  error: unknown,
  t: (key: string, vars?: Record<string, string | number>) => string,
): string {
  const raw = error instanceof Error ? error.message : String(error);
  const [token, detail] = raw.split(/:\s*/, 2);
  switch (token) {
    case "agent_skill_missing":
      return t("agents.error.skillMissing", { skill: detail ?? "" });
    case "agent_disabled":
      return t("agents.error.disabled", { agent: detail ?? "" });
    case "agent_not_found":
      return t("agents.error.notFound", { agent: detail ?? "" });
    case "agent_prompt_required":
      return t("agents.error.promptRequired");
    default:
      return raw;
  }
}

export function findAgent(agents: AgentRecord[], id: string): AgentRecord | null {
  return agents.find((agent) => agent.id === id) ?? null;
}

/**
 * The agent a feature is bound to. Builtin seeds always exist, so a miss means
 * the registry could not be read — a clear error beats silently falling back to
 * global settings and ignoring whatever the user configured.
 */
export function requireAgent(agents: AgentRecord[], id: string): AgentRecord {
  const agent = findAgent(agents, id);
  if (!agent) throw new Error(`agent_not_found: ${id}`);
  return agent;
}

// === Runner ===

export interface RunAgentContext {
  skills: SkillRecord[];
  ai: AiSettings;
  workPath: string;
  /** Overrides `agent.prompt`. Feature-bound agents always pass one. */
  prompt?: string;
  context?: SkillContextItem[];
  metadata?: Record<string, unknown>;
}

export interface AgentDispatch {
  invocationId: string;
  runtime: AiRuntime;
  skillId: string;
}

/**
 * Resolve, probe and dispatch one agent run. Returns the invocation id, the
 * runtime actually used (which may differ from the preferred one after
 * fallback) and the resolved skill id.
 *
 * `metadata.origin` is defaulted to the agent id but never overwritten:
 * `isInboxProcessMission`, `isCompletedSchedulerSkillMission` and the tasks
 * runs panel all branch on `origin`, so a converted call site must keep
 * emitting exactly the origin it emitted before. `agentId` is always stamped —
 * it is the join key the Agents pane uses to group missions.
 */
export async function runAgentDetailed(
  agent: AgentRecord,
  ctx: RunAgentContext,
): Promise<AgentDispatch> {
  if (agent.kind !== "background") {
    throw new Error(`agent_not_background: ${agent.id}`);
  }
  // Turning an agent off has to actually stop its feature, not just hide the
  // row. One guard here covers every call site and the scheduler alike.
  if (!agent.enabled) throw new Error(`agent_disabled: ${agent.id}`);
  const prompt = (ctx.prompt ?? agent.prompt).trim();
  if (!prompt) throw new Error("agent_prompt_required");

  const skill = findSkill(ctx.skills, agent.skillName);
  if (!skill) throw new Error(`agent_skill_missing: ${agent.skillName}`);

  const preferred = resolveAgentRuntime(agent, ctx.ai);
  const permissionMode = resolveAgentPermissionMode(agent, ctx.ai);
  const { runtime, commandOverride } = await resolveAvailableRuntime(preferred, ctx.ai);

  const context = ctx.context ?? [];
  const invocationId = await skillsDispatchBackground({
    skillId: skill.id,
    runtime: runtime as SkillDispatchRuntime,
    prompt,
    cwd: ctx.workPath,
    context,
    commandOverride,
    permissionMode,
    metadata: {
      origin: agent.id,
      ...ctx.metadata,
      agentId: agent.id,
      skillName: skill.name,
      runtime,
      permissionMode,
      workspacePath: ctx.workPath,
      inputPaths: context.map((item) => item.path),
    },
  });
  return { invocationId, runtime, skillId: skill.id };
}

/** `runAgentDetailed` for callers that only need the invocation id. */
export async function runAgent(agent: AgentRecord, ctx: RunAgentContext): Promise<string> {
  return (await runAgentDetailed(agent, ctx)).invocationId;
}

/**
 * The preferred runtime if it is installed and authenticated, else the first
 * fallback that is. Throws the preferred runtime's own diagnosis when nothing
 * is available, because that is the one the user chose and wants told about.
 */
export async function resolveAvailableRuntime(
  preferred: AiRuntime,
  ai: AiSettings,
): Promise<{
  runtime: AiRuntime;
  commandOverride: string | null;
  status: SkillRuntimeStatus;
}> {
  let firstFailure: string | null = null;
  for (const runtime of agentRuntimeFallbackOrder(preferred)) {
    const commandOverride = ai.commandOverrides[runtime] ?? null;
    try {
      const status = await skillsRuntimeStatus({
        runtime: runtime as SkillDispatchRuntime,
        commandOverride,
      });
      if (status.available) return { runtime, commandOverride, status };
      if (firstFailure === null) {
        firstFailure = [status.message, status.suggestedAction]
          .filter(Boolean)
          .join(" ");
      }
    } catch (error) {
      if (firstFailure === null) {
        firstFailure = error instanceof Error ? error.message : String(error);
      }
    }
  }
  throw new Error(firstFailure || `agent_runtime_unavailable: ${preferred}`);
}

export interface InlineAgentRuntime {
  runtime: AiRuntime;
  commandOverride: string | null;
  /**
   * False when the user switched this agent off. Inline features are plain
   * request/response calls with no mission to refuse, so the caller has to
   * check: `runAgentDetailed`'s disabled guard never runs for them.
   */
  enabled: boolean;
}

/** The runtime an inline (non-mission) feature should use for this agent. */
export function inlineAgentRuntime(
  agents: AgentRecord[],
  id: string,
  ai: AiSettings,
): InlineAgentRuntime {
  const agent = findAgent(agents, id);
  const runtime = agent ? resolveAgentRuntime(agent, ai) : ai.defaultRuntime;
  return {
    runtime,
    commandOverride: ai.commandOverrides[runtime] ?? null,
    // A registry that could not be read leaves the feature working on global
    // settings rather than dead.
    enabled: agent?.enabled ?? true,
  };
}

// === Mission correlation ===

/**
 * Missions recorded before agents existed carry no `agentId`, so their
 * `origin` maps back to the agent that now owns that feature — otherwise the
 * pane's run history would start empty on upgrade.
 *
 * Matching is by prefix because followup runs mint their origin from the
 * followup's skill (`meetingNotesVaultConnect`, `taskManagementMeetingNotes`,
 * …). Those namespaces are generated from the parent surface, so a prefix
 * keeps working when a new followup skill is added; an enumeration would rot
 * silently.
 */
const ORIGIN_PREFIX_TO_AGENT_ID: ReadonlyArray<readonly [string, string]> = [
  ["inboxProcess", "inbox-triage"],
  ["meetingNotes", "meeting-notes"],
  ["taskManagement", "task-extract"],
  ["ideationDraft", "ideation-draft"],
];

export function agentIdOf(mission: MissionRecord): string | null {
  const metadata = mission.metadata;
  if (!metadata || typeof metadata !== "object" || Array.isArray(metadata)) return null;
  const bag = metadata as Record<string, unknown>;
  const explicit = bag.agentId;
  if (typeof explicit === "string" && explicit.trim()) return explicit;
  const origin = bag.origin;
  if (typeof origin !== "string") return null;
  return (
    ORIGIN_PREFIX_TO_AGENT_ID.find(([prefix]) => origin.startsWith(prefix))?.[1] ?? null
  );
}

/** Schedule that fired this run, when the scheduler stamped one. */
export function scheduleIdOf(mission: MissionRecord): string | null {
  const metadata = mission.metadata;
  if (!metadata || typeof metadata !== "object" || Array.isArray(metadata)) return null;
  const value = (metadata as Record<string, unknown>).scheduleId;
  return typeof value === "string" && value.trim() ? value : null;
}

export function missionsForAgent(
  missions: MissionRecord[],
  agentId: string,
): MissionRecord[] {
  return missions.filter((mission) => agentIdOf(mission) === agentId);
}

// === Pane rows ===

export type AgentRunStatus = "running" | "idle" | "failed" | "stopped" | "done" | "never";

export interface AgentRow {
  agent: AgentRecord;
  /**
   * Every schedule attached to this agent, soonest first. A list, not a single
   * schedule: this pane is the only `listSchedules` consumer now, so anything
   * it does not render keeps firing in the Rust ticker while being impossible
   * to inspect, pause or remove.
   */
  schedules: SchedulerSchedule[];
  /** This agent's missions, newest first. */
  missions: MissionRecord[];
  status: AgentRunStatus;
  /** Mission to stop, when one is in flight. */
  activeMissionId: string | null;
}

export interface AgentBoard {
  rows: AgentRow[];
  /** Schedules belonging to no agent — still live, so still manageable. */
  orphans: SchedulerSchedule[];
}

/**
 * Attention tiers. Everything at tier 3 is quiet, and quiet rows are ordered by
 * what happens next rather than by what happened last — so the list answers
 * "what is coming up" instead of re-sorting itself every time something runs.
 * A failure stays above that: it is the one quiet state that wants a human.
 */
const STATUS_TIER: Record<AgentRunStatus, number> = {
  running: 0,
  idle: 1,
  failed: 2,
  stopped: 3,
  done: 3,
  never: 3,
};

/**
 * Schedules belonging to `agent`: those that name it explicitly, plus — for
 * schedules created before agents existed, which carry no `agentId` — those
 * dispatching its skill. Without the second rule the user's existing schedules
 * would have no row at all now that the old scheduler section is gone.
 *
 * The skill inference is display-only: dispatch still reads the schedule's own
 * snapshot until the user re-attaches it, so nothing about what runs changes.
 * `claimed` keeps two agents sharing a skill from showing the same schedule.
 */
function matchSchedules(
  schedules: SchedulerSchedule[],
  agent: AgentRecord,
  claimed: Set<string>,
): SchedulerSchedule[] {
  const needle = agent.skillName.trim().toLowerCase();
  const dispatchesOwnSkill = (schedule: SchedulerSchedule) =>
    needle.length > 0
    && !schedule.agentId
    && (schedule.skillId.toLowerCase() === needle
      || schedule.skillId.toLowerCase().endsWith(`:${needle}`));

  return schedules
    .filter(
      (schedule) =>
        !claimed.has(schedule.id)
        && (schedule.agentId === agent.id || dispatchesOwnSkill(schedule)),
    )
    .sort(bySoonest);
}

function bySoonest(a: SchedulerSchedule, b: SchedulerSchedule): number {
  const nextA = a.nextRunAt ?? "";
  const nextB = b.nextRunAt ?? "";
  if (nextA !== nextB) {
    if (!nextA) return 1;
    if (!nextB) return -1;
    return nextA.localeCompare(nextB);
  }
  return a.id.localeCompare(b.id);
}

function newestFirst(a: MissionRecord, b: MissionRecord): number {
  return (
    b.lastOutputAt.localeCompare(a.lastOutputAt) || b.startedAt.localeCompare(a.startedAt)
  );
}

/**
 * An agent is "running" while any of its missions is, "idle" while one has
 * gone quiet (60s without output), and otherwise wears its newest mission's
 * outcome. A live run outranks a stale failure so the row reflects now, not
 * history.
 */
export function agentRunStatus(missions: MissionRecord[]): AgentRunStatus {
  if (missions.length === 0) return "never";
  if (missions.some((mission) => mission.status === "running")) return "running";
  if (missions.some((mission) => mission.status === "idle")) return "idle";
  const newest = [...missions].sort(newestFirst)[0];
  return newest.status === "failed" || newest.status === "stopped" || newest.status === "done"
    ? newest.status
    : "never";
}

/**
 * One row per agent, sorted the way the pane reads top-down: what is happening
 * now, then what is scheduled soonest, then what ran most recently, then what
 * has never run. Disabled agents sink below their peers so the list opens on
 * work that is actually live.
 */
export function buildAgentBoard(
  agents: AgentRecord[],
  schedules: SchedulerSchedule[],
  missions: MissionRecord[],
): AgentBoard {
  const claimed = new Set<string>();
  const rows = agents.map((agent): AgentRow => {
    const matched = matchSchedules(schedules, agent, claimed);
    for (const schedule of matched) claimed.add(schedule.id);
    // A run fired by a pre-agent schedule carries no `agentId` and no origin
    // the prefix map knows, so it would show under no agent at all — even
    // though the schedule itself is displayed on this row.
    const scheduleIds = new Set(matched.map((schedule) => schedule.id));
    const own = missions
      .filter(
        (mission) =>
          agentIdOf(mission) === agent.id || scheduleIds.has(scheduleIdOf(mission) ?? ""),
      )
      .sort(newestFirst);
    const active = own.find(
      (mission) => mission.status === "running" || mission.status === "idle",
    );
    return {
      agent,
      schedules: matched,
      missions: own,
      status: agentRunStatus(own),
      activeMissionId: active?.id ?? null,
    };
  });
  rows.sort((a, b) => {
    if (a.agent.enabled !== b.agent.enabled) return a.agent.enabled ? -1 : 1;
    const byTier = STATUS_TIER[a.status] - STATUS_TIER[b.status];
    if (byTier !== 0) return byTier;
    const nextA = a.schedules[0]?.nextRunAt ?? null;
    const nextB = b.schedules[0]?.nextRunAt ?? null;
    if (nextA && nextB && nextA !== nextB) return nextA.localeCompare(nextB);
    if (nextA && !nextB) return -1;
    if (!nextA && nextB) return 1;
    const ranA = a.missions[0]?.lastOutputAt ?? "";
    const ranB = b.missions[0]?.lastOutputAt ?? "";
    if (ranA !== ranB) return ranB.localeCompare(ranA);
    return a.agent.id.localeCompare(b.agent.id);
  });
  return {
    rows,
    orphans: schedules.filter((schedule) => !claimed.has(schedule.id)).sort(bySoonest),
  };
}
