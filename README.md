# Maru

Maru is a local-first desktop workspace for Korean knowledge and document
operations. It combines a React 19 and TypeScript interface with a Tauri 2 Rust
core, and treats the filesystem as the source of truth.

The current product release is **v1.1.26, Clear Frames**. Releases
before v0.3.0 shipped under the name Anchor; v0.3.0 completed the application
identifier and on-disk migration to Maru.

## Current Status

| Area | State | Evidence |
|------|-------|----------|
| Product release | v1.1.26 | Signed desktop bundles and standalone CLI for macOS, Windows, and Linux |
| Planning milestone | v1.1 Felt Quality and Native Proof, closed | Closed 2026-09-27: phases 6-11 (56 plans), audit `tech_debt` with the debt accepted |
| Application shell | Complete | 19 lazy modes; `MainApp` held to 15 `useState` and 24 `useEffect` calls |
| Verification | Passing | Typecheck, ESLint, unit tests, Rust fmt/clippy, E2E, build, and bundle budgets |
| Typed IPC | ERR-06 closed | Every conflict-emitting command preserves `{ code, message }`; recursive source guard active |
| Main-thread isolation | PERF-01/02 closed | Phase 08 baseline classified 388 production commands: 379 isolated off the UI thread, 9 kept on it for main-thread affinity; Phase 08 baseline native load proof keeps loaded p95 at 2ms with the negative control at 4789ms |
| Active milestone | None, v1.2 being defined | v1.1 closed 2026-09-27; opening v1.2 moves releases to 1.2.0 |

The milestone archive, audit, retrospective, and summary live under
`.planning/milestones/`, `.planning/RETROSPECTIVE.md`, and
`.planning/reports/`.

## Core Principles

- **Filesystem authoritative:** notes, tasks, drafts, evidence, and diagrams
  remain usable without Maru. Caches are disposable.
- **Local-first writes:** ordinary editing happens inside user-owned workspace
  folders. Cloud or Hub writes require an explicit supported path and approval.
- **Byte-stable documents:** a frontmatter field edit preserves unrelated keys,
  comments, order, quoting, and document body bytes.
- **Fail-closed mutation:** revision checks, workspace ownership, write policy,
  path containment, and managed-write validation run again in Rust.
- **Inspectable automation:** AI work is suggestion-first. Protected writes use
  approval staging and durable audit events.
- **Korean document fidelity:** HWPX, DOCX, PDF, Korean filenames, Korean IME,
  and public-document writing workflows are first-class concerns.

Rule SSOTs for the working environment live at:

```text
~/workspace/work/_meta/rules/
  frontmatter-schema.md
  document-lifecycle.md
  hub-contract.md
  evidence-policy.md
```

## Work Surfaces

Settings opens as an overlay and is not counted as an app mode. Diagram and
Graph are enabled by default; E2E Flow is flag-gated.

| Mode | Korean label | Purpose |
|------|--------------|---------|
| `dashboard` | 대시보드 | Today, tasks, schedule, inbox, agents, drafts, git, recent documents, and sync status |
| `pkm` | 문서 | Markdown and HTML document tree, multi-tab editor, outline, references, and utility rail |
| `scratchpad` | 스크래치패드 | Durable memos and disposable result files with Rich, Source, and Preview editing |
| `files` | 파일 | Finder-style folders, direct children, previews, editing, and safe file operations |
| `inbox` | 인박스 | Drop, pending, processed, provider, classification, approval, and processing flows |
| `comms` | 메시지 | Telegram, Outlook/Microsoft 365, and provider readiness configuration |
| `meetings` | 회의록 | Plaud and external meeting-note review, transcript references, meeting review, and follow-through |
| `today` | 오늘 | Prepare, execute, review, capacity, calendar selection, and explicit sync |
| `tasks` | 태스크 | File-backed task list, calendar, detail editing, status changes, and AI runs |
| `drafts` | 아이디어 | Idea lifecycle, implementation drafts, promotion, and recurring automation |
| `gap` | 갭 분석 | Compare promoted drafts with frozen baselines and record human revision patterns |
| `agents` | 에이전트 | Runtime status, chat, runs, permissions, schedules, and user-created agents |
| `catalog` | 카탈로그 | Operations catalog for deadlines, approvals, evidence, and inbox signals |
| `studio` | 스튜디오 | Seven-step document authoring, template, guideline, HWP field, export, and package flow |
| `diagram` | 다이어그램 | Concept maps, report patterns, templates, history, and managed report assets |
| `architecture` | 설계도 | Read-only gallery of archify blueprints (`*-rendered.html`) from the working trees of dev/ and sites/ submodules |
| `graph` | 그래프 | WebGL vault/workspace graph, neighborhoods, saved views, and reviewed relationship writes |
| `sites` | 사이트 | Site switcher and embedded native browser surface |
| `e2e` | E2E 플로우 | Hidden end-to-end flow console for development and verification |

## Install

The desktop application and standalone CLI are separate artifacts.

```bash
# Desktop application only
brew install --cask staixbwlb/cask/maru-workspace

# Standalone CLI only; installs the executable as `maru`
brew install staixbwlb/cask/maru-cli

maru --version
```

Homebrew 6 refuses short names from an untrusted tap; installing by the full
name trusts that item. The cask installs `Maru.app` and does not create a CLI symlink. The desktop app
uses signed Tauri updater metadata from GitHub Releases. Homebrew installations
can also be upgraded explicitly:

```bash
brew upgrade --cask maru-workspace
brew upgrade maru-cli
```

## Architecture

