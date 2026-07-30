# Drafts and the skill scheduler

Drafts unify AI-generated task drafts and ideation into one first-class,
unconfirmed concept. A draft is never vault data until the user explicitly
promotes it through the approval gate.

Backend: `src-tauri/src/drafts.rs` (store + promote),
`src-tauri/src/scheduler.rs` (recurring skill runs).
Frontend: `src/components/drafts/` (DraftsPane, SchedulerSection),
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
<work>/scratchpad/drafts/<id>.md      # draft bodies (scratchpad collection)
<work>/.maru/drafts/index.json        # metadata index (JSON array)
<work>/.maru/drafts/<id>/baseline.md  # frozen promote baseline (gap analysis)
<work>/.maru/schedules.json           # persisted schedules
```

Bodies are capped at 2 MiB. A missing or corrupt index loads as empty so a
bad file can never wedge the workflow; all writes go through `atomic_file`.

**Isolation invariant**: nothing in the drafts module writes outside
`<workspace>/scratchpad/drafts/`, `<work>/.maru/drafts/`, and the explicit,
approval-gated promote target. Vault scanning already excludes the scratchpad
root, so drafts never leak into confirmed vault data, the knowledge graph, or
search.

## Scheduler

The Drafts pane's Automation section manages recurring skill runs
(`SchedulerSection.tsx`). A schedule has a name, `skillId`, AI runtime,
free-form prompt, local time (hour/minute), optional weekdays (empty means
daily), and an enabled flag.

- Schedules persist per workspace at `<work>/.maru/schedules.json`.
- A ticker started in app setup scans every registered workspace every 60
  seconds and dispatches due schedules through the existing skill-run
  machinery (`skills_dispatch_background`) — no new AI invocation path.
- On launch, a schedule whose `nextRunAt` lies in the past fires exactly once
  (catch-up) and is then re-aligned to its next future slot.
- Adding a schedule requires the `scheduler.add` approval; the app emits
  `scheduler://changed|fired|error` events the pane listens to.

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
  scheduler missions) and live via `ai://mission_update`.
- The skill contract lives in `skills/skills/inbox-process/SKILL.md`. When the
  schedule prompt carries a `## 최근 수정 경향` section (auto-attached gap
  feedback, see [gap-analysis.md](gap-analysis.md)), the skill applies its
  hints to every `draftBody`.

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

1. Rejects discarded and already-accepted drafts.
2. Reads the body, then writes it to the chosen target:
   - **Document** — `write_atomic_create` at a vault-relative path resolved
     through `resolve_inside_vault`; an existing target is never overwritten
     (`drafts_promote_target_exists`).
   - **Task** — `tasks::create_task_note` into the active bucket.
3. Freezes the pre-promotion body to `.maru/drafts/<id>/baseline.md` — this is
   the gap-analysis baseline.
4. Flips the entry to `accepted`, records `promotedTo`, bumps `updatedAt`.

The frozen baseline is what makes [gap analysis](gap-analysis.md) possible:
it captures exactly what the AI produced before any human edit.
