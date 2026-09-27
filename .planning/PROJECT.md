# maru

## What This Is

Local-first Maru Workspace and AI editing desktop app. A Tauri 2 desktop shell -
React 19 + TypeScript frontend over a Rust core - where a folder on disk is the
workspace: notes, documents, terminals, a knowledge graph, diagrams, skills, and
AI agent runs all operate on real files the user owns. Shipped as signed bundles
for macOS, Windows, and Linux; currently v1.1.12.

## Core Value

The filesystem stays the source of truth - everything Maru shows is derived from
real files the user owns, and nothing is lost if Maru is uninstalled.

## Current State

Milestone v1.1 Felt Quality and Native Proof closed on 2026-09-27. All six
phases (6-11), 56 plans, and 17 requirements are complete. The audit status is
`tech_debt` and the owner accepted the debt; the archive, audit, and phase
directories live under `.planning/milestones/`. Product releases v1.1.0
through v1.1.12 shipped during the milestone, and no milestone tag was created.

What v1.1 made true:

- A native WebDriver runner drives the real app's WKWebView DOM, PTY output,
  synthetic IME composition, and menu commands. The CI verdict is ci-viable
  (hosted macOS evidence in docs/native-e2e.md): the suite runs unattended on
  `main` and release tags and gates `release-preflight`.
- Six named locks recover from poisoning, recursive watchers prune generated
  trees, a sanitizer guard gates `make verify`, and the inbox is out of the
  document index on all three index paths.
- `skills_sync_source` no longer holds `REGISTRY_LOCK` across the network, and
  all 383 production commands carry isolation evidence gated in `make verify`.
- A SIGHUP-trapping terminal can always be killed, every autosave surface saves
  on unmount and quit through one guard, and a failed teardown save keeps a
  `.maru/recovery/` copy and raises a toast.
- The shipped CSP `script-src` is `'self'`, per-mode CSS rides lazy chunks, and
  TS and Rust coverage is reported without gating.

Milestone v1.0 Structural Debt Paydown shipped on 2026-08-28 (five phases, 32
plans, 24 requirements). Product release v0.5.0 commemorates it.

The next milestone, v1.2, is being defined and is not open yet.

## Requirements

### Validated

<!-- Shipped and relied upon. Inferred from the codebase map, not from a PRD. -->

- ✓ Workspace and vault scanning with a fingerprinted warm cache and filesystem
  watchers - disposable cache, filesystem authoritative
- ✓ Document read/save/create/version/move/trash with optimistic-concurrency
  revision checks, and a single allowed frontmatter write path that preserves key
  order and comments
- ✓ Editor surfaces: BlockNote rich markdown, CodeMirror source mode, sanitized
  markdown preview
- ✓ Native PTY terminal (alacritty screen model over `portable-pty`) with
  generation-token session safety
- ✓ WebGL knowledge graph (sigma + graphology) with off-thread insight
  computation and enforced perf budgets
- ✓ Diagram mode (envelope v8, v7 migration), Studio 7-step wizard, export
  pipeline with a manifest SSOT
- ✓ Federated skill host: five ownership tiers, one-name-one-tier, symlink
  installs into tool-owned directories, minisign-verified OTA bundle updates
- ✓ Agent host: provider probes, structured loop, suggestion-only proposals,
  protected writes behind approval staging
- ✓ Inbox and provider I/O (Gmail/GWS, Outlook/MSO, Telegram, Kakao, drops),
  today/tasks, scheduler, evidence binder, gap analysis, drafts
- ✓ Local MCP sidecar (Node, stdio, read-first)
- ✓ Signed/notarized release bundles, Homebrew cask + CLI formula, in-app
  auto-update via minisign-verified `latest.json`
- ✓ Measured and gated startup/bundle budgets (320 KiB gzip initial JS, 70 KiB
  CSS, lazy GraphView/RichMarkdownEditor/i18n chunks)
- ✓ `make verify` is a signal a refactor can be trusted against — Phase 1
  (pinned rust-toolchain 1.98.0, fmt-check + clippy gates, ESLint four-rule
  gate wired into verify, `e2e/`+`scripts/` typechecked, CI trace on e2e
  failure with no retries; UAT 24/24)
- ✓ One shared generated-directory prune list replaces the diverged copies —
  Phase 2 (`crate::paths::GENERATED_DIRS`, 14-entry union, six consumers)
