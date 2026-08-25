# Roadmap: maru

## Overview

Milestone 1 is structural debt paydown on a shipped, disciplined brownfield app.
The journey runs from "the signals we verify against are trustworthy" to "adding
pane state no longer means editing a 9,337-line file". Phase 1 makes `make verify`
worth trusting, because every later phase is behavior-preserving work whose only
proof is a green gate. Phases 2 and 3 collapse duplicated Rust invariants (five
diverged prune lists, ~20 ad-hoc containment checks, string-prefix error codes)
while the frontend is still untouched. Phases 4 and 5 then peel `MainApp`'s state
into module stores one pane at a time, highest prop arity first, ending with the
mode-routing chain. Nothing user-visible changes in any phase; that is the point.

## Phases

**Phase Numbering:**

- Integer phases (1, 2, 3): Planned milestone work
- Decimal phases (2.1, 2.2): Urgent insertions (marked with INSERTED)

Decimal phases appear between their surrounding integers in numeric order.

- [x] **Phase 1: Trustworthy Verify Signal** - Make `make verify` and CI tell the truth about a behavior-preserving change (completed 2026-08-23)
- [x] **Phase 2: Shared Scanner and Path Invariants** - Collapse five prune lists and ~20 containment checks into one of each (completed 2026-08-23)
- [x] **Phase 3: Typed IPC Error Contract** - Give the errors the frontend branches on a machine-readable code (completed 2026-08-24)
- [ ] **Phase 4: Editor Surface State Extraction** - Move `OutlinePane` and `EditorPane` off their prop bundles onto module stores
- [ ] **Phase 5: Shell Decomposition Completion** - Move the remaining panes and mode routing out of `MainApp`

## Phase Details

### Phase 1: Trustworthy Verify Signal

**Goal**: A developer can believe a green `make verify` means a refactor changed nothing
**Depends on**: Nothing (first phase)
**Requirements**: GATE-01, GATE-02, GATE-03, GATE-04, GATE-05, GATE-06, GATE-07
**Success Criteria** (what must be TRUE):

  1. A deliberately broken hook dependency list, an unused symbol, an unformatted Rust file, and a clippy warning each fail `make verify` locally and in CI
  2. A type error introduced into a Playwright spec or a `scripts/*.mjs` file fails `make verify` instead of surfacing at runtime
  3. A failing e2e test in CI leaves a downloadable Playwright trace in the uploaded artifacts
  4. Checking out an older commit and building reproduces that commit's Rust toolchain rather than today's `stable`
  5. `pnpm typecheck` passes with `@types/dompurify` removed, and the shipped E2E flow ledger contains no already-resolved entries

**Plans**: 7/7 plans executed

Plans:
**Wave 1**

- [x] 01-01-PLAN.md - Tracer: pin the Rust toolchain and gate `make verify` on `cargo fmt --check` (GATE-05, GATE-01 format half)

**Wave 2** *(blocked on Wave 1 completion)*

- [x] 01-02-PLAN.md - Fix the clippy backlog to zero and add the `clippy` gate (GATE-01)
- [x] 01-03-PLAN.md - Playwright trace on first failure, and a truthful E2E flow ledger (GATE-04, GATE-07)
- [x] 01-04-PLAN.md - Typecheck `e2e/` via a new project reference, drop the deprecated types stub (GATE-03 e2e half, GATE-06)

**Wave 3** *(blocked on Wave 2 completion)*

- [x] 01-05-PLAN.md - Typecheck `scripts/` under `checkJs` and reference it (GATE-03 scripts half)
- [x] 01-06-PLAN.md - Install ESLint, write the flat config, clear `src/App.tsx` (GATE-02 setup)

**Wave 4** *(blocked on Wave 3 completion)*

- [x] 01-07-PLAN.md - Clear the rest of the lint backlog and add the `lint` gate (GATE-02)

Notes for planning:

