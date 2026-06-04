---
name: inbox-process
description: >
  Public-safe inbox processing skill. Use when extracting text from normalized
  inbox items, writing summaries, classifying action/schedule/info/noise,
  proposing routes, generating digest/task candidates, channel-scoped processing
  such as "inbox-process kakao", or moving processed artifacts. It consumes
  inbox-intake manifests and never fetches directly from external providers.
---

# Inbox Process

Process normalized inbox items created by `inbox-intake` or an `io-*` provider
skill. The user may scope processing with `inbox-process <channel>`.

## Boot Sequence

1. Find `workspace.config.yaml`.
2. Read `inbox`, including `inbox.paths` and `inbox.naming`,
   `ssot.project_registry`, `ssot.registry_scoring`, and optional
   `inbox.hooks`. When `inbox.hooks.enrichment` is set, also read
   `ssot.context_enrichment` for entity resolution and weak-route assist.
3. Load `inbox-intake/references/manifest-schema.md` before changing item
   state.
4. Load `references/summary-schema.md` before creating a summary.

## Workflow

1. Parse the request:
   - no channel: select all pending items or the item ID provided by the user.
   - `<channel>`: select only pending items whose manifest `channel` matches
     the configured `inbox.channels` key.
   - `<channel> [context...]`: treat remaining words as processing context.
     Preserve free text as `metadata.processing_context`; parse `key=value`
     tokens into `metadata.processing_hints`.
   - A `Processing context (user-provided):` block in the request carries the
     same guidance as trailing `<channel> [context...]`; treat its text
     identically. When an item's manifest already has
     `metadata.processing_context`, honor it as guidance on (re)processing.
2. If a channel is provided, scan that channel's configured `drop_paths` first.
   Stage unnormalized files there through `inbox-intake` before processing.
   Ignore `.DS_Store` and other configured OS noise files.
3. Read each `inbox.naming.manifest_file` and verify
   `schema: inbox-item/v1`.
4. Extract text from `files[]` into `inbox.naming.extracted_file`.
   - `.pdf`, `.docx`, `.pptx`, `.xlsx`, `.hwpx`, `.hwp`, `.txt`, `.md`, and
     `.csv` should use the closest installed public toolkit or platform reader.
   - Unsupported binaries stay pending with a clear `failed` reason.
5. Create `inbox.naming.summary_file` with the required frontmatter and
   exactly three body sections: `## 요약`, `## 핵심`, `## 실행`.
6. Classify each item as `action`, `schedule`, `info`, `ideation`, or `noise`.
   If the item is `kind: transcript` — or a record that is clearly a meeting —
   propose handing it to `meeting-notes` rather than finalizing it here; do not
   write the meeting note yourself.
7. Propose a route using `project-registry.yaml` and the configured scoring
   spec. When the top score is weak (< 3) and `hooks.enrichment` is set, run the
   context-enrichment §2 entity resolution and `search_notes` to disambiguate
   before leaving the item pending, and attach the matched `vault_note` /
   `relatedMeetings` to the proposal. Write the decision to
   `inbox.naming.route_file`.
8. Ask for confirmation before moving originals or summaries outside the inbox.
   In Anchor review mode (see *Anchor Run Contract*), do not move anything
   yourself — defer the move to Anchor's confirmation step.
9. Move processed items to `done/`, `failed/`, or `duplicate/` and append a
   receipt to `_state/index.jsonl`. In Anchor review mode, skip this step;
   Anchor performs the move and writes the receipt after the user confirms.

## Anchor Run Contract

When Anchor runs this skill in background/review mode (the dispatch metadata
sets `reviewFlow: true`), process **every** selected item in one run and:

1. Emit concise human-readable progress logs. Prefix each major log line with
   exactly one phase marker at the start of the line (after any timestamp) so
   Anchor can render stepwise status and colour-code phases:
   - `[phase:source]` after the selected items / channels are resolved.
   - `[phase:extract]` while extracting text into `inbox.naming.extracted_file`.
   - `[phase:summary]` while writing `inbox.naming.summary_file`.
   - `[phase:classify]` while classifying action/schedule/info/ideation/noise.
   - `[phase:route]` while scoring routes against `project-registry.yaml`.
   - `[phase:review]` when preparing the `anchor_inbox_review_v1` block.
   - For errors prepend `ERROR:` to the message or use `[phase:error]`.
2. You MAY write the inbox-internal artifacts during the run: per item write
   `extracted_file`, `summary_file`, and `route_file` INSIDE that item's
   directory. These are non-destructive and stay within the inbox. You MAY also
   record the user's processing context onto each item by writing
   `metadata.processing_context` / `metadata.processing_hints` into that item's
   `manifest.yaml`; this is a non-destructive in-item write and is allowed in
   review mode.
3. In review mode you MUST NOT perform the destructive route step yourself: do
   not move items to `done/`, `failed/`, or `duplicate/`, do not file raw
   originals into project folders, and do not append the `_state/index.jsonl`
   route receipt. Anchor applies those only after the user confirms.
4. Do not run follow-up skills (`task-management`, `meeting-notes`, vault
   skills) directly; surface them as `recommendedAction: "handoff"` items.
5. Return exactly one `anchor_inbox_review_v1` JSON object listing a decision
   for every processed item:

```json
{
  "schemaVersion": "anchor_inbox_review_v1",
  "summary": "short batch summary across channels",
  "items": [
    {
      "itemId": "pending item id",
      "itemDir": "inbox/items/pending/<id>",
      "title": "human title",
      "channel": "kakao",
      "classification": "action|schedule|info|ideation|noise",
      "project": "project id or null",
      "destination": "workspace-relative folder for raw originals, or null",
      "confidence": "high|medium|low",
      "summaryPreview": "2-3 sentence preview",
      "requiresConfirmation": true,
      "recommendedAction": "route|reject|skip|handoff",
      "note": "why, or what is uncertain"
    }
  ]
}
```

Set `requiresConfirmation: true` for weak routes (top score < 3), `noise`, and
`handoff` items so the user must decide before Apply unlocks. Parsers ignore
unknown fields, so the artifact stays forward-compatible.

## Channel Invocation

Use root channel names from `workspace.config.yaml`, not subchannel names:

```text
inbox-process kakao
inbox-process mso regional innovation plan project=rise
inbox-process transcripts meeting=committee
```

Provider-specific folders under a channel root, such as `drop/mso/mail/`, are
source-kind hints only. Do not require users to call fine-grained channel names.

## Hooks

Hooks are optional and config-driven:

- `task_skill`: create local task candidates or call `task-management` when the
  user asks for task registration.
- `vault_extract_skill` and `vault_connect_skill`: only propose or call explicit
  vault skills. This public skill must not write vault notes by itself.
- `digest_output`: write a local digest under the configured inbox state path.
- `enrichment`: when set, consult `ssot.context_enrichment` to resolve entities
  for weak routes and to enrich route proposals (`vault_note`,
  `relatedMeetings`), and to hand `kind: transcript` items to `meeting-notes`.

## Routing Rules

- Use `project-registry.yaml` as the first source of truth.
- If project confidence is weak, leave the item pending and ask for a route.
- Do not create new project folder structures for one item.
- Do not overwrite existing destination files.

## References

- `references/summary-schema.md` - required summary shape
- `references/workspace-config.md` - processing config keys
- `ssot.context_enrichment` (`_sys/rules/context-enrichment.md`) - entity
  resolution for weak routes + transcript handoff (when `hooks.enrichment` set)