- ✓ One shared path-containment helper is the canonical one for new commands —
  Phase 2 (`crate::paths::ensure_within`, lexical, plus `require_absolute`
  guarding `maru_home()`/`install_root_base()`)
- ✓ Errors the frontend branches on carry a typed machine-readable `code` —
  Phase 3 (cross-language rename drills, no residual string-prefix branches,
  display-only errors left unchanged)
- ✓ `OutlinePane` and `EditorPane` own keyed module-store state instead of
  71/55-prop bundles — Phase 4 (four structural props each, real MainApp
  render-isolation proof, preview marked-node identity, native WKWebView smoke)
- ✓ Shell decomposition is complete — Phase 5 (`DocumentList` and
  `TerminalPanel` use four-input facades, all 18 modes route through lazy
  registry adapters, `MainApp` is 15 `useState` / 24 `useEffect`, D-20 native
  UAT 5/5, verification 8/8)

- ✓ Phase 6 native e2e runner - WebDriver drives the real app's WKWebView DOM,
  a real PTY, synthetic IME composition, and menu commands against the real Rust
  backend; the spike verdict is ci-viable and the suite gates
  `release-preflight` (TEST-01) - v1.1
- ✓ Phase 7 guardrails - scoped poison recovery (PERF-03), watcher pruning
  (PERF-04), sanitizer provenance gate (SEC-02), and independent Inbox/index
  behavior (PERF-06); UAT 5/5, existing security register 15/15 closed.
- ✓ Phase 8 main-thread responsiveness - `skills_sync_source` releases
  `REGISTRY_LOCK` across the network and reloads fresh (PERF-02); every
  production command carries isolation evidence (383 today: 374 ISOLATED, 9 UI)
  gated by `check-command-isolation`, and the native load test keeps loaded p95
  at 2 ms against a 4,789 ms negative control (PERF-01) - v1.1
- ✓ Phase 10 bundle and build hardening - shipped CSP `script-src` is `'self'`
  (SEC-01; config, AST dist scan and debug-binary codegen scan enforce it) and
  every mode's pane CSS rides its lazy chunk with the entry CSS at 45 KiB gzip
  against the unchanged 70 KiB budget (PERF-05); UAT 2/2, verification 10/10,
  shipped in v1.1.10/v1.1.11.
- ✓ Phase 11 milestone verification and evidence - non-gating TS and Rust
  coverage report with a recorded baseline (TEST-02), narrowed trace re-proven by
  a deliberate CI failure (GATE-08), v1.0 01-03 Nyquist metadata reconciled
  (VALID-01), and a retroactive v1.0 Phase 02 security report (SEC-03); UAT 1/1,
  verification 4/4, security 20/20 closed.
- ✓ Phase 9 durability and session lifecycle - process-group kill ladder with
  foreground-job targeting and a 3 s quit sweep (REL-01), autosaves flushed on
  unmount and quit through one guard with a 3 s budget (REL-02), failed teardown
  saves kept as recovery copies with a toast (REL-03), tilde-expansion verified
  (REL-04); owner real-app checks passed after two fixes, verification 16/16.

### Active

None. All 17 v1.1 requirements moved to Validated and are archived in
`.planning/milestones/v1.1-REQUIREMENTS.md`. Active requirements return when
v1.2 is scoped (see Next Milestone Goals).

### Out of Scope

- **New product features in milestone scope** - v1.0 excluded them because a
  feature landing mid-refactor makes every regression ambiguous (one recorded
  exception: the `hwped_*` hwp-editor bridge, adopted from a parallel track),
  and v1.1 excluded them because it changed how existing surfaces behave under
  load. Whether v1.2 keeps this exclusion is decided when it is scoped
- **Converting every `Result<T, String>` signature** - CONCERNS.md rejects
  it explicitly; only the errors the frontend actually branches on move
- **Retrofitting all ~20 existing path-traversal validators** - the existing
  checks are individually sound; promoting the canonical helper is the goal
- **Changing `.maruignore` defaults** (`src-tauri/src/maru_dir.rs:79`) - that is a
  user-facing file format, not a scanner constant
- **A full lint style campaign** (formatting rules, import ordering, `console`
  cleanup) - only the correctness rules that guard the decomposition
- **ERR-05's closed-enum contract** - the typed IPC guard checks declarations
  but not emission sites. Real, but it is a developer-facing correctness gap
  rather than something a user feels; deferred again rather than diluting a
  felt-quality milestone
