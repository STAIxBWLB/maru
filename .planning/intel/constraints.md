# Constraints (from SPEC-classified docs)

13 SPEC docs. Traversal of the drafts.md / gap-analysis.md pair starts at
docs/drafts.md (manifest precedence 10) and then docs/gap-analysis.md (11).
All other SPECs carry default precedence.

---

## DraftEntry record schema
- source: docs/drafts.md
- type: schema
- content: `DraftEntry` (serde camelCase) fields: `id` (validated, filesystem-path safe),
  `kind` (`task` | `idea` | `implementation`), `status` (`new` | `in-review` | `accepted` |
  `discarded`), optional `importance` (`high|medium|low`) and `confidence` (0..1),
  `source` (originating AI runtime), `originRefs` (workspace-relative paths),
  `bodyPath`, `promotedTo` (vault-relative, set on promote), `createdAt`/`updatedAt`
  (RFC 3339; `updatedAt` doubles as promote time).

## Drafts storage layout and collection root
- source: docs/drafts.md
- type: schema
- content: `<work>/scratchpad/drafts/<id>.md` (default; actual root is `$MARU_DRAFTS`),
  `<work>/.maru/drafts/index.json`, `<work>/.maru/drafts/<id>/baseline.md`,
  `<work>/.maru/schedules.json`. The body directory is configurable via
  `scratchpad.drafts_subdir` (default `drafts`); Maru injects the resolved absolute root
  as `MARU_DRAFTS` into bundled and headless skill runs and producers must use that
  variable. The value must be a safe relative subdirectory and may not equal or contain
  any other Scratchpad collection root. Bodies capped at 2 MiB; a missing or corrupt
  index loads as empty; all writes go through `atomic_file`.

## Draft stage lifecycle
- source: docs/drafts.md
- type: protocol
- content: `seed -> developing -> proposal -> archive`, plus `seed -> archive` and
  `archive -> seed`. Reads return a content revision; saves send it as
  `expectedRevision` so a concurrent disk edit is reported as a conflict instead of
  being overwritten. Ideation files live under `scratchpad.ideation_subdir` in
  `seeds/`, `developing/`, `proposals/`, `_archive/`, accessed through
  `scratchpad_list`/`scratchpad_read`/`scratchpad_save`/`scratchpad_create_idea`/
  `scratchpad_transition_idea`.

## Dropped-body adoption mapping
- source: docs/drafts.md
- type: protocol
- content: `drafts_list` adopts any `*.md` in the collection no index entry points at.
  Frontmatter mapping, degrading rather than failing: `title` -> `title` (else first
  `# ` heading, else file name); `kind` (`task`/`implementation`) -> `kind` (else
  `idea`); `status` (`in-review`/`accepted`/`discarded`) -> `status` (else `new`;
  `draft` also means `new`); `importance`, `confidence` -> same (else unset);
  `runtime` (`claude`/`codex`/`kimi`/`kiro`/`maru`) -> `source` (else `manual`);
  `origin_refs` -> `originRefs` (else empty). The key is `runtime`, not `source`.
  `promoted_to` is never adopted from a file; only Maru sets it at promote time.
  Symlinked, oversized, and non-`.md` bodies are skipped; adoption is skipped entirely
  on a workspace Maru may not write to.

## Drafts isolation invariant
- source: docs/drafts.md
- type: nfr
- content: Nothing in the drafts module writes outside
  `<workspace>/scratchpad/<drafts_subdir>/` (exposed as `$MARU_DRAFTS`),
  `<work>/.maru/drafts/`, and the explicit approval-gated promote target. Vault
  scanning already excludes the scratchpad root, so drafts never leak into confirmed
  vault data, the knowledge graph, or search.

## Skill scheduler dispatch contract
- source: docs/drafts.md
- type: protocol
- content: A schedule carries name, `skillId`, AI runtime, free-form prompt, local
  time (hour/minute), optional weekdays (empty = daily), enabled flag, optional
  `agentId`. Schedules persist per workspace at `<work>/.maru/schedules.json`; agent
  definitions are global at `~/.maru/agents.json`. A ticker scans every registered
  workspace every 60 seconds and dispatches through `skills_dispatch_background` (no
  new AI invocation path). On launch a schedule whose `nextRunAt` is in the past fires
  exactly once (catch-up), then re-aligns. Adding a schedule requires the
  `scheduler.add` approval; events are `scheduler://changed|fired|error`.

## Extract-tasks ingestion contract
- source: docs/drafts.md
- type: api-contract
- content: An `inbox-process extract-tasks` run prints one `maru_task_candidates_v1`
  JSON object on stdout. The dispatcher records each stdout line as a `provider.output`
  event under `<work>/.maru/runs/skills/<runId>/events.jsonl`; the app reassembles,
  validates, and imports candidates as task drafts via `drafts_create`. Candidates
  below `ai.taskIngestMinImportance` are skipped; candidates whose normalized title
  matches a non-discarded draft are skipped as duplicates. Ingestion runs once per run
  id; the once-per-run claim and mutual exclusion live at module scope
  (`onceSerialized` in `taskIngestion.ts`), not in component state. The
  `ideation-drafts` `ideate-to-draft` mode prints one `maru_implementation_draft_v1`
  object per run; one active implementation draft per idea.

## Promote flow and baseline freeze
- source: docs/drafts.md
- type: protocol
- content: `drafts_promote` (approval kind `drafts.promote`): (1) rejects discarded and
  already-accepted drafts; (2) writes the body to the chosen target -- Document via
  `write_atomic_create` at a vault-relative path resolved through
  `resolve_inside_vault` then `assert_document_owner`, never overwriting an existing
  target (`drafts_promote_target_exists`); Task via `tasks::create_task_note` into the
  active bucket; (3) freezes the promoted bytes to `.maru/drafts/<id>/baseline.md` --
  for the task target this is read back from the created note rather than reused from
  the draft body, because `create_task_note` injects `status`/`title` frontmatter;
  (4) flips the entry to `accepted`, records `promotedTo`, bumps `updatedAt`. The
  document promote dialog suggests `<promote_dir>/<slug>.md`; `drafts.promote_dir`
  defaults to `_incoming`, must be a safe workspace-relative directory, and cannot use
  `scratchpad` or `.maru` as its first path component.

