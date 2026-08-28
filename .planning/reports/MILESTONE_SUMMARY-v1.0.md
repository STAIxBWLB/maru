# Milestone v1.0 Project Summary

**Generated:** 2026-08-28
**Milestone:** v1.0 Structural Debt Paydown
**Product release:** v0.5.0 - A Stronger Foundation
**Result:** 5 phases, 32 plans, and 24/24 requirements complete

## Project Snapshot

Maru is a local-first desktop workspace for Korean knowledge and document
operations. It combines a React 19 and TypeScript interface with a Tauri 2 Rust
core. The filesystem remains authoritative: documents, tasks, drafts, evidence,
diagrams, and workspace metadata remain usable without Maru.

The v1.0 planning milestone was a behavior-preserving structural debt paydown.
It did not add a new product surface. It made the existing product safer to
change, easier to verify, and less dependent on `MainApp` as a state owner.

## Delivered Phases

| Phase | Outcome | Plans | Verification |
|-------|---------|-------|--------------|
| 1. Trustworthy Verify Signal | Pinned toolchain, authoritative lint/type/test/build gates, and CI evidence | 7/7 | passed |
| 2. Shared Scanner and Path Invariants | One generated-directory list and canonical lexical containment helpers | 3/3 | passed |
| 3. Typed IPC Error Contract | Cross-language `{ code, message }` contract with rename-failure guards | 4/4 | passed |
| 4. Editor Surface State Extraction | Store-backed Outline and Editor facades with render-isolation proof | 7/7 | passed |
| 5. Shell Decomposition Completion | Four-input Documents and Terminal facades plus an 18-mode lazy registry | 11/11 | passed |

## Key Results

- `make verify` now covers four TypeScript projects, ESLint correctness rules,
  frontend and Rust unit tests, rustfmt, clippy with warnings denied, release
  version synchronization, production build, and bundle budgets.
- Six scanner consumers share `GENERATED_DIRS`; new containment work has one
  canonical lexical helper without changing the deliberate symlink policy.
- Typed conflict codes cross Rust, Tauri, normalization funnels, and frontend
  branch sites without message parsing.
- `OutlinePane`, `EditorPane`, `DocumentList`, and `TerminalPanel` consume small,
  least-authority facades backed by keyed module stores.
- All 18 modes route through typed lazy registry adapters. `MainApp` remains at
  15 `useState` and 24 `useEffect` calls, below the enforced ceilings.
- Milestone audit results: 24/24 requirements, 5/5 phase verifications,
  integration 8/8, E2E flows 5/5, and native D-20 UAT 5/5.

## Post-Close Hardening

PR #283 closed ERR-06 before the commemorative v0.5.0 release:

- `today_apply_plan_result`, `task_calendar_set_sync`, and
  `update_frontmatter_field` now return `IpcError` on reserved conflict paths.
- `updateFrontmatterField` uses the shared frontend normalizer and pins both
  typed conflict and legacy uncoded message behavior.
- The regression guard walks every Rust source module recursively instead of
  relying on a manual source list.
- A temporary unregistered source module made the guard fail at the exact
  flattening line; after removal, the final tree returned green.
- Phase 3 security verification closed seven threats with `threats_open: 0`.

ERR-06 was not one of the original 24 v1 requirements. It is recorded as a
post-close resolution so the archived milestone result remains historically
accurate.

## Architecture Decisions Preserved

- Filesystem data is authoritative; caches are disposable.
- Frontmatter edits preserve unrelated bytes, comments, order, and quoting.
- Workspace containment stays lexical so deliberate in-workspace symlinks work.
- Managed writes remain schema-gated, revision-checked, snapshotted, and atomic.
- Shared frontend state uses module stores and `useSyncExternalStore`; no new
  state library or provider tree was introduced.
- Terminal commands require generation-bearing session handles.
- The entry bundle and initial CSS remain budget-gated.
- Native-only macOS behavior still requires real-app verification because CI
  runs Chromium with mocked Tauri IPC.

## Release Evidence

The v0.5.0 release must not be considered complete from the tag alone. The
release gate requires all of the following on the same release commit:

- PR CI and exact-tree main CI
- Release Preflight
- four-platform Release Bundles
- non-empty updater signatures and an 11-platform `latest.json`
- notarized and stapled macOS DMGs plus Gatekeeper checks
- signed app bundles and version/architecture-correct CLIs
- Homebrew cask and formula updates with matching download hashes

## Deferred Work

- ERR-05: close the Rust code-construction surface with a closed enum and a
  generated TypeScript union.
- PERF-01..04: UI-thread blocking, lock duration, poison recovery, and watcher
  pruning candidates.
- SEC-01/02: CSP and sanitizer coverage candidates.
- REL-01: process-group escalation for SIGHUP-resistant terminal children.
- TEST-01..04: native Tauri E2E, coverage reporting, remaining large-component
  tests, and an app-menu smoke test.
- Evidence debt: deliberate failing-CI trace reproduction, Phase 1-3 Nyquist
  reconciliation, and a Phase 2 security report.

These remain candidates until a new milestone promotes them into requirements.

## Current State

- Planning milestone tag: `v1.0`, immutable at the archive commit.
- Product distribution tag: `v0.5.0`.
- Active milestone: none.
- Next action: start discovery with `$gsd-new-milestone` when the next scope is
  selected.