- The cheapest Rust half is zero-config: `cargo clippy -- -D warnings` and `cargo fmt --check` appended to the `verify` target (`Makefile:309`). The Rust code is already idiomatic enough to pass or near-pass.
- The TypeScript half is the one place a new dependency may be justified: `noUnusedLocals`/`noUnusedParameters` in `tsconfig.app.json` is free, but `react-hooks/exhaustive-deps` needs a linter. Scope it to the correctness rules that guard Phases 4-5; do not open a style campaign.
- GATE-03 is a third `tsc -b` project reference covering `e2e` and `scripts`; today `tsconfig.app.json` includes only `["src"]`.
- GATE-04 is one line: `retries: process.env.CI ? 1 : 0`, or switch `playwright.config.ts:12` to `trace: "retain-on-failure"`.
- GATE-05 is a `rust-toolchain.toml`; `src-tauri/Cargo.toml:8` declares `rust-version = "1.77.2"` as a floor, not a pin. Bump it deliberately like the Node pin.
- GATE-07 drops the resolved `skill-name-drift` entry at `src/lib/e2eFlow.ts:139` and notes in the module comment that the ledger is hand-written, not derived.
- Adding gates will surface pre-existing violations. Fixing them is in scope; rewriting the code they point at is not.

### Phase 2: Shared Scanner and Path Invariants

**Goal**: A new command author has exactly one prune list and one containment helper to reach for
**Depends on**: Phase 1
**Requirements**: SCAN-01, SCAN-02, SCAN-03, SCAN-04, SCAN-05
**Success Criteria** (what must be TRUE):

  1. Adding a generated directory to the skip set is a one-line edit in one file, and `workspace_files.rs`, `vault.rs`, `secrets.rs`, `project_activity.rs`, and `evidence_binder.rs` all honor it
  2. A workspace scan over a repo-containing folder no longer walks into `.git` object storage or `.venv`
  3. `ensure_within` is importable from a shared module and is the obvious canonical example, while the existing per-module checks stay as they are
  4. A test proves that joining a `maru_home()`/`env_root()` result against a non-absolute base panics or errors rather than creating a tree in the working directory
  5. `Users/yj.lee/.maru/env/` no longer exists at the repo root

**Plans**: 3/3 plans executed

Plans:
**Wave 1**

- [x] 02-01-PLAN.md - Tracer: create `src-tauri/src/paths.rs` (GENERATED_DIRS union + ensure_within + require_absolute), register it, rewire workspace_files/content_search, promote ensure_within into maru_dir (SCAN-01, SCAN-02, SCAN-03)

**Wave 2** *(blocked on Wave 1 completion)*

- [x] 02-02-PLAN.md - Rewire vault/secrets/project_activity/evidence_binder to the union; red-then-green SCAN-02 union-proof test; .maru retained module-locally (SCAN-01, SCAN-02)
- [x] 02-03-PLAN.md - SCAN-04 absolute-base guard inside maru_home()/install_root_base() + regression test + delete stray Users/ tree (SCAN-04, SCAN-05)

Notes for planning:

- The `workspace_files.rs:21` list is already `pub(crate)`; promoting it is the shortest path. The unified constant must be the union that includes `.git` and `.venv`, not the intersection.
- Keep `maru_dir.rs:79`'s twelve-entry `.maruignore` default separate and unchanged - it is a user-facing file format, not a scanner constant.
- Do not retrofit the ~20 existing path validators. `Component::ParentDir` checks and substring `".."` checks are not equivalent, but each is individually sound today; converting them all is a much larger behavioral risk than the problem justifies.
- Path containment must stay lexical. `resolve_inside_vault`/`lexical_normalize` avoid `canonicalize()` on purpose so user-created symlinks inside a workspace stay part of it.
- SCAN-05 is a delete; SCAN-04 is the guard that stops it recurring. Do them together or the delete is cosmetic.