- **Hub graph-metadata sync** - the one explicit deferral in the ingested doc
  set (`docs/graph.md`); held until a Hub consumer exists

## Next Milestone Goals

v1.2 is being defined by the owner and is not open yet. Opening it moves
releases to 1.2.0 (README Release Process). v1.1's goal, target features, and
per-phase detail are archived in `.planning/milestones/v1.1-ROADMAP.md`.

Candidates on record, none promoted yet:

- HWPE-01..03 registration of the adopted `hwped_*` bridge, Semantica S1-S4,
  HUB-01 Hub graph-metadata sync, and ERR-05's closed-enum contract
- TEST-03 (remaining large untested components) and TEST-04 (`app_menu.rs`
  smoke test)
- The accepted v1.1 tech debt in `.planning/milestones/v1.1-MILESTONE-AUDIT.md`,
  including open issues #380, #381, #382, #386, #387, #388 and #389

## Context

**Brownfield, and unusually disciplined.** TypeScript is `strict` with 7 `any`
uses and zero `@ts-ignore`; Rust production code has 18 `.unwrap()` calls;
deliberate simplifications carry `ponytail:` comments naming their ceiling. The
debt below is the real remainder, not a symptom of neglect.

**The shell debt is paid down.** `MainApp` now stays below its contract ceiling
at 15 `useState` and 24 `useEffect` calls. `OutlinePane`, `EditorPane`,
`DocumentList`, and `TerminalPanel` use small store-backed facades, all 18 modes
route through lazy registry adapters, and real-`MainApp` isolation tests guard
the preview-mark failure mode behind #260/#262/#264.

**The extraction pattern already exists and works.** `src/lib/errorStore.ts`,
`src/lib/editorTabsStore.ts`, `src/lib/appOverlayStore.ts`, and
`src/lib/workspaceStore.ts` are module-slot stores read via
`useSyncExternalStore`; `errorStore` exists explicitly "so any component can raise
or clear the toast without an onError prop drill". The milestone continues that
precedent rather than introducing a new state library.

**Ingested documentation describes shipped behavior.** 18 docs: 13 SPEC, 5 DOC,
0 ADR, 0 PRD. The 64 constraints extracted from the SPECs are invariants to
preserve, not features to build. Candidate work came from
`.planning/codebase/CONCERNS.md`.

**Settled ownership context.** The skill ownership tier map is five tiers - T1
Core, T2 Public, T3 Private, T4 Imported, T5 Managed Local - agreed across
`docs/SSOT-TIERS.md` and the workspace rule
`~/workspace/work/_meta/rules/skills-ssot.md` as of 2026-08-22 (work commit
de0b0f70). The earlier four-tier divergence is resolved.

**The refactor boundary is now guarded.** Real-`MainApp` render-isolation tests,
pane facade contracts, preview DOM-identity tests, terminal generation tests,
mode-registry tests, and the production extensibility drill cover the extracted
shell boundaries. Since v1.1 the native e2e suite covers WKWebView, the PTY,
IME composition, and menu commands on hosted macOS runners for `main` and
release tags; pull-request e2e still runs Chromium with mocked IPC, so a
macOS-affecting change still needs a real-app check before merge.

**v1.1 closed with known, accepted debt.** About 355k tracked lines across
TypeScript, TSX, Rust, and `.mjs` scripts. The debt register is the
`tech_debt` frontmatter of `.planning/milestones/v1.1-MILESTONE-AUDIT.md`; the
user-visible items are open issues #380, #381, #382, #387 and #389, and the
hosted-runner native e2e flakes are #388.

## Constraints

The 64 SPEC-tier constraints in `.planning/intel/constraints.md` are project
invariants for this milestone. There are no ADRs in the ingested set, so none of
them is decision-locked - **any of them is overridable by a future ADR**. The
ones this milestone can actually break are listed here.

- **Behavior**: `make verify` must stay green throughout, but for v1.1 it is a
  floor rather than the success metric. The milestone's own changes are
  observable (work moves off the main thread, a trapped-SIGHUP session dies, a
  flush lands before unmount), so each one needs evidence that the behavior
  changed in the intended direction - not only that nothing else did
- **Frontend architecture**: New shared state is a module store read via
  `useSyncExternalStore`, never a new prop threaded through `MainApp` and never a
  Context-provider tree - matches the existing precedent
- **Module boundary**: Business logic lives in Rust or `src/lib/`; React owns
  editors, palette, graph layout, and diagram canvas only
