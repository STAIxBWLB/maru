---
name: meeting-notes
description: >
  Public-safe meeting notes skill. Use when turning any reviewed transcript,
  meeting memo, interview note, call note, or meeting-related inbox item into a
  structured meeting note. The source can be pasted text, a transcript file, or
  an inbox item; no vendor-specific transcript service is assumed.
---

# Meeting Notes

Create and file structured meeting notes from transcript-like inputs. This
skill is provider-neutral and does not require inbox staging.

## Boot Sequence

1. Find `workspace.config.yaml`.
2. Read `meeting_notes` for root, filename template, guide paths, and optional
   hooks.
3. Read only the local guide files needed for the current note.
4. If `meeting_notes.hooks.enrichment` is set, read `ssot.context_enrichment`
   (the context-enrichment procedure) and the `context.*` lookup paths it names
   (people/glossary fast caches plus the canonical vault MOCs).
5. If the input is an inbox item, read its `manifest.yaml` and `extracted.md`.

## Workflow

1. Accept pasted text, a local transcript file, a meeting memo, or an inbox item
   with `kind: transcript`.
2. Identify meeting date, type, topic, participants, venue, decisions, and action
   items from the provided material.
3. **Context enrichment (`[phase:normalize]`, Vault-First T2).** When
   `hooks.enrichment` is set, resolve people, orgs, and the project per the
   context-enrichment procedure §2 (fast cache → project-registry → vault
   `people.md`/`glossary.md` MOC; on conflict the vault MOC wins). Assemble the
   project context bundle per §3 (registry `vault_note`, recent meetings, open
   tasks, and — targeted only — matching calendar events) and use it to
   cross-check facts and enrich the draft. Surface unresolved entities as
   uncertainties; never invent a canonical name or a wiki-link. Without the
   hook, fall back to normalizing against the local guides only.
4. Draft the note using `templates/meeting-note.md`. Fill the frontmatter
   `title` with a human-readable meeting title so the display name does not
   depend on the filename alone — Anchor resolves the shown label as
   `title -> name -> filename` and also reads `date`, `type`, `topic`, `tags`,
   and `attendees` from frontmatter. Keep the configured filename policy. When
   enrichment resolved them, also set the additive cross-link fields per the
   context-enrichment §4 contract: `project: [[vault_note]]`, `attendees` as
   resolved `[[person]]` links, `relatedMeetings`, `relatedTasks`, and
   `source_doc`. Emit a wiki-link only for entities §2 actually resolved (never
   a guessed link). Structure action items as `{assignee, task, due}` rather
   than bare checkboxes so they can seed pre-filled task candidates.
5. Propose filing it under the configured meeting root, usually
   `YYYY/YYYY-MM/`; Anchor applies the write only after user approval.
6. If configured and explicitly requested, prepare task candidates for
   `task-management` or vault extraction candidates. Pre-fill each task
   candidate from the structured action items (`title`, `assignee`, `due`) and
   add a `meetingSourcePath` backref to this meeting note so the task links back
   to its origin (context-enrichment §4). Do not write vault notes directly;
   follow-ups are proposals only.

## Anchor Run Contract

When Anchor runs this skill in background/review mode:

1. Emit concise human-readable progress logs while working. Prefix major
   progress logs with stable phase markers so Anchor can render stepwise
   status:
   - `[phase:source]` after source text/files are identified.
   - `[phase:normalize]` while applying guides, glossary, people, and naming
     conventions.
   - `[phase:draft]` while drafting the meeting note.
   - `[phase:proposal]` when preparing the `anchor_skill_proposal_v1` block.
   - `[phase:review]` when preparing the `anchor_meeting_review_v1` block.
   - Always include exactly one phase marker per line and keep that marker
     at the start of the line (after the timestamp) so the run-card parser
     and Activity panel can colour-code each phase reliably.
   - For errors, prepend `ERROR:` to the message or use `[phase:error]` so
     the UI can surface them in red.
2. Do not directly write files, update the vault, or run follow-up skills.
3. Return one `anchor_skill_proposal_v1` JSON object with the meeting note file
   write proposal.
4. Return one `anchor_meeting_review_v1` JSON object for user confirmation:

```json
{
  "schemaVersion": "anchor_meeting_review_v1",
  "summary": "short review summary",
  "terms": [
    { "label": "source term", "normalized": "workspace term", "note": "why", "required": true }
  ],
  "people": [
    { "label": "source person", "normalized": "canonical person", "note": "role", "required": true }
  ],
  "properNouns": [
    { "label": "source name", "normalized": "canonical name", "note": "context", "required": true }
  ],
  "uncertainties": [
    { "label": "uncertain item", "normalized": "best guess", "note": "needs user check", "required": true }
  ],
  "enrichment": {
    "project": "[[vault-note]]",
    "relatedMeetings": ["[[meeting-note]]"],
    "relatedTasks": ["[[task-note]]"],
    "calendarLink": { "calendarId": "id-or-null", "calendarEventId": "id-or-null" },
    "resolvedPeople": [
      { "surface": "source person", "canonical": "canonical name", "wikiLink": "[[person]]", "confidence": "resolved" }
    ]
  },
  "followups": [
    {
      "skill": "task-management",
      "title": "Create task from action item",
      "prompt": "proposal-only follow-up prompt",
      "reason": "why this is useful",
      "assignee": "person or null",
      "due": "YYYY-MM-DD or null",
      "meetingSourcePath": "meetings/YYYY/YYYY-MM/<file>.md",
      "selected": false
    }
  ]
}
```

Allowed follow-up skills are `vault-extract`, `vault-connect`, and
`task-management`. Follow-ups must be proposals for the user to review. The
`enrichment` object and the `assignee`/`due`/`meetingSourcePath` follow-up
fields are additive and optional — populate them only from resolved enrichment
(context-enrichment §3/§4) and omit or null them otherwise. Parsers ignore
unknown fields, so existing `anchor_meeting_review_v1` consumers are unaffected.

## Rules

- Do not assume a specific transcript vendor.
- Do not transcribe raw audio unless a configured `io-*` or transcriber tool
  has already produced text.
- Keep filename policy configurable; default to
  `MM-DD <type> - <topic> - <detail>.md`.
- If date, participants, or topic cannot be recovered from the input, leave a
  visible placeholder and state what is missing.
- Legal/accounting evidence meeting records are out of scope unless the user
  provides a local template and explicitly requests that format.

## References

- `references/workspace-config.md` - runtime config keys
- `templates/meeting-note.md` - neutral meeting note template
- `ssot.context_enrichment` (`_sys/rules/context-enrichment.md`) - entity
  resolution + context bundle + cross-link contract (consulted when
  `meeting_notes.hooks.enrichment` is set)
