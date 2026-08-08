# Drafts and the skill scheduler

The **Ideation hub** is the Drafts mode. It brings durable ideas and
AI-generated implementation drafts together in one first-class, unconfirmed
workspace. A draft is never vault data until the user explicitly promotes it
through the approval gate.

Ideas can be created, edited, and saved from the hub. Reads return a content
revision, and saves send that revision as `expectedRevision`, so a concurrent
disk edit is reported as a conflict instead of being overwritten. Stage changes
use the same optimistic revision and follow the backend lifecycle:

`seed -> developing -> proposal -> archive`, with `seed -> archive` and
`archive -> seed` also allowed.

The Scratchpad pane is reserved for memos and temporary results. It does not
list ideation or implementation-draft files, and idea creation, editing, and
stage actions live in the Ideation hub.

Backend: `src-tauri/src/drafts.rs` (store + promote),
`src-tauri/src/scheduler.rs` (recurring skill runs).
Frontend: `src/components/drafts/` (DraftsPane, useTaskCandidateIngestion),
`src/lib/taskIngestion.ts` (extract-tasks artifact ingestion),
`src/lib/ideationDrafts.ts` (ideation artifact ingestion).

## Draft model

`DraftEntry` (serde camelCase) holds one draft's metadata:

- `id` — validated identifier, safe for use in filesystem paths.
- `kind` — `task` | `idea` | `implementation`.
- `status` — `new` | `in-review` | `accepted` | `discarded`.
- `importance` (`high|medium|low`) and `confidence` (0..1), both optional.
- `source` — the originating scratchpad source (claude/codex/kimi/kiro/...).
- `originRefs` — workspace-relative paths the draft was derived from.
- `bodyPath` — markdown body path under the drafts scratchpad root.
- `promotedTo` — vault-relative target path, set on promote.
- `createdAt` / `updatedAt` — RFC 3339; `updatedAt` doubles as promote time.

## Storage layout

```text
<work>/scratchpad/drafts/<id>.md      # default; actual root is $MARU_DRAFTS
<work>/.maru/drafts/index.json        # metadata index (JSON array)
<work>/.maru/drafts/<id>/baseline.md  # frozen promote baseline (gap analysis)
<work>/.maru/schedules.json           # persisted schedules
```

The draft-body directory is configurable with `scratchpad.drafts_subdir` and
defaults to `drafts`. Maru injects the resolved absolute collection root as
`MARU_DRAFTS` into bundled and headless skill runs; producers must use that
variable rather than assuming `scratchpad/drafts/`. The value must be a safe relative subdirectory and may
not equal or contain any other Scratchpad collection root. This keeps custom
draft storage inside the Scratchpad root without allowing collection overlap.

### Ideation hub

Ideation files live below the configured `scratchpad.ideation_subdir` root in
the lifecycle directories `seeds/`, `developing/`, `proposals/`, and
`_archive/`. The hub refreshes these files through `scratchpad_list`, opens an
idea with `scratchpad_read`, and saves with `scratchpad_save`. New ideas use
`scratchpad_create_idea`; lifecycle moves use `scratchpad_transition_idea`.

The former **Open in Scratchpad** action is intentionally gone. This avoids
two editors competing for the same optimistic revision while keeping memo and
temporary-file workflows in the Scratchpad pane.

Bodies are capped at 2 MiB. A missing or corrupt index loads as empty so a
bad file can never wedge the workflow; all writes go through `atomic_file`.

### Adopting dropped bodies

`drafts_list` also adopts any `*.md` in the collection that no index entry
points at, so a body written outside the app (the headless pipeline, or a
person) becomes a real draft on the next listing rather than staying invisible.
Adoption reads what it can from the file's own frontmatter and degrades instead
of failing, because a malformed drop must never wedge the list:

| Frontmatter | Maps to | Missing or unrecognized |
|---|---|---|
| `title` | `title` | first `# ` heading, else the file name |
| `kind` (`task`/`implementation`) | `kind` | `idea`, whose promote dialog defaults to a document |
| `status` (`in-review`/`accepted`/`discarded`) | `status` | `new` (`draft` also means `new`) |
| `importance` (`high`/`medium`/`low`) | `importance` | unset |
| `confidence` (0..1) | `confidence` | unset |
| `runtime` (`claude`/`codex`/`kimi`/`kiro`/`maru`) | `source` | `manual` |
| `origin_refs` (list of strings) | `originRefs` | empty |

The key is `runtime`, not `source`: `DraftEntry.source` is the AI runtime, so a
drop recording an inbox channel under `source` would collide with it. Every
other frontmatter key is left in the file untouched; that is where richer
provenance (run id, channel, message ids) lives for a person to read.

`promoted_to` is never adopted from a file. Only Maru sets it, at promote time;
trusting a dropped file to claim it was already promoted would let it point the
gap baseline at an arbitrary path. Symlinked and oversized bodies are skipped,
as are non-`.md` files, and adoption is skipped entirely on a workspace Maru
may not write to.

