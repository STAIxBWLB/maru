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
} from "./skills";
import type { MissionRecord } from "./types";

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

export async function listAgents(): Promise<AgentRecord[]> {
  if (!isTauri()) {
    const override = await invokeE2EOverride<AgentRecord[]>("agents_list", {});
    if (override) return override;
    return [];
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

export function findAgent(agents: AgentRecord[], id: string): AgentRecord | null {
  return agents.find((agent) => agent.id === id) ?? null;
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
): Promise<{ runtime: AiRuntime; commandOverride: string | null }> {
  let firstFailure: string | null = null;
  for (const runtime of agentRuntimeFallbackOrder(preferred)) {
    const commandOverride = ai.commandOverrides[runtime] ?? null;
    try {
      const status = await skillsRuntimeStatus({
        runtime: runtime as SkillDispatchRuntime,
        commandOverride,
      });
      if (status.available) return { runtime, commandOverride };
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

/** The runtime an inline (non-mission) feature should use for this agent. */
export function inlineAgentRuntime(
  agents: AgentRecord[],
  id: string,
  ai: AiSettings,
): { runtime: AiRuntime; commandOverride: string | null } {
  const agent = findAgent(agents, id);
  const runtime = agent ? resolveAgentRuntime(agent, ai) : ai.defaultRuntime;
  return { runtime, commandOverride: ai.commandOverrides[runtime] ?? null };
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

export function missionsForAgent(
  missions: MissionRecord[],
  agentId: string,
): MissionRecord[] {
  return missions.filter((mission) => agentIdOf(mission) === agentId);
}