---

## Gap analysis baseline resolution
- source: docs/gap-analysis.md
- type: protocol
- content: Analysis reads the baseline frozen by `drafts_promote` at
  `<work>/.maru/drafts/<id>/baseline.md` and the promoted document at the draft index
  entry's `promotedTo`, re-validated through `resolve_inside_vault` so a hand-edited
  index cannot redirect the read outside the workspace. `gap_reports_list` returns
  accepted drafts with a `promotedTo`, each flagged `hasBaseline` and `hasDocument`.
  `drafts_relink_promoted` validates containment, ownership, and file type and updates
  only index metadata; the frozen baseline is never rewritten. Files refuses to move a
  promoted target, or a directory containing one, to Trash until the draft is relinked
  or discarded; other entries in the same batch continue independently. Drafts and Gap
  Analysis always use the primary private workspace regardless of the focused tab.

## Gap diff hunk schema
- source: docs/gap-analysis.md
- type: schema
- content: `gap_analyze(workPath, draftId)` runs a line-level diff (`similar::TextDiff`)
  grouped into unified-diff-style hunks with 3 lines of context per side; change groups
  at most 6 equal lines apart merge into one hunk. Each hunk carries `op`
  (`insert` | `delete` | `replace`; equal runs never emitted), 1-based
  `oldStart`/`newStart` plus line counts (for pure insertions `oldStart` is the
  baseline line after which content was added, 0 = before the first line), `lines`
  (`' '` context, `'-'` removed, `'+'` added), and `hunkType` + `evidence`. The report
  carries `baselineHash` (sha256 of the baseline) and a summary: total hunks,
  added/removed line counts, per-type hunk counts.

## Hunk classification heuristics (v1)
- source: docs/gap-analysis.md
- type: protocol
- content: Pure Rust string/regex signals, no AI call, ordered first-match-wins:
  (1) **formatting** -- every changed line is blank, added/removed lines are identical
  once whitespace is squashed, or every changed line sits inside the leading
  frontmatter block (also covers an insert-only hunk where the baseline has no
  frontmatter at all); (2) **cross-doc-reference** -- an added line contains a
  `[[wikilink]]` or a markdown link to a non-URL target; (3) **external-info** -- an
  added line contains a URL, date, number, or quoted name absent from the baseline;
  (4) **direct-edit** -- everything else. Every classification surfaces its `evidence`.

## Gap log record schema and append discipline
- source: docs/gap-analysis.md
- type: schema
- content: `gap_append_log` (explicit, frontend-triggered after an analysis is viewed)
  re-runs the analysis and appends one JSON line to `<work>/.maru/gap-log.jsonl`:
  `{ "at", "draftId", "promotedTo", "addedLines", "removedLines",
  "byType": { "externalInfo", "directEdit", "crossDocReference", "formatting" },
  "hunkCount" }`. The record is built into a single buffer and written under the
  per-path append lock the other JSONL writers use; a two-call `writeln!` could tear a
  line and the reader's skip-unparseable behavior would silently swallow it.
  `gap_log_list(workPath, limit)` returns entries newest-first, default cap 100;
  corrupt lines are skipped.

## Gap analysis isolation invariant
- source: docs/gap-analysis.md
- type: nfr
- content: The module only reads the draft index, baselines, and in-vault documents,
  and only writes `.maru/gap-log.jsonl` -- and only through `gap_append_log`, never as
  a side effect of analysis.

## Gap feedback digest injection
- source: docs/gap-analysis.md
- type: protocol
- content: `buildGapFeedbackDigest(entries, maxEntries?)` aggregates the most recent 20
  entries into Korean summary lines plus one actionable hint for the dominant edit
  type; empty input yields an empty string. A Rust port
  (`build_gap_feedback_digest`) produces the identical digest and the two must stay in
  sync. Injection happens at dispatch time in `build_dispatch_prompt`: when an
  `inbox-process` schedule fires, the scheduler strips any previously attached digest
  section and appends one built fresh from the current gap log under
  `## 최근 수정 경향 (자동 첨부)`. Best-effort: a gap-log read failure dispatches the
  bare stripped prompt; non-`inbox-process` schedules are untouched. Stored schedule
  prompts stay bare.

---

## Maru / dotfiles-v2 path ownership
- source: docs/BOUNDARIES.md
- type: protocol
- content: Maru owns `~/.maru/**`, `~/.maru/skills/registry.json`,
  `~/.maru/skills/_builtin`/`_sources`/`_managed`, `~/.maru/env`,
  `~/.maru/skills/<name>` runtime symlinks, and `~/.claude/skills/<name>` /
  `~/.codex/skills/<name>` symlinks created through Maru install actions. Maru must not
  write `~/.claude/CLAUDE.md`, `~/.claude/settings.json`,
  `~/.claude/settings.local.json`, `~/.claude/hooks/**`, or non-skill global tool
  settings owned by dotfiles-v2. dotfiles-v2 owns AGENTS fan-out and global instruction
  targets, Claude/Codex/Antigravity settings and status line, shell and environment
  bootstrap, and read-only skill inventory reports; it must not write
  `~/.claude/skills/**`.

## Boundary conflict rule
- source: docs/BOUNDARIES.md
- type: protocol
- content: This file mirrors the workspace policy in
  `~/workspace/work/_meta/rules/skills-ssot.md`. If a change needs to alter the
  ownership table, both repositories' boundary documents must be updated in the same
  change set.

---

