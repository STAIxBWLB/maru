import type { MeetingsSettings } from "./settings";
import type { MeetingGuides } from "./types";

export type MeetingSourceKind = "transcript" | "external";

/**
 * Shared meeting-notes run contract. Both the Meetings workbench and the
 * generic Apply-skill dialog inject this so a tracked run reliably emits the
 * `anchor_skill_proposal_v1` + `anchor_meeting_review_v1` blocks that the
 * review panel parses.
 */
export function meetingNotesRunContract(): string[] {
  return [
    "Run contract:",
    "- Do not directly write files.",
    "- Emit concise human-readable progress logs while working.",
    "- Prefix major progress logs with phase markers: [phase:source], [phase:normalize], [phase:draft], [phase:proposal], [phase:review].",
    "- Final output must include exactly one JSON object with schemaVersion \"anchor_skill_proposal_v1\".",
    "- Final output must include exactly one JSON object with schemaVersion \"anchor_meeting_review_v1\".",
    "- The review JSON must include summary, terms, people, properNouns, uncertainties, and followups.",
    "- Followups may include only vault-extract, vault-connect, and task-management.",
  ];
}

function formatGuide(label: string, content: string | null): string | null {
  return content ? `${label}:\n${content}` : null;
}

function sourceLabel(sourceKind: MeetingSourceKind): string {
  return sourceKind === "transcript" ? "TRANSCRIPT_TEXT" : "EXTERNAL_NOTE";
}

/**
 * The full prompt used by the Meetings workbench (transcript / external flows).
 */
export function buildMeetingNotesPrompt({
  sourceKind,
  settings,
  type,
  topic,
  detail,
  note,
  guides,
}: {
  sourceKind: MeetingSourceKind;
  settings: MeetingsSettings;
  type: string;
  topic: string;
  detail: string;
  note: string;
  guides: MeetingGuides | null;
}): string {
  const action =
    sourceKind === "transcript"
      ? "Convert the pasted transcript text and/or selected transcript file(s) into a polished meeting note."
      : "Refine the external note into the workspace meeting-note standard.";
  const missingHints = [topic.trim() ? null : "topic", detail.trim() ? null : "detail"]
    .filter(Boolean)
    .join(" and ");
  return [
    action,
    "",
    ...meetingNotesRunContract(),
    "",
    `Root: ${settings.root ?? "meetings"}`,
    `Filename template: ${settings.filenameTemplate}`,
    `Type: ${type}`,
    topic.trim() ? `Topic: ${topic.trim()}` : null,
    detail.trim() ? `Detail: ${detail.trim()}` : null,
    missingHints
      ? `Infer only the missing ${missingHints} from the transcript or note body; preserve any provided hint.`
      : null,
    "Use the six-section meeting note structure, normalized tags, and wiki-link conventions.",
    guides ? formatGuide("QUICK_START", guides.quickStart) : null,
    guides ? formatGuide("GLOSSARY", guides.glossary) : null,
    guides ? formatGuide("PEOPLE", guides.people) : null,
    guides ? formatGuide("TAG_STANDARDS", guides.tagStandards) : null,
    guides ? formatGuide("NOTES_GUIDELINES", guides.notesGuidelines) : null,
    note.trim() ? `${sourceLabel(sourceKind)}:\n${note.trim()}` : null,
  ]
    .filter(Boolean)
    .join("\n\n");
}

const CONTRACT_MARKER = "schemaVersion \"anchor_meeting_review_v1\"";

/**
 * Append a tagged SOURCE block to an arbitrary user prompt, reusing the same
 * run-contract + TRANSCRIPT_TEXT/EXTERNAL_NOTE framing as the workbench. Used by
 * the generic Apply-skill dialog when the selected skill accepts a source.
 *
 * No-ops (returns the base prompt unchanged) when `sourceText` is empty. The run
 * contract is injected only once — if the base prompt already carries it (e.g.
 * the skill body or a prior call), it is not duplicated.
 */
export function appendSourceBlock(
  basePrompt: string,
  sourceText: string,
  sourceKind: MeetingSourceKind = "transcript",
): string {
  const trimmed = sourceText.trim();
  if (!trimmed) return basePrompt;
  const base = basePrompt.trim();
  const sections: string[] = [];
  if (base) sections.push(base);
  if (!base.includes(CONTRACT_MARKER)) {
    sections.push(meetingNotesRunContract().join("\n"));
  }
  sections.push(`${sourceLabel(sourceKind)}:\n${trimmed}`);
  return sections.join("\n\n");
}
