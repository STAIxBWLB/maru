# maru

## What This Is

Local-first Maru Workspace and AI editing desktop app. A Tauri 2 desktop shell -
React 19 + TypeScript frontend over a Rust core - where a folder on disk is the
workspace: notes, documents, terminals, a knowledge graph, diagrams, skills, and
AI agent runs all operate on real files the user owns. Shipped as signed bundles
for macOS, Windows, and Linux; currently v0.4.62.

## Core Value

The filesystem stays the source of truth - everything Maru shows is derived from
real files the user owns, and nothing is lost if Maru is uninstalled.

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

### Active

<!-- Milestone 1: structural debt paydown. Scoped to the Tech Debt section of
     .planning/codebase/CONCERNS.md. -->

- [ ] Errors the frontend branches on carry a typed `code`, not a string prefix
- [ ] `src/App.tsx` no longer owns pane state - `OutlinePane`, `EditorPane`,
      `DocumentList`, and `TerminalPanel` read module stores instead of 71/55/40/25-prop
      bundles

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
- **Any visible UI change during decomposition** - a refactor that alters output
  cannot be verified against the existing e2e suite
- **A full lint style campaign** (formatting rules, import ordering, `console`
  cleanup) - only the correctness rules that guard the decomposition
- **Concurrency, security, and perf items from CONCERNS.md** (sync-command main
  thread blocking, lock poisoning recovery, CSP `script-src blob:` audit, SIGHUP
  session escalation, native Tauri E2E runner) - real, tracked as v2 in
  REQUIREMENTS.md, deliberately not competing with the structural work
- **Hub graph-metadata sync** - the one explicit deferral in the ingested doc
  set (`docs/graph.md`); held until a Hub consumer exists

## Context

**Brownfield, and unusually disciplined.** TypeScript is `strict` with 7 `any`
uses and zero `@ts-ignore`; Rust production code has 18 `.unwrap()` calls;
deliberate simplifications carry `ponytail:` comments naming their ceiling. The
debt below is the real remainder, not a symptom of neglect.

**Where the debt bites.** `src/App.tsx` is 9,337 lines. `MainApp`
(`src/App.tsx:774`) holds 68 `useState` and 50 `useEffect` and passes state down
as prop bundles: `OutlinePane` ~71 props, `EditorPane` ~55, `DocumentList` ~40,
`TerminalPanel` ~25. Every `MainApp` state change re-renders the whole tree. The
preview-mark regressions in v0.4.57-v0.4.58 and #260/#262/#264 are a direct
consequence of components re-rendering for reasons they cannot see. That is the
concrete cost this milestone is paying down.

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

**No test coverage where the refactor lands.** `src/App.tsx` has no test of any
kind. `EditorPane.tsx` (1,096 lines) has no component test, though
`decoratePreviewHtml.test.ts` and `editorPreviewDebounce.test.tsx` cover part of
the path. `src/lib/` is the opposite story - 183 test files against 375 source
files - which is why the answer is to move logic into `src/lib/` stores.

## Constraints

The 64 SPEC-tier constraints in `.planning/intel/constraints.md` are project
invariants for this milestone. There are no ADRs in the ingested set, so none of
them is decision-locked - **any of them is overridable by a future ADR**. The
ones this milestone can actually break are listed here.

- **Behavior**: The refactor must be output-identical - `make verify` (typecheck,
  unit, e2e, startup/bundle budget gates) is the developer-facing success metric,
  and it must stay green throughout
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
| Milestone 1 = structural debt paydown, no features | Behavior-preserving work is only verifiable if behavior is not also changing | - Pending |
| Scope drawn from CONCERNS.md Tech Debt, not from the SPECs | 18 ingested docs describe shipped behavior; inventing forward work from them would be fabrication | - Pending |
| Verification gates land before the decomposition (Phase 1) | Moving 68 `useState` / 50 `useEffect` without a hook-dependency gate reproduces #260/#262/#264 | ✓ Phase 1 — 7 gates live, deliberate-break proofs red-then-green, UAT 24/24 |
| Continue the module-store precedent instead of adding a state library | `errorStore`/`workspaceStore`/`editorTabsStore` already prove the pattern here | - Pending |
| Typed error contract covers only branched-on errors | Converting all ~1,138 signatures is cost without benefit; display-only errors read fine as strings | - Pending |
| Promote `ensure_within`, do not retrofit all ~20 callers | Existing checks are individually sound; the problem is that a new author has no canonical example | ✓ Phase 2 — promoted to `crate::paths`, doc + tests as the example, zero retrofits |
| Phases 4-5 get no `UI hint` annotation | They refactor UI state plumbing with pixel-identical output as the success criterion; a UI design spec would be the wrong downstream suggestion | - Pending |
| 64 SPEC constraints recorded as invariants, not decisions | 0 ADRs in the set - nothing is decision-locked, so a future ADR can override any of them | - Pending |

---
*Last updated: 2026-08-23 after Phase 2*