## Skill source ownership classes
- source: docs/SSOT-TIERS.md
- type: schema
- content: Bundled (`builtin` / `maru-builtin`, Maru release, installable); Owned
  catalog (`linked` or `cloned` / public, private, managed; catalog repo or local Maru
  owner; installable); Imported (`imported` / `maru-imported`, explicit local import,
  installable); External managed (`external-managed`, `~/.agents` or another manager,
  inventory only, never copied or installed); Tool native (`tool-native`, Claude/Codex
  plugin or built-in runtime, inventory only). Default owned catalog is 43 skills
  (34 bundled, 5 public, 4 private) producing 86 Maru install records when synced to
  Claude and Codex. Inventory-only counts (`~/.agents/skills` as `external-managed`,
  `$CODEX_HOME/skills/.system` -- falling back to `~/.codex/skills/.system` -- as
  `tool-native`) never increase the 43 managed skills or 86 installs.

## Skill tier map T1-T5
- source: docs/SSOT-TIERS.md
- type: schema
- content: T1 Core -- `STAIxBWLB/skills` repo `skills/<name>/`, deployed via the
  `skills-channel` OTA bundle (no app release), change path `STAIxBWLB/skills` PR ->
  auto-published bundle. T2 Public -- `~/.maru/skills/_sources/skills-public/skills/<name>/`,
  frozen on the `archive/legacy-catalog` branch of `STAIxBWLB/skills`. T3 Private --
  `~/.maru/skills/_sources/skills-private/skills/<name>/`, `entelecheia/skills` push.
  T4 Imported -- `~/.maru/skills/_imported/skills/<name>/`, `maru skills import`.
  T5 Managed Local -- `~/.maru/skills/_managed/<name>/`, Maru local registry.
  (See INGEST-CONFLICTS.md WARNING: this numbering diverges from the workspace SSOT
  this doc set declares authoritative.)

## Skills registry invariants
- source: docs/SSOT-TIERS.md
- type: nfr
- content: One skill name belongs to one tier only. Duplicate names across registered
  sources are registry validation errors. Duplicate or misplaced skills are visible for
  repair but cannot install or dispatch. `public` and `private` tiers are valid only in
  their matching `_sources/skills-public` or `_sources/skills-private` checkouts.
  Runtime edits are allowed, but the owner tier determines the reconcile path. External
  legacy skills stay outside Maru management unless explicitly imported.

## T1 OTA bundle deployment contract
- source: docs/SSOT-TIERS.md
- type: protocol
- content: T1 skills ship as signed immutable bundles on the fixed `skills-channel`
  prerelease of `STAIxBWLB/skills`. The app applies the newest bundle automatically
  when `_builtin` is clean and the runtime env hash matches; otherwise it notifies and
  waits for a manual apply (`maru skills update --apply [--repair-env]` or the Skills
  UI). Local T1 edits block bundle apply until promoted (Save As) or discarded. The
  embedded `src-tauri/skills-bootstrap/` snapshot only seeds offline first runs and can
  never downgrade an applied bundle; refresh with `make skills-bootstrap-refresh` at
  release time. Reconcile paths: T1 dirty -> revert / change `dev/maru` / promote to
  T2-T3; T2 -> push `STAIxBWLB/skills`; T3 -> push `entelecheia/skills`; T4 -> accept
  or unmanage; T5 -> accept or delete.

## maru skills CLI surface
- source: docs/SSOT-TIERS.md
- type: api-contract
- content: `maru doctor --quiet`; `maru skills update --check`;
  `maru skills update --apply [--repair-env]`;
  `maru skills sync --check|--apply --tools claude,codex`; `maru skills dirty --json`;
  `maru skills reconcile <name-or-id> --accept --message "..."` / `--discard`;
  `maru skills import /path/to/skill --copy`;
  `maru skills import-unmanage <name> --delete-files`. Codex installs follow
  `$CODEX_HOME/skills` when the runtime exports `CODEX_HOME`, otherwise
  `~/.codex/skills`.

---

## maru doctor read-only guarantee
- source: docs/maru-doctor.md
- type: nfr
- content: `maru doctor` validates the local skills registry under `~/.maru/skills` and
  is strictly read-only: it scans sources and validates registry and symlink state in
  memory but never writes `registry.json`, materializes the bundled catalog, creates
  directories, or repairs links. Legacy external skill links outside Maru are ignored
  unless imported. `skills update --check` is read-only (reports active bundle, newest
  `skills-channel` bundle, blockers). `skills sync --check` is read-only and exits `1`
  when changes are needed. `--quiet` exits `0` when no error issue exists and `1` when
  a critical skills issue exists.

## Doctor issue codes and exit semantics
- source: docs/maru-doctor.md
- type: schema
- content: error -- `duplicate_source` (same name in more than one registered source),
  `tier_misplaced`, `skill_invalid` (malformed/unsupported frontmatter),
  `skill_missing` (registry points at a directory without `SKILL.md`), `source_invalid`,
  `install_skill_missing`, `install_link_broken` (install symlink no longer points
  through Maru); warn -- `skill_dirty` (content differs from saved hash or source
  working tree). Invalid skills stay visible for repair, but install/dispatch paths
  fail closed until doctor is clean.

## Skills update/sync/reconcile refusal rules
- source: docs/maru-doctor.md
- type: protocol
- content: `skills update --apply` downloads, verifies (minisign signature + sha256),
  and atomically applies the bundle; `--repair-env` additionally runs the bundle's env
  setup when the runtime env hash changed, rolling the bundle back if the repair fails.
  `skills sync --apply` creates canonical `~/.maru/skills/<name>` links, points selected
  tool runtimes at those links, and updates install records; it refuses to overwrite
  non-symlink tool content. Reconcile: for `_sources/*` git-backed skills `--accept`
  stages, commits, and attempts to push (on push failure the local commit remains and
  the outcome reports the failure) and `--discard` restores from git. For bundled
  skills `--accept` is refused and `--discard` restores from the ACTIVE bundle's
  pristine baseline (`~/.maru/skills/_bundles/<id>/`), falling back to the embedded
  bootstrap snapshot only when no baseline exists. For managed/imported skills
  `--accept` updates the saved hash and `--discard` is unavailable unless the source is
  git-backed.

---

