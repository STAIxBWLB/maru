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
5. Load `ssot.rules`/`naming-and-placement.md` §C before proposing a route — it governs
   destination subfolder selection inside the target project.

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
   - Prefer the native route when its tool is installed: `.hwp`/`.hwpx` via
     `ahwp cat --format markdown` (agent-hwp; `hwp` only on releases before
     `v1.6.0`), `.xlsx` via `xlsx-toolkit`, `.pptx` via
     `pptx-toolkit`.
     `.docx`, `.txt`, `.md`, and `.csv` use the closest installed public
     toolkit or platform reader.
   - Formats with no native route (`.pdf`, `.epub`, `.msg`, `.html`, images)
     fall back to `markitdown <file>` when it is installed. It is a read-only
     text extractor here; never use it to generate or convert documents.
   - Unsupported binaries stay pending with a clear `failed` reason.
5. Create `inbox.naming.summary_file` with the required frontmatter and
   exactly three body sections: `## 요약`, `## 핵심`, `## 실행`.
6. Classify each item as `action`, `schedule`, `info`, `ideation`, or `noise`.
   If the item is `kind: transcript` — or a record that is clearly a meeting —
   propose handing it to `meeting-notes` rather than finalizing it here; do not
   write the meeting note yourself.
   If the item classifies as `ideation` (dictation, idea-conversion output, or
   a long memo carrying several unscoped ideas at once), do not route it as a
   normal item. Emit `recommendedAction: "handoff"` with
   `requiresConfirmation: true` and propose two destinations in `note`:
   the raw original to the memos collection and the distilled one-idea-per-file
   seeds to `seeds/` under the ideation collection. Resolve both through
   `~/.maru/skills/_builtin/lib/scratchpad_adapter.md` (`paths.scratchpad` plus `memos_subdir` /
   `ideation_subdir`); do not join a literal `scratchpad/` segment. Do not write
   the seeds yourself; a person confirms and the split follows the three-way
   triage in the ideation collection's `README.md` §인테이크, which separates
   idea from already-committed task from scope decision.
7. Propose a route using `project-registry.yaml` and the configured scoring
   spec. When the top score is weak (< 3) and `hooks.enrichment` is set, run the
   context-enrichment §2 entity resolution and `vmem_search` to disambiguate
   before leaving the item pending, and attach the matched `vault_note` /
   `relatedMeetings` to the proposal. Resolve the destination **subfolder** (not
   just the project) per `naming-and-placement.md` §C — map the item kind to the
   project's matching subfolder (`<project>/.maru/bu-config.yaml` `tree_map` →
   existing `NN-`/`N-` subfolder → `_incoming/` fallback; never the bare project
   root). Write the decision to `inbox.naming.route_file` in the shape defined in
   *Route File* below; the machine-readable block is what the applying tool reads.
8. Ask for confirmation before moving originals or summaries outside the inbox.
   In Maru review mode (see *Maru Run Contract*), do not move anything
   yourself — defer the move to Maru's confirmation step.
   When filing a raw original OUT of the exempt inbox zone into a non-exempt
   project folder, rename it to an English slug per `_meta/rules/naming-and-placement.md` §A4
   (`YYMMDD-type-description[-vX].ext`) and preserve the Korean original in the
   item manifest `source.original_name`. §A4's scope is tracked text only —
   `.md`, `.txt`, `.svg` with a non-ASCII name. Binaries (`.pdf`, `.hwp`,
   `.hwpx`, `.xlsx`, `.pptx`, `.docx`) keep their original filename.
9. Move processed items to `done/`, `failed/`, or `duplicate/` and append a
   receipt to `_state/index.jsonl`. In Maru review mode, skip this step;
   Maru performs the move and writes the receipt after the user confirms.

## Maru Run Contract

When Maru runs this skill in background/review mode (the dispatch metadata
sets `reviewFlow: true`), read `references/maru-review-output.md` before
processing, process **every** selected item in one run, and:

1. Emit concise human-readable progress logs with the phase markers defined in
   `references/maru-review-output.md`.
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
   route receipt. Maru applies those only after the user confirms.
