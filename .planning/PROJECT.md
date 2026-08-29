# maru

## What This Is

Local-first Maru Workspace and AI editing desktop app. A Tauri 2 desktop shell -
React 19 + TypeScript frontend over a Rust core - where a folder on disk is the
workspace: notes, documents, terminals, a knowledge graph, diagrams, skills, and
AI agent runs all operate on real files the user owns. Shipped as signed bundles
for macOS, Windows, and Linux; currently v0.5.0.

## Core Value

The filesystem stays the source of truth - everything Maru shows is derived from
real files the user owns, and nothing is lost if Maru is uninstalled.

## Current State

Milestone v1.0 Structural Debt Paydown shipped on 2026-08-28. All five phases,
32 plans, and 24 v1 requirements are complete. The milestone archive and audit
live under `.planning/milestones/`. Product release v0.5.0 commemorates the
milestone and includes the post-close ERR-06 hardening.

Milestone v1.1 Felt Quality and Native Proof is active as of 2026-08-28 and
continues phase numbering at Phase 6.

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

### Active

Milestone v1.1 promotes the deferred reliability, performance, security, and
native-verification backlog into committed requirements. REQ-IDs are assigned in
`.planning/REQUIREMENTS.md` and the scope is summarised under Current Milestone
below. Candidates deliberately left unpromoted - HWPE-01..03 registration,
Semantica S1-S4, HUB-01, and ERR-05 - stay in the archived v1.0 requirements.

### Out of Scope

- **New product features of any kind** - this milestone preserves behavior; a
  feature landing mid-refactor makes every regression ambiguous. One recorded
  exception: the `hwped_*` hwp-editor bridge, written by a parallel track and
  adopted here rather than built (STATE.md "Scope Exceptions")
- **Converting every `Result<T, String>` signature** - CONCERNS.md rejects
  it explicitly; only the errors the frontend actually branches on move
- **Retrofitting all ~20 existing path-traversal validators** - the existing
  checks are individually sound; promoting the canonical helper is the goal
- **Changing `.maruignore` defaults** (`src-tauri/src/maru_dir.rs:79`) - that is a
  user-facing file format, not a scanner constant
- **New user-facing product features** - v1.1 changes how the existing surfaces
  behave under load, not what they do. Note the difference from v1.0: this
  milestone deliberately alters observable behavior (a pane that froze must stop
  freezing), so "the e2e suite still passes" is necessary but no longer
  sufficient evidence
- **A full lint style campaign** (formatting rules, import ordering, `console`
  cleanup) - only the correctness rules that guard the decomposition
- **ERR-05's closed-enum contract** - the typed IPC guard checks declarations
  but not emission sites. Real, but it is a developer-facing correctness gap
  rather than something a user feels; deferred again rather than diluting a
  felt-quality milestone
- **Hub graph-metadata sync** - the one explicit deferral in the ingested doc
  set (`docs/graph.md`); held until a Hub consumer exists

## Current Milestone: v1.1 Felt Quality and Native Proof

**Goal:** Maru stops freezing, stops losing terminal sessions and unsaved text,
and proves it in the runtime users actually run rather than through a human
driving the app by hand.

**Target features:**

- Heavy-IO IPC commands leave the main thread - the 37 sync commands that reach
  `WalkDir`, `read_dir`, a subprocess, or the network within their first 80
  lines move to `async fn` or to the invocation-id + event-streaming pattern
  (PERF-01)
- `skills_sync_source` stops holding `REGISTRY_LOCK` across a network round-trip,
  so a slow remote no longer freezes both the UI thread and every other skills
  operation (PERF-02)
- The six process-global locks recover from poisoning instead of bricking their
  feature until app restart (PERF-03)
- Recursive filesystem watchers prune through the shared `GENERATED_DIRS` list
  (PERF-04)
- A PTY child that traps SIGHUP can still be killed, via process-group
  escalation (REL-01)
- Scratchpad flushes its debounced save on unmount instead of only clearing the
  timer, closing the 700 ms window where localStorage is the sole durable path
- CSP drops `script-src blob:` if the Vite build no longer requires it (SEC-01),
  and `verify` asserts every `dangerouslySetInnerHTML` value traces to a
  DOMPurify-backed helper (SEC-02)
- A native E2E runner exercises WKWebView, a real PTY, IME input, and the macOS
  menu - the four surfaces CI has never touched (TEST-01)
- `src/styles.css` splits per mode into the lazy chunks those modes already have,
  restoring the CSS budget headroom spent since v0.4.46
- Coverage is measured rather than inferred from file presence, as a non-gating
  report (TEST-02)
- The v1.0 closeout evidence debt is settled: GATE-04 trace reproduction, Phase
  01-03 Nyquist reconciliation, and the Phase 02 security report

**Out of scope:** HWPE-01..03 requirement registration, Semantica S1-S4, HUB-01
Hub graph-metadata sync, and ERR-05's closed-enum contract. All four remain
candidates for the milestone after this one.

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
shell boundaries. Native-only behavior remains a manual macOS gate because CI
still runs Chromium with mocked IPC.

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
- **CI reality**: `make verify` runs on `ubuntu-22.04` only, and e2e runs
  Chromium against Vite with mocked IPC. macOS-native changes ship unverified by
  CI - validate them by running the real app

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
| Milestone v1.1 = felt quality, synthesised from the carried-over backlog | The deferred items are not equal in weight: a 40s main-thread block measured on a 64k-file workspace is a product defect, while Nyquist metadata drift is a bookkeeping one. Grouping them by what a user experiences gives the milestone one goal instead of nine chores | Pending |
| The native E2E runner lands early, not as closeout | v1.1's success condition is that observable behavior changed for the better; the mocked-IPC Chromium suite cannot see that, and v1.0's retrospective already ruled that a human approval marker is not reusable evidence | Pending |
| Features stay out for a second consecutive milestone | HWPE-01..03, Semantica S1-S4, and HUB-01 all add surface area to panes whose responsiveness this milestone is trying to fix; shipping them first would move the target | Pending |

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
*Last updated: 2026-08-28 at the start of milestone v1.1*
