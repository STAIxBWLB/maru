---
name: meeting-notes
description: >
  Public-safe meeting notes skill. Use when turning any reviewed transcript,
  meeting memo, interview note, call note, or meeting-related inbox item into a
  structured meeting note. The source can be pasted text, a transcript file, or
  an inbox item; no vendor-specific transcript service is assumed. Before
  drafting, verifies high-risk facts against internal workspace sources and, as
  a last resort, web research, and supplements content the source cannot
  carry; corrections are proposed for user review, never silently applied.
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
5. Read `io.providers` to learn which calendar provider commands are available
   for the schedule lookup in workflow step 3.
6. If the input is an inbox item, read its `manifest.yaml` and `extracted.md`.

## Workflow

1. Accept pasted text, a local transcript file, a meeting memo, or an inbox item
   with `kind: transcript`.
2. Identify meeting date, type, topic, participants, venue, decisions, and action
   items from the provided material.
3. **Work-schedule lookup (`[phase:normalize]`, required before drafting).**
   Search the configured calendars (`io.providers`, e.g. `io-gws`
   `calendar.event.search` or `io-mso`) for the meeting date and match the
   event for this meeting. Take its title, attendees, start/end time, and
   location as the primary metadata for the note, and read the same day's
   adjacent events for context the transcript cannot carry — the meeting's
   formal name, attendees who never spoke, and the preceding/follow-up
   meetings it belongs to. A calendar that is unreachable or has no matching
   event never blocks the draft: state that in the note and continue.
4. **Context enrichment (`[phase:normalize]`, Vault-First T2).** When
   `hooks.enrichment` is set, resolve people, orgs, and the project per the
   context-enrichment procedure §2 (fast cache → project-registry → vault
   `people.md`/`glossary.md` MOC; on conflict the vault MOC wins). Assemble the
   project context bundle per §3 (registry `vault_note`, recent meetings, open
   tasks, and — targeted only — matching calendar events) and use it to
   cross-check facts and enrich the draft. Surface unresolved entities as
   uncertainties; never invent a canonical name or a wiki-link. Without the
   hook, fall back to normalizing against the local guides only.
