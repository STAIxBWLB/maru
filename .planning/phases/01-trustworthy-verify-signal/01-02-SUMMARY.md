---
phase: 01-trustworthy-verify-signal
plan: 02
subsystem: infra
tags: [rust, clippy, makefile, ci, tauri-ipc]

# Dependency graph
requires:
  - phase: 01-trustworthy-verify-signal (plan 01)
    provides: "rust-toolchain.toml pinning rustc 1.98.0, the toolchain this plan's clippy count was measured against"
provides:
  - "src-tauri/ clippy-clean at lib scope on rustc 1.98.0 (cargo clippy -- -D warnings exits 0)"
  - "Makefile clippy target, verify prerequisite list extended with clippy"
affects: [phase-2, phase-4, phase-5]

# Actuals (#2632)
actuals:
  tokens: 15904
  tasks: 3
  commits: 3

# Tech tracking
tech-stack:
  added: []
  patterns:
    - "Argument-count fix for a #[tauri::command] IPC boundary: bundle plain-data params into one #[derive(Deserialize)] struct parameter, update the paired frontend invoke() call to nest the same fields under one new key (field names and wire values unchanged), leave AppHandle/State/Channel params top-level"
    - "Argument-count fix for a plain internal function: bundle related params into a small local struct, destructure at the top of the function so the body is otherwise untouched"