**Isolation invariant**: nothing in the drafts module writes outside
`<workspace>/scratchpad/<drafts_subdir>/` (default: `drafts`, exposed to
producers as `$MARU_DRAFTS`),
`<work>/.maru/drafts/`, and the explicit,
approval-gated promote target. Vault scanning already excludes the scratchpad
root, so drafts never leak into confirmed vault data, the knowledge graph, or
search.

## Scheduler

Recurring runs are managed from the **Agents** mode
(`src/components/agents/AgentsPane.tsx`), not from Drafts — see
[agents.md](agents.md). A schedule has a name, `skillId`, AI runtime,
free-form prompt, local time (hour/minute), optional weekdays (empty means
daily), an enabled flag, and an optional `agentId` whose agent supplies the
live configuration at dispatch.

Drafts keeps only the ingestion half: `useTaskCandidateIngestion` has to run
where the drafts it creates appear, since ingestion only runs while its host
component is mounted.

- Schedules persist per workspace at `<work>/.maru/schedules.json`; agent
  definitions are global, at `~/.maru/agents.json`.
- A ticker started in app setup scans every registered workspace every 60
  seconds and dispatches due schedules through the existing skill-run
  machinery (`skills_dispatch_background`) — no new AI invocation path.
- On launch, a schedule whose `nextRunAt` lies in the past fires exactly once
  (catch-up) and is then re-aligned to its next future slot.
- Adding a schedule requires the `scheduler.add` approval; the app emits
  `scheduler://changed|fired|error` events the pane listens to. A dispatch now
  also carries the user's CLI command override and permission mode, which it
  previously dropped.

## Extract-tasks flow

A scheduled (or manual) `inbox-process extract-tasks` run prints one
`maru_task_candidates_v1` JSON object on stdout. The dispatcher records every
stdout line as a `provider.output` event under
`<work>/.maru/runs/skills/<runId>/events.jsonl`; the app reassembles stdout
from those events, validates the candidates, and imports them as task drafts
via `drafts_create` (`src/lib/taskIngestion.ts`).

- Candidates below the configured minimum importance
  (`ai.taskIngestMinImportance`) are skipped; candidates whose normalized
  title matches a non-discarded draft are skipped as duplicates.
- Ingestion runs once per run id, both on pane mount (scan of completed
  scheduler missions) and live via `ai://mission_update`. The once-per-run claim
  and mutual exclusion live in `taskIngestion.ts` at module scope
  (`onceSerialized`), not in component state: the pane unmounts on every mode
  switch while mission records live for the whole process, so a per-mount guard
  replayed every completed run on each visit and, because the title dedupe
  ignores discarded drafts, resurrected drafts the user had discarded.
  Serialization matters too, since each ingest reads the draft list, decides,
  then writes: two un-awaited runs sharing a candidate title would both miss the
  other's pending create.
- The skill contract lives in `skills/skills/inbox-process/SKILL.md`. When the
  schedule prompt carries a `## 최근 수정 경향` section (gap feedback attached
  fresh at dispatch time by the Rust scheduler, see
  [gap-analysis.md](gap-analysis.md)), the skill applies its hints to every
  `draftBody`.

## Ideation drafts

The `ideation-drafts` skill's `ideate-to-draft` mode prints one
`maru_implementation_draft_v1` JSON object per run. The mission carries
`{kind: "implementation-draft", ideaPath}` metadata so completions route to
`src/lib/ideationDrafts.ts` instead of the scheduler ingestion. One active
implementation draft per idea: a second completion for the same idea is
skipped as a duplicate.

## Promote flow

`drafts_promote` (approval kind `drafts.promote`) moves a draft into confirmed
state:

For a document promotion, the dialog suggests
`<promote_dir>/<slug>.md`. Set `drafts.promote_dir` in `workspace.config.yaml`
to change that suggestion; it defaults to `_incoming`. The value must be a safe
workspace-relative directory and cannot use `scratchpad` or `.maru` as its
first path component.
This is a suggestion only: an explicitly entered, valid target path remains
supported.

1. Rejects discarded and already-accepted drafts.
2. Reads the body, then writes it to the chosen target:
   - **Document** — `write_atomic_create` at a vault-relative path resolved
     through `resolve_inside_vault` and then `assert_document_owner`, the same
     ownership guard every other document writer applies (without it a nested
     registered workspace could receive the file and the parent's scan would
     skip it); an existing target is never overwritten
     (`drafts_promote_target_exists`).
   - **Task** — `tasks::create_task_note` into the active bucket.
3. Freezes the promoted bytes to `.maru/drafts/<id>/baseline.md`. For the task
   target this is read back from the created note rather than reused from the
   draft body, because `create_task_note` injects `status`/`title` frontmatter:
   freezing the raw body instead made every task promotion report its own
   generated frontmatter as a human edit.
4. Flips the entry to `accepted`, records `promotedTo`, bumps `updatedAt`.

The frozen baseline is what makes [gap analysis](gap-analysis.md) possible:
it captures exactly what the AI produced before any human edit. The pane flushes
an unsaved editor buffer before opening the promote dialog, so the baseline and
the published artifact are both the text the user actually approved.