- **Import direction**: `src/lib/` must not import from `src/components/` (one
  type-only exception at `src/lib/appOverlayStore.ts:3`), and nothing imports
  `src/App.tsx`
- **Preview markup**: Marks must be folded into the HTML string React renders and
  the markup object memoized on that string. Never add an effect that mutates the
  preview container's DOM - it will not re-run when the erasing re-render had no
  dependency change (`src/components/EditorPane.tsx:167`)
- **Terminal sessions**: Preserve the generation check on every session-scoped
  command; it is what stops a stale frontend handle writing into a recycled
  session
- **Path containment is lexical**: `resolve_inside_vault` / `lexical_normalize`
  deliberately avoid `canonicalize()` so user-created symlinks inside a workspace
  stay part of it. A unified helper must not "fix" this
- **Frontmatter**: `src-tauri/src/frontmatter/ops.rs` stays the only YAML write
  path; key order and comments survive a single-field patch
- **Write gating**: Mutating commands keep routing through
  `vault_list::assert_maru_can_write` / `assert_document_owner` and, for managed
  vaults, `vault_guard::validate_managed_write`
- **Bundle budget**: `scripts/check-bundle-budget.mjs` gates the entry chunk;
  extracted stores must not pull a lazy mode pane into the entry graph
- **i18n parity**: every UI string stays in `src/lib/i18n/locales/{ko,en}.ts`;
  `pnpm lint:i18n` fails on key drift or a hardcoded string
- **macOS window policy**: `backgroundThrottling: "throttle"` is contract-guarded
  by `scripts/tauri-window-policy.test.mjs`
- **Skill host boundaries**: read `docs/SSOT-TIERS.md` and `docs/BOUNDARIES.md`
  before touching install or sync paths; an ownership change must update both
  repositories' boundary documents in the same change set
- **Tech stack**: Tauri 2.10 / React 19.2 / Vite 7.3 / Rust MSRV 1.77.2, Node
  >= 22 + pnpm 9.15.0. No new frontend state library, no CSS framework
- **CI reality**: `make verify` runs on `ubuntu-22.04` only; e2e runs Chromium
  against Vite with mocked IPC. A macOS job compile-checks the runner per PR;
  the suite runs unattended on `main`/tags and gates `make release-preflight` - `docs/native-e2e.md`

## Key Decisions

