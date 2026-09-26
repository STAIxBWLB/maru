---
phase: 09-durability-and-session-lifecycle
plan: 01
subsystem: infra
tags: [launchd, jobs, tilde-expansion, requirements-traceability]

# Dependency graph
requires: []
provides:
  - "REL-04 closed in traceability with a criterion-to-assertion map, zero source changes"
affects: [09-02, 09-03, 09-05]

# Actuals (#2632)
actuals:
  tokens: 255
  tasks: 2
  commits: 1

# Tech tracking
tech-stack:
  added: []
  patterns: []

key-files:
  created: []
  modified:
    - .planning/REQUIREMENTS.md

key-decisions:
  - "No new test added to jobs.rs: all three success-criterion-4 components already had direct, named assertions; adding one would have violated D-13's verify-only scope for a criterion that already passes"

patterns-established: []

requirements-completed: [REL-04]

coverage:
  - id: D1
    description: "Success criterion 4 (job PATH tilde expansion) verified against the shipped fix with no code change"
    requirement: "REL-04"
    verification:
      - kind: unit
        ref: "src-tauri/src/jobs.rs::tests::env_value_expands_every_tilde_segment"
        status: pass
      - kind: integration
        ref: "src-tauri/src/jobs.rs::tests::plist_env_expands_colon_separated_tildes"
        status: pass
    human_judgment: false
  - id: D2
    description: "REL-04 marked Complete in REQUIREMENTS.md traceability, sibling REL-01/02/03 rows untouched"
    requirement: "REL-04"
    verification:
      - kind: other
        ref: "grep -F \"| REL-04 | Phase 9 | Complete |\" .planning/REQUIREMENTS.md"
        status: pass
    human_judgment: false

# Metrics
duration: 6min
completed: 2026-09-25
status: complete
---

# Phase 9 Plan 1: REL-04 Verify-Only Close-Out Summary

**Confirmed the shipped `expand_tilde_segments` fix in `jobs.rs` covers all of success criterion 4 with existing named tests, then flipped REL-04 to Complete in traceability (no source line touched).**

## Performance

- **Duration:** 6 min
- **Started:** 2026-09-25T22:07:00Z (approx.)
- **Completed:** 2026-09-25T22:13:21Z
- **Tasks:** 2
- **Files modified:** 1

## Accomplishments
- Ran `cargo test --manifest-path src-tauri/Cargo.toml --lib jobs::tests`: both named REL-04 regression tests pass (`env_value_expands_every_tilde_segment`, `plist_env_expands_colon_separated_tildes`), among 29/29 passing in the module.
- Confirmed `git diff --exit-code -- src-tauri/src/jobs.rs` is clean (no production code was changed), matching D-13's verify-only scope.
- Marked REL-04 complete in `.planning/REQUIREMENTS.md` (checkbox + traceability row) via `gsd-tools query requirements.mark-complete REL-04`; verified REL-01/02/03 rows unchanged.

## Task Commits

Task 1 (verification) produced no diff, so no commit; this is expected and correct for a verify-only task per D-13.

1. **Task 2: Mark REL-04 complete in REQUIREMENTS.md traceability** - `736da12a` (docs)

**Plan metadata:** committed alongside Task 2 (worktree mode, STATE.md/ROADMAP.md excluded per orchestrator ownership)

## Files Created/Modified
- `.planning/REQUIREMENTS.md` - REL-04 checkbox ticked (`- [x]`) and traceability row flipped from `Pending` to `Complete`

## Criterion-to-Assertion Map (Task 1)

Success criterion 4 (ROADMAP.md, Phase 9): *"A job whose `program.env.PATH` carries several tilde entries installs a launchd plist in which every one of them is absolute... A colon-bearing non-path value and a single-path value are byte-identical to today's output."*