```text
+---------------------------------------------------------------+
| Tauri WebView: React 19 + TypeScript                          |
|                                                               |
| 19 typed lazy mode adapters                                   |
| BlockNote / CodeMirror / DOMPurify / Radix UI                 |
| Sigma WebGL / Graphology / diagram canvas / terminal canvas   |
+-------------------------------+-------------------------------+
                                | Tauri IPC
+-------------------------------v-------------------------------+
| Rust core                                                     |
|                                                               |
| workspace scan + cache       document + frontmatter           |
| inbox + provider bridges     today + tasks + scheduler        |
| terminal PTY + screen model  graph + diagram + Studio         |
| skill host + agent host      Hub client + export pipeline     |
| write policy + approval      atomic files + revision guards   |
| worker-isolated commands     path-transaction admission       |
+---------------+-------------------------------+---------------+
                | stdio                         | fixed argv
+---------------v--------------+  +-------------v---------------+
| Local MCP sidecar (Node)     |  | External CLIs and skills    |
| Read-first workspace tools   |  | Claude/Codex/Kimi/Kiro/hwp  |
+------------------------------+  +-----------------------------+
```

### Module Boundaries

- Rust owns workspace filesystem access, cache, git operations, frontmatter,
  provider bridges, terminal sessions, skill ownership, agent execution,
  catalog, Studio, export, Diagram, Graph storage, and write enforcement.
- `src/lib/` owns frontend domain logic and module stores.
- React components own rendering, editors, user interaction, graph layout, and
  diagram canvas behavior. They do not bypass Rust write guards.
- `src/lib/` does not import components, except for documented type-only legacy
  boundaries. Nothing imports `src/App.tsx`.
- Shared UI state follows keyed module-store plus `useSyncExternalStore`
  patterns. No additional global state library or provider tree is used.
- Production commands never block the UI/shared async worker thread:
  ISOLATED commands run on awaited `spawn_blocking` workers and
  native-window commands stay UI-bound, and every filesystem mutation passes
  shared path-transaction admission before taking domain locks. The
  389-command inventory, worker-boundary, and admission evidence are gated by
  `check-command-isolation` in `make verify`.

## Capability Highlights

### Documents and Files

- Markdown uses Rich, Source, and sanitized Preview modes.
- HTML uses Visual, Source, and sandboxed Preview modes. Scripts, event
  handlers, forms, frames, meta refresh, network resources, and paths outside
  the owning workspace are blocked in the runtime clone and never written back.
- Documents support read, save, create, version, rename, move, duplicate, and
  system-Trash operations with optimistic concurrency.
- Deleting a document opens a review of every file it would move to the system
  Trash: the source, plus, when chosen, derived files (export bundle, version
  snapshots, Studio outputs) and Maru metadata (Binder, Studio, kg-cache) that
  record a link to it. A plan that changed since review deletes nothing.
- Files presents folders, direct children, search, binary previews, shared
  document drafts, multi-selection, keyboard control, and collision-safe file
  operations.
- Rename and move use `.maru-rename-txn/` staging with recovery on the next
  scan. Operations never overwrite an existing target.

### Korean Document Operations

- Document Studio guides source selection, template and guideline choice,
  section editing, HWP fields, export, and package freeze.
- HWP fields, form fill, the inline HWPX preview, and HWPX structure checks
  run through released `hwp` 1.3.0 or newer. Native template publication
  fails closed on malformed fill reports, unmatched fields, or validation
  failure.
- The lower-level `hwped_*` engine bridge supports read, render, edit, compose,
  validate, and capabilities with `hwp` 0.8.7 or newer.
- Export manifests bind source hashes to DOCX, HWPX, and PDF outputs and record
  partial failures instead of reporting silent success.
- The gaejosik linter supports Korean public-document style during authoring.

### Evidence, Drafts, and Knowledge

- Plaud and other externally generated meeting notes enter a mandatory source
  review before meeting-note generation. The review preserves the imported
  original, supports participant and meeting-context correction, shows a
  side-by-side original-versus-corrected diff with aligned rows and shared scrolling, and records explicit version reasons and
  acknowledged uncertainties. A transcript is optional evidence, read-only by default;
  Maru does not connect to the Plaud API in this workflow.

- Evidence Binder stores schema-v2 state under
  `<workspace>/.maru/binder/<doc-id>.json`, uses full binary SHA-256 identity,
  revision-checked atomic mutations, explicit targets, local verification, and
  submission selection.
- Drafts use `$MARU_DRAFTS` plus `.maru/drafts/index.json`; promotion is
  approval-gated and freezes a baseline for Gap analysis.
- Diagram documents live at `diagrams/*.cmd.json`; report assets live under
  `attachments/diagrams/<docId>/`; pattern presets live in
  `.maru/diagram-patterns/`.
- Graph uses a multi-directed Graphology model, Sigma WebGL, an off-thread
  ForceAtlas2 worker, visibility reducers, saved views, and schema-gated writes.

### Sites and Local Agent Console

