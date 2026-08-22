---
phase: 01-trustworthy-verify-signal
plan: 01
subsystem: infra
tags: [rust, cargo, rustfmt, rust-toolchain, makefile, ci]

# Dependency graph
requires: []
provides:
  - "rust-toolchain.toml pinning rustc 1.98.0 (exact channel, clippy+rustfmt components)"
  - "Makefile fmt-check target running `cargo fmt --check`"
  - "verify prerequisite list extended with fmt-check"
affects: [01-02-clippy-gate]

# Actuals (#2632)
actuals:
  tokens: 400
  tasks: 2
  commits: 1

# Tech tracking
tech-stack:
  added: []
  patterns:
    - "Makefile target registration: .PHONY line + trailing ## help gloss + tab-indented recipe, matching test-rust/lint-i18n convention"

key-files:
  created: [rust-toolchain.toml]
  modified: [Makefile]

key-decisions:
  - "Pinned channel = 1.98.0, resolved live via `rustup update stable` + `rustc +stable --version` rather than trusting RESEARCH.md's predicted value, per D-11 (pin the version CI builds with today)"
  - "fmt-check has no $(ICON_PATH) prerequisite (unlike test-rust/clippy) because rustfmt does not compile the crate"

patterns-established:
  - "Rust toolchain pin lives at the repo root (sibling of Makefile/package.json), not inside src-tauri/, so it governs both `cd src-tauri && cargo ...` and any future root-level cargo invocation"

requirements-completed: [GATE-05, GATE-01]

coverage:
  - id: D1
    description: "rust-toolchain.toml pins the exact toolchain (1.98.0) CI builds with today, with clippy+rustfmt components"
    requirement: GATE-05
    verification:
      - kind: other
        ref: "cd src-tauri && rustc --version -> rustc 1.98.0 (88d9e12ae 2026-08-18), matches rust-toolchain.toml channel"
        status: pass
      - kind: other
        ref: "ls src-tauri/rust-toolchain.toml fails (file not inside crate dir)"
        status: pass
    human_judgment: false
  - id: D2
    description: "make fmt-check target exists, runs cargo fmt --check, and is wired into the verify prerequisite list"
    requirement: GATE-01
    verification:
      - kind: other
        ref: "make fmt-check (exit 0 on unmodified tree)"
        status: pass
      - kind: other
        ref: "make -n verify shows `cd src-tauri && cargo fmt --check` in the recipe list; make help lists fmt-check with a non-empty description"
        status: pass
    human_judgment: false
  - id: D3
    description: "The format gate goes red on a deliberate formatting break in a real Rust file, and returns to green after revert, with no residue"
    requirement: GATE-01
    verification:
      - kind: manual_procedural
        ref: "Break-and-revert on src-tauri/src/main.rs (see Verification Evidence below); make fmt-check exit 2 on break, exit 0 after `git checkout --`"
        status: pass
    human_judgment: false

# Metrics
duration: 8min
completed: 2026-08-22
status: complete
---

# Phase 1 Plan 01: Rust Toolchain Pin + Format Gate Summary

**Pinned rustc to 1.98.0 via a repo-root `rust-toolchain.toml` and wired a new `make fmt-check` target into `verify`, proving it fails on a real formatting break and passes clean after revert.**

## Performance

- **Duration:** 8 min
- **Started:** 2026-08-22T05:51:00Z
- **Completed:** 2026-08-22T05:59:00Z
- **Tasks:** 2
- **Files modified:** 2 (`rust-toolchain.toml` created, `Makefile` edited)

