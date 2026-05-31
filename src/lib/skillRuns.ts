import type {
  AgentRunEvent,
  SkillContextItem,
  SkillDispatchRuntime,
  SkillProposal,
} from "./skills";
import type { MissionRecord } from "./types";

export type SkillRunPhase =
  | "preflight"
  | "queued"
  | "running"
  | "proposal"
  | "review"
  | "applied"
  | "failed"
  | "stopped";

export type SkillRunSeverity = "info" | "warn" | "error";

export interface SkillRunRetryRequest {
  skillId: string;
  runtime: SkillDispatchRuntime;
  prompt: string;
  cwd: string | null;
  context: SkillContextItem[];
  commandOverride?: string | null;
  permissionMode?: string | null;
}

export interface SkillRunView {
  id: string;
  skillName: string;
  runtime: SkillDispatchRuntime | null;
  status: MissionRecord["status"];
  phase: SkillRunPhase;
  sourceKind: string | null;
  inputPaths: string[];
  workspacePath: string | null;
  latestLog: string;
  latestSeverity: SkillRunSeverity;
  elapsedMs: number;
  canStop: boolean;
  canReview: boolean;
  canRetry: boolean;
}

const STREAM_PREFIX = /^\s*(?:-\s*)?\[(stdout|stderr|error)\]\s*/i;
const ERROR_RE = /\b(error|failed|exception|panic|fatal|denied|unauthorized)\b/i;
const WARN_RE = /\b(warn|warning|retry|deprecated|rate limit)\b/i;

export function isSkillMission(mission: MissionRecord): boolean {
  return mission.kind === "skill";
}

export function isStructuredMission(mission: MissionRecord): boolean {
  return stringField(missionMetadata(mission), "origin") === "structuredLoop";
}

export function isTrackedAgentMission(mission: MissionRecord): boolean {
  return isSkillMission(mission) || isStructuredMission(mission);
}

export function activeSkillMissions(missions: MissionRecord[]): MissionRecord[] {
  return missions.filter(isSkillMission).sort(compareMissions);
}

export function activeTrackedAgentMissions(missions: MissionRecord[]): MissionRecord[] {
  return missions.filter(isTrackedAgentMission).sort(compareMissions);
}

export function skillRunView(
  mission: MissionRecord,
  logLines: string[] = [],
  options: {
    reviewLoaded?: boolean;
    applied?: boolean;
    retryAvailable?: boolean;
    now?: number;
  } = {},
): SkillRunView {
  const metadata = missionMetadata(mission);
  const formatted = logLines.map(formatSkillRunLogLine);
  const latest = formatted.at(-1);
  const structured = isStructuredMission(mission);
  return {
    id: mission.id,
    skillName: stringField(metadata, "skillName") ?? mission.id,
    runtime: runtimeField(metadata),
    status: mission.status,
    phase: deriveSkillRunPhase(mission, formatted, options),
    sourceKind: stringField(metadata, "sourceKind"),
    inputPaths: arrayField(metadata, "inputPaths"),
    workspacePath: stringField(metadata, "workspacePath"),
    latestLog: latest?.text ?? "",
    latestSeverity: latest?.severity ?? "info",
    elapsedMs: Math.max(0, (options.now ?? Date.now()) - Date.parse(mission.startedAt)),
    canStop: !structured && (mission.status === "running" || mission.status === "idle"),
    canReview: mission.status === "done" || options.reviewLoaded === true,
    canRetry: options.retryAvailable === true && mission.status !== "running" && mission.status !== "idle",
  };
}

export function deriveSkillRunPhase(
  mission: MissionRecord,
  formattedLines: Array<{ text: string }> = [],
  options: { reviewLoaded?: boolean; applied?: boolean } = {},
): SkillRunPhase {
  if (options.applied) return "applied";
  if (mission.status === "stopped") return "stopped";
  if (mission.status === "failed" || (mission.exitCode !== null && mission.exitCode !== 0)) {
    return "failed";
  }
  if (options.reviewLoaded) return "review";
  if (
    formattedLines.some((line) =>
      /anchor_skill_proposal_v1|proposal\.created|proposal ready|proposal/i.test(line.text),
    )
  ) {
    return "proposal";
  }
  if (mission.status === "running" || mission.status === "idle") return "running";
  if (mission.status === "done") return "proposal";
  return "queued";
}

export function formatSkillRunLogLine(raw: string): {
  text: string;
  stream: string | null;
  severity: SkillRunSeverity;
} {
  const match = raw.match(STREAM_PREFIX);
  const stream = match?.[1]?.toLowerCase() ?? null;
  const text = raw.replace(STREAM_PREFIX, "").trim();
  const severity =
    stream === "stderr" || stream === "error" || ERROR_RE.test(text)
      ? "error"
      : WARN_RE.test(text)
        ? "warn"
        : "info";
  return { text, stream, severity };
}

export function formatElapsed(ms: number): string {
  const seconds = Math.max(0, Math.floor(ms / 1000));
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ${seconds % 60}s`;
  const hours = Math.floor(minutes / 60);
  return `${hours}h ${minutes % 60}m`;
}

export function extractSkillRunRetryRequest(events: AgentRunEvent[]): SkillRunRetryRequest | null {
  for (const event of events) {
    if (event.type !== "run.started") continue;
    const payload = record(event.payload);
    const dispatch = record(payload?.dispatch);
    if (!dispatch) continue;
    const runtime = stringValue(dispatch.runtime);
    if (runtime !== "claude" && runtime !== "codex") continue;
    const skillId = stringValue(dispatch.skillId);
    const prompt = stringValue(dispatch.prompt);
    if (!skillId || !prompt) continue;
    return {
      skillId,
      runtime,
      prompt,
      cwd: stringValue(dispatch.cwd),
      context: Array.isArray(dispatch.context)
        ? dispatch.context
            .map((item) => record(item))
            .filter((item): item is Record<string, unknown> => item !== null)
            .map((item) => ({
              path: stringValue(item.path) ?? "",
              kind: stringValue(item.kind),
            }))
            .filter((item) => item.path)
        : [],
      commandOverride: stringValue(dispatch.commandOverride),
      permissionMode: stringValue(dispatch.permissionMode),
    };
  }
  return null;
}

export function proposalSummary(proposal: SkillProposal | null): string {
  if (!proposal) return "";
  return [
    proposal.summary,
    `${proposal.files.length} file(s)`,
    `${proposal.commands.length} command(s)`,
    `${proposal.risks.length} risk(s)`,
  ].join(" · ");
}

function compareMissions(a: MissionRecord, b: MissionRecord): number {
  return b.lastOutputAt.localeCompare(a.lastOutputAt) || b.startedAt.localeCompare(a.startedAt);
}

function missionMetadata(mission: MissionRecord): Record<string, unknown> | null {
  return record(mission.metadata);
}

function runtimeField(metadata: Record<string, unknown> | null): SkillDispatchRuntime | null {
  const value = stringField(metadata, "runtime");
  return value === "claude" || value === "codex" ? value : null;
}

function stringField(metadata: Record<string, unknown> | null, key: string): string | null {
  if (!metadata) return null;
  return stringValue(metadata[key]);
}

function arrayField(metadata: Record<string, unknown> | null, key: string): string[] {
  const value = metadata?.[key];
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
}

function stringValue(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value : null;
}

function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}
