---
phase: 07-guardrails-before-churn
fixed_at: 2026-09-05T11:05:00Z
review_path: .planning/phases/07-guardrails-before-churn/07-REVIEW.md
iteration: 1
findings_in_scope: 2
fixed: 2
skipped: 0
status: all_fixed
---

# Phase 07: Code Review Fix Report

**Fixed at:** 2026-09-05T11:05:00Z
**Source review:** .planning/phases/07-guardrails-before-churn/07-REVIEW.md
**Iteration:** 1

**Summary:**
- Findings in scope: 2 (CR-01, WR-01; fix_scope `critical_warning` — Info findings IN-01 through IN-04 intentionally not addressed)
- Fixed: 2
- Skipped: 0

**Verification location:** fixes were applied and committed in the isolated
review-fix worktree (`rf-07-*`, branch `gsd-reviewfix/07-98299`, since removed);
`cargo check`/`cargo test` ran there. After the transactional fast-forward of
`main`, `pnpm vitest`, `make clippy`, and `cargo fmt --check` ran in the main
checkout (the worktree has no node_modules). All gates reproducible from the
current `main` tree.

## Fixed Issues

### CR-01: Sanitizer guard fails open on multi-line `dangerouslySetInnerHTML` sinks

**Files modified:** `scripts/check-dom-sanitizer.mjs`, `scripts/check-dom-sanitizer.behavior.test.ts`
**Commit:** 30e23b0
**Applied fix:** Added per-file reconciliation in the guard: after the
line-based sink scan, the raw `dangerouslySetInnerHTML` occurrence count in a
comment/string-stripped copy of the source (small char scanner — strips line
comments, block comments, and string/template literals without an AST parser,
preserving the D-07 no-AST design) is compared against the traced sink count;
when occurrences exceed traced sinks the file fails closed with a violation
naming the file. The naive raw-count approach from the review snippet was
adapted: current `src/` files mention the attribute in doc comments
(`HwpxViewer.tsx:11`, `EditorPane.tsx:120,451`), so counting un-stripped
occurrences would false-positive. Added a behavior-test probe pinning the
multi-line Prettier-wrapped sink shape fails closed (exit 1).
**Logic classification:** structural reconciliation, not a logic-error fix;
status `fixed`.
**Verification:** `node --check` pass; guard exit 0 on the current tree
("all 6 sinks trace"); live multi-line probe fails closed naming the probe
file; `pnpm vitest run` on both guard test files: 10 passed (behavior test
includes the new multi-line case); guard's own unit-test policy pins still
pass.

### WR-01: Single-root watchers silently die when the watched root's own name collides with GENERATED_DIRS

**Files modified:** `src-tauri/src/vault_watcher.rs`, `src-tauri/src/scratchpad_watcher.rs`, `src-tauri/src/inbox_watcher.rs`, `src-tauri/src/terminal_hooks.rs`
**Commit:** f91755e (plus style follow-up a54bae4 for cargo fmt/clippy)
**Applied fix:** Applied `is_under_generated_dir` to the root-relative path
instead of the absolute path in all four single-root watchers, matching the
review's fix direction:
- `vault_watcher::relevant_path` — predicate now runs on `rel` (already
  computed via `strip_prefix`).
- `scratchpad_watcher` drain thread — the generated-dir filter now strips
  `root_for_thread` before the predicate; the unit-test mirror of the
  drain chain was updated to match.
- `inbox_watcher` — reordered the handler to resolve `matched_root` and
  `rel_to_downloads` first, then prune on `rel_to_downloads` (the drop roots
  are settings-driven and multi-valued, so root-stripping happens after the
  root match rather than against a single known root).
- `terminal_hooks` — cloned the watch dir into the handler and strips it
  before the predicate, so a runtime dir under an ancestor named like a
  generated dir (e.g. a home directory literally named `dist`) no longer
  silences every hook event; `unwrap_or(true)` fails closed if stripping
  ever fails.
- `ops_catalog/watcher.rs` left unchanged (genuinely multi-root, absolute
  check is correct there).
Added regression tests: `vault_watcher::root_named_generated_dir_still_dispatches`
and `scratchpad_watcher::drain_filter_still_dispatches_when_root_name_is_generated_dir`,
both pinning that a root named `dist` still dispatches while nested generated
dirs stay pruned.
**Logic classification:** watcher dispatch logic; behavior verified by
targeted unit tests rather than eyeball-only — status `fixed`.
**Verification:** `cargo check --lib` exit 0; `cargo test --lib -- paths::
vault_watcher scratchpad_watcher inbox_watcher terminal_hooks`: 45 passed,
0 failed (includes both new regression tests); `make clippy` clean under
`-D warnings`; `cargo fmt --check` clean.

## Skipped Issues

None. Info findings (IN-01 to IN-04) are out of scope for `fix_scope:
critical_warning` and were not touched.

---

_Fixed: 2026-09-05T11:05:00Z_
_Fixer: gsd-code-fixer (generic-agent workaround dispatch)_
_Iteration: 1_