| Criterion component | Covering assertion | Input -> expected output |
|---|---|---|
| (1) Every `:`-separated tilde segment becomes absolute | `env_value_expands_every_tilde_segment` (unit) + `plist_env_expands_colon_separated_tildes` (plist XML integration) | `"~/a:~/b:/usr/bin"` -> `"{home}/a:{home}/b:/usr/bin"`; plist test additionally asserts the rendered `<string>` contains the fully-expanded PATH and that `!xml.contains("~/")` (no literal tilde survives) |
| (2) A colon-bearing non-path value is byte-identical | `env_value_expands_every_tilde_segment` | `"https://example.com/x"` -> `"https://example.com/x"` (unchanged); `"12:30"` -> `"12:30"` (unchanged) |
| (3) A single-path value is byte-identical to pre-fix output | `env_value_expands_every_tilde_segment` | `"~/bin/tools"` -> `"{home}/bin/tools"`; `"/usr/bin:/opt/homebrew/bin"` (no tilde) -> unchanged |

**Explicit edge rows (asserted, resolved per plan's `must_haves.truths`):**
- **Ordering:** `expand_tilde_segments("~/a:~/b:/usr/bin")`'s expected output lists segments `a`, `b`, `/usr/bin` in the same order as input; the assertion's exact-match `assert_eq!` proves order is preserved (a reordered result would fail this assertion, not merely a differently-formatted pass).
- **Adjacency:** `"~:/usr/bin"` -> `"{home}:/usr/bin"` proves a bare `~` segment touching a separator (not a `~/` prefix) still expands, i.e. the segment boundary decides expansion, not string-prefix matching.

**Backstop edge rows (untested-by-design under D-13, no assertion added):**
- **Empty string:** no test exercises `expand_tilde_segments("")`; by inspection `"".split(':')` yields `[""]`, `expand_tilde("")` returns `""` unchanged (matches neither `"~"` nor a `"~/"` prefix), and `.join(":")` of a single empty element is `""`, so an empty input stays empty by code inspection, not by an executed assertion.
- **Non-ASCII segment:** no test exercises a segment with non-ASCII path characters; `split(':')` splits on the ASCII colon byte and `expand_tilde` only rewrites a leading `~`/`~/`, so a non-ASCII segment with no tilde prefix passes through untouched by construction, not by an executed assertion.

Both backstops are `verification: backstop` in the plan's `must_haves.truths` (reasoned from source, not proven by a running test, per D-13's instruction not to add tests outside a stated success-criterion gap).

**Conclusion:** All three success-criterion-4 components (and both explicit edge cases) already have direct, passing, named test coverage. No missing-criterion gap was found, so per Task 1's action, nothing was added to `jobs.rs`.

## Decisions Made
- No new test added: research (09-RESEARCH.md) predicted full coverage and this run confirmed it empirically; adding a redundant test would go beyond D-13's verify-only mandate.

## Deviations from Plan

None - plan executed exactly as written.

## Issues Encountered
None.

## User Setup Required
None - no external service configuration required.

## Next Phase Readiness
- REL-04 is closed; REL-01, REL-02, REL-03 remain Pending and are owned by sibling plans 09-02, 09-03, 09-05 (wave 1 lead per ROADMAP; this plan intentionally had no dependencies).
- No blockers for subsequent Phase 9 plans.

## Self-Check: PASSED

- `.planning/REQUIREMENTS.md` exists and contains the expected changed lines: FOUND
- Commit `736da12a` exists in git log: FOUND (`git log --oneline -3` confirms)
- Both `<verify>` commands from Task 1 and Task 2 re-run clean: `cargo test ... jobs::tests` (29 passed, 0 failed); `git diff --exit-code -- src-tauri/src/jobs.rs` (exit 0, clean); `grep -F "| REL-04 | Phase 9 | Complete |"` and checkbox grep both matched; sibling `REL-01 | Phase 9 | Pending` unchanged.
- All `<acceptance_criteria>` from both tasks re-verified PASS.

---
*Phase: 09-durability-and-session-lifecycle*
*Completed: 2026-09-25*