4. Do not run follow-up skills (`task-management`, `meeting-notes`, vault
   skills) directly; surface them as `recommendedAction: "handoff"` items.
5. Return exactly one `maru_inbox_review_v1` JSON object, in the shape defined
   in `references/maru-review-output.md`, listing a decision for every
   processed item. Set `requiresConfirmation: true` for weak routes (top score
   < 3), `noise`, and `handoff` items so the user must decide before Apply
   unlocks.

## Proposal-Only Mode

When the request names explicit item IDs and no channel — the headless case an
unattended scheduler runs — propose and stop. This is the same non-destructive
contract as *Maru Run Contract* items 2 and 3, and it holds without the caller
restating it in the prompt.

1. Process only the named items.
2. Write `inbox.naming.extracted_file`, `inbox.naming.summary_file` and
   `inbox.naming.route_file` inside each item's directory, and
   `metadata.processing_context` / `metadata.processing_hints` into its
   `manifest.yaml`. Nothing else.
3. Move nothing. The item stays in `pending/`, `_state/index.jsonl` gets no
   receipt, and no raw original is filed into a project folder. A person or the
   applying tool performs the move after confirmation.
4. Do not run follow-up skills.

Items staged with `metadata.processing_hints.intake_mode: auto` are the usual
input (see `inbox-intake` §Processing Hints), but the mode is selected by the
request shape, not by the hint.

## Route File

`inbox.naming.route_file` carries the routing decision: prose reasoning in the
workspace language, then one machine-readable `## Destination (schema)` block.
Read `references/route-file.md` before writing a route file; it defines the
block's keys, parsing rules, no-destination values, and `filed_as` renames.

## Task Extraction Mode (`extract-tasks`)

`inbox-process extract-tasks` turns recent inbox and meeting material into
structured task candidates instead of routing items. This mode is read-only:
never write, move, or delete files in any mode (review mode included), and do
not run follow-up skills. Read `references/extract-tasks.md` before collecting
inputs; it defines the sources and the `maru_task_candidates_v1` output.

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

- Use `project-registry.yaml` as the first source of truth for the target project.
- Serialize the decision per *Route File*; a weak route (top score < 3) is
  `confidence: low`, which keeps it out of any automatic apply.
- Resolve the destination **subfolder** per `naming-and-placement.md` §C: classify the
  item's kind, then map kind → subfolder (`<project>/.maru/bu-config.yaml`
  `tree_map` → existing `NN-`/`N-` subfolder → default kind→category). Never drop
  files at the bare project root.
- If project confidence is weak (top score < 3) or the kind is ambiguous, route
  to the project's `_incoming/` (create if missing) or leave pending and ask.
- You MAY create one **standard** subfolder when the kind clearly maps and it
  extends the project's structure; do NOT invent ad-hoc one-off folders, and
  defer whole new business-unit trees to `business-unit-lifecycle`.
- Do not overwrite existing destination files.
- `ideation` items are exempt from project routing. They exit to the scratchpad
  (memos collection for the raw original, ideation collection's `seeds/` for the
  seeds), never into a project tree, and always behind confirmation.

## References

- `references/summary-schema.md` - required summary shape
- `references/workspace-config.md` - processing config keys
- `references/maru-review-output.md` - phase markers and `maru_inbox_review_v1`
- `references/route-file.md` - route file block and keys
- `references/extract-tasks.md` - `extract-tasks` inputs and output
- `ssot.rules`/`naming-and-placement.md` §C - destination subfolder resolution
  (kind→category→`tree_map`/`_incoming`); never route to a bare project root
- `~/.maru/skills/_builtin/lib/scratchpad_adapter.md` - scratchpad path resolution for
  `ideation` handoffs
- `_meta/rules/naming-and-placement.md` §A4 - English-slug naming for files moved into
  non-exempt project folders
- `ssot.context_enrichment` (`_meta/rules/context-enrichment.md`) - entity
  resolution for weak routes + transcript handoff (when `hooks.enrichment` set)