Sites loads ordinary HTTP(S) entries in native top-level child webviews, with
no remote IPC grants. Application command dispatch centrally requires both a
first-party `main` or `skill-editor` label and the current native webview URL:
`tauri://localhost` or `http://tauri.localhost`, or the configured development
server origin in debug builds only. Other callers receive the same refusal.
Caller-supplied headers are not authentication. This checks the current top-level
webview document, not requesting subframe origins. Tauri 2.12.5 requests
main-frame-only IPC initialization on macOS/WKWebView and Linux/WebKitGTK;
Windows/WebView2 applies initialization scripts to every frame
([platform notes](https://docs.rs/tauri/2.12.5/tauri/webview/struct.WebviewWindowBuilder.html#method.initialization_script)). Maru keeps
configurable HTTP(S) content outside the main webview: the Kakao relay console
opens explicitly in the system browser with its initial theme query, browser
cookies and independent window lifetime. Live theme postMessages are not used.
Plugin permissions normally use Tauri capabilities and origin checks, with
Tauri's internal channel-fetch path exempt from that gate; its pending data is
scoped to the owning webview in the upgraded framework.
JavaScript-bound application channel payloads, including terminal frames, use a
recipient-bound inline callback/index envelope. Each payload rechecks the bound
view's first-party label and native URL. Formatting or dispatch failures are
consumed with content-free diagnostics, without selecting the fallback transport.
Channel ordering and end notifications retain their framework contract. Other
framework-managed command-response paths remain separate from this channel policy.
H1/H2 URL entries and manual URL opening need no launcher. Sites refuses
Tauri-localhost subdomains and the configured app development origin in debug
builds, while ordinary localhost/loopback sites remain available.
An optional `launch: "acon ui --no-open --json"` entry starts the local console;
the older `acon ui --json` spelling maps to the same fixed argv. The editor offers
URL opening or Agent Console, without a free-form executable field. Saving or
refreshing the registry never launches or installs a tool.

Inventory and launch share the active `acon` selected from the Maru process
PATH and its fixed augmented install paths, falling back to supported aliases
when no executable is found. Dangling aliases are skipped. The selected program
must still match its supported dot-family or Bun-global package identity.
It runs that entry with Bun from `~/.bun/bin` or the fixed Homebrew/system
install paths, without a shell or workspace runtime lookup.
Canonical paths and Unix owner/write permissions are checked before execution.
Readiness is one bounded JSON line (32 KiB, 10 seconds), followed by a direct,
non-redirecting HTTP literal-loopback origin probe (2 seconds). URL/origin/owned
PID mismatches and process failures refuse navigation with a recovery step.
Launcher-resolved single-use URLs stay in browser state and are not automatically
written to Sites; bookmark and Copy URL actions also refuse launcher-derived URLs
even after their bookmark association is detached. New tabs carry that privacy
flag from creation. Open completion is tracked with the webview session so a
pane remounted after a mode switch receives the result; failed relaunches
restore the previous page using the current visibility intent.
The launched server owns its normal idle shutdown. Closing its tab does not stop
a successfully launched server; on Unix it may also outlive Maru until its idle
shutdown. Failed or cancelled startup terminates only its owned child tree, and
tab cancellation fences stale opens.
Maru does not change console plugin grants, note writers or task policy.

### Family tool inventory

Settings > Family tools lists ahub, amem, vmem and acon. Refresh reads bounded
npm latest metadata and validates the active executable against its owning
dot-family, ahub-upgrade release or Bun-global package/bin identity.
For amem/vmem, their supported read-only `manifest --json` supplies command
capabilities; tools without that contract expose package identity/version only.
Absent, installed, stale and unavailable states are distinct. An offline registry
leaves a verified tool installed with a latest-version-unknown detail; it does
not mark the executable broken. Shadowed Bun duplicates are reported separately.
External installs are labelled
and never executed or overwritten by this inventory.

Installation/update ownership remains with dotfiles or the existing installer
(`docs/BOUNDARIES.md`). `dot ai family install <id> --version <version>` and
`ahub upgrade --to <version>` lines are terminal handoffs,
not executable UI actions. Refresh and selection never install, deploy, restart
hubs/MCP sessions, change grants/frozen tasks or write notes. Rollback belongs to
[dotfiles#319](https://github.com/STAIxBWLB/dotfiles/issues/319) and the owning
installer. A verified dot-family previous-version link enables the owning
`dot ai rollback <id>` handoff. Maru provides command handoffs only and makes no rollback or
package/data/settings restoration claim. Installation failure recovery belongs
to that installer.

Only explicit acon selection can enqueue the existing fixed-argv Sites launcher.
Native integration fixtures cover selection and that handoff with a synthetic
console; compiling them is separate from executing WKWebView/Origin/CSP/session
checks. The inventory is portable Rust/TypeScript; native runtime proof and
platform-specific package/runtime availability must be verified separately on
macOS, Linux and Windows. No local native build is implied by a passing web test.

### Terminal and AI Runtimes

- The terminal uses `portable-pty` and `alacritty_terminal`, streams ordered
  generation-tagged frames, limits frames in flight, and requires a current
  generation-bearing handle for every session command.
- Terminal and Graph share a persistent bottom/right panel with independent
  themes and remembered layout.
- Claude Code, Codex, Kimi, and Kiro are first-class runtimes. Each named agent
  binds a skill, runtime, permission mode, and optional schedule.
- Adaptive runtime policy is opt-in under Settings > AI (`ai.adaptivePolicy`).
  Each invocation asks `dot ai policy resolve --json` for an eligible runtime,
  model, reasoning effort, and native automatic-review permission. Missing or
  invalid policy fails visibly; it never falls back to permission bypass.
  Claude and Codex with verified subscription authentication can execute this
  policy; DGX execution is excluded until endpoint and auth binding is verified.
  Kimi and Kiro remain available for
  existing manually configured runs. Legacy schedules and the commit-message
  API retain their selected runtime and do not inherit adaptive policy automatically. Explicit plan mode
  retains native restrictions on task-file writes; it is not a blanket guarantee
  that every remote MCP operation is read-only. The authorized memory/vault
  lookup and record exceptions receive exact no-confirmation rules, subject to
  higher-level native mode restrictions and explicit deny rules. No other remote
  write permission is added.
  Runtime decisions are reported in invocation metadata and chat diagnostics.
  Structured roles freeze the complete initial configuration and stop on drift.
  Chat permits at most two configuration changes per task, then stops on another
  change; explicit selections freeze the recorded configuration. New turns resolve
  again using capped transcript replay, not native session resume. Maru does
  not automatically replay failed actions or change providers after a rejection.
  Explicitly authorized amem and vmem lookup/record tools receive
  exact native approval rules from resolved `knowledge_approvals`: amem is the
  plain `amem` MCP server and vmem the plain `vmem` server. Their grant lists
  come from the installed release's `manifest --json` (read once per process)
  under the dotfiles rule: a published name is granted only if the frozen list
  (nine `amem_*` tools, 21 `vmem_*` tools from vmem 0.1.0) has it, or the
  manifest marks it `readOnly: true` and its name has no delete, forget, move,
  purge or remove verb. Without a manifest the frozen list applies. Unknown
  servers, tools, deletion, and move grants are rejected. claude-mem and
  obsidian (mcpvault) grants were retired: old server/tool names are rejected
  with a reason naming the replacement (amem or vmem), never silently mapped,
  and a frozen task that recorded one is refused the same way. Knowledge approval
  scope is part of the frozen task fingerprint. A runtime switch must retain
  every previously available memory/vault tool or stop before launch, even when
  switch budget remains. Vault writes remain vmem-owned; Maru managed writes still use `vault_guard`.
  Native configuration remains owned by dotfiles; Maru only constructs argv.
- Provider probes and real integrations have bounded output, timeout,
  cancellation, and stale-request handling. The real-binary integration smoke
  remains separate from hermetic `make verify`.

### Skills and Workspace Sync

- Proposal apply approvals bind the canonical workspace target, proposal payload,
  source run, file revisions, and workspace policy revision. Rust recomputes the
  binding inside the write transaction; drift needs a new approval. Bound grants
  are single-use, terminal decisions are immutable, and remembered grants match
  the complete binding. Request, decision, consume, and effect outcome records
  live under `~/.maru/approvals/<canonical-workspace-sha256>/` as application-owned
  private metadata, independently of provider document capabilities. Legacy
  registry migration completes before the approval policy pin. Restarting
  restores readable history without
  restoring authority. Failed durable consume blocks writes. An outcome audit
  failure after an effect reports uncertainty and must not cause automatic retry.

- The skill host owns five tiers: core, public, private, imported, and managed.
  One name maps to one tier; doctor, dirty, reconcile, import, and tool-sync
  operations are available through the CLI.
- Codex installs target `$CODEX_HOME/skills` when `CODEX_HOME` is set, otherwise
  `~/.codex/skills`.
- Settings > Jobs manages the external `dot` workspace sync service through its
  versioned JSON API. Maru uses fixed arguments, serializes mutations, and
  confirms destructive or secret-expanding actions.
- Workspace calendar jobs default to their local-time daily calendar fire.
  `recoveryMode: "repeat"` keeps the legacy `StartInterval` behavior;
  `recoveryMode: "missedFire"` keeps the calendar cadence and adds an interval
  guard that runs only when neither a successful run nor the install baseline
  covers the latest daily fire. The baseline is stored before launchd loads the
  jobs, and run state (including the effective Jobs > Start/Stop state) is kept
  under `.maru/jobs-state/`. Install sets the initial enabled state and Start
  or Stop changes it under a short state lock, separate from the lock held
  across a running child. Run now queues a one-shot request and returns after
  launchd kickstart; launchd retains control of stopping the child. Run now
  requires the installed service to be loaded and enabled, and bypasses daily
  fire dedup for that one request. The ledger attributes each success to the
  daily fire frozen at logical run admission, so a long run crossing
  tomorrow's fire cannot suppress tomorrow's work. Calendar and recovery
  invocations share a run lock and success ledger, so a recovered fire is not
  run again if launchd later coalesces its calendar event. This
  schedule model supports daily times; it does not express weekday or weekly
  calendars.
- Every installed job runs through the CLI wrapper, including Repeat jobs, with
  its existing schedule preserved. The wrapper durably records admission before
  spawning and records native owner/child creation identities and process exit
  separately from the success-fire ledger. Jobs shows the latest 100 receipts;
  recovery skips, deduplicated fires, and manual requests remain distinguishable.
  No verifier is configured by this feature, so verification is `notRequested`,
  including for exit 0. Interrupted runs with uncertain child ownership block
  another effect attempt; history reconciliation never replays a provider.

## Storage and Configuration

Global user state:

```text
~/.maru/
  settings.json
  workspaces.json
  skills/registry.json
  skills/_cache/
```

Workspace-local state:

```text
<workspace>/
  .maruignore
  .maru/
    cache/                  # disposable workspace index and Hub cache
    workspace-state.json   # collapsed folders and workspace UI state
    versions/               # explicit document snapshots
    studio/                 # per-document Studio state
    binder/                 # per-document Evidence Binder state
    diagrams/               # diagram history and backups
    meetings/source-reviews/ # immutable Plaud originals, state, versions, and review records
    drafts/                 # draft index and frozen promotion baselines
    queue/                   # recoverable provider/Hub work queues
```

`<workspace>/.maru/settings.json` is a legacy migration input only. New
workspaces use global settings plus `workspace-state.json`.

Scratchpad structure:

```text
<work>/scratchpad/
  ideation/{seeds,developing,proposals,_archive}/
  memos/
  drafts/
  temp/{claude,codex,kimi,kiro,runtime}/
```

Only `temp/` is disposable. Ideation, memos, and drafts are durable and may be
Git-tracked. Cleanup is explicit and moves selected files to system Trash.

Public workspace configuration is registry-only in v1.1.0. Provider metadata
is non-secret, manually entered roles map to coarse capabilities, and filesystem
writability is probed again before granting direct writes. OAuth and live cloud
role checks are not implied by this metadata.

Meeting source review accepts pasted UTF-8 text and TXT/Markdown imports up to
2 MiB per source. Imported bytes are retained as immutable originals before any
editing; unsupported or undecodable files are rejected without lossy conversion.

## Safety Contracts

- `src-tauri/src/frontmatter/ops.rs` is the only allowed frontmatter write path.
- `resolve_inside_vault` and shared containment helpers stay lexical. Deliberate
  symlinks inside a workspace remain supported.
- Managed writes pass `vault_guard::validate_managed_write`, create a snapshot,
  and use revision-checked atomic replacement. Note deletion remains MCP-only.
- Every conflict code the frontend can consume crosses as structured
  `IpcError`. New Rust modules are covered automatically by the ERR-06 guard.
- Error normalization accepts only known contract codes. Unknown or forged
  codes degrade to a plain `Error` and never satisfy recovery branches.
- Provider and subprocess commands use fixed argv rather than a shell whenever
  input can cross a trust boundary.
- The application has no default telemetry, Maru account, cloud-sync engine,
  multi-user CRDT, or autonomous-write default.
- Signed update metadata is mandatory. Unsigned or ad-hoc updater feeds are not
  accepted.

## Development

Requirements:

- Node.js 22 or newer
- pnpm 9.15 or newer
- Rust MSRV 1.90.0; `rust-toolchain.toml` pins the repository verification
  toolchain
- Platform libraries required by Tauri 2

Common commands:

```bash
pnpm install

# Browser development with mocked Tauri IPC
pnpm dev

# Native development
pnpm tauri:dev

# Focused frontend gates
pnpm typecheck
pnpm lint
pnpm lint:i18n
pnpm test
pnpm test:e2e
pnpm build

# Rust gates
make test-rust
make fmt-check
make clippy

# Complete hermetic verification
make verify

# Phase 08 evidence closure gate alone (389 production commands, PERF-01/PERF-02)
node scripts/check-command-isolation.mjs --all --expected-count 389

# Full verify plus release-only CLI and debug Tauri checks
make release-checks

# Complete local release gate
make release-preflight

# Real installed runtime smoke; not hermetic
make verify-integration
MARU_CLI_SMOKE_ROUNDTRIP=1 make verify-integration

# TypeScript + Rust coverage report; non-gating, not part of verify, needs
# cargo-llvm-cov and llvm-tools installed locally
make coverage

# Local MCP sidecar smoke
MARU_MCP_WORKSPACE="$PWD" node sidecars/maru-mcp/index.mjs
```

Skill registry checks:

```bash
cargo run --manifest-path src-tauri/Cargo.toml -p maru-cli --bin maru-cli -- --version
cargo run --manifest-path src-tauri/Cargo.toml -p maru-cli --bin maru-cli -- doctor --json
cargo run --manifest-path src-tauri/Cargo.toml -p maru-cli --bin maru-cli -- skills dirty --json
cargo run --manifest-path src-tauri/Cargo.toml -p maru-cli --bin maru-cli -- skills sync --check --tools claude,codex --json
```

### Selected-agent skill federation

For operator-selected peer filesystem transport, read the separate
[dotfiles boundary](https://github.com/STAIxBWLB/dotfiles/blob/main/docs/BOUNDARIES.md)
when configuring peer home paths. That transport preserves filesystem entries
under the explicitly selected paths while source, installer, registry and
per-target ownership remain with their existing managers. The capability and
deferral rules in this section govern skill installation and federation.

Maru owns generic skill sources, registry records, and deployment. External
orchestrators such as dotfiles query the native CLI before requesting a selected
operation (Maru issue #396, dotfiles issue #150):

```bash
maru skills capabilities --json
maru skills list --json
maru skills sync --check --tools claude,kimi --skills meeting-notes --json
maru skills sync --apply --tools claude,kimi --skills meeting-notes --json
```

The capability response has `schemaVersion: 1`, `targets` containing `claude`,
`codex`, `kimi`, `qwen`, `grok`, and `opencode`, and `selectedSync: true`, `list: true`.
`list` returns flat `SkillRecord` fields plus `installable: boolean` and an optional
`reason` for unavailable entries. The picker must offer only installable entries.
Eligibility uses the same target-independent checks as selected sync: Maru-owned
source, valid metadata, and existing source/skill paths. Target conflicts and
profile divergence remain sync-preview checks. These list-only fields are never
stored in the registry. Listing proceeds without refreshing sources, persisting migrations
or writing the registry, or materializing bundled skills. Missing capability
support requires the orchestrator to defer; it must not copy files itself.

`--skills` accepts comma-separated unique names or exact IDs. Empty selectors,
ambiguous names, catalog duplicate-name conflicts (including selection by ID),
missing sources, native-plugin skills, and external inventory
skills are rejected. Explicit selections reconcile only those skills and targets,
preserving unrelated installs. Omitting `--skills` retains the existing whole
Maru-owned catalog sync behavior. Neither command updates upstream sources.
Conflicting directories or foreign links are preserved and reported as errors.
The sync JSON report adds `profiles` (the resolved destination root per
requested target, so the orchestrator can scope subprocesses to the same
profile environment) and a `source` on every planned action (what the link
points at) alongside the destination `path`. `--check` writes nothing.

Default skill roots are `~/.claude/skills`, `$CODEX_HOME/skills` (default
`~/.codex/skills`), `$KIMI_CODE_HOME/skills` (default `~/.kimi-code/skills`),
`~/.qwen/skills`, `~/.grok/skills`, and `$OPENCODE_CONFIG_DIR/skills` (default
`$XDG_CONFIG_HOME/opencode/skills`, then `~/.config/opencode/skills`). Overrides
must be absolute paths. Recorded install roots remain sticky; apply and selected
sync fail when the runtime home changes unless `--retarget` is explicitly supplied.
A selected retarget can leave unrelated installs pinned to an earlier root.
Sync rejects targets spanning multiple effective roots until an explicit
unfiltered `--retarget` reconciles them. Read-only whole-catalog previews of a
single sticky root report that root, including when the runtime home differs.
Orchestrators must never add that flag automatically. A destination link proves
file exposure, not that a particular agent release loaded the skill.

Install/apply remains subject to per-repository resource admission and host-pressure
checks. Global shared-tooling maintenance is serialized independently. An
orchestrator must hold the applicable admission lease for the complete CLI call.

## Verification and CI

`make verify` covers:

- four TypeScript projects: application, Node config, E2E, and scripts
- ESLint correctness rules with zero warnings
- release-version synchronization and static architecture guards
- main iframe sources restricted to srcDoc previews or traced local asset URLs
- frontend tests and Rust library tests
- rustfmt and clippy with warnings denied
- production frontend build and gzip bundle budgets, including the native-e2e
  ship-isolation scan of the produced bundle (D-10)
- the Phase 08 evidence closure gate (`check-command-isolation`): every
  registered production command carries final justified worker-boundary,
  mutation-admission and processing-caller evidence against the 389-command
  inventory (`node scripts/check-command-isolation.mjs --all --expected-count 389`)

The iframe source guard prevents accidental reintroduction, rather than
analyzing adversarial JavaScript. Its regressions cover factory aliases,
indirect calls and lexical asset bindings; computed or obfuscated access is
outside its guarantee. The relay's browser UI no longer needs an app-side
reachability probe, so its former event listener and outbound HTTP path are
removed.

On Windows, run Make with Git for Windows' Bash and Unix tools on `PATH`,
alongside Node, pnpm, and Cargo. For a native Windows GNU Make installation,
use `make verify "SHELL=C:/Program Files/Git/bin/bash.exe"` (and the same
override for `make test-e2e`). Tracked text checks out with LF via
`.gitattributes`; this preserves vendored pin hashes and Node shebang imports.
The Windows unit and browser test runners default to two workers to reduce
startup contention on hosts with many logical CPUs. Vitest's explicit
`--maxWorkers` and Playwright's `--workers` options still override that default.

Use workspace-relative paths such as `task_management.root: tasks` in shared
`workspace.config.yaml` files. A home-relative or absolute path from another
machine can resolve outside the selected workspace and is correctly rejected
by the containment guard.

Every pull request reports `ci-ok`, including docs-only changes. A lightweight
path/label decision selects verify and Playwright; native fixtures, IPC,
window/menu/webview, PTY and runtime/config changes (listed in
`native-e2e.yml`) or the `native-e2e` label additionally select the full native
suite through a reusable workflow. Other code PRs keep native compile coverage;
selected native PRs do not compile twice. `ci-ok` requires every selected job,
including the suite, and rejects failures, cancellations and unplanned skips.
Version-changing PRs use `make release-checks`. Docs-only and `.planning/**`
changes skip builds; performance evidence JSON remains validation input. Native
label changes may reuse successful CI for the same SHA and tree, while unrelated labels
cannot replace or cancel the required check. Browser E2E runs on PRs and explicit manual CI dispatches, not main pushes.

A push to `main` may reuse the exact PR tree only when the successful PR run is
for the identical head SHA. Direct pushes, merge-tree differences, missing
checks, and API failures run the full suite.

CI E2E runs Chromium against Vite with mocked IPC. It does not prove WKWebView,
the native PTY, Korean IME behavior, macOS menus, signing, or notarization.
macOS-affecting changes require a real-app or release-artifact check.

Native fixture lifecycle and terminal readiness are documented in
[`docs/native-e2e.md`](docs/native-e2e.md#fixture-lifecycle-and-terminal-readiness).
Spec-owned roots/profiles are isolated at the launcher boundary; actual Mocha
setup hooks and final completion gates propagate fixture failures.

Coverage is measured by `make coverage` locally and by the `coverage` workflow
on every push to `main`. It never runs for pull requests and is not a required
check. Both HTML reports upload as the `coverage-report` artifact with 30-day
retention, and the per-language and per-crate totals table appears in the
run's Job Summary. There is no threshold, so a lower number never fails
anything.

The compiled CSP gate invokes the built host-native desktop binary with
`--print-compiled-csp`. This headless diagnostic reports the runtime-effective
CSP from the same generated Tauri Context used by startup (including `devCsp`
fallback when applicable), before plugins, services, or windows initialize.
The guard rejects absent or malformed policies, unsafe script directive
fallbacks, execution failures, and timeouts. Binary string layout and embedded
source JSON are not evidence of the effective policy.

Generated Rust executable test fixtures use
`src-tauri/src/test_support.rs::write_executable_fixture`, including rewrites,
with the existing script bytes and permission mode. On Unix the helper waits
for all inherited writable file descriptors to close before direct execution.
Linux can otherwise return `ETXTBSY` even after `fs::write` closes its own file:
a concurrent fork can retain a writable descriptor until exec. The test-only
lock handoff addresses fixture publication without changing production spawn
behavior or test assertions. Windows cannot execute a `#!` script, so the
helper also places a `<path>.exe` launcher beside it, which `Command::new(path)`
and PATH lookup resolve first. The launcher runs the script under its shebang
interpreter (Git for Windows `sh`/`bash`, or `node`), quotes every argument for
MSYS, and passes `\\?\C:\` paths in their equivalent `C:\` form. It is built once
per run with the toolchain's `rustc`. Fixtures that run a shell line directly
use `test_support::posix_shell()`, and fixture Git remotes and paths given to
Git use `test_support::git_local_path()`, because Git reads a verbatim path as
an SSH remote.

React dialog fixtures use `src/lib/testing/unmountReactRoot.ts` before removing
their fixture containers. Radix FocusScope defers disposal to a timer; awaiting
it inside the fixture's React act keeps CustomEvent construction in the same
jsdom realm. Closing that realm first can leak an invalid Event into the next
test file even when all assertions passed.

The command-isolation source guard also checks the production app-command and
channel-delivery routing hooks. Its mutation regressions cover removing either
hook. Native PTY output logs full-frame channel JSON parse and receiver-callback
timings, with payload size and dimensions; these samples exclude Rust preparation,
native dispatch, generated-script compilation and asynchronous paint.

## Release Process

Each minor release must state N-1 compatibility for wire, files, CLI and MCP
surfaces in its release notes and test against the latest published patch of
the previous minor line. Patch releases preserve that compatibility and do not
add an N-1 release-note line.

Skills updates retain the active and previous bundle and environment, plus
immutable snapshots used by Maru-launched sessions. `maru skills rollback`
restores the previous bundle and its environment without downloading or
rebuilding it. Rollback rechecks the retained bundle's app and tool floors;
legacy bundles use their original `manifest.json` when no cached compatibility
record exists, and missing compatibility data blocks rollback. Rollback requires
the target's completed hashed env even when active and target hashes match;
legacy envs are allowed only for recorded legacy activations or the initial
pre-hash bootstrap. Direct repair/bootstrap certifies a hashed env with
`.maru-env-complete` only after actual setup succeeds; status-created directories,
dry runs and missing setup scripts do not certify completion.
Same-hash rebuilds rename the prior directory to `<hash>.prev` and build at the
original path, preserving absolute venv paths. A failed build restores that
backup; the backup is deleted only after the new completion marker exists.
Environment resolution recovers an interrupted attempt from `.prev`, or keeps
the completed new root and removes the backup. Hash-specific OS locks prevent
that recovery from racing a live builder; symlink/file conflicts fail closed.
A failed restoration preserves the conflicting env path and `.prev` for recovery
while independently cleaning unapplied bundle artifacts. Backup-cleanup warnings
appear in the Env status diagnostics alongside existing setup errors; these
transient warnings are not saved to `status.json` and do not invalidate health.
Settings health also requires this marker for hashed envs. A live session's hash
is not rebuilt by bundle Apply; Bootstrap in the Settings > Skills toolbar is
the explicit repair path while that session remains live. Completion failures
surface their error reason even when the setup process itself exited with 0.
Rollback also checks the retained bundle against the file
list and hashes recorded when it was applied, and refuses missing, added or
changed files; a bundle applied before that list existed must still contain
every skill its `manifest.json` names.
Where POSIX modes are available, retained files are checked against recorded
signed modes during both reuse and rollback. Fingerprints prune ignored runtime
subtrees before traversal and continue to report errors for real bundle files.
Maru-supplied bundled skill instructions and resource references bind their
bundle and environment at start; external skill aliases switch atomically for
subsequent reads.
`_builtin` remains the editable workspace alias, with dirty edits blocking an
update or rollback until preserved with Save As or discarded. Session retention
is conservative: a launching Maru process keeps its captured versions until it
exits, including for detached terminal runs.
Initial migration of an existing `_builtin` directory uses atomic name exchange
on Linux/macOS. The [AC1 Windows exception](https://github.com/STAIxBWLB/maru/issues/466#issuecomment-6622259347)
permits a short gap for this one-time migration on Windows or a filesystem that
reports exchange unsupported: fully stage the symlink, retire the old directory,
then rename the link into place. The old tree is retained for N-1 and recovery.
Every later switch keeps atomic link replacement (Windows `FileRenameInfoEx`).

After bundle activation, dropped-skill unlink failures are progress warnings;
they do not skip saving the rescanned registry. A provider alias that could not
be unlinked keeps its install record and shared Maru entry, while other removed
installs are saved normally. Shared-entry unlink failures also warn without
turning an already activated update into a failed apply.
Cleanup warnings state that activation succeeded and name the retained provider
alias and shared entry. After closing sessions using the skill, verified owned
symlinks may be removed manually using the exact command in the warning. If a
target is unreadable or the entry still has another reference, the warning
limits removal to the verified alias or asks for inspection. Unix warnings may
include a quoted `rm --` command. Windows warnings give link-only wording with
no removal command and explicitly preserve target directories and contents;
recursive directory removal is never advised. No new CLI action or automatic
deletion bypasses these checks.

The release version's major and minor come from the active GSD milestone in
`.planning/STATE.md`; releases only increment the patch. Milestone v1.1 shipped
as 1.1.x and closed on 2026-09-27. Opening milestone v1.2, whose scope is being
defined, moves releases to 1.2.0. There is one tag namespace and it belongs to
releases: milestone completion no longer creates a git tag.

Version sources must remain synchronized:

```text
package.json
src-tauri/tauri.conf.json
src-tauri/Cargo.toml
src-tauri/maru-cli/Cargo.toml
src-tauri/Cargo.lock (maru and maru-cli package entries)
```

Release sequence:

1. Merge a version PR after release checks and Playwright E2E pass.
2. Verify exact-tree `main` CI.
3. Verify that the `native-e2e` real-app suite passed on that `main` commit
   (`gh workflow run native-e2e.yml --ref main` if the push run was skipped or
   cancelled). A failing spec blocks the release. An intentional skip states its
   cause in the spec, and links the upstream issue when an external defect
   causes it; opt-in local checks gated by an environment variable count as
   intentional skips.
4. Dispatch and pass Release Preflight.
5. Publish a GitHub Release whose tag is exactly `v<package version>` and whose
   target is the verified `main` commit. `Validate release inputs` enforces the
   prefix and fails before release lookup or bundle creation.
6. Wait for Release Bundles to finish across macOS ARM, macOS Intel, Linux, and
   Windows.
7. Verify the public artifacts, updater manifest, signatures, and Homebrew tap.
   The tap lands a few minutes after the finalizer, once the tap audit passes on
   `publish/maru-<tag>`.

The release workflow produces 20 platform assets, then a single finalizer
publishes `latest.json` for 11 updater platforms and updates Homebrew. A complete
release therefore has 21 non-empty assets. Platform jobs never race to write
the manifest.

Useful local checks:

```bash
make release-version-check
node scripts/check-release-version.mjs --tag v$(node -p "require('./package.json').version")
make macos-distribution-check
make macos-distribution-local-check
```

### macOS Signing and Notarization

Public macOS releases fail closed unless all signing secrets are configured:

```text
APPLE_CERTIFICATE
APPLE_CERTIFICATE_PASSWORD
KEYCHAIN_PASSWORD
APPLE_ID
APPLE_PASSWORD
APPLE_TEAM_ID
TAURI_SIGNING_PRIVATE_KEY
TAURI_SIGNING_PRIVATE_KEY_PASSWORD
```

Developer ID signing and Tauri updater signing are separate. The normal release
does not enable the browser-passkey provisioning overlay.

Local Apple material belongs outside the repository:

```text
~/workspace/work/.maru/secrets/apple/
  DeveloperIDApplication.p12
  AuthKey_<APPLE_API_KEY_ID>.p8
  certificate-password
  api-issuer-id
  api-key-id             # optional
  keychain-password      # optional
```

After downloading release artifacts:

```bash
xcrun stapler validate Maru_*.dmg
spctl -a -vv -t open --context context:primary-signature Maru_*.dmg
codesign --verify --deep --strict --verbose=4 Maru.app
spctl -a -vv -t exec Maru.app
```

Homebrew verification:

```bash
make homebrew-audit
make homebrew-fetch
```

Both read the installed `staixbwlb/cask` tap and first trust only the
`maru-workspace` cask and `maru-cli` formula, which Homebrew 6 requires for
`audit` and `fetch`.

The explicit `make homebrew-update*` targets are recovery tools. The release
finalizer pushes the rendered cask and formula to `publish/maru-<tag>` in
`STAIxBWLB/homebrew-cask` after the manifest succeeds, never to tap `main`. The
tap audits that commit, then opens and merges its own PR.

## Skills OTA Channel

Skills deploy independently from the desktop application through
`STAIxBWLB/skills`. Bundle changes are verified, packaged, minisign-signed, and
published to the `skills-channel` prerelease. Maru checks after launch and every
six hours, auto-applies only when local skills are clean and runtime-compatible,
and exposes manual check/apply commands in the CLI and Skills UI. A bundle is
not applied when the app is older than its `minAppVersion` (`bundle_requires_app`)
or an installed tool misses a `requires` floor such as `{"vmem": ">=0.2.3"}`
(`bundle_requires_tools`, versions from `<tool> manifest --json`, else
`<tool> --version`). A `registry.json` in a newer format than the build reads is
refused (`registry_newer_than_build`) and never rewritten.

`src-tauri/skills-bootstrap/` is a frozen first-run fallback, not the live OTA
source. Refresh it deliberately with `make skills-bootstrap-refresh` only when
an application release must carry a newer offline bootstrap.

## Roadmap

The GSD v1.0 Structural Debt Paydown and v1.1 Felt Quality and Native Proof
milestones are complete and archived. v1.1 (phases 6-11) closed on 2026-09-27
with audit status `tech_debt`, and the debt was accepted. The next milestone,
v1.2, is being defined and is not open yet. The long-range product plan remains
in [ROADMAP.md](ROADMAP.md), but planned items there are not active commitments
until a GSD milestone promotes them into requirements.

Milestone v1.1 promoted part of the carried-over backlog into requirements. The
remaining candidates are:

- ERR-05 closed-enum IPC construction
- Hub evidence index, approval/finalize, certification, and Deck Studio tracks

## Scope Boundaries

Maru v1.1.0 intentionally does not include:

- semantic or embedding search
- a Maru account or default telemetry
- a built-in cloud-sync engine
- mobile distribution
- iMessage or Slack ingestion
- multi-user collaboration, CRDT, or realtime editing
- PDF annotation or OCR
- a public skill marketplace server
- agent-autonomous edits as the default behavior
- unsigned updater feeds

## Documentation

- [CHANGELOG.md](CHANGELOG.md): release-by-release shipped changes
- [ROADMAP.md](ROADMAP.md): long-range product tracks
- [docs/agents.md](docs/agents.md): agents and runtime model
- [docs/diagram.md](docs/diagram.md): Diagram and report-pattern contracts
- [docs/graph.md](docs/graph.md): Graph storage, interaction, and write safety
- [docs/studio.md](docs/studio.md): Document Studio and native template flow
- [docs/hwp-editor.md](docs/hwp-editor.md): lower-level HWP engine bridge
- [docs/SSOT-TIERS.md](docs/SSOT-TIERS.md): skill ownership tiers
- [docs/BOUNDARIES.md](docs/BOUNDARIES.md): cross-repository ownership boundaries
- [docs/macos-passkeys.md](docs/macos-passkeys.md): opt-in passkey distribution runbook
- [.planning/reports/MILESTONE_SUMMARY-v1.0.md](.planning/reports/MILESTONE_SUMMARY-v1.0.md): completed structural milestone summary

## License

No license file is currently published. All rights reserved unless a license is
added.