5. **Content verification & supplementation (`[phase:verify]`).** When
   `meeting_notes.hooks.verification` is set (e.g. `internal-external`),
   verify and supplement before drafting; without the hook, skip this step.
   - Extract high-risk claims from the normalized material: person
     names/titles/affiliations, org and program names, decisions and their
     owners, dates, amounts, quoted commitments, and any "someone said X is
     happening" attributions.
   - Internal verification: cross-check each claim against the step-4 context
     bundle plus targeted lookups — vault notes
     (`mcp__obsidian__search_notes`), past meeting notes under the meeting
     root, open tasks, and the project registry. Flag transcription-error
     suspects (a surface form phonetically/visually close to a known
     canonical entity, e.g. a garbled company name matching a glossary
     entry) and contradiction suspects (claims conflicting with recorded
     decisions or known project state).
   - External verification (last resort): for claims about external parties
     that internal sources cannot settle (a person's current title, an
     org's program, a public event), use web search under the
     context-enrichment §2-7 contract verbatim — results are
     `web_unverified`, carry a source URL, and are promoted only by explicit
     user confirmation. No web lookup for bare person names.
   - Supplementation: add context the transcript cannot carry — the formal
     meeting name from the calendar event, full org names from the
     glossary, prior decisions a statement refers to — each tagged with its
     source.
   - Every proposed change is emitted as a structured correction in the
     review block (see `corrections` below), never as an in-place rewrite.
6. Draft the note using `templates/meeting-note.md`. Fill the frontmatter
   `title` with a human-readable meeting title so the display name does not
   depend on the filename alone — Maru resolves the shown label as
   `title -> name -> filename` and also reads `date`, `type`, `topic`, `tags`,
   and `attendees` from frontmatter. Keep the configured filename policy. When
   enrichment resolved them, also set the additive cross-link fields per the
   context-enrichment §4 contract: `project: [[vault_note]]`, `attendees` as
   resolved `[[person]]` links, `relatedMeetings`, `relatedTasks`, and
   `source_doc`. Emit a wiki-link only for entities §2 actually resolved (never
   a guessed link). Structure action items as `{assignee, task, due}` rather
   than bare checkboxes so they can seed pre-filled task candidates.
7. Propose filing it under the configured meeting root, usually
   `YYYY/YYYY-MM/`; Maru applies the write only after user approval. The
   meeting root holds the **canonical** note. When a partner/project also needs a
   copy or reference, place it in that project's meeting subfolder per
   `_meta/rules/naming-and-placement.md` §C (e.g. the partner's `*-meetings/` or
   `04-operations/meetings/YYYY/`), never the project's bare root.
8. If configured and explicitly requested, prepare task candidates for
   `task-management` or vault extraction candidates. Pre-fill each task
   candidate from the structured action items (`title`, `assignee`, `due`) and
   add a `meetingSourcePath` backref to this meeting note so the task links back
   to its origin (context-enrichment §4). Do not write vault notes directly;
   follow-ups are proposals only.

## Maru Run Contract

When Maru runs this skill in background/review mode:

1. Emit concise human-readable progress logs while working. Prefix major
   progress logs with stable phase markers so Maru can render stepwise
   status:
   - `[phase:source]` after source text/files are identified.
   - `[phase:normalize]` while applying guides, glossary, people, and naming
     conventions.
   - `[phase:verify]` while checking high-risk facts against internal
     sources and web research, and assembling corrections.
   - `[phase:draft]` while drafting the meeting note.
   - `[phase:proposal]` when preparing the `maru_skill_proposal_v1` block.
   - `[phase:review]` when preparing the `maru_meeting_review_v1` block.
   - Always include exactly one phase marker per line and keep that marker
     at the start of the line (after the timestamp) so the run-card parser
     and Activity panel can colour-code each phase reliably.
   - For errors, prepend `ERROR:` to the message or use `[phase:error]` so
     the UI can surface them in red.
2. Do not directly write files, update the vault, or run follow-up skills.
3. Return one `maru_skill_proposal_v1` JSON object with the meeting note file
   write proposal.
4. Return one `maru_meeting_review_v1` JSON object for user confirmation:

```json
{
  "schemaVersion": "maru_meeting_review_v1",
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
  "corrections": [
    {
      "before": "exact passage from source/draft",
      "after": "proposed replacement",
      "category": "transcription|fact|attribution|date|amount|decision|action|omission|supplement",
      "evidence": "internal note path / calendar event / source URL",
      "confidence": "resolved | card_reference | web_unverified | fuzzy",
      "required": true
    }
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
`enrichment` object, the `corrections` array, and the
`assignee`/`due`/`meetingSourcePath` follow-up
fields are additive and optional — populate them only from resolved enrichment
(context-enrichment §3/§4) and verified corrections (workflow step 5), and
omit or null them otherwise. Parsers ignore
unknown fields, so existing `maru_meeting_review_v1` consumers are unaffected.

## Rules

- Do not assume a specific transcript vendor.
- Never apply a correction silently: every change to names, numbers,
  decisions, or attributions goes through the `corrections` list and user
  review.
- A correction needs evidence — an internal file path, a calendar event, or a
  source URL. No evidence means uncertainty, not a correction.
- External facts stay `web_unverified` with a source URL and are promoted
  only by explicit user confirmation (same rule as context-enrichment §2-7).
- Supplemented content is marked with its source, never blended in as if it
  came from the transcript.
- Never draft from the transcript alone when a calendar is configured: the
  matching calendar event is the meeting's primary metadata, and the note
  must say so when no event was found.
- Do not transcribe raw audio unless a configured `io-*` or transcriber tool
  has already produced text.
- Keep filename policy configurable; default to
  `YYMMDD-meeting-<slug>.md` (English lowercase kebab-case slug, no spaces/Hangul).
  The 회의유형/한글 제목 are preserved in frontmatter `type`/`title`, not the filename.
- If date, participants, or topic cannot be recovered from the input, leave a
  visible placeholder and state what is missing.
- Legal/accounting evidence meeting records are out of scope unless the user
  provides a local template and explicitly requests that format.

## References

- `references/workspace-config.md` - runtime config keys
- `templates/meeting-note.md` - neutral meeting note template
- `_meta/rules/naming-and-placement.md` §C - destination subfolder for project/partner
  copies of the meeting note (`*-meetings/`); the canonical note stays in the
  meeting root
- `ssot.context_enrichment` (`_meta/rules/context-enrichment.md`) - entity
  resolution + context bundle + cross-link contract (consulted when
  `meeting_notes.hooks.enrichment` is set); its §2-7 web-search contract also
  governs external verification in workflow step 5
