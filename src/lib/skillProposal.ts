import type { AgentRunEvent, SkillProposal, SkillProposalFile } from "./skills";

// Schema-agnostic helpers shared by every skill review flow (meetings, tasks, …).
// These deal only with `anchor_skill_proposal_v1` proposals and generic JSON
// extraction; per-skill review artifacts live in their own modules.

export type UnknownRecord = Record<string, unknown>;

/** Editable draft of one proposed file write in a review UI. */
export interface ProposalFileDraft {
  id: string;
  selected: boolean;
  path: string;
  operation: string;
  beforeContent: string;
  afterContent: string;
  expectedHash?: string | null;
  diff?: string | null;
}

export function extractProviderOutput(events: AgentRunEvent[], fallbackLines: string[] = []): string {
  const lines = events
    .filter((event) => event.type === "provider.output")
    .map((event) => asRecord(event.payload)?.line)
    .filter((line): line is string => typeof line === "string");
  return (lines.length > 0 ? lines : fallbackLines).join("\n");
}

export function extractSkillProposal(events: AgentRunEvent[]): SkillProposal | null {
  for (const event of events) {
    if (event.type !== "proposal.created") continue;
    const payload = asRecord(event.payload);
    const proposal = asRecord(payload?.proposal);
    if (!proposal || typeof proposal.summary !== "string") continue;
    return {
      summary: proposal.summary,
      files: Array.isArray(proposal.files) ? proposal.files as SkillProposalFile[] : [],
      commands: Array.isArray(proposal.commands) ? proposal.commands as SkillProposal["commands"] : [],
      risks: Array.isArray(proposal.risks) ? proposal.risks.filter(isString) : [],
      requiresApproval:
        typeof proposal.requiresApproval === "boolean" ? proposal.requiresApproval : true,
      schemaVersion:
        typeof proposal.schemaVersion === "string"
          ? proposal.schemaVersion
          : "anchor_skill_proposal_v1",
    };
  }
  return null;
}

export function rebuildSkillProposal(
  proposal: SkillProposal,
  files: ProposalFileDraft[],
): SkillProposal {
  return {
    ...proposal,
    files: files
      .filter((file) => file.selected)
      .map((file) => ({
        path: file.path,
        operation: file.operation,
        content: file.operation === "delete" ? null : file.afterContent,
        expectedHash: file.expectedHash ?? null,
        diff: file.diff ?? null,
      })),
  };
}

export function selectedProposalFileCount(files: ProposalFileDraft[]): number {
  return files.filter((file) => file.selected).length;
}

export function extractJsonCandidates(raw: string): string[] {
  const candidates: string[] = [];
  const fencePattern = /```(?:json)?\s*([\s\S]*?)```/gi;
  let match: RegExpExecArray | null;
  while ((match = fencePattern.exec(raw)) !== null) {
    const body = match[1]?.trim();
    if (body?.startsWith("{")) candidates.push(body);
  }
  candidates.push(...extractBalancedObjects(raw));
  return Array.from(new Set(candidates));
}

export function extractBalancedObjects(raw: string): string[] {
  const objects: string[] = [];
  for (let start = raw.indexOf("{"); start >= 0; start = raw.indexOf("{", start + 1)) {
    let depth = 0;
    let inString = false;
    let escaped = false;
    for (let index = start; index < raw.length; index += 1) {
      const char = raw[index];
      if (inString) {
        if (escaped) {
          escaped = false;
        } else if (char === "\\") {
          escaped = true;
        } else if (char === "\"") {
          inString = false;
        }
        continue;
      }
      if (char === "\"") {
        inString = true;
      } else if (char === "{") {
        depth += 1;
      } else if (char === "}") {
        depth -= 1;
        if (depth === 0) {
          objects.push(raw.slice(start, index + 1));
          break;
        }
      }
    }
  }
  return objects;
}

export function safeParseRecord(raw: string): UnknownRecord | null {
  try {
    return asRecord(JSON.parse(raw));
  } catch {
    return null;
  }
}

export function asRecord(value: unknown): UnknownRecord | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as UnknownRecord
    : null;
}

export function stringValue(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

export function isString(value: unknown): value is string {
  return typeof value === "string";
}