### Phase 3: Typed IPC Error Contract

**Goal**: A frontend recovery path breaks at compile time when the error it depends on is renamed
**Depends on**: Phase 1
**Requirements**: ERR-01, ERR-02, ERR-03, ERR-04
**Success Criteria** (what must be TRUE):

  1. A frontend caller can read a stable `code` and a human message from every error it branches on, without parsing the message
  2. Renaming a code on the Rust side fails `make verify` on the TypeScript side, and vice versa
  3. No `message.includes("<error_code>")` matcher remains in `src/` for a code that moved to the contract
  4. The `Result<T, String>` count in `src-tauri/src/` is essentially unchanged from the measured baseline of 1,138 (CONCERNS.md's 1,118 is stale) - display-only errors were not touched

**Plans**: 4/4 plans complete

Plans:
**Wave 1**

- [x] 03-01-PLAN.md - Tracer: IpcError struct + TS mirror + normalizer, proven end-to-end on evidence_binder_revision_conflict; real-app smoke checkpoint ratifying the 7-command scope (ERR-01, ERR-02)

**Wave 2** *(blocked on Wave 1 completion)*

- [x] 03-02-PLAN.md - Migrate the today and document Rust domains to IpcError; map_err adapter for today_ai; record the ERR-04 count (ERR-01, ERR-04)
- [x] 03-03-PLAN.md - Normalize the today/save funnels, migrate all five branch sites to err.code, retire todayErrorCode, align e2e fixtures (ERR-01, ERR-03)

**Wave 3** *(blocked on Wave 2 completion)*

- [x] 03-04-PLAN.md - ERR-02 rename drill (red-then-revert both sides), ERR-04 count guard, ERR-03 residual grep, full make verify (ERR-02, ERR-03, ERR-04)

Notes for planning:

- Start from the codes the frontend actually branches on today: `evidence_binder_revision_conflict` (`src/components/evidence/EvidenceBinderPane.tsx:174`), plus the prefix-encoded families `unknown_source:`, `install_target_exists:`, `terminal_kill_failed:`. Grep `src/` for `.includes(` against error text to find the rest; the set is expected to be small.
- Two real error enums already exist (`agent_host/status.rs:351`, `hub_client/http.rs:19`). Reuse the shape rather than inventing a third convention.
- The mirrored union belongs in `src/lib/types.ts`. "Fails the build on both sides" is the requirement; a generated file or an exhaustive `satisfies` check both satisfy it - pick the one with the smaller diff.
- The Tauri bridge turns `Err` into a rejected promise and `src/lib/errorStore.ts` renders it. Whatever struct is chosen must still produce a readable toast without special-casing at every call site.

### Phase 4: Editor Surface State Extraction

**Goal**: The two highest-arity panes own their state, and editing stops re-rendering the whole shell
**Depends on**: Phase 1
**Requirements**: SHELL-01, SHELL-02, SHELL-03, SHELL-04
**Success Criteria** (what must be TRUE):

  1. `OutlinePane` and `EditorPane` each take a small prop list and read the rest from module stores via `useSyncExternalStore`
  2. Typing in the editor does not re-render `DocumentList`, `TerminalPanel`, or the activity rail
  3. `EditorPane` has a component test that fails if a preview mark is lost to an unrelated re-render - the #260/#262/#264 failure mode
  4. The e2e suite, unit tests, and the startup/bundle budget gates pass unchanged, and no lazy mode pane has been pulled into the entry chunk

**Plans**: 5/6 plans executed

Plans:
**Wave 1**

- [x] 04-01-PLAN.md - Create all Wave 0 facade, render-isolation, preview-identity, and prop-budget contracts before production work
- [x] 04-02-PLAN.md - Prove the production Outline facade/command-port tracer and first isolated render domains

**Wave 2** *(blocked on Wave 1 completion)*

- [x] 04-03-PLAN.md - Complete Outline extraction, guarded persistence, cleanup, and the eight-prop contract

**Wave 3** *(blocked on Wave 2 completion)*

- [x] 04-04-PLAN.md - Establish keyed Editor state, exact persistence boundaries, and lifecycle isolation

**Wave 4** *(blocked on Wave 3 completion)*

- [x] 04-05-PLAN.md - Migrate EditorPane and drive render-isolation plus preview DOM-identity contracts green

**Wave 5** *(blocked on Wave 4 completion)*

- [ ] 04-06-PLAN.md - Run composite gates and the single focused native Tauri smoke

Notes for planning:

- Peel one pane's prop cluster per plan, highest arity first: `OutlinePane` (~71 props, `src/App.tsx:8917`), then `EditorPane` (~55, `src/App.tsx:7995`).
- The pattern is already proven in this repo: `src/lib/errorStore.ts`, `editorTabsStore.ts`, `appOverlayStore.ts`, `workspaceStore.ts`. Do not introduce a state library or a Context-provider tree.
- Hard invariant on `EditorPane`: marks must be folded into the HTML string React renders, and the markup object memoized on that string. Never add an effect that mutates the preview container's DOM - React reassigns `dangerouslySetInnerHTML` on any non-identity-equal prop, and the effect will not re-run because nothing it depends on changed (`src/components/EditorPane.tsx:167`).
- Success criterion 2 needs a way to observe re-renders. A render-counter assertion in a component test is the cheap version; do not build a profiling harness.
- No UI hint annotation: this phase must produce pixel-identical output, so a UI design spec is the wrong downstream step.

### Phase 5: Shell Decomposition Completion

**Goal**: `src/App.tsx` is a shell, not a state container - a new pane can be added without touching it
**Depends on**: Phase 4
**Requirements**: SHELL-05, SHELL-06, SHELL-07, SHELL-08
**Success Criteria** (what must be TRUE):

  1. `DocumentList` and `TerminalPanel` read their state from module stores instead of ~40- and ~25-prop bundles
  2. Mode selection is a registry lookup, and adding a mode surface does not add a branch to a nested ternary chain
  3. Adding state to any decomposed pane is a change inside that pane's store and component, with no edit to `src/App.tsx`
  4. `make verify` and the e2e suite pass with no visible behavior change, and `MainApp`'s `useState`/`useEffect` count is a fraction of today's 68/50

**Plans**: TBD

Notes for planning:

- Remaining prop bundles: `DocumentList` (~40, `src/App.tsx:8781`), `TerminalPanel` (~25, `src/App.tsx:9040`). The mode ternary chain runs roughly `src/App.tsx:8600` to `:8790`.
- Terminal invariant: preserve the generation check on every session-scoped command. It is what stops a stale frontend handle writing into a recycled session, and it is easy to lose when moving state.
- The mode registry must keep every mode surface a `React.lazy` chunk. A registry that eagerly imports all 18 surfaces will fail `scripts/check-bundle-budget.mjs`, which is the intended safety net.
- Success criterion 3 is verified by doing it: add a throwaway piece of pane state, confirm `src/App.tsx` is untouched, revert.
- No UI hint annotation, same reason as Phase 4.

## Progress

**Execution Order:**
Phases execute in numeric order: 1 -> 2 -> 3 -> 4 -> 5

| Phase | Plans Complete | Status | Completed |
|-------|----------------|--------|-----------|
| 1. Trustworthy Verify Signal | 7/7 | Complete    | 2026-08-23 |
| 2. Shared Scanner and Path Invariants | 3/3 | Complete    | 2026-08-23 |
| 3. Typed IPC Error Contract | 4/4 | Complete   | 2026-08-24 |
| 4. Editor Surface State Extraction | 5/6 | In Progress|  |
| 5. Shell Decomposition Completion | 0/TBD | Not started | - |

---
*Roadmap created: 2026-08-22*