## Accomplishments
- `rust-toolchain.toml` at the repository root pins `channel = "1.98.0"` (the version `rustup update stable` resolved live during this session, matching RESEARCH.md's Pitfall 6 prediction of 1.98.0 exactly) with `components = ["clippy", "rustfmt"]`
- New `fmt-check` Makefile target (`cd $(TAURI_DIR) && $(CARGO) fmt --check`), placed immediately after `test-rust`, with no `$(ICON_PATH)` prerequisite since rustfmt does not compile the crate
- `verify` prerequisite list extended with `fmt-check` (after `test-rust`), and its `##` gloss re-worded to mention the Rust format check
- Format gate proven to go red on a real break (a mis-indented line in `src-tauri/src/main.rs`) and green again after `git checkout --`, with zero residue in the working tree

## Task Commits

Each task was committed atomically:

1. **Task 1: End-to-end "an unformatted Rust file fails make verify", one gate only** - `1cbefd8` (feat)
2. **Task 2: Prove the format gate goes red on a deliberate break, then revert** - no commit (the task is pure verification against Task 1's artifacts; it leaves the tree byte-identical to Task 1's end state, per its own "leave no residue" requirement)

**Plan metadata:** (this commit, docs: complete plan)

## Files Created/Modified
- `rust-toolchain.toml` - repo-root toolchain pin, `channel = "1.98.0"`, `components = ["clippy", "rustfmt"]`
- `Makefile` - new `fmt-check` target after `test-rust`; `verify` prerequisite list gains `fmt-check`, gloss re-worded

## Verification Evidence

**Task 1 acceptance criteria, all passed:**
- `ls src-tauri/rust-toolchain.toml` fails (file is at repo root only)
- `channel` value `1.98.0` matches `^[0-9]+\.[0-9]+\.[0-9]+$`
- `components` contains both `clippy` and `rustfmt`
- `cd src-tauri && rustc --version` -> `rustc 1.98.0 (88d9e12ae 2026-08-18)`, matches the pinned channel exactly
- `make fmt-check` exits 0 on the unmodified tree
- `grep -c 'fmt-check' Makefile` -> `3` (`.PHONY` line, target line, `verify` prerequisite list)
- `make help` output contains a `fmt-check` row: `fmt-check    Rust format check (no changes written)`
- `git diff --stat src-tauri/Cargo.toml` shows no change

**Task 2: deliberate break, observed failure, revert:**

Broke `src-tauri/src/main.rs` by mis-indenting one line (4 spaces -> 8 spaces) inside `fn main()`. `make fmt-check` output:

```
cd src-tauri && cargo fmt --check
Diff in /Users/yj.lee/workspace/work/dev/maru/src-tauri/src/main.rs:4:
 )]

 fn main() {
-        let mut args = std::env::args().skip(1);
+    let mut args = std::env::args().skip(1);
     if matches!(args.next().as_deref(), Some("--maru-cli")) {
         std::process::exit(maru_lib::run_cli(args.collect()));
     }
make: *** [fmt-check] Error 1
```
Exit code: `2` (non-zero).

After `git checkout -- src-tauri/src/main.rs`:
- `git status --porcelain src-tauri/` -> empty (no residue)
- `make fmt-check` -> exit 0

**Plan-level verification (`<verification>` block):**
- `make fmt-check` green on the current tree, red on a deliberate break: confirmed above.
- `make verify` reaches `fmt-check`: `make -n verify` dry-run recipe list includes `cd src-tauri && cargo fmt --check` (placed after `cd src-tauri && cargo test --lib`, before `pnpm build:frontend`).
- `cd src-tauri && rustc --version` matches the pinned channel exactly: confirmed.
- `git diff` at plan end touches only `rust-toolchain.toml` and `Makefile`: confirmed via `git diff --stat 3e9c8a0 HEAD` (2 files changed, 8 insertions, 1 deletion).

**Pinned version for downstream plans:** `1.98.0`. Plan 01-02 must re-measure its clippy violation count against this exact toolchain (RESEARCH.md D-08's 75-violation count was measured on local `rustc 1.96.0`, which this plan's pin supersedes).

## Decisions Made
- Resolved the pin value live (`rustup update stable` then `rustc +stable --version`) rather than hardcoding RESEARCH.md's predicted `1.98.0`; it happened to match, confirming D-11's "the version CI builds with today" as of 2026-08-22.
- `fmt-check` intentionally omits `$(ICON_PATH)` as a prerequisite (unlike `test-rust`/the planned `clippy`), because `cargo fmt --check` does not compile the crate and forcing an icon build first would slow the fastest gate in the phase for no reason.
- Task 2 produced no code commit: the break was deliberately never staged or committed (plan requirement), and the plan's own acceptance criteria only require the SUMMARY to record the evidence, not a commit. This SUMMARY plus the final metadata commit is the record.

## Deviations from Plan

None - plan executed exactly as written. `rustup update stable` was needed to resolve the toolchain version live (the local default was 1.96.0), which is exactly what Task 1's `<action>` instructs, not a deviation.

## Issues Encountered

The local machine's default toolchain was `stable` (1.96.0) at session start. `rustup update stable` was run per the task's explicit instruction, updating the local `stable` alias to 1.98.0 and confirming the pin value to write. Installing the pinned `1.98.0` toolchain (as its own named toolchain, since `rust-toolchain.toml` pins an exact version rather than the `stable` alias) triggered a first-time download; `make fmt-check` took over 2 minutes on the first invocation for this reason. Subsequent invocations are fast since the toolchain is now cached locally.

## User Setup Required

None - no external service configuration required.

## Next Phase Readiness

- GATE-05 fully satisfied: the toolchain pin is live and verified.
- GATE-01 half satisfied (rustfmt only); clippy is plan 01-02's responsibility.
- Plan 01-02 must re-measure its clippy violation count against `rustc 1.98.0` (this plan's pin), not the `1.96.0` count RESEARCH.md originally measured, since RESEARCH.md's own Pitfall 6 anticipated this.
- No blockers.

---
*Phase: 01-trustworthy-verify-signal*
*Completed: 2026-08-22*
