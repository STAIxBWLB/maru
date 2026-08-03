# Agents

An **agent** is a named preset for one AI dispatch: a skill binding, a backend
runtime, a permission mode and a prompt. It is not a schedule (timing lives in
`<work>/.maru/schedules.json`) and it is not a skill (a skill has no backend).

Backend: `src-tauri/src/agents.rs` (registry + seeds),
`src-tauri/src/scheduler.rs` (timed dispatch).
Frontend: `src/lib/agents.ts` (types, `runAgent`, resolution),
`src/lib/agentChat.ts` (conversation),
`src/components/agents/` (`AgentsPane`, `AgentChatTab`, `AgentEditor`).

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

## Chat

The 대화 tab talks to the selected agent's backend without a PTY. It exists as
a tab rather than an app mode because the configuration a conversation needs is
already the `AgentRecord`'s: runtime, permission mode, prompt and command
override all resolve through the same helpers `runAgent` uses, so nothing is
picked per message and chat stores no settings of its own.

It dispatches through `start_agent_cli_invocation`, not
`skills_dispatch_background`: the latter requires a skill id and prepends the
whole `SKILL.md`, which is right for a job and wrong for a conversation. No
Rust command was added.

**Multi-turn is transcript replay.** Each turn re-sends the capped conversation
as one prompt, because native resume is unavailable across the board today:
`build_cli_command` ends the codex argv with `-`, so anything appended lands
after the stdin sentinel; kiro has no resume flag; and no provider prints its
session id in headless mode without `--output-format json` parsing. The ceiling
(prompt grows O(turns²); every turn is a cold subprocess) and the upgrade path
are recorded beside `buildChatPrompt`.

`CHAT_PROMPT_MAX_CHARS` (24k) is sized for **argv**, not for a context window;
claude, kimi and kiro pass the whole prompt as a single argument. Oldest turns
drop first; the newest user message is never truncated, so an over-long
question fails loudly instead of being silently mangled and answered anyway.

Scrollback is `localStorage`, keyed by workspace and agent and capped at
`CHAT_HISTORY_CAP`. It is UI state: anything worth keeping leaves through the
turn actions: 할 일로 만들기 (`create_task_note`), 메모로 저장
(`save_scratchpad_document`), and 제안 적용, which reuses `SkillRunsPanel`'s
approval gate. All three write **new** files. There is deliberately no "insert
into the active document": `save_document` is revision-checked, frontmatter
byte-identity is a hard rule, and a chat turn carries no revision handle.

## Backend capabilities

`CliProviderKind::capabilities()` (`src-tauri/src/agent_host/provider.rs`) is
the single declaration of what each CLI can do. `src/lib/agentCapabilities.ts`
mirrors it (a mirror because the readers are synchronous argv builders, and
because ComposeDialog runs in the browser dev shell where there is no Tauri),
and `agentCapabilities.test.ts` parses the Rust file so drift fails the build.

| | claude | codex | kimi | kiro |
|---|---|---|---|---|
| `resume` | ✅ `--resume` | ✅ `resume` | ✅ `--session` | ❌ |
| `usage` | ✅ OAuth API | ✅ rollout JSONL | ❌ | ❌ |
| `add_dirs` | ✅ | ✅ | ✅ | ❌ |

Only flags a gate reads live here. Attach-mention is **not** a capability: the
predicate is "is an agent launcher, not a shell", and `shell` is not a
provider; `isAgentKind` covers it instead.

Two things that look like capabilities but stay per-backend `match`es on
purpose. Auth probing genuinely differs per CLI (`claude auth status` JSON,
`codex login status`, kimi's credentials file, `kiro-cli whoami` + an `Email:`
line). And `usage_status` reports `unsupported` from its own match rather than
from the flag, so `make verify-integration` can assert the two agree instead of
asserting a tautology.

## Verifying the backends

Every provider unit test drives a fake shell script, so `make verify` proves
argv shape but nothing about the real integration. `make verify-integration`
smokes the installed CLIs: `--version`, auth classification, agreement between
the skills gate and the account probe, usage-vs-capability, and permission
argv. Uninstalled backends are skipped, not failed.
`MARU_CLI_SMOKE_ROUNDTRIP=1` adds one live prompt per authenticated backend.

It stays out of `make verify` because that gate must be hermetic: a merge that
fails on an expired OAuth token is a gate people learn to bypass.

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