## AgentRecord field contract
- source: docs/agents.md
- type: schema
- content: `id` matches `^[a-z0-9][a-z0-9-]{0,47}$` and builtin ids are reserved;
  `labelKey`/`label` (i18n key for builtins, literal name for user agents);
  `skillName` is the skill **name**, not the registry id (`<sourceId>::<name>` ids are
  machine-local), resolved at run time by `findSkill` (TS) and `store::resolve_skill_id`
  (Rust); `runtime` is `inherit` | `claude` | `codex` | `kimi` | `kiro` (`inherit`
  resolves to `ai.defaultRuntime`); `permissionMode` is `inherit` | `plan` |
  `acceptEdits` | `default` | `bypassPermissions`; `prompt` is literal text, empty on a
  feature-bound builtin; `kind` is `background` (tracked, stoppable mission) or
  `inline` (request/response); `enabled: false` stops the agent's feature, not just its
  row; `recommendedSchedule` is derived from the seed and never creates a schedule by
  itself.

## Agent storage and sparse builtin overrides
- source: docs/agents.md
- type: schema
- content: Agents are global at `~/.maru/agents.json`; schedules stay per workspace.
  Builtins are a `const` array in `agents.rs`, never a file. The user layer stores a
  sparse patch per builtin: `{ "version": 1, "agents": [ ... ], "overrides": {
  "<id>": { "runtime": "codex" } } }`. On load, untouched fields pick up the new seed
  value and touched fields survive; reset drops the patch. Only `runtime`,
  `permissionMode`, `prompt`, and `enabled` are overridable -- a builtin's `skillName`
  is fixed because its call site depends on that skill's output contract. A malformed
  override degrades to the seed for that agent alone. Builtins cannot be deleted
  (`agent_builtin_not_deletable`); `enabled: false` is the delete.

## runAgent dispatch invariants
- source: docs/agents.md
- type: protocol
- content: `runAgent(agent, ctx)` is the one path every AI feature takes: resolve skill
  by name, resolve runtime (falling back across the other CLIs when the preferred one
  is missing), look up the command override, probe availability, dispatch through
  `skills_dispatch_background`. Two rules it must keep: (1) `metadata.origin` is never
  overwritten -- `origin` defaults to the agent id only when the caller supplies none;
  (2) `agentId` is always stamped -- pre-agent runs map back through their origin
  namespace by prefix (`meetingNotes*` -> `meeting-notes`).

## Scratchpad environment for skill runs
- source: docs/agents.md
- type: api-contract
- content: Every work-scoped skill run receives `MARU_SCRATCHPAD`, `MARU_DRAFTS`,
  `MARU_TEMP`, and `CLAUDE_CODE_TMPDIR`. `MARU_DRAFTS` is the configured
  `scratchpad.drafts_subdir` root; bundled and headless producers must use it instead
  of assuming `scratchpad/drafts/`.

## CLI backend capability matrix
- source: docs/agents.md
- type: api-contract
- content: `CliProviderKind::capabilities()`
  (`src-tauri/src/agent_host/provider.rs`) is the single declaration;
  `src/lib/agentCapabilities.ts` mirrors it and `agentCapabilities.test.ts` parses the
  Rust file so drift fails the build. `resume`: claude `--resume`, codex `resume`,
  kimi `--session`, kiro unsupported. `usage`: claude OAuth API, codex rollout JSONL,
  kimi and kiro unsupported. `add_dirs`: claude, codex, kimi yes; kiro no. Only flags a
  gate reads live here; attach-mention is not a capability (`isAgentKind` covers it).
  Auth probing and `usage_status` stay per-backend matches on purpose.

