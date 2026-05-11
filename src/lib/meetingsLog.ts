export type MeetingsLogEventKind =
  | "start"
  | "phase"
  | "apply"
  | "clear"
  | "error"
  | "followup"
  | "retry"
  | "unknown";

export type MeetingsLogSeverity = "info" | "warn" | "error";

export interface MeetingsLogLine {
  raw: string;
  ts: string | null;
  event: string;
  runId: string | null;
  status: string | null;
  skill: string | null;
  target: string | null;
  payload: Record<string, unknown> | null;
  legacy: boolean;
}

export interface MeetingsLogEventInput {
  event: MeetingsLogEventKind;
  runId?: string | null;
  status?: string | null;
  skill?: string | null;
  target?: string | null;
  extra?: Record<string, unknown> | null;
  ts?: string;
}

const ISO_TIMESTAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/;
const ERROR_KEYWORDS = /\b(error|failed|exception|panic|fatal)\b/i;
const WARN_KEYWORDS = /\b(warn|warning|deprecat|retrying)\b/i;

export function serializeMeetingsLogLine(input: MeetingsLogEventInput): string {
  const ts = input.ts ?? new Date().toISOString();
  const payload: Record<string, unknown> = { ...(input.extra ?? {}) };
  if (input.runId) payload.runId = input.runId;
  if (input.status) payload.status = input.status;
  if (input.skill) payload.skill = input.skill;
  if (input.target) payload.target = input.target;
  return `- ${ts} [${input.event}] ${JSON.stringify(payload)}`;
}

export function parseMeetingsLogLine(raw: string): MeetingsLogLine {
  const trimmed = raw.replace(/^-\s*/, "").trim();
  const [headToken, ...rest] = trimmed.split(/\s+/);
  const head = headToken ?? "";
  if (ISO_TIMESTAMP.test(head)) {
    const remainder = rest.join(" ").trim();
    const structured = parseStructured(raw, head, remainder);
    if (structured) return structured;
    const legacy = parseLegacy(raw, head, remainder);
    if (legacy) return legacy;
    return {
      raw,
      ts: head,
      event: remainder ? "unknown" : "unknown",
      runId: null,
      status: null,
      skill: null,
      target: null,
      payload: null,
      legacy: true,
    };
  }
  return {
    raw,
    ts: null,
    event: "unknown",
    runId: null,
    status: null,
    skill: null,
    target: null,
    payload: null,
    legacy: true,
  };
}

export function logLineSeverity(line: MeetingsLogLine | string): MeetingsLogSeverity {
  const text = typeof line === "string" ? line : line.raw;
  if (typeof line !== "string") {
    if (line.event === "error" || line.status === "failed" || line.status === "error") {
      return "error";
    }
    if (line.status === "stopped" || line.status === "warning") {
      return "warn";
    }
  }
  if (ERROR_KEYWORDS.test(text)) return "error";
  if (WARN_KEYWORDS.test(text)) return "warn";
  return "info";
}

export function logLinePhase(line: MeetingsLogLine | string): string | null {
  const text = typeof line === "string" ? line : line.raw;
  const match = text.match(/\[phase:([a-z_-]+)\]/i);
  if (match) return match[1].toLowerCase();
  if (typeof line !== "string") {
    if (line.event === "phase" && typeof line.payload?.phase === "string") {
      return (line.payload.phase as string).toLowerCase();
    }
  }
  return null;
}

function parseStructured(raw: string, ts: string, remainder: string): MeetingsLogLine | null {
  if (!remainder.startsWith("[")) return null;
  const end = remainder.indexOf("]");
  if (end < 0) return null;
  const event = remainder.slice(1, end).trim();
  if (!event) return null;
  const tail = remainder.slice(end + 1).trim();
  let payload: Record<string, unknown> | null = null;
  if (tail.startsWith("{")) {
    try {
      const parsed = JSON.parse(tail);
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        payload = parsed as Record<string, unknown>;
      }
    } catch {
      payload = null;
    }
  }
  return {
    raw,
    ts,
    event,
    runId: stringField(payload, "runId"),
    status: stringField(payload, "status"),
    skill: stringField(payload, "skill"),
    target: stringField(payload, "target"),
    payload,
    legacy: false,
  };
}

function parseLegacy(raw: string, ts: string, remainder: string): MeetingsLogLine | null {
  const colon = remainder.indexOf(":");
  if (colon < 0) return null;
  const skill = remainder.slice(0, colon).trim();
  const target = remainder.slice(colon + 1).trim();
  if (!skill) return null;
  return {
    raw,
    ts,
    event: "followup",
    runId: null,
    status: "started",
    skill,
    target: target || null,
    payload: null,
    legacy: true,
  };
}

function stringField(payload: Record<string, unknown> | null, key: string): string | null {
  if (!payload) return null;
  const value = payload[key];
  return typeof value === "string" && value.trim() ? value : null;
}