| Decision | Rationale | Outcome |
|----------|-----------|---------|
| Milestone 1 = structural debt paydown, no features | Behavior-preserving work is only verifiable if behavior is not also changing | ✓ Complete — all 5 phases and 24 v1 requirements verified |
| Scope drawn from CONCERNS.md Tech Debt, not from the SPECs | 18 ingested docs describe shipped behavior; inventing forward work from them would be fabrication | ✓ Held throughout the milestone; one adopted parallel-track exception recorded in STATE.md |
| Verification gates land before the decomposition (Phase 1) | Moving 68 `useState` / 50 `useEffect` without a hook-dependency gate reproduces #260/#262/#264 | ✓ Phase 1 — 7 gates live, deliberate-break proofs red-then-green, UAT 24/24 |
| Continue the module-store precedent instead of adding a state library | `errorStore`/`workspaceStore`/`editorTabsStore` already prove the pattern here | ✓ Phases 4-5 complete with store-backed facades and no new state library |
| Typed error contract covers only branched-on errors | Converting all ~1,138 signatures is cost without benefit; display-only errors read fine as strings | ✓ Phase 3 complete; ERR-06 closed after milestone review in v0.5.0, ERR-05 remains deferred |
| Promote `ensure_within`, do not retrofit all ~20 callers | Existing checks are individually sound; the problem is that a new author has no canonical example | ✓ Phase 2 — promoted to `crate::paths`, doc + tests as the example, zero retrofits |
| Phases 4-5 get no `UI hint` annotation | They refactor UI state plumbing with pixel-identical output as the success criterion; a UI design spec would be the wrong downstream suggestion | ✓ Completed with behavior-preserving UAT and no visible redesign |
| 64 SPEC constraints recorded as invariants, not decisions | 0 ADRs in the set - nothing is decision-locked, so a future ADR can override any of them | ✓ Preserved as the milestone verification baseline |
| Milestone numbers own the release major.minor | Two numbering systems sharing the `v*` tag namespace put `v1.0` above every real release in version sort, breaking the Homebrew tap audit four releases running; aligning the bands removes the ambiguity instead of patching each consumer | ✓ Adopted 2026-08-30 in v1.1.0 - operative rule in README's Release Process; v1.1 closed on 2026-09-27 with no milestone tag |
| Milestone v1.1 = felt quality, synthesised from the carried-over backlog | The deferred items are not equal in weight: a 40s main-thread block measured on a 64k-file workspace is a product defect, while Nyquist metadata drift is a bookkeeping one. Grouping them by what a user experiences gives the milestone one goal instead of nine chores | ✓ v1.1 closed 2026-09-27 - 17/17 requirements, audit `tech_debt` with the debt accepted |
| The native E2E runner lands early, not as closeout | v1.1's success condition is that observable behavior changed for the better; the mocked-IPC Chromium suite cannot see that, and v1.0's retrospective already ruled that a human approval marker is not reusable evidence | ✓ Phase 6 - verdict `ci-viable`; Phases 8 and 9 verified against it (responsiveness and quit specs). Hosted-runner flakes tracked in #388 |
| Features stay out for a second consecutive milestone | HWPE-01..03, Semantica S1-S4, and HUB-01 all add surface area to panes whose responsiveness this milestone is trying to fix; shipping them first would move the target | ✓ Held for the milestone - all three stay unpromoted candidates. Unrelated product work (#297, #315, #319) shipped in parallel 1.1.x releases outside milestone scope |
| Poison recovery only for the six named locks, each with its own justification (PERF-03) | Blanket `into_inner()` recovery converts a loud panic into silent corruption on invariant-bearing state | ✓ Phase 7 - shared `recover_guard`, per-lock justification, no raw poison producers on the six locks |
| Main-thread isolation is proven by per-command evidence and a native load test, not by the absence of a freeze (PERF-01) | Moving a blocking call onto Tauri's shared async pool looks like a fix from the UI and has no passive warning sign | ✓ Phase 8 - `check-command-isolation` gates every production command in `make verify`; loaded p95 2 ms against a 4,789 ms negative control |
| Mode CSS moves to lazy per-mode files; late overrides live at the end of the owning file | Lazy CSS always loads after the entry stylesheet, so an entry-side override of a mode selector silently loses; the split first shipped 24 such inversions | ✓ Phase 10 - SPLIT HOME guard in `check-mode-css-ownership` makes it build-enforced |
| Coverage is reported, never gated, and runs on `main` pushes only (TEST-02, D-01/D-04) | A threshold turns a diagnostic into a merge blocker before anyone knows what the numbers mean; running it per PR would slow every PR by an instrumented build | ✓ Phase 11 - `make coverage` outside `verify`, `coverage.yml` push-to-main only, baseline recorded in 11-EVIDENCE.md |
| One quit path: Cmd+Q is a Maru-owned menu item routed into the window-close guard (D-03) | The native Quit item called `NSApplication terminate:` and bypassed every JS guard; a Rust `ExitRequested` veto would race the webview | ✓ Phase 9 - Dock Quit and logout remain a known gap, covered by the Scratchpad localStorage mirror |
| Terminal kill targets the leader group and the PTY's foreground group, never the whole session (D-09) | A job-control shell runs foreground jobs in their own group; signaling the whole session would kill deliberately disowned jobs | ✓ Phase 9 - found by the owner's real-app check, pinned by real-PTY tests |
| Evidence is recorded in the repo, not left in CI artifacts (GATE-08, D-07) | The v1.0 trace proof became unverifiable when its 7-day artifact expired | ✓ Phase 11 - `unzip -l` listing and run metadata in 11-EVIDENCE.md |
| Idle preload warms only the modes whose CSS was split (D-03 amended) | Vite resolves a lazy mode only after its CSS lands, so preload never prevented FOUC; warming every mode cost ~2.9 MB of evaluated JS per session | ✓ Phase 10 / #340 - six modes, one per idle callback |

## Evolution

This document evolves at phase transitions and milestone boundaries.

**After each phase transition** (via `/gsd-transition`):
1. Requirements invalidated? → Move to Out of Scope with reason
2. Requirements validated? → Move to Validated with phase reference
3. New requirements emerged? → Add to Active
4. Decisions to log? → Add to Key Decisions
5. "What This Is" still accurate? → Update if drifted

**After each milestone** (via `/gsd-complete-milestone`):
1. Full review of all sections
2. Core Value check — still the right priority?
3. Audit Out of Scope — reasons still valid?
4. Update Context with current state

---
*Last updated: 2026-09-27 after v1.1 milestone*