## Schedule binding and unattended permission mode
- source: docs/agents.md
- type: protocol
- content: At dispatch, an enabled and standalone agent's current
  skill/runtime/permission mode/prompt win. Switching an agent off stops its schedules
  outright (`agent_disabled`, skipped before the ticker's day claim). Only a missing or
  feature-bound agent falls back to the schedule's own stored snapshot. Unattended runs
  default to permission mode `plan` regardless of `ai.permissionMode`; an agent that
  needs more sets its own `permissionMode` explicitly. `agentId` is serde-default and
  omitted when absent so a pre-agent `schedules.json` round-trips unchanged. A schedule
  matching no agent still appears with run/pause/remove. Nothing fires on a timer until
  the user attaches a schedule, which goes through the `scheduler.add` approval; seeds
  never create schedules. Read-only and proposal-only agents ship enabled; anything
  that pushes to a remote or sends a message ships disabled (`daily-digest`,
  `git-sync`).

## Agent chat transcript replay ceiling
- source: docs/agents.md
- type: nfr
- content: Chat dispatches through `start_agent_cli_invocation`, not
  `skills_dispatch_background`. Multi-turn is transcript replay: each turn re-sends the
  capped conversation as one prompt, because native resume is unavailable across the
  board today. Ceiling: prompt grows O(turns^2) and every turn is a cold subprocess.
  `CHAT_PROMPT_MAX_CHARS` (24k) is sized for argv, not a context window; oldest turns
  drop first and the newest user message is never truncated. Scrollback is
  `localStorage`, keyed by workspace and agent, capped at `CHAT_HISTORY_CAP`. Turn
  actions all write new files; there is deliberately no "insert into the active
  document" because `save_document` is revision-checked and frontmatter byte-identity
  is a hard rule. `make verify-integration` (not `make verify`, which must stay
  hermetic) smokes the installed CLIs; uninstalled backends are skipped, not failed.

---

## Diagram document envelope v8 and v7 migration
- source: docs/diagram.md
- type: schema
- content: Diagrams live at `<workspace>/diagrams/<name>.cmd.json` as a `v:8` envelope
  (report datasets + pattern views). The last-opened document is restored from
  `diagram.lastDocument`; unsaved state is workspace-keyed. Legacy `v:7` documents
  migrate in memory on load; the first v8 save over a migrated document triggers a
  one-time backup to `<workspace>/.maru/diagrams/backups/<name>-v7-<ts>.cmd.json`
  (temp-file + rename). A backup failure warns but never blocks the save and is not
  retried within the session.

## Diagram storage paths
- source: docs/diagram.md
- type: schema
- content: `diagrams/<name>.cmd.json` (documents);
  `.maru/diagram-patterns/<name>.pattern.json` (workspace pattern presets);
  `.maru/diagrams/history/<docId>/` (auto-snapshot ring, cap 20);
  `.maru/diagrams/backups/` (one-time v7 backups);
  `attachments/diagrams/<docId>/` (rendered report assets, the only write target
  outside the diagram stores).

## Diagram backend command surface
- source: docs/diagram.md
- type: api-contract
- content: `diagram_save_document`, `diagram_load_document`, `diagram_list_documents`,
  `diagram_delete_document`, `diagram_export_blob` / `diagram_export_blob_to_path`,
  `diagram_save_snapshot` / `diagram_list_snapshots` / `diagram_restore_snapshot`,
  `diagram_backup_document`, `diagram_pattern_save` / `diagram_pattern_list` /
  `diagram_pattern_delete`, and `diagram_write_report_asset` (extension-whitelisted to
  svg/png/json, traversal-safe, atomic, write-guard checked).

## Codec registry export fidelity classes
- source: docs/diagram.md
- type: protocol
- content: `src/lib/diagram/codecs.ts` declares each format's import capabilities and
  export fidelity up front. lossless -- `maru-json` (canonical document) and
  `maru-svg` (SVG with the canonical JSON embedded as metadata; re-import restores the
  full document). structural -- csv / tsv / markdown-table / html-table / mermaid (data
  or topology survives, styling does not). visual -- svg-image / png / png-transparent
  / jpg / pdf (a rendering only). Pattern conversions classify as `same-family`
  (lossless regeneration, no dialog), `cross-family` (records remapped through a
  field-mapping preview dialog, unmapped fields warn), or `freeform`
  (non-convertible).

## Managed report-link block contract
- source: docs/diagram.md
- type: protocol
- content: Requires a saved, clean diagram. Renders a standalone SVG and a 2x PNG,
  computes `renderHash = sha256(serializeDoc(doc) + renderOptions)`, and writes both to
  `attachments/diagrams/<docId>/<fileScope>-<hash8>.svg`/`.png` via
  `diagram_write_report_asset`, where `fileScope` replaces non-`[A-Za-z0-9._-]` runs
  with `-`. Scope is `pattern:<viewId>` when exactly one pattern view is selected,
  otherwise `doc`. Block format:
  `<!-- maru-diagram:v1 {"source":...,"scope":...,"asset":...,"fallback":...,"renderHash":"sha256:<hash>"} -->`
  followed by the image line. Blocks are matched on `source` + `scope`: a match
  replaces in place, no match appends at the end. Content outside the block is
  preserved byte-for-byte, malformed blocks are skipped with a warning, and splicing is
  idempotent. Saves go through the revision-checked `save_document` path; a
  `document_conflict` surfaces a notice and is never retried automatically. Studio and
  the export converters treat the block as a normal linked image (no inline editor, no
  export preprocessor, no automatic refresh; HWPX output does NOT embed the linked
  image).

## Diagram history and performance budgets
- source: docs/diagram.md
- type: nfr
- content: 5-minute auto-snapshot ring, cap 20 per document, under
  `<workspace>/.maru/diagrams/history/<docId>/`. Viewport culling (`visibleSubset`)
  plus a position-keyed edge-route Map cache (5k entries) keep 1000-node diagrams
  smooth. Diagram mode ships default-on; opt out via Settings -> Preferences,
  `VITE_MARU_DIAGRAM=0`, or `?maru-diagram=0`. Snap size configurable 1-200 px.

---

## Graph dual-source data model and graceful degrade
- source: docs/graph.md
- type: schema
- content: Assembled by `src/lib/graph/model.ts` from (1) a live layer --
  `VaultEntry.links` from the workspace scan, where any frontmatter field containing a
  `[[wikilink]]` is an edge (no hard-coded field list), always available; and (2) a
  community overlay -- `<vault>/reports/vault-graph.json` read by
  `vault_graph_read(vault_path) -> Option<VaultGraphFile>`, tolerant of both `edges`
  and `links` shapes, supplying community coloring and precomputed metrics. If the
  overlay is missing or malformed the model degrades to the live layer alone. The
  overlay is produced out-of-band by the `vault-graph` skill, not by the app.

## GraphSettingsV3 schema and migration
- source: docs/graph.md
- type: schema
- content: `MaruSettings.graph` is `GraphSettingsV3` (`schemaVersion: 3`): `source`
  (vault|workspace), `mode` (global|local|chains), `localDepth`/`localDirection`,
  `searchAsFilter`, `generatedPatterns`, per-source `profiles`
  (domains/origins/types/relations/community/showUnresolved/showGenerated/
  minVisibleNeighbors, where `minVisibleNeighbors` replaces the old scope toggle and
  minDegree and the V1->V2 migration maps `all`->workspace and
  `max(minDegree, connected ? 1 : 0)`), `display`, `panels` (one optional pinned Tools
  drawer, width clamped 280-480), and `savedViews`
  (source/mode/localTarget/profile/display per view). V2 settings migrate without
  losing filters or saved views.

## Graph display defaults, fresh install vs legacy
- source: docs/graph.md
- type: schema
- content: `display` = arrows `typed|all|none`, label density `low|balanced|high`,
  color mode `neutral|domain|community|origin`, optional relation colors, theme
  `dark|light|app`, accent `seal|violet|green`, node/edge scale 0.5-2. Fresh installs
  adopt the V6 dark / seal / origin canvas defaults. Legacy default displays keep the
  app theme with violet accent and community colors. Display wiring is hot-applied
  (arrows/labels via `setSetting` or attribute updates + `refresh()`), never a graph
  rebuild. Frontmatter edges carry a stable `relationColor` (palette hash); body
  `wiki_link` edges stay neutral.

## Graph derivation pipeline order
- source: docs/graph.md
- type: protocol
- content: `src/lib/graph/derive.ts` is one pure pipeline: node facet filter ->
  relation filter (before traversal/counting) -> local k-hop -> `minVisibleNeighbors`
  k-core pruning (focus anchor always retained) -> search-as-filter. It produces
  `analysisModel` (insights/pathfinding, before transient search), `visibleModel` plus
  node/edge masks, facets, `pausedFilters` (persisted values absent from the current
  graph, shown as inactive chips and never silently blanking the canvas),
  `emptyReason`, and `focusMissing`. Untyped is not generated: notes without a
  frontmatter `type` are `"untyped"` and visible authored content; only paths matching
  `generatedPatterns` (trailing `/` = prefix, else exact filename, case-insensitive)
  count as generated.

## Graph renderer state machine and camera rules
- source: docs/graph.md
- type: protocol
- content: `GraphCanvas.tsx` is a Sigma WebGL renderer over a Graphology
  `MultiDirectedGraph`; GPU picking owns hit testing and reducers own hover, path,
  selection, and visibility. Filters never rebuild topology or restart layout. States:
  `loading | layout-running | ready | gpu-recovery | fallback | fatal`. Mount gating
  (no renderer while the container is zero-size); ResizeObserver -> coalesced
  `resize()` + `refresh()` and never a camera move; camera fits on first frame, on
  topology change after settle, and when every visible node leaves the viewport --
  ordinary resizes and filter changes never move the camera. Pins sync to
  ForceAtlas2's native `fixed` attribute. Sigma's invalid-container guard is enabled so
  hiding or maximizing another pane cannot crash the app while Graph is mounted.
  Layout stops after three stable samples or five seconds; a dead worker keeps
  last-good positions and reports through `onLayoutError`.

## Graph local targets and saved views
- source: docs/graph.md
- type: protocol
- content: A Local target is `{ownerWorkspacePath, relPath}` plus an explicit graph
  source at app handoff; never a basename or node id, so duplicate filenames in
  different folders or workspaces resolve deterministically. The Local anchor is
  protected throughout derivation: if its canonical path is absent from the selected
  source, the focus bar reports that state and offers a direct exit instead of silently
  focusing another note. Applying a saved Local view changes source, profile, display,
  mode, and the canonical target in one settings transition; switching source clears an
  incompatible session focus.

## Managed vault writes and MCP-only deletion
- source: docs/graph.md
- type: nfr
- content: Vault write safety is opt-in per workspace via `write_policy: "managed"`.
  When enabled, `vault_guard::validate_managed_write` +
  `vault_validate_note(content, rel_path)` enforce the note schema before any write, a
  snapshot is taken before every managed write, and note deletion stays MCP-only -- the
  app never deletes vault notes directly. This is the only invariant change Phase 8
  introduces to the capability model (README "Critical invariants" #6).

## Graph performance budgets and degradation
- source: docs/graph.md
- type: nfr
- content: Insights run in `analysis.worker.ts` so the main thread stays interactive.
  Layout cache v2 stores the full position map and pinned ids, migrates v1 on read,
  merges partial updates, and uses atomic replacement; writes are skipped when settled
  positions contain non-finite values and cached seeds are sanitized on read. WebGL
  context loss gets a restore attempt, then degrades to a static SVG graph at 2k nodes
  or a searchable inspector/list for larger models; PNG/SVG export remains available
  from the fallback and observes the same visibility masks. 2026-07-11 local baseline
  at 10,000 nodes / 59,994 edges: model build 47 ms, ForceAtlas2 20 iterations 694 ms,
  visibility update 0.021 ms, insight pass 129 ms, cold adjacency build 9.7 ms
  (hardware-dependent means).

## Graph test contracts
- source: docs/graph.md
- type: nfr
- content: vitest covers `model`, `derive` (pipeline plus dense filter/search
  round-trip <100 ms), `insights`, `decisionChains`, `positions`, `search`, and
  `settings` (graph settings round-trip + V1->V2 migration); bench
  `src/lib/graph/perf.bench.ts`. cargo covers `vault_graph` (overlay read +
  layout-cache round-trip). e2e `e2e/graph.spec.ts` drives the REAL Sigma renderer
  (chromium + SwiftShader) through the dev-only `window.__maruGraph` bridge; the old
  fake DOM overlay is gone. `e2e/graph-shell.spec.ts` pins shell geometry across
  viewports and terminal dock/resize/maximize states. Scope note: the enrichment path
  (`vault_graph_read`) is Tauri-only, so browser-mode e2e verifies the degraded
  live-layer path plus a mock-overlay opt-in.

---

## kg_document_refs mapping contract
- source: docs/kg-references.md
- type: api-contract
- content: `kg_document_refs(workPath, docPath) -> DocumentRefMap` reports two match
  kinds. **wikilink** -- every `[[target]]` in body and frontmatter, resolved by
  mirroring the frontend resolver (exact title -> filename-no-ext -> exact relPath ->
  relPath-no-ext -> slash-suffix fallback); unresolved targets are skipped.
  **entity** -- occurrences of other notes' titles plus frontmatter `aliases` as
  whole-phrase matches in the BODY only, case-insensitive; pure-ASCII phrases
  additionally require non-word neighbors, Korean phrases use plain substring; titles
  shorter than 2 chars never entity-match. Caps: 20 spans/note, 200 spans total. Each
  ref carries `nodePath` (matches `GraphNode.relPath`), `nodeTitle`, `matchKind`, and
  `spans`.

## KG ref on-demand constraint and cache validity
- source: docs/kg-references.md
- type: nfr
- content: The mapping is one regex scan of the document per vault title, so it runs on
  demand only, through explicit user actions; nothing computes it during scan, watch,
  or open. Results cache at `<work>/.maru/kg-cache/<sha256(docRelPath)>.json`. A cached
  entry is valid iff the document content hash matches AND the vault stamp matches --
  a sha256 over the identity of every note in the vault scan cache (rel path, title,
  aliases), deliberately excluding bodies, fingerprints, and timestamps, with entries
  sorted before hashing. `kg_document_refs` is `#[tauri::command(async)]` so a cache
  miss cannot block the UI thread. Known gap: a vault edit no `scan_vault` call has
  picked up yet leaves the stamp unchanged and serves the stale entry.

## KG byte-offset semantics
- source: docs/kg-references.md
- type: protocol
- content: Backend spans are UTF-8 byte offsets into the raw document content, not JS
  char offsets; `paragraph` is the 0-based index of the blank-line-separated block
  containing the span start, counted over the whole raw document, with the frontmatter
  block as paragraph 0. `src/lib/kgRefs.ts` owns conversion: `buildByteToCharTable`
  (byte offset -> UTF-16 code-unit index in one pass; multibyte interior bytes map to
  their lead character), `refMapToCharSpans` (flattens to one sorted non-overlapping
  span list; overlaps resolve wikilink over entity, then longer span, then earlier
  start), `mapSpansToRenderedText` (re-locates source spans in rendered preview text
  from a moving cursor; dropped spans are skipped and one miss never desyncs the rest).
  Never slice the document with backend offsets directly in JS.

## Graph reference-focus rendering constraints
- source: docs/kg-references.md
- type: protocol
- content: `visualizeDocRefs` opens the doc/graph split with
  `referenceFocus: { source, docPath, docRoot, nodePaths, steps, nonce }`. The focus is
  source-owned: editor focus clears when the active editor document changes, while
  Drafts and Gap overlay their selected unconfirmed item without being cleared;
  in-flight editor focus requests are monotonic so a late response cannot replace a
  newer overlay. Drafts and Gap resolve `originRefs`, `promotedTo`, and body wikilinks
  against the primary workspace entries in the frontend and never add scratchpad or
  draft files as graph nodes. `docRoot` is load-bearing: `resolveReferenceNodeIds`
  rebases both sides to absolute before matching, because graph nodes are rooted at the
  graph's own data path. The converge animation has two hard constraints: the per-frame
  repaint must be `refresh({ partialGraph, skipIndexation: true })` (a bare `refresh()`
  re-reads x/y from graphology and discards the reducer's animated coordinates), and
  `partialGraph` must include the animated nodes' incident edges (edge geometry is
  baked from the node cache at upload time). `prefers-reduced-motion` jumps to the rest
  state. The animation consumes its trigger nonce only on completion.

---

## AI adapter suggestion-only contract
- source: docs/phase2-ai-boundary.md
- type: api-contract
- content: Status: Stage 6 entry contract. Phase 2 starts with a read-only inbox slice:
  scan `<vault>/inbox/downloads/**`, show placeholder classification, allow user
  accept/reject decisions, and do not write, move, rename, stage, commit, or delete
  files from AI output. `src/lib/aiAdapters.ts` declares `claude-code` (local
  subprocess, streaming capable) and `anthropic` (API fallback, streaming capable);
  both expose `canWriteFiles: false`. Any future apply step must route through the
  existing writer boundary and user confirmation.

## AI credential and log redaction rules
- source: docs/phase2-ai-boundary.md
- type: nfr
- content: Claude Code CLI uses the user's existing CLI session; the Anthropic API
  fallback must read credentials from a dedicated secret store before implementation.
  Credentials must never be written to vault files, logs, localStorage, or test
  fixtures. Logs may include adapter kind, failure taxonomy, document relative paths,
  and the redacted vault path from `redactVaultPath`. Logs must not include the full
  vault path, full document body, API keys, raw email contents, or unredacted
  subprocess prompts.

## AI failure taxonomy
- source: docs/phase2-ai-boundary.md
- type: schema
- content: `classifyAiFailure` maps adapter failures to `credential_missing`,
  `cli_missing`, `network`, `model`, `permission`, `unknown`. Only `network` and
  selected `model` failures are retryable by default.

## External writer rule
- source: docs/phase2-ai-boundary.md
- type: protocol
- content: If a registered vault has `externalWriter` / `external_writer`, Maru blocks
  direct writes: save, create document, snapshot, frontmatter patch, git commit, and
  future AI apply. Rust command handlers enforce the same rule so UI bypasses cannot
  write directly.

---

## Studio 7-step wizard contract
- source: docs/studio.md
- type: protocol
- content: Source -> Template (reuses `src/lib/hubLibrary.ts`) -> Guideline
  (multi-select) -> Sections (Rich or Source mode, debounced 350 ms gaejosik lint;
  violations underline via CodeMirror decorations or a BlockNote `gaejosikLint` mark;
  dismissals persist under workspace-state `composer.lintDismissals` with a
  per-document Studio fallback) -> HWP fields (`template_get_fields` calls
  `hwpx slots <template> --format json` and merges with `kordoc_lite` HWPX
  label/inline-label detection, each field carrying source + confidence;
  `template_fill_hwpx` writes to `.maru/studio/filled/`, preserves form-label fills,
  and validates with `hwpx validate` plus structure checks) -> Export (wraps
  `export_plan` + the M4 dispatch pipeline) -> Package (`studio_apply_body` replaces
  only the markdown body and preserves the frontmatter bytes exactly).

## Studio state persistence
- source: docs/studio.md
- type: schema
- content: Per-document Studio state persists at
  `<workspace>/.maru/studio/<doc-id>/state.json` via `src-tauri/src/studio/mod.rs`
  (`studio_state_list`, `studio_state_read`, `studio_state_save`,
  `studio_state_delete`, `studio_apply_body`). This directory is disposable runtime
  data (gitignored); canonical content stays in the source markdown.

## Export pipeline manifest SSOT
- source: docs/studio.md
- type: protocol
- content: `export/manifest.rs` writes `manifest.yaml` next to a
  `<source-stem>.exports/` bundle; the manifest is the SSOT for export state and the
  only place output sha256s live. `export/validate.rs` runs format-specific structure
  checks (docx / hwpx / pdf) plus `kordoc_lite` HWPX/form checks.
  `export/dispatch.rs` drives `pending -> ready/failed` with deterministic local
  converters (`pandoc`, `hwpx`, LibreOffice-backed PDF fallback); missing converters,
  missing outputs, and source-hash drift surface as partial failures rather than silent
  success.

## Frontmatter byte-identity and provenance invariants
- source: docs/studio.md
- type: nfr
- content: Every field mutation goes through `src-tauri/src/frontmatter/ops.rs`;
  unrelated fields, comments, ordering, and quoting are preserved. `create_document`
  emits `maru:template` / `maru:business_unit` / `maru:guidelines` as proper
  frontmatter (the W5 HTML-comment trailer is deprecated).

---

## Graph canvas theme-token sourcing
- source: docs/superpowers/specs/2026-07-12-graph-ui-obsidian-design.md
- type: protocol
- content: Status: approved (design), pending implementation plan. Extend
  `graphStyle.ts` with a theme reader sampling the CSS custom properties (`--bg`,
  `--ink`, `--muted`, `--line`, `--accent`, warn color) via
  `getComputedStyle(document.documentElement)`, exposed as a `GraphThemeColors` object.
  All hardcoded hex in `GraphCanvas.tsx` (label color, node `borderColor`, hover-dim
  colors, edge default/dim colors, ghost fill, SVG/PNG export background) switches to
  it. On theme change (MutationObserver on `data-theme` plus a `prefers-color-scheme`
  media listener) re-read tokens and push via `renderer.setSetting()` /
  `scheduleRefresh()`; no renderer rebuild.

## Zoom-linked label fade contract
- source: docs/superpowers/specs/2026-07-12-graph-ui-obsidian-design.md
- type: protocol
- content: Custom `defaultDrawNodeLabel` replacement (canvas 2D). Alpha ramps with the
  node's rendered on-screen size: 0 below ~6 px, 1 above ~12 px, linear between. Hub
  nodes (`forceLabel`/god nodes), the selected node, and the hovered node always render
  at full alpha (hovered via the hover-label drawer, slightly larger: 12px/600). Type:
  Pretendard 11px/500, fill `--ink` at ~80%, with a bg-colored halo. Retune
  `labelRenderedSizeThreshold` down and keep `labelDensity` as the collision limiter.
  Nodes: keep `MaruNodeBorderProgram` with border color = theme `--bg`; hover grows the
  hovered node ~1.15x in the nodeReducer. Edges (values-only): default thinner and
  lower contrast derived from `--line` mixed toward bg, dimmed near-invisible,
  highlighted on the accent token. Out of scope: curved edges, physics/layout changes,
  panel restructuring, animations beyond the hover grow, node icons/shapes.

## Community hull removal mandate
- source: docs/superpowers/specs/2026-07-12-graph-ui-obsidian-design.md
- type: protocol
- content: Decision (user-confirmed): remove hulls entirely; represent communities by
  node color only (Obsidian-style color groups); the legend stays as the key. Delete
  outright: `GraphView.tsx` `hulls` useMemo, hull-only `settled`/`settledNodesRef`
  usage, `showHulls` state and prop plumbing; `GraphCanvas.tsx` `hullCanvas` layer,
  `drawHulls`, `hulls` prop, and hull markup in the e2e debug overlay;
  `GraphFilterPanel.tsx` hull toggle (`graph-hulls-toggle`); `graph.css` `.graph-hull*`
  rules; `e2e/graph.spec.ts` hull assertions replaced with a color-group assertion.
  Replace the single Tableau10-ish palette with two 12-color palettes keyed by theme.
  (Verified landed: no `src/lib/graph/hull.ts` and zero `hull` references in `src/` as
  of 2026-08-22.)

## Graph panel typography scale
- source: docs/superpowers/specs/2026-07-12-graph-ui-obsidian-design.md
- type: protocol
- content: `graph.css` only, no structural or markup changes beyond class tweaks. One
  type scale across filter panel, insights panel, inspector, toolbar, and legend
  (panel titles, body, chip labels, counts). Counts and metrics use
  `font-variant-numeric: tabular-nums`. 8px spacing grid, hairline `--line` borders,
  and drop redundant boxes/fills.

## GraphTheme interface contract
- source: docs/superpowers/plans/2026-07-12-graph-ui-obsidian.md
- type: api-contract
- content: `interface GraphTheme { bg; ink; muted; line; accent; warn; labelColor;
  edge; edgeStrong; edgeDim; nodeBorder; ghostFill; dimNode; dark;
  communityColors: string[]; domainColors: Record<string,string>; fallback: string }`
  (strings are hex/rgba; `dark` is boolean). `refreshGraphTheme(): GraphTheme` re-reads
  tokens; `graphTheme(): GraphTheme` returns the cache. `nodeColor(node, enriched)`,
  `communityColor(community)`, and `domainColor(domain)` keep their exact current
  signatures but read the active theme palette. `GraphCanvas.tsx` rebuilds on theme
  change via a `themeEpoch` state; positions are preserved by the existing
  `positionsValid` path, so no relayout. Labels move to a custom
  `defaultDrawNodeLabel`/`defaultDrawNodeHover` pair in a new `graphLabels.ts`.
  Pinned stack: sigma 3.0.3, graphology 0.26.

## Palette slot-order constraint
- source: docs/superpowers/plans/2026-07-12-graph-ui-obsidian.md
- type: nfr
- content: The 12-color palettes are dataviz-validated (light: min adjacent deutan
  delta-E 13.3 on `#f4f3ee`; dark: 14.8 on `#181a18`). Do not reorder or swap entries;
  slot order is the CVD-safety mechanism. Slot order is identical in both palettes so a
  community keeps its hue across themes. Contrast relief for low-contrast light slots
  comes from node labels, the legend, and the bg-colored node border.
  `settled`/`settledNodesRef` in `GraphView.tsx` stay (the layout-cache save effect
  uses them); only their hull usage goes. Existing tests must stay green after every
  task.
