# Agents

An **agent** is a named preset for one AI dispatch: a skill binding, a backend
runtime, a permission mode and a prompt. It is not a schedule (timing lives in
`<work>/.maru/schedules.json`) and it is not a skill (a skill has no backend).

Backend: `src-tauri/src/agents.rs` (registry + seeds),
`src-tauri/src/scheduler.rs` (timed dispatch).
Frontend: `src/lib/agents.ts` (types, `runAgent`, resolution),
`src/components/agents/` (`AgentsPane`, `AgentEditor`).

## Model

```
AgentRecord (~/.maru/agents.json + Rust seeds)  ← identity, skill, backend, prompt
      ↑ agentId                     ↑ agentId
SchedulerSchedule (<work>/.maru/schedules.json) ← timing only
      ↓ dispatch metadata.agentId
MissionRecord                                   ← live status, stop, log tail
```

`metadata.agentId` is the single join key: it is what the pane groups runs by,
and what a schedule uses to pick up its agent's current configuration.

| Field | Meaning |
|---|---|
| `id` | `^[a-z0-9][a-z0-9-]{0,47}$`. Builtin ids are reserved. |
| `labelKey` / `label` | i18n key for builtins; a literal name for user agents. |
| `skillName` | Skill **name**, not registry id — ids are `<sourceId>::<name>` and machine-local. Resolved at run time by `findSkill` (TS) and `store::resolve_skill_id` (Rust). |
| `runtime` | `inherit` \| `claude` \| `codex` \| `kimi` \| `kiro`. `inherit` resolves to `ai.defaultRuntime`. |
| `permissionMode` | `inherit` \| `plan` \| `acceptEdits` \| `default` \| `bypassPermissions`. |
| `prompt` | Literal text. Empty on a feature-bound builtin, whose owning surface builds one per run. |
| `kind` | `background` = tracked, stoppable mission. `inline` = request/response. |
| `enabled` | `false` stops the agent's feature, not just its row: `runAgent` refuses a disabled agent, the inline callers check `inlineAgentRuntime().enabled`, and the ticker skips any schedule naming it. |
| `recommendedSchedule` | Derived from the seed; pre-fills the 일정 추가 form. Never creates a schedule by itself. |

## Storage

Agents are **global** (`~/.maru/agents.json`) because `maru_dir`'s
`GLOBAL_SETTINGS_PATHS` already treats the whole `["ai"]` settings block as
user-global, and a user has one "회의록 정리" agent rather than one per
workspace. Schedules stay per-workspace, where they already were.

Builtins are a `const` array in `agents.rs`, never a file, so an app upgrade has
nothing to clobber. The user layer stores a **sparse patch** per builtin:

```json
{ "version": 1,
  "agents":    [ /* user-created, full records */ ],
  "overrides": { "inbox-triage": { "runtime": "codex" } } }
```

On load, every field the user did not touch picks up the new seed value and
every field they did touch survives. Reset drops the patch. Only `runtime`,
`permissionMode`, `prompt` and `enabled` are overridable: a builtin's
`skillName` is fixed because its call site depends on that skill's output
contract.

A malformed override degrades to the seed **for that agent alone**. Propagating
the error would leave `agents_list` empty, which makes every feature-bound
builtin fail with `agent_not_found` and hides the very pane the user would
reset it from.

Builtins cannot be deleted (`agent_builtin_not_deletable`); `enabled: false` is
the delete.

## The runner

`runAgent(agent, ctx)` (`src/lib/agents.ts`) is the one path every AI feature
takes. It resolves the skill by name, resolves the runtime (falling back across
the other CLIs when the preferred one is missing), looks up the command
override, probes availability, and dispatches through
`skills_dispatch_background`.

Two rules it must keep:

- **`metadata.origin` is never overwritten.** `isInboxProcessMission`,
  `isCompletedSchedulerSkillMission` and the per-pane run panels branch on it,
  so a converted call site keeps emitting exactly the origin it emitted before.
  `origin` defaults to the agent id only when the caller supplies none.
- **`agentId` is always stamped.** Runs recorded before agents existed map back
  through their origin namespace by prefix (`meetingNotes*` → `meeting-notes`),
  so followup runs group under their parent agent too.

## Registered agents

| id | Skill | Kind | Ships |
|---|---|---|---|
| `inbox-triage` | `inbox-process` | background | enabled, feature-bound |
| `inbox-classify` | — | inline | enabled |
| `meeting-notes` | `meeting-notes` | background | enabled, feature-bound |
| `task-extract` | `task-management` | background | enabled, feature-bound |
| `ideation-draft` | `ideation-drafts` | background | enabled, feature-bound |
| `commit-message` | — | inline | enabled |
| `vault-hygiene` | `vault-lint` | background | enabled, 일 22:00 recommended |
| `vault-proposal` | `vault-sync` | background | enabled, 금 18:00 recommended |
| `daily-digest` | `draft-writer` | background | **disabled** — produces and sends |
| `git-sync` | `git-sync` | background | **disabled** — pushes to a remote |

Read-only and proposal-only agents ship enabled; anything that pushes to a
remote or sends a message ships disabled. `enabled` only makes an agent visible
and runnable — **nothing fires on a timer until the user attaches a schedule**,
which goes through the `scheduler.add` approval. Seeds never create schedules;
shipping a JSON file must not bypass that gate.

## Feature-bound vs standalone

A background agent with an empty prompt is **feature-bound**: the surface that
owns it (Inbox, Meetings, Tasks, Drafts) builds a prompt per run from what the
user selected. "지금 실행" is disabled for it, because dispatching an empty
prompt would just fail. Attaching a schedule supplies a prompt, which re-enables
it.

Inline agents (`inbox-classify`, `commit-message`) expose only the backend
selector. They return a typed value under a timeout rather than emitting a
mission, so run/stop/schedule are disabled honestly instead of returning
`mission_not_running`.

## Schedules

A schedule may name an `agentId`. At dispatch, an enabled and standalone
agent's current skill/runtime/permission mode/prompt win, so editing the agent
updates every schedule that uses it.

Switching an agent **off stops its schedules outright** (`agent_disabled`,
skipped before the ticker's day claim so it stays silent rather than erroring
once a minute). Only a **missing or feature-bound** agent falls back to the
schedule's own stored snapshot — that fallback exists so deleting an agent
never breaks a live schedule, and it must not double as a way for a disabled
agent to keep running: the snapshot is byte-identical to what the agent used to
run, so "off" would mean nothing on the one path nobody is watching.

**Unattended runs default to permission mode `plan`** regardless of
`ai.permissionMode`. The global setting is for runs the user is sitting in
front of; silently promoting a 07:00 timer to `bypassPermissions` is the
"agent-autonomous edits as default behavior" the README rules out. An agent
that needs more sets its own `permissionMode` explicitly.

`agentId` is serde-default and omitted when absent, so a pre-agent
`schedules.json` parses and round-trips unchanged. Such a schedule is adopted
into its agent's row by the skill it dispatches (display-only inference), and
its runs group there via `metadata.scheduleId` since they carry no `agentId`.

A schedule matching no agent still appears, under 연결되지 않은 일정, with
run / pause / remove — the pane is the only `listSchedules` consumer, so
anything it fails to render would keep firing invisibly.

## Naming

Settings › **AI 런타임 / AI Runtimes** is about CLI runtime *accounts* — auth,
login, usage quota, binary path override. The **에이전트 / Agents** mode is
about the user's named agents. The settings tab id stays `agents`; only its
label moved.