key-files:
  created: []
  modified:
    - src-tauri/src/*.rs (25 files, mechanical + hand clippy fixes)
    - src-tauri/src/skill_host/dispatch.rs (SkillDispatchBackgroundArgs bundling)
    - src-tauri/src/terminal/mod.rs (TerminalSpawnArgs bundling, boxed Frame variant)
    - src/lib/skills.ts, src/lib/api.ts (paired invoke() payload reshaping)
    - Makefile (clippy target + verify prerequisite)

key-decisions:
  - "Re-measured count (75) matched RESEARCH.md's 75 exactly despite the toolchain moving from 1.96.0 to 1.98.0 - Pitfall 6's predicted drift did not materialize this time, but the plan's re-measure-first instruction is what caught that (rather than assumed)"
  - "Two too_many_arguments violations were on #[tauri::command] IPC boundary functions (skills_dispatch_background, terminal_spawn); fixed by bundling params into a struct and updating the one paired frontend invoke() call site per command, rather than reaching for #[allow(clippy::too_many_arguments)] (an existing pre-plan precedent for that escape exists on start_agent_cli_invocation in ai_router.rs, but D-08 forbids the executor from adding new ones)"
  - "Two is_none_or usages (agents.rs, kakao_relay.rs, pre-existing from PR #258) were rewritten to map_or(true, ...): is_none_or needs rustc 1.82, the crate's declared MSRV (Cargo.toml rust-version = 1.77.2, out of this plan's files_modified scope) is 1.77.2. The toolchain pin (1.98.0) and the MSRV floor are different numbers on purpose (D-11)"
  - "Two genuinely test-only helpers in maru_dir.rs (only referenced from #[cfg(test)] mod tests) were marked #[cfg(test)] rather than deleted or allow()'d - accurate to how they're actually used, and dead_code is real at lib-only clippy scope even though cargo test --lib compiles and uses them"

patterns-established:
  - "too_many_arguments fix menu, in order of preference: (1) plain function, single call site -> bundle unrelated-but-co-occurring params into a small local struct; (2) #[tauri::command] boundary -> bundle into a #[derive(Deserialize)] struct, update the paired invoke() call in the same commit, leave AppHandle/State/Channel top-level"

requirements-completed: [GATE-01]

coverage:
  - id: D1
    description: "cargo clippy --offline -- -D warnings exits 0 on the pinned toolchain (rustc 1.98.0), down from 75 violations"
    requirement: GATE-01
    verification:
      - kind: other
        ref: "cd src-tauri && cargo clippy --offline -- -D warnings (exit 0, see Verification Evidence)"
        status: pass
    human_judgment: false
  - id: D2
    description: "make verify enforces the clippy gate: clippy target added, wired into verify's prerequisite list, proven red on a deliberate needless_return violation and green after revert with no residue"
    requirement: GATE-01
    verification:
      - kind: manual_procedural
        ref: "Break-and-revert on src-tauri/src/maru_dir.rs (see Verification Evidence below); make clippy Error 101 on break, exit 0 after git checkout --"
        status: pass
    human_judgment: false
  - id: D3
    description: "No clippy lint was silenced with a suppression attribute (D-08); every one of the 75 violations was fixed at the call site"
    requirement: GATE-01
    verification:
      - kind: other
        ref: "git diff <before> <after> -- src-tauri/src | grep -c allow(clippy:: -> 0; grep -cE '^\\+#!\\[(allow|deny|warn)' -> 0"
        status: pass
    human_judgment: false
  - id: D4
    description: "Behavior preserved through 75 fixes (36 automated, 39 by hand) including two IPC contract reshapes: cargo test --lib result set unchanged"
    requirement: GATE-01
    verification:
      - kind: unit
        ref: "cd src-tauri && cargo test --lib --offline -> 1199 passed; 0 failed; 3 ignored (identical before and after every fix pass)"
        status: pass
    human_judgment: false

# Metrics
duration: 37min
completed: 2026-08-22
status: complete
---

# Phase 1 Plan 02: Rust Clippy Lint Gate Summary

**Cleared all 75 clippy violations on the pinned rustc 1.98.0 toolchain (36 via `cargo clippy --fix`, 39 by hand, including two Tauri IPC command signatures whose paired frontend `invoke()` calls were updated in the same commit) and wired `clippy` into `make verify`.**

## Performance

- **Duration:** 37 min
- **Started:** 2026-08-22T06:02:37Z
- **Completed:** 2026-08-22T06:39:08Z
- **Tasks:** 3
- **Files modified:** 42 (25 `src-tauri/src/*.rs` production files, 2 frontend TS files, `Makefile`)

## Accomplishments

- Re-measured the clippy backlog on the pinned toolchain from plan 01-01 (rustc 1.98.0): **75 violations**, matching RESEARCH.md's count exactly (measured there on rustc 1.96.0) - Pitfall 6's predicted toolchain drift did not add lints this time, but only re-measuring first (rather than trusting the old number) proved that
- `cargo clippy --fix --allow-dirty --allow-staged` auto-cleared 36 of the 75 (needless_borrow, `map_or(false,..)`→`is_some_and`, `derivable_impls`→`#[derive(Default)]`, `io::Error::new(Other,_)`→`io::Error::other`, `sort_by`→`sort_by_key`, `.last()`→`.next_back()`, eta-reductions); `cargo fmt` normalized the two spots the autofix left non-idiomatic
- Hand-fixed the remaining 39 across 25 files: 2 dead_code (marked `#[cfg(test)]`, genuinely test-only), 2 `incompatible_msrv` (`is_none_or`→`map_or(true,..)`, MSRV-compatible), 9 `too_many_arguments` (param-bundling structs, including two `#[tauri::command]` boundaries with a paired frontend reshape), 7 `redundant_closure` (self-inflicted by Task 1's own `io::Error::other` fix), 2 `large_enum_variant`/1 `result_large_err` (boxed), 2 `field_reassign_with_default`, 2 `manual_clamp`, 1 `manual_strip`, 2 `drop_non_drop`, 1 `explicit_counter_loop`, 1 `filter().next_back()`→`.rfind()`, 5 `doc_lazy_continuation`
- `clippy` Makefile target added (with the `$(ICON_PATH)` prerequisite, matching `test-rust`'s precedent since it compiles the crate) and wired into `verify`'s prerequisite list after `fmt-check`
- Gate proven red-then-green: a deliberate `needless_return` in `src-tauri/src/maru_dir.rs` made `make clippy` exit 101 naming the lint; `git checkout --` reverted with zero residue and `make clippy` exit 0 again
- `cargo test --lib --offline`: 1199 passed, 0 failed, 3 ignored - identical before and after every fix pass, including the two IPC contract reshapes
- Zero suppression attributes added (`grep -c allow(clippy::` and crate-level `#!\[allow|deny|warn` both 0 across the full diff)

## Task Commits

Each task was committed atomically:

1. **Task 1: Re-measure on the pinned toolchain, then clear the mechanical majority with cargo clippy --fix** - `3df2300` (feat)
2. **Task 2: Fix the remaining clippy violations by hand to zero** - `b36f3f8` (feat)
3. **Task 3: Add the clippy make target, wire it into verify, prove it goes red** - `3860173` (feat)

**Plan metadata:** (this commit, docs: complete plan)

## Files Created/Modified

**Production Rust (`src-tauri/src/`, 25 files):** `agents.rs`, `ai_router.rs`, `diagram/mod.rs`, `evidence_binder.rs`, `export/manifest.rs`, `hub_client/cache.rs`, `inbox.rs`, `inbox_settings.rs`, `kakao_relay.rs`, `maru_dir.rs`, `meetings.rs`, `ops_catalog/index.rs`, `ops_catalog/scan.rs`, `outlook_mso.rs`, `scheduler.rs`, `skill_host/dispatch.rs`, `skill_host/mod.rs`, `tasks.rs`, `terminal/input.rs`, `terminal/mod.rs`, `terminal/model.rs`, `today_lifecycle.rs`, `today_outbox.rs`, `today_store.rs`, `vault_guard.rs`, `web_actions.rs` - plus 23 more touched only by Task 1's mechanical autofix (see `3df2300`).

**Frontend (paired with the two `#[tauri::command]` argument-bundling fixes):**
- `src/lib/skills.ts` - `skillsDispatchBackground`'s `invoke()` call nests its params under a new `args` key (function's own public signature unchanged)
- `src/lib/api.ts` - `terminalSpawn`'s `invoke()` call nests its plain-data params under `args`, keeps `onEvent`'s `Channel` top-level

**Build config:**
- `Makefile` - new `clippy` target after `fmt-check`; `verify` prerequisite list gains `clippy`, gloss re-worded

## Verification Evidence

**Task 1 - before count:**
```
cd src-tauri && cargo clippy --offline -- -D warnings 2>&1 | grep -c '^error'
76   # 75 violations + 1 "could not compile ... due to 75 previous errors" summary line
```
Toolchain: `rustc 1.98.0 (88d9e12ae 2026-08-18)`. Per-lint breakdown (top): `needless_borrow` 10, `too_many_arguments` 9, `io_other_error` 8, `unnecessary_map_or` 5, `doc_lazy_continuation` 5, `derivable_impls` 4, `unnecessary_sort_by` 3, plus 18 more at 1-2 each.

After `cargo clippy --fix --offline --allow-dirty --allow-staged -- -D warnings` + `cargo fmt`: 39 remaining, `cargo test --lib --offline`: 1199 passed, 0 failed, 3 ignored.

**Task 2 - remaining 39, by lint (file):**
- `dead_code` x2 (`maru_dir.rs` - genuinely test-only, marked `#[cfg(test)]`)
- `incompatible_msrv` x2 (`agents.rs`, `kakao_relay.rs` - `is_none_or` needs 1.82, MSRV is 1.77.2)
- `too_many_arguments` x9 (`ai_router.rs`, `evidence_binder.rs`, `inbox.rs`, `skill_host/dispatch.rs` x2, `terminal/input.rs` x2, `terminal/mod.rs`, `today_outbox.rs`)
- `unnecessary_sort_by` x2 (`diagram/mod.rs`)
- `explicit_counter_loop` x1 (`evidence_binder.rs`)
- `redundant_closure` x7 (`export/manifest.rs` x2, `hub_client/cache.rs` x3, `ops_catalog/index.rs`, `ops_catalog/scan.rs` - self-inflicted by Task 1's own `io::Error::other` autofix wrapping it in a closure)
- `large_enum_variant` x2 (`inbox.rs`, `terminal/mod.rs`)
- `field_reassign_with_default` x2 (`inbox_settings.rs`, `terminal/model.rs`)
- `manual_clamp` x2 (`meetings.rs`, `tasks.rs`)
- `manual_strip` x1 (`ops_catalog/index.rs`)
- `drop_non_drop` x2 (`outlook_mso.rs`)
- `called filter().next_back()` x1 (`today_store.rs`, →`.rfind()`)
- `doc_lazy_continuation` x5 (`vault_guard.rs`, one blank-line fix resolved all 5)
- `result_large_err` x1 (`web_actions.rs`)

After: `cargo clippy --offline -- -D warnings` exits 0. `cargo test --lib --offline`: 1199 passed, 0 failed, 3 ignored. `cargo fmt --check` exits 0. `pnpm typecheck` clean (frontend changes paired with the two IPC bundling fixes).

**Task 3 - break-and-revert:**

Broke `src-tauri/src/maru_dir.rs` by wrapping `maru_home_dir`'s tail expression in an explicit `return`. `make clippy` output:
```
error: unneeded `return` statement
   --> src/maru_dir.rs:158:5
    |
158 | /     return dirs::home_dir()
159 | |         .map(|home| home.join(".maru"))
160 | |         .ok_or_else(|| "Could not determine home directory for ~/.maru".to_string());
    | |____________________________________________________________________________________^
    = note: `-D clippy::needless-return` implied by `-D warnings`
error: could not compile `maru` (lib) due to 1 previous error
make: *** [clippy] Error 101
```
After `git checkout -- src-tauri/src/maru_dir.rs`: `git status --porcelain src-tauri/` empty, `make clippy` exits 0.

**Plan-level verification:**
- `cd src-tauri && cargo clippy --offline -- -D warnings` exits 0: confirmed.
- `cd src-tauri && cargo fmt --check` exits 0 (no regression from plan 01-01's gate): confirmed.
- `cd src-tauri && cargo test --lib --offline`: 1199 passed, 0 failed, 3 ignored (unchanged from plan start): confirmed.
- `make clippy` red on deliberate violation, green after revert: confirmed above.
- `git status --porcelain` clean at plan end (all changes committed): confirmed.
- `git diff <plan-start> <plan-end> -- src-tauri/src | grep -c 'allow(clippy::'` → 0; crate-level `#!\[allow|deny|warn` → 0.

## Decisions Made

- Two `too_many_arguments` violations sit on `#[tauri::command]` functions (`skills_dispatch_background`, `terminal_spawn`). Fixing these without an `allow` requires either changing the IPC wire shape or accepting the escape. Chose to bundle the plain-data parameters into one `#[derive(Deserialize)]` struct and update the single paired frontend `invoke()` call site (`src/lib/skills.ts`, `src/lib/api.ts`) in the same commit, nesting the identical field set under a new key. Field names, JSON values, and every other caller are unchanged - verified with `pnpm typecheck` and the unchanged Rust test count. This diverges from `files_modified: [Makefile, src-tauri/src/]` in the plan frontmatter by touching two frontend files, but D-08 ("every violation gets fixed... an escape is a decision the developer makes, not the executor") and Rule 3 (blocking-issue fix, no new dependency, no behavior change) together point at fixing it over adding a new suppression attribute; a pre-existing `#[allow(clippy::too_many_arguments)]` on `start_agent_cli_invocation` (predating this plan) was left untouched since D-08 targets new escapes, not grandfathered ones.
- `enqueue_record`'s 9-argument signature bundled 7 of them into `OutboxRecordDraft` (a `pub(crate)` struct), touching 8 call sites across `today_outbox.rs`, `today_lifecycle.rs`, and `web_actions.rs`. All were plain internal functions (no IPC boundary), so no frontend change was needed.
- `is_none_or` (agents.rs, kakao_relay.rs) predates this plan (from PR #258) and was flagged by `incompatible_msrv` only because clippy on the newly-pinned 1.98.0 toolchain reads the crate's declared `rust-version = "1.77.2"` (`Cargo.toml`, untouched by this plan per its `files_modified` scope) and `is_none_or` stabilized in 1.82. Rewrote to `map_or(true, ...)`, the MSRV-compatible equivalent - same logic, no `Cargo.toml` edit needed.

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 1 - Bug] Fixed a redundant-closure regression Task 1's own autofix introduced**
- **Found during:** Task 2, re-running clippy after Task 1's commit
- **Issue:** `cargo clippy --fix` rewrote `.map_err(|e| io::Error::new(io::ErrorKind::Other, e))` to `.map_err(|e| io::Error::other(e))`, but `io::Error::other` takes the value directly, so the closure itself is now redundant - a fresh `redundant_closure` violation (7 occurrences across 4 files) that did not exist before Task 1's own fix.
- **Fix:** `.map_err(|e| io::Error::other(e))` → `.map_err(io::Error::other)` in all 7 spots.
- **Files modified:** `export/manifest.rs`, `hub_client/cache.rs`, `ops_catalog/index.rs`, `ops_catalog/scan.rs`.
- **Committed in:** `b36f3f8` (Task 2 commit)

**2. [Rule 3 - Blocking] Frontend `invoke()` payload reshape for two Tauri commands**
- **Found during:** Task 2, fixing `too_many_arguments` on `skills_dispatch_background` and `terminal_spawn`
- **Issue:** Reducing these two `#[tauri::command]` functions' argument count below clippy's threshold, without an `allow`, requires nesting their plain-data parameters into one struct - which changes the IPC payload shape their frontend callers send.
- **Fix:** Bundled Rust-side params into `SkillDispatchBackgroundArgs`/`TerminalSpawnArgs`; updated `src/lib/skills.ts` and `src/lib/api.ts` in the same commit to nest the identical field set under a new `args` key. No field renamed, no value changed, every other caller of the two exported TS wrapper functions unaffected.
- **Files modified:** `src-tauri/src/skill_host/dispatch.rs`, `src-tauri/src/skill_host/mod.rs`, `src-tauri/src/terminal/mod.rs`, `src-tauri/src/scheduler.rs` (the one Rust-side caller of `skills_dispatch_background`), `src/lib/skills.ts`, `src/lib/api.ts`.
- **Verification:** `pnpm typecheck` clean; `cargo test --lib --offline` unchanged (1199/0/3); no e2e spec or mock references either command's argument shape (`grep -rn` came up empty for both).
- **Committed in:** `b36f3f8` (Task 2 commit)

---

**Total deviations:** 2 auto-fixed (1 bug, 1 blocking-issue fix with an intentionally minor scope expansion beyond the plan's declared `files_modified`)
**Impact on plan:** Both were necessary to reach the plan's stated zero-violation success criterion without a suppression attribute. No product behavior changed - verified by the unchanged Rust test count, `pnpm typecheck`, and a payload-shape check against every known caller.

## Issues Encountered

None beyond the two items documented above as deviations. The first `cargo clippy` invocation on the newly-pinned 1.98.0 toolchain took several minutes (first-time compile of the full dependency graph under that toolchain, matching plan 01-01's note about the first `cargo fmt-check` invocation); subsequent runs were fast (well under a minute) since the toolchain and build cache were warm.

## User Setup Required

None - no external service configuration required.

## Next Phase Readiness

- GATE-01 fully satisfied: `fmt-check` (plan 01-01) + `clippy` (this plan) both gate `make verify`.
- Phase 2 and Phases 4-5 (the `App.tsx` decomposition) now have a Rust lint gate in place, on top of the format gate - refactors that introduce sloppy Rust will fail `make verify` rather than land silently.
- No blockers.

---
*Phase: 01-trustworthy-verify-signal*
*Completed: 2026-08-22*

## Self-Check: PASSED

- Commit `3df2300` (Task 1): found in `git log --oneline --all`
- Commit `b36f3f8` (Task 2): found in `git log --oneline --all`
- Commit `3860173` (Task 3): found in `git log --oneline --all`
- `.planning/phases/01-trustworthy-verify-signal/01-02-SUMMARY.md`: exists
- `clippy` target present in `Makefile`
